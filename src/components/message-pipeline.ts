/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { cleanResponse } from "./clean-response.js";
import { loadUsers } from "./user-registry.js";
import { tryReaction } from "./reactions.js";
import { SessionRegistry } from "./session-registry.js";
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
import type { MemoryManager } from "abmind";
import type { IdleSave } from "./idle-save.js";
import type { ConversationBuffer } from "./conversation-buffer.js";
import type { RunningJob } from "./tasks/task-queue.js";
import type { InboundMessage, PlatformAdapter } from "../types/platform.js";
import { updateBridgeLockField } from "./transport/bridge-lock-transport.js";
import { createMessageContext, runPipeline, voiceMiddleware, commandMiddleware, busyGuardMiddleware } from "./pipeline/index.js";
import { hasHooks, fire as fireHook } from "./hooks/hook-system.js";
import { buildPrompt, buildSessionStartPrompt } from "./pipeline/prompt-builder.js";

import { getEnv } from "./env-schema.js";
import { sanitizeOutbound } from "./sanitize-outbound.js";

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
export { SessionRegistry } from "./session-registry.js";
/** Reset by bridge-app on inbound message to re-enable floating compaction. */
export let resetIdleCompactFlag: (() => void) | null = null;
export function setIdleCompactReset(fn: () => void): void { resetIdleCompactFlag = fn; }

