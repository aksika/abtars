/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { cleanResponse } from "./clean-response.js";
import { loadUsers } from "./user-registry.js";
import { ModelNotFoundError } from "./transport/acp-transport.js";
import type { SttConfig } from "./stt.js";
import { synthesizeSpeech, type TtsConfig } from "./tts.js";

/** Retry a send operation on transient network errors (fetch failed, timeout, 5xx). */
async function retrySend<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = msg.includes("fetch failed") || msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || /^5\d\d/.test(msg);
      if (!transient || i === attempts - 1) throw err;
      const delay = 1000 * Math.pow(3, i);
      logWarn("pipeline", `Delivery failed (attempt ${i + 1}/${attempts}), retrying in ${delay}ms: ${msg}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";
import type { IdleSave } from "./idle-save.js";
import type { ConversationBuffer } from "./conversation-buffer.js";
import type { RunningJob } from "./tasks/task-queue.js";
import type { InboundMessage, PlatformAdapter, DeliveryCorrelation } from "../types/platform.js";
import { updateBridgeLockField } from "./transport/bridge-lock-transport.js";
import { createMessageContext, runPipeline, voiceMiddleware, sessionSelectionMiddleware, commandMiddleware, pausedGuardMiddleware, busyGuardMiddleware } from "./pipeline/index.js";
import { releaseBusy } from "./pipeline/busy-guard.js";
import { hasHooks, fire as fireHook } from "./hooks/hook-system.js";
import { buildPrompt } from "./pipeline/prompt-builder.js";

import { getEnv } from "./env-schema.js";
import { sanitizeOutbound } from "./sanitize-outbound.js";
import { abmind } from "../utils/abmind-lazy.js";
import type { ResolvedHailMary } from "./transport-config.js";

const TAG = "pipeline";
const PRIMING_MAX = 8;

// #824: Track which recalled memory IDs were active per agent message (for emoji feedback)
// Map<platform_message_id, recalled_memory_ids[]> with 1h TTL
const recalledIdsPerMessage = new Map<number, number[]>();
const RECALL_MAP_TTL = 60 * 60_000;
setInterval(() => { /* prune entries older than TTL — best-effort, no timestamp tracking needed for small maps */ if (recalledIdsPerMessage.size > 200) recalledIdsPerMessage.clear(); }, RECALL_MAP_TTL);

/** Look up recalled memory IDs for a given platform message (for reaction-based feedback). */
export function getRecalledIdsForMessage(platformMsgId: number): number[] | undefined {
  return recalledIdsPerMessage.get(platformMsgId);
}

const STOPWORDS = new Set(["the","a","an","is","are","was","were","be","been",
  "have","has","had","do","does","did","will","would","could","should","can",
  "may","might","shall","it","its","this","that","what","how","when","where",
  "who","which","why","about","for","with","from","into","just","also","very",
  "not","but","and","or","if","so","too","let","lets","dont","you","we",
  "my","your","our","me","us","them","they","he","she"]);

function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOPWORDS.has(w))
    .slice(0, 3);
}
/** Reset by bridge-app on inbound message to re-enable floating compaction. */
export let resetIdleCompactFlag: (() => void) | null = null;
export function setIdleCompactReset(fn: () => void): void { resetIdleCompactFlag = fn; }

/** Shared session reset: reset transport, clear buffer, mark pendingStart. */
export async function resetAndPrepare(opts: {
  transport: IKiroTransport;
  sessionKey: string;
  reason: string;
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}): Promise<void> {
  await opts.transport.resetSession(opts.sessionKey);
  if (opts.conversationBuffer && opts.bufKey) opts.conversationBuffer.clear(opts.bufKey);
  const { spin } = await import("./spin.js");
  const pSession = spin.getSessionById(opts.sessionKey);
  if (pSession) {
    pSession.seen = false;
    pSession.pendingStart = true;
    pSession.busy = false;
    pSession.queue = [];
  }
}

/** Transport + agent runtime deps. */
export interface TransportDeps {
  transport: IKiroTransport;
  config: { workingDir: string };
  startedAt: number;
  maxContext?: number;
}

/** Memory system deps. */
export interface MemoryDeps {
  memoryRuntime: AbtarsMemoryRuntime;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  conversationBuffer: ConversationBuffer;
  idleSave: IdleSave;
  nlmConfig: { enabled: boolean; [k: string]: unknown };
  updateCtxStart: (memoryDir: string, userId: string) => void;
}

/** Voice processing deps. */
export interface VoiceDeps {
  sttConfig: SttConfig | null;
  ttsConfig: TtsConfig | null;
}

/** Pipeline dependencies — composed from focused interfaces. */
export interface PipelineDeps extends TransportDeps, MemoryDeps, VoiceDeps {
  sessionManager: import("./spin.js").Spin;
  cronCurrentJob?: () => RunningJob | null;
  enqueueCron?: (entryId: string, manual?: boolean) => string | null;
  requestShutdown?: (code?: number) => void;
  sleepProgress?: () => { percent: number; step: string } | null;
  /** Admit a manual sleep run directly (/sleep now | /sleep resume). #1321. */
  startSleep?: (opts: { fresh: boolean; resume: boolean }) => import("../capabilities/sleep/index.js").SleepStartResult;
  loadedCapabilities?: string[];
  selfHealerTask?: { enabled: boolean } | null;
  hailMary?: (ResolvedHailMary & { apiKey?: string }) | null;
  /** Rebuild professor transport in place (used by /reset to pick up provider changes). */
  rebuildTransport?: () => Promise<void>;
  /** Boot-time phase health (#331). */
  phaseHealth?: Map<string, { status: "ok" | "failed" | "skipped"; error?: string }>;
  /** Service registry for live state (#331). */
  registry?: { getStates(): Record<string, import("./service-registry.js").ServiceState> };
  /** bridge.lock path for heartbeat liveness check. */
  bridgeLockPath?: string;
}

/**
 * Process an inbound message through the full pipeline.
 * The adapter has already handled platform-specific pre-processing
 * (voice transcription, mention stripping, group filtering, security).
 */
export async function handleInboundMessage(
  msg: InboundMessage,
  adapter: PlatformAdapter,
  deps: PipelineDeps,
): Promise<void> {
  // Run early middleware (voice → select → commands → paused → busy guard)
  const ctx = createMessageContext(msg, adapter, deps);
  await runPipeline(ctx, [voiceMiddleware, sessionSelectionMiddleware, commandMiddleware, pausedGuardMiddleware, busyGuardMiddleware]);
  if (ctx.handled) return;

  // --- BeforeMessage hook ---
  if (hasHooks("BeforeMessage")) {
    const result = await fireHook("BeforeMessage", {
      event: "BeforeMessage", timestamp: new Date().toISOString(),
      sessionKey: ctx.sessionId ?? "", platform: msg.platform, userId: msg.userId,
      chatId: String(ctx.chatId), text: ctx.text,
    });
    if (result?.decision === "block") {
      logInfo(TAG, `BeforeMessage hook blocked: ${result.reason ?? "no reason"}`);
      return;
    }
  }

  // --- #1336: Ensure transport for the already-selected effective session ---
  const effectiveSessionId = ctx.sessionId!;
  const effectiveSession = ctx.session!;
  const { spin } = await import("./spin.js");
  if (!effectiveSession.transport) {
    try {
      await spin.ensureSessionTransport(effectiveSession);
    } catch (err) {
      logWarn(TAG, `ensureSessionTransport failed for ${effectiveSessionId}: ${err instanceof Error ? err.message : String(err)}`);
      await adapter.sendMessage(msg.channelId, `⚠️ ${err instanceof Error ? err.message : String(err)}`, { threadId: msg.threadId }).catch(() => {});
      return;
    }
  }
  ctx.transport = effectiveSession.transport!;
  ctx.delivery = effectiveSession.delivery;

  // Mark seen so isSessionStart doesn't inject full soul bundle
  effectiveSession.seen = true;
  effectiveSession.lastActiveAt = Date.now();

  // --- Core transport/response handling ---
  const {
    memoryConfig,
    idleSave, conversationBuffer,
    ttsConfig,
  } = deps;
  const transport = ctx.transport;

  const { channelId, isVoice } = msg;
  const chatId = ctx.chatId;
  const text = ctx.text;

  const registry = loadUsers();
  const userId = msg.userId;

  const activeSessionId = effectiveSessionId;
  const pSession = effectiveSession;
  const busyEntry = pSession;
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let typingTtlTimer: ReturnType<typeof setTimeout> | undefined;
  let toolElapsedTimer: ReturnType<typeof setInterval> | undefined;
  let streamMsgId: number | string | undefined; // tool indicator message (editable)
  try {
    busyEntry.busy = true;
    resetIdleCompactFlag?.(); // re-enable floating compaction on next idle
    const ctxPct = transport.contextPercent;
    logInfo(TAG, `← [${msg.platform}] ${isVoice ? "🎤 " : ""}"${text.slice(0, 60)}"${ctxPct >= 0 ? ` (ctx: ${ctxPct}%)` : ""}`);
    // --- Sleep: main transport is available during sleep (sleep uses its own) ---
    // No queueing needed

    // --- Build prompt ---
    // #1329: currentMessageId is the just-persisted raw user row ID (or
    // undefined on a no-write path). We forward it to spin as part of
    // the spec, and the chokepoint at spin.ts#sendPrompt carries it
    // through to the transport.sendPrompt as `beforeMessageId`.
    const { prompt: builtPrompt, imageContent, recalledHits, currentMessageId, currentTurn } = await buildPrompt(msg, text, {
      memoryRuntime: deps.memoryRuntime, memoryConfig, sessionManager: deps.sessionManager, conversationBuffer, contextPercent: ctxPct, maxContext: deps.maxContext,
      isAcp: transport.getRuntimeStatus?.().route === "acp",
    }, registry);

    if (builtPrompt === "__INJECTION_BLOCKED__") {
      await adapter.sendMessage(channelId, "⛔ Message blocked — suspicious content detected.", { threadId: msg.threadId });
      return;
    }

    let prompt = builtPrompt;

    // --- Auto-notify: inject background session completions (#570) ---
    const { drainCompletions } = await import("./completion-buffer.js");
    const completions = drainCompletions(activeSessionId);
    if (completions.length > 0) {
      const notes = completions.map(c => {
        const cost = c.inputTokens + c.outputTokens > 0 ? ` [${((c.inputTokens + c.outputTokens) / 1000).toFixed(1)}k tokens]` : "";
        return `[SYSTEM] Background session ${c.sessionId} ${c.status}\nGoal: ${c.goal}\nResult: ${c.result}${cost}`;
      }).join("\n\n");
      prompt = `${notes}\n\n---\n\n${prompt}`;
    }

    // --- Auto-notify: inject task failures (#646) ---
    const { drainTaskFailures } = await import("./tasks/task-failure-buffer.js");
    const failures = drainTaskFailures();
    if (failures.length > 0) {
      const lines = failures.map(f => `[SYSTEM] Task "${f.taskName}" failed (exit ${f.exitCode}${f.error ? `: ${f.error}` : ""}). ${f.consecutiveFailures > 1 ? `${f.consecutiveFailures} consecutive failures.` : ""}`);
      prompt = `${lines.join("\n")}\n\n${prompt}`;
    }

    // --- Auto-notify: inject buffered system events (#844) ---
    const { drainSystemEvents } = await import("./system-event-buffer.js");
    const events = drainSystemEvents();
    if (events.length > 0) {
      prompt = `${events.map(e => `[SYSTEM] ${e}`).join("\n")}\n\n${prompt}`;
    }

    // --- Send to transport ---
    const { sessionType } = await import("./spin-types.js");
    const sessionTransport = effectiveSession.transport ?? transport;
    logDebug(TAG, `Route: session=${activeSessionId} type=${sessionType(effectiveSession)} transport=${effectiveSession.transport ? "session" : "main"}`);

    // #681: attach sandbox policy (owner for now — peer/guest in #678)
    if ("sandboxPolicy" in sessionTransport) {
      const { buildPolicy } = await import("./tool-sandbox.js");
      (sessionTransport as any).sandboxPolicy = buildPolicy("owner");
    }
    // Wire cooperative pause check (#539) — agent loop checks this between tool calls
    if ("isPaused" in sessionTransport) {
      (sessionTransport as any).isPaused = () => effectiveSession.status === "paused";
    }

    // #1271: pipeline main turn goes through spin(spec) (model-call chokepoint).
    // Streaming/tool callbacks remain pipeline-owned (set on the transport before,
    // reset in the finally below). spin() sends via the session's own transport.
    const directContextTurn = currentTurn
      ? { rawUserText: currentTurn.rawText, volatileBlocks: currentTurn.volatileContext }
      : undefined;
    const responsePromise = deps.sessionManager.spin({
      type: sessionType(effectiveSession),
      sessionId: activeSessionId,
      prompt,
      imageContent,
      userId,
      currentMessageId,
      directContextTurn,
      await: true,
    }).then(r => r.result ?? "");
    // #1292: the model call is started early to overlap with the setReaction/sendTyping
    // round-trips below, but is not awaited until later in this try block. Without this
    // guard, a fast provider-down rejection (403 / all models exhausted) floats as an
    // unhandled rejection during those awaits and crashes the bridge. Marking the promise
    // handled here: the real rejection still propagates when `await responsePromise` runs
    // and is caught by this try/catch, which renders the graceful error to the user.
    void responsePromise.catch(() => {});

    // --- Typing + reaction ---
    if (!isVoice && adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "👀");
    }
    if (adapter.sendTyping) {
      await adapter.sendTyping(channelId, msg.threadId);
      typingInterval = setInterval(() => {
        adapter.sendTyping!(channelId, msg.threadId).catch(err => logAndSwallow(TAG, "adapter call", err));
      }, 8000);
    }

    // --- Typing TTL ---
    const TYPING_TTL_MS = getEnv().typingTtlMs;

    typingTtlTimer = setTimeout(() => {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = undefined; }
    }, TYPING_TTL_MS);

    // Per-tool-call progress — show tool name + elapsed time
    let lastToolNotifyAt = 0;
    let toolBatch: string[] = [];
    let toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
    let currentToolName = "";
    let toolStartAt = 0;
    let toolCallCount = 0;
    let totalToolStartAt = 0;

    transport.onToolCallStart = (toolName: string) => {
      toolCallCount++;
      if (!totalToolStartAt) totalToolStartAt = Date.now();
      currentToolName = toolName;
      toolStartAt = Date.now();
      effectiveSession.lastActiveAt = Date.now(); // #1198: keep session alive during tool execution
      adapter.sendTyping?.(channelId, msg.threadId).catch(err => logAndSwallow(TAG, "adapter call", err));

      // Clear previous elapsed timer
      if (toolElapsedTimer) { clearInterval(toolElapsedTimer); toolElapsedTimer = undefined; }

      // Batch tool names within 500ms, emit once
      toolBatch.push(toolName);
      if (!toolBatchTimer) {
        toolBatchTimer = setTimeout(async () => {
          const now = Date.now();
          if (now - lastToolNotifyAt >= 10000) {
            const names = toolBatch.join(", ");
            const status = `🔧 ${names}...`;
            if (streamMsgId && adapter.editMessage) {
              adapter.editMessage(channelId, streamMsgId, status + "...").catch(err => logAndSwallow(TAG, "adapter call", err));
            } else {
              const id = await adapter.sendMessage(channelId, status, { threadId: msg.threadId }).catch(err => { logAndSwallow(TAG, "sendMessage tool status", err); return undefined; });
              if (id && adapter.editMessage) streamMsgId = id;
            }
            lastToolNotifyAt = now;
          }
          toolBatch = [];
          toolBatchTimer = undefined;
        }, 500);
      }

      // Start elapsed timer — update every 10s during long tool execution
      toolElapsedTimer = setInterval(() => {
        const elapsed = Math.round((Date.now() - toolStartAt) / 1000);
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`;
        const status = `🔧 ${currentToolName} (${elapsedStr})...`;
        if (streamMsgId && adapter.editMessage) {
          adapter.editMessage(channelId, streamMsgId, status + "...").catch(err => logAndSwallow(TAG, "adapter call", err));
        }
      }, 10_000);
    };

    // --- Fallback notification inline ---
    if ("onFallback" in transport) {
      const prev = (transport as any).onFallback;
      (transport as any).onFallback = (model: string, _ctxPct: number, reason?: string) => {
        prev?.(model, _ctxPct, reason);
      };
    }

    // --- Segment break: deliver pre-tool text immediately ---
    let fullResponseSegments: string[] = [];
    transport.onSegmentBreak = (text: string) => {
      const clean = sanitizeOutbound(text);
      if (!clean) return;
      fullResponseSegments.push(clean);
      if (streamMsgId && adapter.editMessage) {
        adapter.editMessage(channelId, streamMsgId, clean).catch(err => logAndSwallow(TAG, "adapter call", err));
      } else {
        adapter.sendMessage(channelId, clean, { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
      }
      streamMsgId = undefined;
    };

    // --- Tool/segment state (used by tool indicators + segment breaks above) ---
    // No edit-in-place streaming timer. Final response delivered as chunks after completion (#583).

    const response = await responsePromise;

    clearTimeout(toolBatchTimer);
    transport.onIntermediateResponse = undefined;
    logDebug(TAG, `Response (${response.length} chars): "${response.trim().slice(0, 120)}"`);

    // --- Extract clean answer ---
    const cleanAnswer = transport.answerOnly;
    const rawResponse = pSession.fullMode ? response : (cleanAnswer || response);
    const { text: cleanedText, reactionEmoji, noReply, topics } = cleanResponse(rawResponse);
    let userResponse = cleanedText;

    // #1397: Capture stable execution ID before async cleanup may clear it.
    const deliveryCorrelation: DeliveryCorrelation | undefined =
      pSession.activeExecutionId
        ? { sessionId: activeSessionId, executionId: pSession.activeExecutionId, kind: "final_assistant" }
        : undefined;

    // #869: strip <think>/<thinking> blocks (Pi transport handles thinking natively via events)
    userResponse = userResponse.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>\s*/g, "");
    userResponse = userResponse.replace(/<\/think(?:ing)?>\s*/g, "");

    // --- Secret redaction (belt-and-suspenders for #436) ---
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("SECRET_") && val && userResponse.includes(val)) {
        userResponse = userResponse.replaceAll(val, `[REDACTED:$${key}]`);
        logWarn(TAG, `Redacted leaked secret $${key} from response`);
      }
    }

    // --- #936: Simple delivery (non-master sessions) ---
    if (ctx.delivery === "simple") {
      if (!userResponse && noReply) return;
      if (userResponse) {
        const chunks = adapter.chunkResponse(userResponse);
        for (const chunk of chunks) {
          const clean = chunk.replace(/\[TOPICS:\s*.+?\]/gi, "").replace(/\[REACT:.+?\]/gi, "").trim();
          if (clean) await retrySend(() => adapter.sendMessage(channelId, clean, { threadId: msg.threadId, deliveryCorrelation }));
        }
      }
      // Record assistant response to memory
      if (deps.memoryRuntime?.state === "ready" && registry.byUserId.get(userId)?.role !== "guest" && !text.startsWith("[SESSION START]")) {
        const timestamp = Date.now();
        await deps.memoryRuntime.recordMessage({ role: "assistant", content: cleanAnswer || response, timestamp, userId, sessionId: activeSessionId }, `assistant-${userId}-${activeSessionId}-${timestamp}`);
      }
      if (isVoice && ttsConfig && adapter.sendVoice) {
        try {
          const audio = await synthesizeSpeech(cleanAnswer || response, ttsConfig);
          if (audio) await adapter.sendVoice(channelId, audio, { threadId: msg.threadId });
        } catch (err) { logAndSwallow(TAG, "TTS", err); }
      }
      logInfo(TAG, `→ [${msg.platform}] Simple delivery (${userResponse.length} chars)`);
      // #938: Update session metrics
      effectiveSession.messageCount = (effectiveSession.messageCount ?? 0) + 1;
      effectiveSession.contextPercent = transport.contextPercent >= 0 ? transport.contextPercent : undefined;
      effectiveSession.toolCallCount = (effectiveSession.toolCallCount ?? 0) + (transport.toolCallsSucceeded ?? 0);
      return;
    }

    // --- Empty response ---
    if (!userResponse && reactionEmoji) {
      userResponse = reactionEmoji; // emoji IS the response — deliver normally
    }
    if (!userResponse) {
      if (noReply) {
        logDebug(TAG, "LLM returned [NO_REPLY], dropping silently");
        return;
      }
      if (transport.toolCallsSucceeded > 0) {
        logDebug(TAG, `Empty text but ${transport.toolCallsSucceeded} tool call(s) succeeded — suppressing fallback`);
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "").catch(err => logAndSwallow(TAG, "adapter call", err));
      } else {
        logWarn(TAG, "Empty response from transport");
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "🤷");
        await adapter.sendMessage(channelId, "🤷 Model returned an empty response. Try again or /reset.", { threadId: msg.threadId });
      }
      return;
    }

    // --- Clear 👀 reaction ---
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(err => logAndSwallow(TAG, "adapter call", err));
    }

    // --- Deliver response — always chunk and send (#583) ---
    let lastSentMsgId: number | string | undefined;
    const chunks = adapter.chunkResponse(userResponse);
    logDebug(TAG, `Sending ${chunks.length} chunk(s)`);
    for (const chunk of chunks) {
      // #652: defense-in-depth — strip leaked metadata tags before delivery
      const clean = chunk.replace(/\[TOPICS:\s*.+?\]/gi, "").replace(/\[REACT:.+?\]/gi, "").trim();
      if (clean) {
        await adapter.sendTyping?.(channelId, msg.threadId);
        lastSentMsgId = await retrySend(() => adapter.sendMessage(channelId, clean, { threadId: msg.threadId, deliveryCorrelation }));
      }
    }

    // --- Send reaction emoji as separate message (if extracted by cleanResponse) ---
    if (reactionEmoji) {
      if (adapter.setReaction && msg.messageId) {
        try { await adapter.setReaction(channelId, msg.messageId, reactionEmoji); }
        catch { await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId }); }
      } else {
        await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
      }
    }

    // --- Update priming buffer ---
    if (getEnv().activeMemory) {
      const modelTopics = getEnv().primingModelTopics && topics ? topics : [];
      const regexKw = extractKeywords(text);
      const existing = pSession.primingTerms ?? [];
      pSession.primingTerms = [...new Set([...modelTopics, ...regexKw, ...existing])].slice(0, PRIMING_MAX);
    }

    // --- Record to memory (skip for guests and greeting injects) ---
    const isGuest = registry.byUserId.get(userId)?.role === "guest";
    if (deps.memoryRuntime?.state === "ready" && !isGuest && !text.startsWith("[SESSION START]")) {
      await deps.memoryRuntime.recordMessage({
        role: "assistant", content: cleanAnswer || response,
        timestamp: Date.now(), userId, sessionId: activeSessionId,
        platformMessageId: typeof lastSentMsgId === "number" ? lastSentMsgId : undefined,
      }, `assistant-${userId}-${activeSessionId}-${lastSentMsgId ?? Date.now()}`);
    }

    // --- TTS for voice notes ---
    if (isVoice && ttsConfig && !pSession.fullMode && adapter.sendVoice) {
      try {
        await adapter.sendTyping?.(channelId, msg.threadId);
        const audio = await synthesizeSpeech(cleanAnswer || response, ttsConfig);
        if (audio) {
          await adapter.sendVoice(channelId, audio, { threadId: msg.threadId });
          logInfo(TAG, `🔊 Voice reply sent (${audio.length} bytes)`);
        }
      } catch (err) {
        logWarn(TAG, `TTS failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- Clear reaction ---
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "");
    }

    const ctxAfter = transport.contextPercent;
    logInfo(TAG, `→ [${msg.platform}] Response delivered${ctxAfter >= 0 ? ` (ctx: ${ctxAfter}%)` : ""}`);
    updateBridgeLockField("lastPromptAt", Date.now());

    // #938: Update session metrics
    effectiveSession.messageCount = (effectiveSession.messageCount ?? 0) + 1;
    effectiveSession.contextPercent = ctxAfter >= 0 ? ctxAfter : undefined;
    effectiveSession.toolCallCount = (effectiveSession.toolCallCount ?? 0) + (transport.toolCallsSucceeded ?? 0);

    // --- #824: Citation detection — did the agent use the recalled memories? ---
    if (recalledHits && recalledHits.length > 0 && memoryConfig.memoryEnabled && deps.memoryRuntime?.state === "ready") {
      try {
        const mod = abmind();
        if (mod) {
          const { detectCitations } = mod;
          const citedIds = detectCitations(userResponse, recalledHits);
          for (const memoryId of citedIds) {
            await deps.memoryRuntime.recordFeedback({ userId, memoryId, feedbackType: "cite" }, `cite-${userId}-${memoryId}-${lastSentMsgId ?? Date.now()}`);
          }
          logDebug(TAG, `Citation: ${citedIds.length}/${recalledHits.length} recalled memories cited`);
          // Track recalledIds for emoji reaction feedback (1h TTL)
          if (lastSentMsgId != null) {
            recalledIdsPerMessage.set(Number(lastSentMsgId), recalledHits.map(h => h.id));
          }
        }
      } catch (err) {
        logWarn(TAG, `Citation detection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // --- AfterMessage hook ---
    if (hasHooks("AfterMessage")) {
      fireHook("AfterMessage", {
        event: "AfterMessage", timestamp: new Date().toISOString(),
        sessionKey: activeSessionId, platform: msg.platform, userId,
        chatId: String(chatId), text: text,
        response: userResponse, model: ("currentModel" in transport ? String((transport as Record<string, unknown>).currentModel) : "unknown"), success: true,
      }).catch(err => logAndSwallow(TAG, "adapter call", err));
    }
  } catch (err) {
    // #287: model not found — surface actionable message to user
    if (err instanceof ModelNotFoundError) {
      logWarn(TAG, `Model not found for ${activeSessionId}: ${err.message}`);
      await adapter.sendMessage(channelId, `❌ ${err.message}\nUse /model to switch.`, { threadId: msg.threadId });
    } else {
      logError(TAG, `Error for ${activeSessionId} — ${err instanceof Error ? err.message : JSON.stringify(err)}${(err as any)?.code ? ` (code=${(err as any).code})` : ""}`);
    }
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(err => logAndSwallow(TAG, "adapter call", err));
    }

    // AfterMessage hook on error
    if (hasHooks("AfterMessage")) {
      fireHook("AfterMessage", {
        event: "AfterMessage", timestamp: new Date().toISOString(),
        sessionKey: activeSessionId, platform: msg.platform, userId,
        chatId: String(chatId), text: text, success: false,
        error: err instanceof Error ? err.message : String(err),
      }).catch(err => logAndSwallow(TAG, "adapter call", err));
    }

    // Auto-reset on context window overflow (ValidationException or actual context errors)
    const errStr = String(err instanceof Error ? err.message : JSON.stringify(err));
    // #1294 + #1298: Synthetic internal prompts are system-initiated, not user requests.
    // If they fail (e.g. models exhausted), don't surface an ❌ error reply — the user sees
    // errors on their own messages, and deliver/announce notifications are queryable via /kanban.
    const SYNTHETIC_PREFIXES = ["[SESSION START]", "[SYSTEM]", "[TASK COMPLETE]"];
    const notifyUser = !SYNTHETIC_PREFIXES.some(p => text.startsWith(p));
    const isContextOverflow = errStr.includes("ValidationException")
      || (errStr.includes("context window") || errStr.includes("token limit") || errStr.includes("maximum context"));
    const isTimeout = errStr.includes("timed out") || errStr.includes("Prompt already in progress");

    if (isContextOverflow) {
      logWarn(TAG, `Context overflow detected — auto-resetting session`);
      await resetAndPrepare({ transport, sessionKey: activeSessionId, reason: `ctx-overflow: ${errStr.slice(0, 100)}` });
      if (notifyUser) await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    } else if (isTimeout) {
      logWarn(TAG, `Request timeout — not resetting session`);
      if (notifyUser) await adapter.sendMessage(channelId, "❌ Model timed out.", { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    } else {
      logError(TAG, `Pipeline error: ${errStr.slice(0, 500)}`);
      const reason = errStr.includes("credits") ? "OpenRouter credits exhausted — top up at openrouter.ai/credits"
        : errStr.includes("rate") || errStr.includes("429") ? "Rate limited."
        : errStr.includes("auth") || errStr.includes("401") || errStr.includes("403") ? "Authentication failed."
        : errStr.includes("connect") || errStr.includes("ECONNREFUSED") ? "Connection lost."
        : errStr.includes("exhausted") || errStr.includes("no candidates") ? "All models exhausted."
        : errStr.includes("aborted") || errStr.includes("code=20") ? "Request aborted — model connection dropped."
        : `Error: ${errStr.slice(0, 80)}`;
      if (notifyUser) await adapter.sendMessage(channelId, `❌ ${reason}`, { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    }
  } finally {
    clearInterval(typingInterval);
    clearTimeout(typingTtlTimer);
    if (toolElapsedTimer) clearInterval(toolElapsedTimer);
    transport.onToolCallStart = undefined;
    transport.onSegmentBreak = undefined;
    releaseBusy(pSession, (m, a) => handleInboundMessage(m, a, deps));
    idleSave.reset(activeSessionId, chatId);
  }
}

/** Build session-start prompt with SOUL + context + greeting, send to transport, push response to adapter. */
