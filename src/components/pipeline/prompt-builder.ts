/**
 * prompt-builder.ts — Build the augmented prompt for a user message.
 * Handles: timestamp, media path, group context, session-start injection,
 * active recall, large-message interception, injection scan.
 */

import { logInfo, logDebug } from "../logger.js";
import { localTime } from "../../utils/local-time.js";
import { interceptLargeMessage } from "../message-interceptor.js";
import { loadSoulBundle } from "../soul-loader.js";
import { loadUsers } from "../user-registry.js";
import { renderMemory } from "abmind";
import { buildSessionStartContext } from "abmind/session-context.js";
import { getEnv } from "../env-schema.js";
import { readAndClearRestartReason } from "../transport/bridge-lock-transport.js";
import type { SessionRegistry } from "../session-registry.js";
import type { MemoryManager } from "abmind/memory-manager.js";
import type { ConversationBuffer } from "../conversation-buffer.js";
import type { InboundMessage } from "../../types/platform.js";
import type { UserRegistry } from "../user-registry.js";

const TAG = "pipeline";
const ACTIVE_MEMORY_LIMIT = 5;

export interface BuildPromptDeps {
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  sessions: SessionRegistry;
  conversationBuffer: ConversationBuffer;
  contextPercent: number;
}

export interface BuildPromptResult {
  prompt: string;
  isSessionStart: boolean;
}

export async function buildPrompt(
  msg: InboundMessage,
  text: string,
  deps: BuildPromptDeps,
  registry: UserRegistry,
): Promise<BuildPromptResult> {
  const { memory, sessions, conversationBuffer, contextPercent } = deps;
  const { sessionKey, channelId, isGroup } = msg;
  const userId = sessionKey.includes(":") ? sessionKey.split(":")[0]! : "master";
  const bufKey = `${msg.platform}:${channelId}`;

  // --- Timestamp prefix ---
  let prompt = `[${localTime()}] ${text}`;
  if (msg.mediaPath) {
    prompt += `\nFile saved at: ${msg.mediaPath}`;
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
  if (isSessionStart && memory) {
    prompt = buildSessionStartPrompt(prompt, memory, userId, sessionKey);
  }
  entry.seen = true;
  entry.pendingStart = false;

  // Record user message to memory
  const userRole = registry.byUserId.get(userId)?.role;
  if (memory && userRole !== "guest") {
    memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), userId, sessionId: sessionKey, platformMessageId: msg.messageId });
  }

  // --- Active recall ---
  if (getEnv().activeMemory && memory && !isSessionStart) {
    const userEntry = registry.byUserId.get(userId);
    if (userEntry?.role !== "guest" && (contextPercent < 0 || contextPercent < getEnv().ctxCompactPct)) {
      try {
        const t0 = performance.now();
        const priming = sessions.get(sessionKey)?.primingTerms ?? [];
        const recall = await memory.recallSearch({
          translated: [...new Set([text, ...priming])],
          original: text,
          userId,
          limit: ACTIVE_MEMORY_LIMIT,
          maxClassification: userEntry?.maxClass ?? 0,
          stages: ["Sf", "S1"],
        });
        const hits = recall.results.filter(h => h.score > 0);
        if (hits.length > 0) {
          const lines = hits.map(h => renderMemory({
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
          logDebug(TAG, `Active recall: ${hits.length} hits, ${block.length} chars, ${Math.round(performance.now() - t0)}ms`);
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
    const { scanForInjection } = await import("abmind/injection-scanner.js");
    const scan = scanForInjection(text);
    if (!scan.safe) {
      logInfo(TAG, `Injection blocked from ${userId}: ${scan.flags.map(f => f.category).join(", ")}`);
      // Return a sentinel — caller checks and sends the block message
      return { prompt: "__INJECTION_BLOCKED__", isSessionStart };
    }
  }

  return { prompt, isSessionStart };
}

/** Single path for session-start injection: SOUL + memory wake-up + context + user identity + restart reason. */
export function buildSessionStartPrompt(
  prompt: string,
  memory: MemoryManager,
  userId: string,
  sessionKey?: string,
): string {
  const contextParts: string[] = [];

  const reason = readAndClearRestartReason();
  if (reason) {
    contextParts.push(`[SESSION START REASON] ${reason}`);
    logInfo(TAG, `Injected restart reason: ${reason}`);
  }

  const soul = loadSoulBundle(memory);
  if (soul) {
    contextParts.push(soul);
    logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
  }

  if (sessionKey) {
    try {
      const registry = loadUsers();
      const user = registry.byUserId.get(userId);
      if (user) {
        const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
        contextParts.push(`[CURRENT USER]\nYou are now talking to ${user.userId} (${user.role}, ${CLASS_NAMES[user.maxClass] ?? `class ${user.maxClass}`} clearance).`);
      }
    } catch { /* registry not available */ }
  }

  const compSummary = null; // Legacy compaction removed — context engine handles summaries
  if (compSummary && sessionKey) {
    // Dead path — kept for type safety during transition
  } else {
    const ctx = buildSessionStartContext(memory, userId);
    if (ctx) {
      contextParts.push(ctx);
      logInfo(TAG, `Injected session-start context (${ctx.length} chars)`);
    }

    try {
      const userRole = loadUsers().byUserId.get(userId)?.role ?? "master";
      if (userRole === "guest") {
        contextParts.push("Hi! How can I help?");
      } else if (userRole === "user") {
        contextParts.push("[SESSION START] Returning user. Be friendly and helpful.");
      } else {
        const wakeUp = memory.buildWakeUp();
        if (wakeUp) {
          contextParts.push(wakeUp);
          logInfo(TAG, `Injected ABM wake-up (${wakeUp.length} chars)`);
        }
      }
    } catch { /* wake-up builder not available */ }
  }

  const contextBlock = contextParts.length > 0
    ? `[CONTEXT — do not respond to this section]\n${contextParts.join("\n\n")}\n[/CONTEXT]\n\n`
    : "";

  const result = contextBlock + prompt;
  if (result.length < 5000) {
    logInfo(TAG, `Session-start prompt suspiciously small (${result.length} chars) — SOUL may be missing`);
  }
  return result;
}
