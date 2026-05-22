/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { cleanResponse } from "./clean-response.js";
import { loadUsers } from "./user-registry.js";
import { tryReaction } from "./reactions.js";
import { SessionRegistry } from "./session-registry.js";
import { ModelNotFoundError } from "./transport/acp-transport.js";
import type { SttConfig } from "./stt.js";
import { synthesizeSpeech, type TtsConfig } from "./tts.js";
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

const TAG = "pipeline";
const PRIMING_MAX = 8;

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
  config: { agentTransport: string; workingDir: string };
  startedAt: number;
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
    const userId = msg.sessionKey.includes(":") ? msg.sessionKey.split(":")[0]! : "master";
    const result = await fireHook("BeforeMessage", {
      event: "BeforeMessage", timestamp: new Date().toISOString(),
      sessionKey: msg.sessionKey, platform: msg.platform, userId,
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

  const { sessionKey, channelId, isVoice } = msg;
  const chatId = ctx.chatId;
  const text = ctx.text;

  // Resolve userId from sessionKey (adapter already resolved it)
  const registry = loadUsers();
  const userId = sessionKey.includes(":") ? sessionKey.split(":")[0]! : "master";

  // Resolve active transport session via session manager (#510)
  const activeSessionId = deps.sessionManager.getActiveSessionId(userId, msg.platform);

  const busyEntry = sessions.getOrCreate(activeSessionId);
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let typingTtlTimer: ReturnType<typeof setTimeout> | undefined;
  let toolElapsedTimer: ReturnType<typeof setInterval> | undefined;
  try {
    busyEntry.busy = true;
    resetIdleCompactFlag?.(); // re-enable floating compaction on next idle
    const ctxPct = transport.contextPercent;
    logInfo(TAG, `← [${msg.platform}] ${isVoice ? "🎤 " : ""}"${text.slice(0, 60)}"${ctxPct >= 0 ? ` (ctx: ${ctxPct}%)` : ""}`);
    // --- Sleep: main transport is available during sleep (sleep uses its own) ---
    // No queueing needed

    // --- Build prompt ---
    const { prompt: builtPrompt } = await buildPrompt(msg, text, {
      memory, memoryConfig, sessions, conversationBuffer, contextPercent: ctxPct,
    }, registry);

    if (builtPrompt === "__INJECTION_BLOCKED__") {
      await adapter.sendMessage(channelId, "⛔ Message blocked — suspicious content detected.", { threadId: msg.threadId });
      return;
    }

    let prompt = builtPrompt;

    // --- Send to transport ---
    const activeSession = deps.sessionManager.getActiveSession(userId, msg.platform);
    const agentSession = activeSession.agentSession;
    logDebug(TAG, `Route: session=${activeSessionId} type=${activeSession.type} agentSession=${agentSession ? "yes" : "no"}`);

    // Wire cooperative pause check (#539) — agent loop checks this between tool calls
    if ("isPaused" in transport) {
      (transport as any).isPaused = () => activeSession.paused;
    }

    const responsePromise = agentSession
      ? agentSession.sendPrompt(activeSessionId, prompt)
      : transport.sendPrompt(activeSessionId, prompt);

    // --- Typing + reaction ---
    if (!isVoice && adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "👀");
    }
    if (adapter.sendTyping) {
      await adapter.sendTyping(channelId, msg.threadId);
      typingInterval = setInterval(() => {
        adapter.sendTyping!(channelId, msg.threadId).catch(() => {});
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
      adapter.sendTyping?.(channelId, msg.threadId).catch(() => {});

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
              adapter.editMessage(channelId, streamMsgId, status + "...").catch(() => {});
            } else {
              const id = await adapter.sendMessage(channelId, status, { threadId: msg.threadId }).catch(() => undefined);
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
          adapter.editMessage(channelId, streamMsgId, status + "...").catch(() => {});
        }
      }, 10_000);
    };

    // --- Fallback notification inline ---
    if ("onFallback" in transport) {
      const prev = (transport as any).onFallback;
      (transport as any).onFallback = (model: string, _ctxPct: number, reason?: string) => {
        prev?.(model, _ctxPct, reason);
        const short = model.split("/").pop() ?? model;
        adapter.sendMessage(channelId, `⚠️ Switched to ${short}${reason ? ` (${reason})` : ""}`, { threadId: msg.threadId }).catch(() => {});
      };
    }

    // --- Segment break: deliver pre-tool text immediately ---
    let fullResponseSegments: string[] = [];
    transport.onSegmentBreak = (text: string) => {
      fullResponseSegments.push(text);
      if (streamMsgId && adapter.editMessage) {
        // Finalize current stream message with the segment text (no cursor)
        adapter.editMessage(channelId, streamMsgId, text).catch(() => {});
      } else if (text) {
        // No stream message yet — send as standalone
        adapter.sendMessage(channelId, text, { threadId: msg.threadId }).catch(() => {});
      }
      // Reset stream state for next segment
      streamMsgId = undefined;
      streamBuffer = "";
    };

    // --- Intermediate streaming ---
    let intermediateDelivered = false;
    let streamMsgId: number | string | undefined;
    let streamBuffer = "";
    let streamTimer: ReturnType<typeof setInterval> | undefined;

    if (adapter.supportsStreaming === false) {
      // No streaming — wait for full response (IRC, etc.)
    } else if (adapter.editMessage) {
      // Edit-in-place streaming (ACP + platforms that support editMessage)
      const FLUSH_INTERVAL = getEnv().streamFlushSec === 0 ? 0 : Math.max(2, Math.min(180, getEnv().streamFlushSec)) * 1000;
      let lastFlushed = "";

      transport.onIntermediateResponse = (chunk: string) => {
        streamBuffer += chunk;
      };

      let flushing = false;
      if (FLUSH_INTERVAL > 0) {
        streamTimer = setInterval(async () => {
          if (flushing) return;
          const text = streamBuffer.replace(/^\[lang:\w{2}\]\s*/i, "").trim();
          if (!text || text === lastFlushed) return;
          flushing = true;
          try {
            if (!streamMsgId) {
              streamMsgId = await adapter.sendMessage(channelId, text + "...", { threadId: msg.threadId });
              intermediateDelivered = true;
            } else {
              await adapter.editMessage!(channelId, streamMsgId, text + "...");
            }
            lastFlushed = text;
          } catch (err) { logAndSwallow("message_pipeline", "op", err); }
          flushing = false;
        }, FLUSH_INTERVAL);
      }
    } else {
      // Chunk-based streaming (tmux + platforms without editMessage)
      transport.onIntermediateResponse = (chunk: string) => {
        intermediateDelivered = true;
        const chunks = adapter.chunkResponse(chunk);
        for (const c of chunks) {
          if (c.trim()) {
            adapter.sendTyping?.(channelId, msg.threadId).catch(() => {});
            adapter.sendMessage(channelId, c, { threadId: msg.threadId }).catch(() => {});
          }
        }
      };
    }

    const response = await responsePromise;

    clearInterval(streamTimer);
    clearTimeout(toolBatchTimer);
    transport.onIntermediateResponse = undefined;
    logDebug(TAG, `Response (${response.length} chars): "${response.trim().slice(0, 120)}"`);

    // --- Extract clean answer ---
    const cleanAnswer = transport.answerOnly;
    const rawResponse = sessions.get(activeSessionId)?.fullMode ? response : (cleanAnswer || response);
    const { text: cleanedText, reactionEmoji, noReply, topics } = cleanResponse(rawResponse);
    let userResponse = cleanedText;

    // --- Secret redaction (belt-and-suspenders for #436) ---
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("SECRET_") && val && userResponse.includes(val)) {
        userResponse = userResponse.replaceAll(val, `[REDACTED:$${key}]`);
        logWarn(TAG, `Redacted leaked secret $${key} from response`);
      }
    }

    // --- Empty response ---
    if (!userResponse) {
      // Strip streaming cursor from partial message
      if (streamMsgId && adapter.editMessage) {
        const partial = streamBuffer.replace(/^\[lang:\w{2}\]\s*/i, "").replace(/...$/, "").trim();
        if (partial) await adapter.editMessage(channelId, streamMsgId, partial).catch(() => {});
      }
      if (noReply) {
        logDebug(TAG, "LLM returned [NO-REPLY], dropping silently");
        return;
      }
      // Reaction-only: [REACT:emoji] with no text
      if (reactionEmoji) {
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
        if (streamMsgId && adapter.editMessage) {
          await adapter.editMessage(channelId, streamMsgId, reactionEmoji).catch(() => {});
        } else {
          await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
        }
        return;
      }
      if (!intermediateDelivered) {
        if (transport.toolCallsSucceeded > 0) {
          logDebug(TAG, `Empty text but ${transport.toolCallsSucceeded} tool call(s) succeeded — suppressing fallback`);
          if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
        } else {
          logWarn(TAG, "Empty response from transport");
          if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "🤷");
          await adapter.sendMessage(channelId, "🤷 Model returned an empty response. Try again or /reset.", { threadId: msg.threadId });
        }
      }
      return;
    }

    // --- Clear 👀 reaction ---
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }

    // --- Standalone emoji → try reaction, fallback to message ---
    const trimmed = userResponse.trim();
    const isEmojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]{1,2}$/u.test(trimmed);
    if (isEmojiOnly) {
      await tryReaction(adapter, channelId, msg.messageId, trimmed, msg.threadId);
      return;
    }

    // --- Deliver response ---
    let lastSentMsgId: number | string | undefined;
    if (streamMsgId && adapter.editMessage) {
      // ACP edit-in-place: final edit removes cursor...
      try {
        await adapter.editMessage(channelId, streamMsgId, userResponse);
        lastSentMsgId = streamMsgId;
      } catch (err) { logAndSwallow("message_pipeline", "op", err); }
    } else if (!intermediateDelivered) {
      const chunks = adapter.chunkResponse(userResponse);
      logDebug(TAG, `Sending ${chunks.length} chunk(s)`);
      for (const chunk of chunks) {
        if (chunk.trim()) {
          await adapter.sendTyping?.(channelId, msg.threadId);
          lastSentMsgId = await adapter.sendMessage(channelId, chunk, { threadId: msg.threadId });
        }
      }
    } else if (transport.intermediateDeliveredText) {
      // Send any tail not yet delivered by intermediate streaming
      const delivered = transport.intermediateDeliveredText;
      const finalAnswer = cleanAnswer || response;
      if (delivered && finalAnswer.length > delivered.length && finalAnswer.startsWith(delivered)) {
        const tail = finalAnswer.slice(delivered.length).trim();
        if (tail) {
          logDebug(TAG, `Sending streamed tail (${tail.length} chars)`);
          const tailChunks = adapter.chunkResponse(tail);
          for (const chunk of tailChunks) {
            if (chunk.trim()) {
              await adapter.sendTyping?.(channelId, msg.threadId);
              lastSentMsgId = await adapter.sendMessage(channelId, chunk, { threadId: msg.threadId });
            }
          }
        }
      }
    }

    // --- Send reaction emoji as separate message (if extracted by cleanResponse) ---
    if (reactionEmoji) {
      await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
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
    logInfo(TAG, `→ [${msg.platform}] Response delivered${intermediateDelivered ? " (streamed)" : ""}${ctxAfter >= 0 ? ` (ctx: ${ctxAfter}%)` : ""}`);
    updateBridgeLockField("lastPromptAt", Date.now());

    // --- AfterMessage hook ---
    if (hasHooks("AfterMessage")) {
      fireHook("AfterMessage", {
        event: "AfterMessage", timestamp: new Date().toISOString(),
        sessionKey, platform: msg.platform, userId,
        chatId: String(chatId), text: text,
        response: userResponse, model: ("currentModel" in transport ? String((transport as Record<string, unknown>).currentModel) : "unknown"), success: true,
      }).catch(() => {});
    }
  } catch (err) {
    // #287: model not found — surface actionable message to user
    if (err instanceof ModelNotFoundError) {
      logWarn(TAG, `Model not found for ${sessionKey}: ${err.message}`);
      await adapter.sendMessage(channelId, `❌ ${err.message}\nUse /model to switch.`, { threadId: msg.threadId });
    } else {
      logError(TAG, `Error for ${sessionKey} — ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    }
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }

    // AfterMessage hook on error
    if (hasHooks("AfterMessage")) {
      fireHook("AfterMessage", {
        event: "AfterMessage", timestamp: new Date().toISOString(),
        sessionKey, platform: msg.platform, userId,
        chatId: String(chatId), text: text, success: false,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
    }

    // Auto-reset on context window overflow (ValidationException or actual context errors)
    const errStr = String(err instanceof Error ? err.message : JSON.stringify(err));
    const isContextOverflow = errStr.includes("ValidationException")
      || (errStr.includes("context window") || errStr.includes("token limit") || errStr.includes("maximum context"));
    const isTimeout = errStr.includes("timed out") || errStr.includes("Prompt already in progress");

    if (isContextOverflow) {
      logWarn(TAG, `Context overflow detected — auto-resetting session`);
      await resetAndPrepare({ transport, sessionKey: activeSessionId, reason: `ctx-overflow: ${errStr.slice(0, 100)}`, sessions });
      await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(() => {});
    } else if (isTimeout) {
      logWarn(TAG, `Request timeout — not resetting session`);
      await adapter.sendMessage(channelId, "❌ Model timed out.", { threadId: msg.threadId }).catch(() => {});
    } else {
      const reason = errStr.includes("rate") || errStr.includes("429") ? "Rate limited."
        : errStr.includes("auth") || errStr.includes("401") || errStr.includes("403") ? "Authentication failed."
        : errStr.includes("connect") || errStr.includes("ECONNREFUSED") ? "Connection lost."
        : errStr.includes("exhausted") || errStr.includes("no candidates") ? "All models exhausted."
        : "Something went wrong.";
      await adapter.sendMessage(channelId, `❌ ${reason}`, { threadId: msg.threadId }).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    clearTimeout(typingTtlTimer);
    if (toolElapsedTimer) clearInterval(toolElapsedTimer);
    transport.onToolCallStart = undefined;
    transport.onSegmentBreak = undefined;
    busyEntry.busy = false;
    idleSave.reset(sessionKey, chatId);

    // Drain queued messages
    const entry = sessions.get(sessionKey);
    if (entry?.queue.length) {
      const next = entry.queue.shift()!;
      logInfo(TAG, `Draining queued message for ${sessionKey} (${entry.queue.length} remaining)`);
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
  const response = await transport.sendPrompt(sessionKey, prompt);
  if (response?.trim() && response.trim() !== "[NO-REPLY]" && response.trim() !== "(no response)") {
    await sendResponse(response);
  }
}


