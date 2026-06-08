/**
 * prompt-builder.ts — Build the augmented prompt for a user message.
 * Handles: timestamp, media path, group context, session-start injection,
 * active recall, large-message interception, injection scan.
 */

import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo, logDebug, logTrace, logWarn } from "../logger.js";
import { localTime } from "../../utils/local-time.js";
import { interceptLargeMessage } from "../message-interceptor.js";
import { loadSoulBundle, loadMinimalSoul } from "../soul-loader.js";
import { loadUsers } from "../user-registry.js";
import { abmind } from "../../utils/abmind-lazy.js";
import { getEnv } from "../env-schema.js";
import { readAndClearRestartReason } from "../transport/bridge-lock-transport.js";
import type { SessionRegistry } from "../session-registry.js";
import type { MemoryManager } from "abmind";
import type { ConversationBuffer } from "../conversation-buffer.js";
import type { InboundMessage } from "../../types/platform.js";
import type { UserRegistry } from "../user-registry.js";

const TAG = "pipeline";
const ACTIVE_MEMORY_LIMIT = 5;

export interface BuildPromptDeps {
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  sessions: SessionRegistry;
  sessionManager: import("../session-manager.js").SessionManager;
  conversationBuffer: ConversationBuffer;
  contextPercent: number;
  maxContext?: number;
  isAcp?: boolean;
}

export interface BuildPromptResult {
  prompt: string;
  isSessionStart: boolean;
  imageContent?: { mime: string; base64: string; path: string };
  recalledHits?: Array<{ id: number; contentEn: string }>;
}

