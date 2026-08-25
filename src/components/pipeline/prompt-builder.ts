/**
 * prompt-builder.ts — Build the augmented prompt for a user message.
 * Handles: timestamp, media path, group context, session-start injection,
 * active recall, large-message interception, injection scan.
 */

import { logInfo, logDebug, logTrace } from "../logger.js";
import { localTime } from "../../utils/local-time.js";
import { interceptLargeMessage } from "../message-interceptor.js";
import { abmind } from "../../utils/abmind-lazy.js";
import { getEnv } from "../env-schema.js";
import type { AbtarsMemoryRuntime, MemoryWritePhase } from "../memory-runtime.js";
import { attemptMemoryMutation } from "../memory-runtime.js";
import { inboundExecutionKey, inboundMessageKey } from "../memory-operation-key.js";
import type { ConversationBuffer } from "../conversation-buffer.js";
import type { InboundMessage } from "../../types/platform.js";
import type { UserRegistry } from "../user-registry.js";
import { sessionTypeOf, type DurableContextIntent } from "../spin-types.js";

const TAG = "pipeline";
const ACTIVE_MEMORY_LIMIT = 5;

export interface BuildPromptDeps {
  memoryRuntime: AbtarsMemoryRuntime | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  sessionManager: import("../spin.js").Spin;
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
  /** #1529: explicit durable-context intent — never an ambiguous optional cursor. */
  durableContextIntent: DurableContextIntent;
  /** #1335: structured current turn components for Pi cache-stable assembly. */
  currentTurn?: {
    rawText: string;
    volatileContext: Array<{
      kind: "timestamp" | "recall" | "session_start" | "runtime" | "other";
      content: string;
    }>;
  };
}

/**
 * #1432: the effective session is passed in — never recomputed. For K
 * (memoryMode "skill-isolated") session assembly, active recall, general
 * conversation-buffer injection, and automatic general-memory writes are
 * skipped; timestamp, media, injection scanning, and busy queueing remain.
 */
