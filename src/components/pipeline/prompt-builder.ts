/**
 * prompt-builder.ts — Build the augmented prompt for a user message.
 * Handles: timestamp, media path, group context, session-start injection,
 * active recall, large-message interception, injection scan.
 */

import { logInfo, logDebug, logTrace, logWarn } from "../logger.js";
import { estimateTokensFromChars } from "../transport/token-budget.js";
import { localTime } from "../../utils/local-time.js";
import { interceptLargeMessage } from "../message-interceptor.js";
import { abmind } from "../../utils/abmind-lazy.js";
import { getEnv } from "../env-schema.js";
import type { AbtarsMemoryRuntime, MemoryWritePhase } from "../memory-runtime.js";
import { attemptMemoryMutation, asSessionSoulBundle } from "../memory-runtime.js";
import { inboundExecutionKey, inboundMessageKey } from "../memory-operation-key.js";
import type { ConversationBuffer } from "../conversation-buffer.js";
import { isTrustedScheduledAnnouncement, type InboundMessage } from "../../types/platform.js";
import type { UserRegistry } from "../user-registry.js";
import { sessionTypeOf } from "../spin-types.js";


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
  /** #1940: the turn runs on the Pi AgentSession route (role SOUL lives in
   *  the Pi session system prompt, never in turn text). */
  piRoute?: boolean;
  /** #1940: the Pi route already holds a live Pi session for this key. A
   *  missing one is a session start: its first message carries hydration. */
  piSessionLive?: boolean;
}