export async function buildPrompt(
  msg: InboundMessage,
  text: string,
  deps: BuildPromptDeps,
  registry: UserRegistry,
): Promise<BuildPromptResult> {
  const { memory, sessions, conversationBuffer, contextPercent } = deps;
  const { channelId, isGroup } = msg;
  const userId = msg.userId;
  const sessionKey = deps.sessionManager.getActiveSessionId(userId, msg.platform);
  const bufKey = `${msg.platform}:${channelId}`;

  // --- Timestamp prefix ---
  let prompt = `[${localTime()}] ${text}`;
  let imageContent: { mime: string; base64: string; path: string } | undefined;
  if (msg.mediaPath) {
    if (deps.isAcp) {
      // ACP: agent reads files itself — just provide the path, no I/O
      prompt += `\nImage saved at: ${msg.mediaPath}`;
    } else {
      // DirectApi: encode for API
      const { readFileSync } = await import("node:fs");
      const ext = msg.mediaPath.split(".").pop()?.toLowerCase();
      const visionMimes: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
      const mime = ext ? visionMimes[ext] : undefined;
      if (mime) {
        try {
          const buf = readFileSync(msg.mediaPath);
          const b64 = buf.toString("base64");
          const maxCtxPct = parseInt(process.env["IMAGE_MAX_CONTEXT_PCT"] ?? "30", 10);
          const maxContext = deps.maxContext ?? 128000;
          const imgTokens = Math.ceil(b64.length / 4);
          if (imgTokens <= maxContext * (maxCtxPct / 100)) {
            imageContent = { mime, base64: b64, path: msg.mediaPath };
          } else {
            prompt += `\n⚠️ Image too large. Saved at: ${msg.mediaPath}`;
          }
        } catch {
          prompt += `\nFile saved at: ${msg.mediaPath}`;
        }
      } else {
        prompt += `\nFile saved at: ${msg.mediaPath}`;
      }
    }
  }

  // --- Group buffer drain ---
  if (isGroup) {
    const context = conversationBuffer.drain(bufKey);
    if (context) {
      prompt = context + text;
      logDebug(TAG, "Prepended group context to prompt");
    }
  }

  // --- Session-start injection ---
  const entry = sessions.getOrCreate(sessionKey);
  const isSessionStart = entry.pendingStart || !entry.seen;
  logTrace(TAG, `session-state: key=${sessionKey} seen=${entry.seen} pendingStart=${entry.pendingStart} isSessionStart=${isSessionStart}`);
  if (isSessionStart && memory) {
    prompt = buildSessionStartPrompt(prompt, memory, userId, sessionKey, deps.maxContext, msg.platform);
  }
  entry.seen = true;
  entry.pendingStart = false;

  // Record user message to memory
  const userRole = registry.byUserId.get(userId)?.role;
  logTrace(TAG, `recordMessage gate: memory=${!!memory} userId=${userId} userRole=${userRole}`);
  if (memory && userRole !== "guest") {
    const numericMsgId = typeof msg.messageId === "number" ? msg.messageId : undefined;
    memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), userId, sessionId: sessionKey, platformMessageId: numericMsgId });
  }

  // --- Active recall ---
  let recalledHits: Array<{ id: number; contentEn: string }> | undefined;
  if (getEnv().activeMemory && memory) {
    const userEntry = registry.byUserId.get(userId);
    if (userEntry?.role !== "guest" && (contextPercent < 0 || contextPercent < getEnv().ctxCompactPct)) {
      try {
        const t0 = performance.now();
        const priming = sessions.get(sessionKey)?.primingTerms ?? [];
        const now = new Date();
        const recall = await memory.recallSearch({
          translated: [...new Set([text, ...priming])],
          original: text,
          userId,
          limit: ACTIVE_MEMORY_LIMIT,
          maxClassification: userEntry?.maxClass ?? 0,
          stages: ["Sf", "Ss"],
          currentContext: { hour: now.getHours(), dayOfWeek: now.getDay() },
        });
        const TRIVIAL_TTL_MS = 36 * 60 * 60_000;
        const nowMs = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hits = recall.results.filter((h: any) => {
          if (h.score <= 0.70) return false;
          // Stale trivial fact: old + no signal + weak match → filter
          if (h.memoryType === "fact" && h.score < 1.0 && h.createdAt && nowMs - h.createdAt > TRIVIAL_TTL_MS) {
            if (!h.emotionTags && !h.importanceFlags) return false;
          }
          return true;
        });
        if (hits.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lines = hits.map((h: any) => abmind()!.renderMemory({
            content_en: h.content,
            topic: h.topic ?? undefined,
            emotion_tags: h.emotionTags ?? undefined,
            importance_flags: h.importanceFlags ?? undefined,
            memory_type: h.memoryType ?? undefined,
            confidence: h.confidence ?? undefined,
            createdAt: h.createdAt,
          }));
          const block = `[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]\n${lines.join("\n")}\n[/MEMORY CONTEXT]\n\n`;
          prompt = block + prompt;
          // #824: track recalled hits for citation detection
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          recalledHits = hits.filter((h: any) => h.id != null).map((h: any) => ({ id: h.id as number, contentEn: h.content as string }));
          logDebug(TAG, `Active recall: ${hits.length} hits, ${block.length} chars, ${Math.round(performance.now() - t0)}ms`);
          logTrace(TAG, `recall content: ${block}`);
        }
      } catch (err) {
        logDebug(TAG, `Active recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- Intercept oversized prompts (skip on session-start — those are expected to be large) ---
  if (!isSessionStart) {
    prompt = interceptLargeMessage(prompt).text;
  }

  // --- Injection scan for non-master ---
  if (userRole !== "master" && text.length > 10) {
    const scanFn = abmind()?.scanForInjection;
    if (scanFn) {
      const scan = scanFn(text);
      if (!scan.safe) {
        logInfo(TAG, `Injection blocked from ${userId}: ${scan.flags.map((f: { category: string }) => f.category).join(", ")}`);
      // Return a sentinel — caller checks and sends the block message
      return { prompt: "__INJECTION_BLOCKED__", isSessionStart, imageContent: undefined, recalledHits: undefined };
    }
    }
  }

  return { prompt, isSessionStart, imageContent, recalledHits };
}

/** Single path for session-start injection: SOUL + memory wake-up + context + user identity + restart reason. */
export function buildSessionStartPrompt(
  prompt: string,
  memory: MemoryManager,
  userId: string,
  sessionKey?: string,
  maxContext?: number,
  platform?: string,
): string {
  const contextParts: string[] = [];

  const reason = readAndClearRestartReason();
  if (reason) {
    contextParts.push(`[SESSION START REASON] ${reason}`);
    logInfo(TAG, `Injected restart reason: ${reason}`);
  }

  // Session identity (#624)
  let sessionType = "A"; // default Main
  if (sessionKey) {
    const parts = sessionKey.split("_");
    if (parts.length === 3) {
      sessionType = parts[1]!;
      const typeMap: Record<string, string> = { A: "Main", B: "Browse", C: "Code", T: "Task" };
      const type = typeMap[sessionType] ?? sessionType;
      const index = parseInt(parts[2]!, 10);
      contextParts.push(`[SESSION] #${index} (${type})`);
    }
  }

  const isCodeSession = sessionType === "C";

  // Soul bundle: full for Main, minimal for Code (#658)
  if (isCodeSession) {
    const minimal = loadMinimalSoul(memory);
    if (minimal) {
      contextParts.push(minimal);
      logInfo(TAG, `Injected minimal soul for Code session (${minimal.length} chars)`);
    }
  } else {
    const soul = loadSoulBundle(memory);
    if (soul) {
      contextParts.push(soul);
      logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
    } else {
      contextParts.push("[⚠️ SOUL BUNDLE MISSING] Your persona files failed to load. Alert the user immediately and request a /reset.");
      logWarn(TAG, "Soul bundle empty — injected missing-soul warning");
    }
  }

  if (sessionKey) {
    try {
      const registry = loadUsers();
      const user = registry.byUserId.get(userId);
      if (user) {
        const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
        const lang = user.languages?.length ? `\nTheir languages: ${user.languages.join(", ")}. Respond ONLY in these languages.` : "";
        const userBlock = `[CURRENT USER]\nYou are now talking to ${user.userId} (${user.role}, ${CLASS_NAMES[user.maxClass] ?? `class ${user.maxClass}`} clearance).${lang}`;
        contextParts.push(userBlock);
        logInfo(TAG, `Injected [CURRENT USER] for ${user.userId} (${user.role})`);
      } else {
        logInfo(TAG, `[CURRENT USER] skipped — userId "${userId}" not found in registry (${registry.byUserId.size} users loaded)`);
      }
    } catch (err) { logAndSwallow("prompt_builder", "op", err); }
  } else {
    logInfo(TAG, `[CURRENT USER] skipped — no sessionKey`);
  }

  // Platform capabilities (#834 → #646)
  if (platform) {
    const CAPS: Record<string, string> = { telegram: "voice, reactions, typing, TTS, groups", discord: "reactions, typing, threads", irc: "text only" };
    contextParts.push(`[SYSTEM] Platform: ${platform} (${CAPS[platform] ?? "unknown"})`);
  }

  // Runtime identity (#879) — prevent agent misidentifying itself
  const transportType = getEnv().defaultTransport === "acp" ? "ACP" : "Direct API";
  const runtimeLine = `[SYSTEM] Runtime: abtars bridge (${transportType}). All registered bridge tools are available.`;
  contextParts.push(runtimeLine);
  logInfo(TAG, `Injected runtime identity: ${transportType}`);

  const compSummary = null; // Legacy compaction removed — context engine handles summaries
  if (compSummary && sessionKey) {
    // Dead path — kept for type safety during transition
  } else {
    const ctxOpts = isCodeSession ? { skipDailies: true, maxAgeMs: 48 * 60 * 60 * 1000 } : (maxContext && maxContext >= 64000 ? { skipMessages: true } : undefined);
    const ctxResult = abmind()?.buildSessionStartContext(memory, userId, maxContext, ctxOpts);
    const ctx = ctxResult?.text ?? null;
    if (ctx) {
      contextParts.push(ctx);
      const s = ctxResult!.stats;
      const ctxPct = maxContext ? Math.round(ctx.length / maxContext * 100) : -1;
      logInfo(TAG, `Session start: ${s.messages} messages + ${s.dailies} dailies (${(s.usedBytes / 1024).toFixed(1)}KB / ${(s.budget / 1024).toFixed(0)}KB budget, ${ctxPct}% ctx${isCodeSession ? ", Code" : ""})`);
      logDebug(TAG, `Session context: ${s.messages} msgs, ${s.dailies} dailies, ${s.usedBytes}B / ${s.budget}B budget, ${ctxPct}% ctx`);
      logTrace(TAG, `session-start content: ${ctx.slice(0, 500)}...`);
    }

    try {
      const userRole = loadUsers().byUserId.get(userId)?.role ?? "master";
      if (userRole === "guest") {
        contextParts.push("Hi! How can I help?");
      } else if (userRole === "user") {
        contextParts.push("[SESSION START] Returning user. Be friendly and helpful.");
      } else if (!isCodeSession) {
        // Wake-up only for Main sessions
        const wakeUp = memory.buildWakeUp();
        if (wakeUp) {
          contextParts.push(wakeUp);
          logInfo(TAG, `Injected ABM wake-up (${wakeUp.length} chars)`);
          logTrace(TAG, `wake-up content: ${wakeUp}`);
        }

        // #646 — system status (skip for Code sessions)
        if (sessionKey && !sessionKey.includes("_C_")) {
          const status = abmind()!.buildStatusBlock(memory);
          if (status) contextParts.push(status);
        }
      }
    } catch (err) { logAndSwallow("prompt_builder", "op", err); }
  }

  const contextBlock = contextParts.length > 0
    ? `[CONTEXT — do not respond to this section]\n${contextParts.join("\n\n")}\n[/CONTEXT]\n\n`
    : "";

  const result = contextBlock + prompt;
  logTrace(TAG, `session-start assembled: ${contextParts.length} parts, context=${contextBlock.length} chars, prompt=${prompt.length} chars, total=${result.length} chars`);
  if (result.length < 5000) {
    logInfo(TAG, `Session-start prompt suspiciously small (${result.length} chars) — SOUL may be missing`);
  }
  if (maxContext && contextBlock.length > maxContext * 0.15) {
    logWarn(TAG, `⚠️ Session injection is ${Math.round(contextBlock.length / maxContext * 100)}% of context window — consider reducing SESSION_HISTORY_PCT`);
  }
  return result;
}