export async function buildPrompt(
  msg: InboundMessage,
  text: string,
  deps: BuildPromptDeps,
  registry: UserRegistry,
  session?: import("../spin-types.js").ManagedSession,
): Promise<BuildPromptResult> {
  const { memoryRuntime, conversationBuffer, contextPercent } = deps;
  const { channelId, isGroup } = msg;
  const userId = msg.userId;
  const { spin } = await import("../spin.js");
  const pSession = session ?? spin.getSessionById(deps.sessionManager.getActiveSessionId(userId, msg.platform));
  const sessionKey = pSession?.id ?? deps.sessionManager.getActiveSessionId(userId, msg.platform);
  const bufKey = `${msg.platform}:${channelId}`;
  const isSkillIsolated = pSession
    && (await import("../spin-profiles.js")).profileFor(sessionTypeOf(pSession.id))?.memoryMode === "skill-isolated";
  const memoryMode = isSkillIsolated ? "skill-isolated" : "standard";

  // #1335: collect volatile context blocks separately from raw user text
  const volatileContext: Array<{ kind: "timestamp" | "recall" | "session_start" | "runtime" | "other"; content: string }> = [];

  // --- Timestamp prefix ---
  const tsPrefix = `[${localTime()}]`;
  let prompt = `${tsPrefix} ${text}`;
  volatileContext.push({ kind: "timestamp", content: tsPrefix });
  let imageContent: { mime: string; base64: string; path: string } | undefined;
  if (msg.mediaPath) {
    if (deps.isAcp) {
      // ACP: agent reads files itself — just provide the path, no I/O
      prompt += `\nImage saved at: ${msg.mediaPath}`;
    } else {
      // Pi API: encode for the embedded provider boundary
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

  // --- Group buffer drain (skipped for K — skill context is manager-owned) ---
  if (isGroup && memoryMode !== "skill-isolated") {
    const context = conversationBuffer.drain(bufKey);
    if (context) {
      volatileContext.push({ kind: "other", content: context });
      prompt = context + text;
      logDebug(TAG, "Prepended group context to prompt");
    }
  }

  // --- Session-start injection (skipped for K — no A SOUL/session assembly) ---
  const entry = pSession;
  const isSessionStart = !entry || entry.pendingStart || !entry.seen;
  logTrace(TAG, `session-state: key=${sessionKey} seen=${entry?.seen} pendingStart=${entry?.pendingStart} isSessionStart=${isSessionStart} memoryMode=${memoryMode}`);
  if (isSessionStart && memoryRuntime?.state === "ready" && memoryMode !== "skill-isolated") {
    try {
      const sessionCtx = await memoryRuntime.assembleSessionContext({
        identity: { principalId: userId, executionId: sessionKey },
        maxChars: deps.maxContext ? Math.floor(deps.maxContext * 0.15) : undefined,
      });
      const sessionParts = [sessionCtx.coreKnowledge, sessionCtx.recall, sessionCtx.wakeUp].filter(Boolean);
      if (sessionParts.length > 0) volatileContext.push({ kind: "session_start", content: sessionParts.join("\n\n") });
    } catch (err) {
      logDebug(TAG, `Session context unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Rebuild combined prompt with session context
    const sessionParts = volatileContext.map(v => v.content);
    prompt = `[CONTEXT — do not respond to this section]\n${sessionParts.join("\n\n")}\n[/CONTEXT]\n\n${tsPrefix} ${text}`;
  }
  if (entry) {
    entry.seen = true;
    entry.pendingStart = false;
  }

  // #1529: classify durable-context intent from configuration and message
  // policy, independently of the memory runtime's instantaneous readiness.
  // A required-but-unavailable intent must never degrade to ephemeral.
  const userRole = registry.byUserId.get(userId)?.role;
  logTrace(TAG, `recordMessage gate: memory=${memoryRuntime?.state === "ready"} userId=${userId} userRole=${userRole} memoryMode=${memoryMode}`);
  const durableRequired =
    deps.memoryConfig.memoryEnabled
    && memoryMode !== "skill-isolated"
    && userRole !== "guest"
    && !text.startsWith("[SESSION START]");
  let durableContextIntent: DurableContextIntent = { mode: "not_required" };
  if (durableRequired && memoryRuntime?.state !== "ready") {
    durableContextIntent = { mode: "required_unavailable", reason: "runtime_unavailable" };
  } else if (durableRequired) {
    // #1724: a trusted scheduled-announcement event carries its durable,
    // card-derived identity — delivery retries must deduplicate against the
    // same inbound row instead of recording a fresh turn per attempt.
    const trustedEventId = msg.internal?.kind === "scheduled_announcement" ? msg.internal.eventId : undefined;
    const messageIdStr = trustedEventId
      ?? (typeof msg.messageId === "number" || typeof msg.messageId === "string" ? String(msg.messageId) : "");
    const messageTimestamp = msg.timestamp;
    const operationKey = messageIdStr
      ? inboundMessageKey(msg.platform, msg.channelId, msg.threadId, userId, messageIdStr)
      : inboundExecutionKey(msg.platform, msg.channelId, msg.threadId, userId, `${sessionKey}:${messageTimestamp}`);
    const phase: MemoryWritePhase = "before_model";
    const result = await attemptMemoryMutation({
      phase,
      family: "inbound",
      operationKey,
      run: () => memoryRuntime!.recordMessage(
        { role: "user", content: text, timestamp: messageTimestamp, userId, sessionId: sessionKey, platformMessageId: typeof msg.messageId === "number" || typeof msg.messageId === "string" ? msg.messageId : undefined },
        operationKey,
      ),
    });
    if (result.ok) {
      const r = result as { ok: true; value: { id: number | null } };
      const id = r.value.id;
      durableContextIntent = typeof id === "number"
        ? { mode: "durable", beforeMessageId: id }
        : { mode: "required_unavailable", reason: "cursor_missing" };
    } else {
      durableContextIntent = { mode: "required_unavailable", reason: "record_failed" };
    }
  }

  // --- Active recall (skipped for K — skill-isolated memory boundary) ---
  let recalledHits: Array<{ id: number; contentEn: string }> | undefined;
  if (memoryMode !== "skill-isolated" && getEnv().activeMemory && memoryRuntime?.state === "ready") {
    const userEntry = registry.byUserId.get(userId);
    if (userEntry?.role !== "guest" && (contextPercent < 0 || contextPercent < getEnv().ctxCompactPct)) {
      try {
        const t0 = performance.now();
        const priming = pSession?.primingTerms ?? [];
        const recall = await memoryRuntime.recall({ query: [...new Set([text, ...priming])].join(" "), userId, limit: ACTIVE_MEMORY_LIMIT });
        const TRIVIAL_TTL_MS = 36 * 60 * 60_000;
        const nowMs = Date.now();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hits = recall.hits.filter((h: any) => {
          if (h.score <= 0.70) return false;
          if (h.memoryType === "fact" && h.score < 1.0 && h.createdAt && nowMs - h.createdAt > TRIVIAL_TTL_MS) {
            if (!h.emotionTags && !h.importanceFlags) return false;
          }
          return true;
        });
        if (hits.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lines = hits.map((h: any) => abmind()?.renderMemory({
            content_en: h.content,
          }) ?? h.content);
          const block = `[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]\n${lines.join("\n")}\n[/MEMORY CONTEXT]`;
          volatileContext.push({ kind: "recall", content: block });
          prompt = `${block}\n\n${prompt}`;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          recalledHits = hits.filter((h: any) => h.memoryId != null).map((h: any) => ({ id: h.memoryId as number, contentEn: h.content as string }));
          logDebug(TAG, `Active recall: ${hits.length} hits, ${block.length} chars, ${Math.round(performance.now() - t0)}ms`);
          logTrace(TAG, `recall content: ${block}`);
        }
      } catch (err) {
        logDebug(TAG, `Active recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- Intercept oversized prompts (skip on session-start) ---
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
      return { prompt: "__INJECTION_BLOCKED__", isSessionStart, imageContent: undefined, recalledHits: undefined, durableContextIntent };
    }
    }
  }

  // #1335: structured current turn for Direct API cache-stable assembly
  const currentTurn: BuildPromptResult["currentTurn"] = {
    rawText: text,
    volatileContext,
  };

  return { prompt, isSessionStart, imageContent, recalledHits, durableContextIntent, currentTurn };
}