/** Shared session reset: reset transport, clear buffer, delete session entry. */
export async function resetAndPrepare(opts: {
  transport: IKiroTransport;
  sessionKey: string;
  reason: string;
  sessions: SessionRegistry;
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}): Promise<void> {
  await opts.transport.resetSession(opts.sessionKey);
  if (opts.conversationBuffer && opts.bufKey) opts.conversationBuffer.clear(opts.bufKey);
  opts.sessions.delete(opts.sessionKey);
  opts.sessions.getOrCreate(opts.sessionKey).pendingStart = true;
  // #254: clear emergency mode on reset — next session starts fresh
  const t = opts.transport as unknown as { setEmergencyMode?: (o: null) => void };
  t.setEmergencyMode?.(null);
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
  memory: MemoryManager | null;
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
  sessions: SessionRegistry;
  sessionManager: import("./session-manager.js").SessionManager;
  cronCurrentJob?: () => RunningJob | null;
  enqueueCron?: (entryId: string, manual?: boolean) => string | null;
  requestShutdown?: (code?: number) => void;
  sleepProgress?: () => { percent: number; step: string } | null;
  loadedCapabilities?: string[];
  selfHealerTask?: { enabled: boolean } | null;
  hailMary?: { model: string; endpoint: string; apiKey?: string } | null;
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
  // Run early middleware (voice → commands → busy guard)
  const ctx = createMessageContext(msg, adapter, deps);
  await runPipeline(ctx, [voiceMiddleware, commandMiddleware, busyGuardMiddleware]);
  if (ctx.handled) return;

  // --- BeforeMessage hook ---
  if (hasHooks("BeforeMessage")) {
    const result = await fireHook("BeforeMessage", {
      event: "BeforeMessage", timestamp: new Date().toISOString(),
      sessionKey: "", platform: msg.platform, userId: msg.userId,
      chatId: String(ctx.chatId), text: ctx.text,
    });
    if (result?.decision === "block") {
      logInfo(TAG, `BeforeMessage hook blocked: ${result.reason ?? "no reason"}`);
      return;
    }
  }

  // --- Core transport/response handling (will become middleware incrementally) ---
  const {
    transport, memory, memoryConfig,
    idleSave, conversationBuffer,
    ttsConfig,
    sessions,
  } = deps;

  const { channelId, isVoice } = msg;
  const chatId = ctx.chatId;
  const text = ctx.text;

  const registry = loadUsers();
  const userId = msg.userId;

  // Resolve active transport session via session manager (#510)
  const activeSessionId = deps.sessionManager.getActiveSessionId(userId, msg.platform);

  const busyEntry = sessions.getOrCreate(activeSessionId);
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
    const { prompt: builtPrompt, imageContent, recalledHits } = await buildPrompt(msg, text, {
      memory, memoryConfig, sessions, sessionManager: deps.sessionManager, conversationBuffer, contextPercent: ctxPct, maxContext: deps.maxContext,
      isAcp: !("agentLoop" in transport),
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
    const activeSession = deps.sessionManager.getActiveSession(userId, msg.platform);
    const agentSession = activeSession.agentSession;
    logDebug(TAG, `Route: session=${activeSessionId} type=${activeSession.type} agentSession=${agentSession ? "yes" : "no"}`);

    // #681: attach sandbox policy (owner for now — peer/guest in #678)
    if ("sandboxPolicy" in transport) {
      const { buildPolicy } = await import("./tool-sandbox.js");
      (transport as any).sandboxPolicy = buildPolicy("owner");
    }
    // Wire cooperative pause check (#539) — agent loop checks this between tool calls
    if ("isPaused" in transport) {
      (transport as any).isPaused = () => activeSession.paused;
    }

    // Wire /wait steer injection (#655) — agent loop drains this between tool rounds
    if ("getPendingInstruction" in transport) {
      const sessionEntry = deps.sessions.getOrCreate(activeSessionId);
      (transport as any).getPendingInstruction = () => {
        const pending = sessionEntry.pendingWait;
        if (!pending) return undefined;
        sessionEntry.pendingWait = undefined;
        return pending;
      };
    }

    const responsePromise = agentSession
      ? agentSession.sendPrompt(activeSessionId, prompt, imageContent)
      : transport.sendPrompt(activeSessionId, prompt, imageContent, userId);

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
    const rawResponse = sessions.get(activeSessionId)?.fullMode ? response : (cleanAnswer || response);
    const { text: cleanedText, reactionEmoji, noReply, topics } = cleanResponse(rawResponse);
    let userResponse = cleanedText;

    // #869: strip <thinking> blocks unless user opted in via /reasoning show
    const reasoningSession = transport.getActiveSession?.();
    if (!reasoningSession?.showReasoning) {
      userResponse = userResponse.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "");
    }

    // --- Secret redaction (belt-and-suspenders for #436) ---
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("SECRET_") && val && userResponse.includes(val)) {
        userResponse = userResponse.replaceAll(val, `[REDACTED:$${key}]`);
        logWarn(TAG, `Redacted leaked secret $${key} from response`);
      }
    }

    // --- Empty response ---
    if (!userResponse) {
      if (noReply) {
        logDebug(TAG, "LLM returned [NO_REPLY], dropping silently");
        return;
      }
      if (reactionEmoji) {
        if (adapter.setReaction && msg.messageId) {
          try { await adapter.setReaction(channelId, msg.messageId, reactionEmoji); }
          catch { await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId }); }
        } else {
          await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
        }
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

    // --- Standalone emoji → try reaction, fallback to message ---
    const trimmed = userResponse.trim();
    const isEmojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]{1,2}$/u.test(trimmed);
    if (isEmojiOnly) {
      await tryReaction(adapter, channelId, msg.messageId, trimmed, msg.threadId);
      return;
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
        lastSentMsgId = await retrySend(() => adapter.sendMessage(channelId, clean, { threadId: msg.threadId }));
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
      const existing = sessions.get(activeSessionId)?.primingTerms ?? [];
      sessions.getOrCreate(activeSessionId).primingTerms = [...new Set([...modelTopics, ...regexKw, ...existing])].slice(0, PRIMING_MAX);
    }

    // --- Record to memory (skip for guests) ---
    const isGuest = registry.byUserId.get(userId)?.role === "guest";
    if (memory && !isGuest) {
      memory.recordMessage({
        role: "assistant", content: cleanAnswer || response,
        timestamp: Date.now(), userId, sessionId: activeSessionId,
        platformMessageId: typeof lastSentMsgId === "number" ? lastSentMsgId : undefined,
      });
    }

    // --- TTS for voice notes ---
    if (isVoice && ttsConfig && !sessions.get(activeSessionId)?.fullMode && adapter.sendVoice) {
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

    // --- #824: Citation detection — did the agent use the recalled memories? ---
    if (recalledHits && recalledHits.length > 0 && memory) {
      try {
        const { detectCitations } = await import("abmind");
        const citedIds = detectCitations(userResponse, recalledHits);
        if (citedIds.length > 0) memory.bumpCitedCount(citedIds);
        logDebug(TAG, `Citation: ${citedIds.length}/${recalledHits.length} recalled memories cited`);
        // Track recalledIds for emoji reaction feedback (1h TTL)
        if (lastSentMsgId != null) {
          recalledIdsPerMessage.set(Number(lastSentMsgId), recalledHits.map(h => h.id));
        }
      } catch (err) {
        logDebug(TAG, `Citation detection failed: ${err instanceof Error ? err.message : String(err)}`);
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
      logError(TAG, `Error for ${activeSessionId} — ${err instanceof Error ? err.message : JSON.stringify(err)}`);
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
    const isContextOverflow = errStr.includes("ValidationException")
      || (errStr.includes("context window") || errStr.includes("token limit") || errStr.includes("maximum context"));
    const isTimeout = errStr.includes("timed out") || errStr.includes("Prompt already in progress");

    if (isContextOverflow) {
      logWarn(TAG, `Context overflow detected — auto-resetting session`);
      await resetAndPrepare({ transport, sessionKey: activeSessionId, reason: `ctx-overflow: ${errStr.slice(0, 100)}`, sessions });
      await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    } else if (isTimeout) {
      logWarn(TAG, `Request timeout — not resetting session`);
      await adapter.sendMessage(channelId, "❌ Model timed out.", { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    } else {
      const reason = errStr.includes("credits") ? "OpenRouter credits exhausted — top up at openrouter.ai/credits"
        : errStr.includes("rate") || errStr.includes("429") ? "Rate limited."
        : errStr.includes("auth") || errStr.includes("401") || errStr.includes("403") ? "Authentication failed."
        : errStr.includes("connect") || errStr.includes("ECONNREFUSED") ? "Connection lost."
        : errStr.includes("exhausted") || errStr.includes("no candidates") ? "All models exhausted."
        : "Something went wrong.";
      await adapter.sendMessage(channelId, `❌ ${reason}`, { threadId: msg.threadId }).catch(err => logAndSwallow(TAG, "adapter call", err));
    }
  } finally {
    clearInterval(typingInterval);
    clearTimeout(typingTtlTimer);
    if (toolElapsedTimer) clearInterval(toolElapsedTimer);
    transport.onToolCallStart = undefined;
    transport.onSegmentBreak = undefined;
    busyEntry.busy = false;
    idleSave.reset(activeSessionId, chatId);

    // Drain queued messages
    const entry = sessions.get(activeSessionId);
    if (entry?.queue.length) {
      const next = entry.queue.shift()!;
      logInfo(TAG, `Draining queued message for ${activeSessionId} (${entry.queue.length} remaining)`);
      handleInboundMessage(next.msg, next.adapter, deps).catch(e => logError(TAG, "Queue drain error", e));
    }
  }
}

/** Build session-start prompt with SOUL + context + greeting, send to transport, push response to adapter. */
export async function startSession(
  transport: IKiroTransport,
  memory: MemoryManager,
  userId: string,
  sessionKey: string,
  greeting: string,
  sendResponse: (text: string) => Promise<unknown>,
): Promise<void> {
  const prompt = buildSessionStartPrompt(greeting, memory, userId, sessionKey);
  logInfo(TAG, `Session start for ${sessionKey} — prompt ${prompt.length} chars`);
  const response = await transport.sendPrompt(sessionKey, prompt, undefined, userId);
  if (response?.trim() && response.trim() !== "[NO_REPLY]" && response.trim() !== "(no response)") {
    await sendResponse(response);
    memory.recordMessage({ role: "assistant", content: response, timestamp: Date.now(), userId, sessionId: sessionKey });
  }
}