export interface BuildPromptResult {
  prompt: string;
  isSessionStart: boolean;
  imageContent?: { mime: string; base64: string; path: string };
  recalledHits?: Array<{ ref: string; contentEn: string }>;
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
          const imgTokens = estimateTokensFromChars(b64.length);
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
  const isSessionStart = !entry || entry.pendingStart || !entry.seen
    || (deps.piRoute === true && deps.piSessionLive === false);
  logDebug(TAG, `session-state: key=${sessionKey} seen=${entry?.seen} pendingStart=${entry?.pendingStart} isSessionStart=${isSessionStart} memoryMode=${memoryMode}`);
  // #1940: on the Pi route the role SOUL bundle is the Pi session system
  // prompt (captured once at session creation, surviving Pi compaction), so
  // turn text never repeats it. Other routes keep the session-start bundle.
  const omitSoulForPiRoute = deps.piRoute === true;
  if (isSessionStart && memoryRuntime?.state === "ready" && memoryMode !== "skill-isolated") {
    try {
      const sessionCtx = await memoryRuntime.assembleSessionContext({
        identity: { principalId: userId, executionId: sessionKey },
        modelContextTokens: deps.maxContext,
      });
      // #1869 — split by mutability: session-start owns profile/notes/
      // coreFacts via the addressable parts map (fresh read every session),
      // while SOUL.md + memory-tools.md stay in the boot system prompt.
      // Older daemons omit parts: fall back to the legacy joined field, which
      // still yields a working full bundle.
      const parts = asSessionSoulBundle(sessionCtx.parts);
      // #1940: on the Pi route the SOUL core blocks live in the session
      // system prompt — session-start carries only hydration (recall +
      // wake-up). The ACP route keeps the full bundle.
      const coreBlocks = omitSoulForPiRoute
        ? []
        : (parts !== undefined
          ? [parts.profile, parts.notes, parts.coreFacts]
          : [sessionCtx.coreKnowledge]);
      const sessionParts = [...coreBlocks, sessionCtx.recall, sessionCtx.wakeUp].filter(Boolean);
      if (sessionParts.length > 0) volatileContext.push({ kind: "session_start", content: sessionParts.join("\n\n") });
      logDebug(TAG, `session-assembly: key=${sessionKey} outcome=${sessionParts.length > 0 ? "ok" : "empty"} parts=${parts !== undefined ? "parts" : "legacy"} coreChars=${parts !== undefined ? coreBlocks.join("").length : sessionCtx.coreKnowledge.length} recallChars=${sessionCtx.recall.length} wakeChars=${sessionCtx.wakeUp.length}`);
    } catch (err) {
      logDebug(TAG, `session-assembly: key=${sessionKey} outcome=failed`);
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

  // #1940 R1: memory is decided at abtars start. The inbound archive write is
  // attempted when memory applies to this turn; a failure is reported and
  // logged, never turned into a turn rejection or a retry subsystem.
  const userRole = registry.byUserId.get(userId)?.role;
  logTrace(TAG, `recordMessage gate: memory=${memoryRuntime?.state === "ready"} userId=${userId} userRole=${userRole} memoryMode=${memoryMode}`);
  const recordInbound =
    deps.memoryConfig.memoryEnabled
    && memoryRuntime?.state === "ready"
    && memoryMode !== "skill-isolated"
    && userRole !== "guest"
    && !text.startsWith("[SESSION START]");
  if (recordInbound) {
    // #1724: a trusted scheduled-announcement event carries its durable,
    // card-derived identity — delivery retries must deduplicate against the
    // same inbound row instead of recording a fresh turn per attempt.
    // #1873: that row records the historical form from trusted metadata; the
    // live text (one-time announcement instruction) is never persisted.
    const trustedAnnouncement = isTrustedScheduledAnnouncement(msg.internal) ? msg.internal : undefined;
    const messageIdStr = trustedAnnouncement?.eventId
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
        { role: "user", content: trustedAnnouncement?.savedText ?? text, timestamp: messageTimestamp, userId, sessionId: sessionKey, platformMessageId: typeof msg.messageId === "number" || typeof msg.messageId === "string" ? msg.messageId : undefined },
        operationKey,
      ),
    });
    if (!result.ok) logWarn(TAG, `Inbound archive write failed for ${sessionKey} — not recorded`);
  }

  // --- Active recall (skipped for K — skill-isolated memory boundary) ---
  let recalledHits: Array<{ ref: string; contentEn: string }> | undefined;
  if (memoryMode !== "skill-isolated" && getEnv().activeMemory && memoryRuntime?.state === "ready") {
    const userEntry = registry.byUserId.get(userId);
    if (userEntry?.role !== "guest" && (contextPercent < 0 || contextPercent < getEnv().ctxCompactPct)) {
      try {
        // #1928 M4 — the verbatim turn rides as the fast raw turn with host
        // capacity; the owner packet is injected verbatim. No floors,
        // numeric-ref selection, or local rendering: citations name the
        // owner ref keys carried on each hit.
        const t0 = performance.now();
        const recall = await memoryRuntime.recall({
          query: text,
          profile: "recall_fast",
          rawTurn: text,
          userId,
          limit: ACTIVE_MEMORY_LIMIT,
        });
        if (recall.hits.length > 0) {
          const block = `[MEMORY CONTEXT — auto-recalled, do not repeat verbatim]\n${recall.context}\n(Reference keys are shown as [n] (ref); if your answer relies on them, end your reply with [SUPPORT: ref, ...] listing only those refs.)\n[/MEMORY CONTEXT]`;
          volatileContext.push({ kind: "recall", content: block });
          prompt = `${block}\n\n${prompt}`;
          recalledHits = recall.hits.map((h) => ({ ref: h.ref, contentEn: h.content }));
          logDebug(TAG, `Active recall: ${recall.hits.length} hits injected, status=${recall.status}, ${block.length} chars, ${Math.round(performance.now() - t0)}ms`);
          logTrace(TAG, `recall content: ${block}`);
        }
        logDebug(TAG, `Active recall outcome: status=${recall.status} omissions=${(recall.omissionReasons ?? []).join("; ") || "none"}`);
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
      return { prompt: "__INJECTION_BLOCKED__", isSessionStart, imageContent: undefined, recalledHits: undefined };
    }
    }
  }

  // #1335: structured current turn for Direct API cache-stable assembly
  const currentTurn: BuildPromptResult["currentTurn"] = {
    rawText: text,
    volatileContext,
  };

  return { prompt, isSessionStart, imageContent, recalledHits, currentTurn };
}
