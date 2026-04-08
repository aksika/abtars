/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { interceptLargeMessage } from "./message-interceptor.js";
import { runCompaction } from "./compaction.js";
import { buildSessionStartContext } from "../memory/session-context.js";
import { loadSoulBundle } from "./soul-loader.js";
import { TELEGRAM_ALLOWED_REACTIONS, REACTION_FALLBACK_MAP } from "./reaction-signal.js";
import type { SttConfig } from "./stt.js";
import { synthesizeSpeech, type TtsConfig } from "./tts.js";
import { writeRestartReason, readAndClearRestartReason } from "./restart-reason.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";
import type { ConversationBuffer } from "./conversation-buffer.js";
import type { RunningJob } from "./cron/cron-queue.js";
import type { InboundMessage, PlatformAdapter } from "../types/platform.js";

const TAG = "pipeline";

// Context window thresholds
const CTX_WARN_PCT = parseInt(process.env["CTX_WARN_PCT"] ?? "70", 10);
const CTX_COMPACT_PCT = parseInt(process.env["CTX_COMPACT_PCT"] ?? "80", 10);
const CTX_AGGRESSIVE_PCT = parseInt(process.env["CTX_AGGRESSIVE_PCT"] ?? "90", 10);
const COMPACT_MAX_FAILURES = 3;

// Per-session compaction state
const ctxWarned = new Set<string>();
const compactFailures = new Map<string, number>();
/** Sessions currently being compacted (for coffee message). */
export { compactingSessions } from "./pipeline/busy-guard.js";
/** Reset by bridge-app on inbound message to re-enable floating compaction. */
export let resetIdleCompactFlag: (() => void) | null = null;
export function setIdleCompactReset(fn: () => void): void { resetIdleCompactFlag = fn; }

/** Shared session reset: reset transport, clear buffer, mark for SOUL re-injection. */
export async function resetAndPrepare(opts: {
  transport: IKiroTransport;
  sessionKey: string;
  reason: string;
  pendingSessionStart: Set<string>;
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}): Promise<void> {
  await opts.transport.resetSession(opts.sessionKey);
  if (opts.conversationBuffer && opts.bufKey) opts.conversationBuffer.clear(opts.bufKey);
  opts.pendingSessionStart.add(opts.sessionKey);
  writeRestartReason(opts.reason);
}

/** Transport + agent runtime deps. */
export interface TransportDeps {
  transport: IKiroTransport;
  codingMode: CodingMode;
  config: { agentTransport: string; workingDir: string; discordA2aEnabled?: boolean; discordA2aChannelId?: string };
  startedAt: number;
}

/** Memory system deps. */
export interface MemoryDeps {
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  conversationBuffer: ConversationBuffer;
  idleSave: IdleSave;
  nlmConfig: { enabled: boolean; [k: string]: unknown };
  updateCtxStart: (memoryDir: string, chatId: number) => void;
}

/** Voice processing deps. */
export interface VoiceDeps {
  sttConfig: SttConfig | null;
  ttsConfig: TtsConfig | null;
}

/** Shared mutable session state. */
export interface SessionState {
  busyChats: Set<string>;
  messageQueue: Map<string, Array<{ msg: InboundMessage; adapter: PlatformAdapter }>>;
  fullModeChats: Set<string>;
  pendingSessionStart: Set<string>;
  seenSessions: Set<string>;
}

/** Pipeline dependencies — composed from focused interfaces. */
export interface PipelineDeps extends TransportDeps, MemoryDeps, VoiceDeps, SessionState {
  cronCurrentJob?: () => RunningJob | null;
  enqueueCron?: (entryId: string) => string | null;
  requestShutdown?: () => void;
  sleepProgress?: () => { percent: number; step: string } | null;
  loadedCapabilities?: string[];
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
  const { createMessageContext, runPipeline, voiceMiddleware, commandMiddleware, busyGuardMiddleware } = await import("./pipeline/index.js");
  const ctx = createMessageContext(msg, adapter, deps);
  await runPipeline(ctx, [voiceMiddleware, commandMiddleware, busyGuardMiddleware]);
  if (ctx.handled) return;

  // --- Core transport/response handling (will become middleware incrementally) ---
  const {
    transport, codingMode, memory, memoryConfig,
    idleSave, conversationBuffer,
    ttsConfig,
    busyChats, fullModeChats, pendingSessionStart, seenSessions, updateCtxStart,
  } = deps;

  const { sessionKey, channelId, isVoice, isGroup } = msg;
  const chatId = ctx.chatId;
  const text = ctx.text;

  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
    busyChats.add(sessionKey);
    resetIdleCompactFlag?.(); // re-enable floating compaction on next idle
    const ctxPct = transport.contextPercent;
    logInfo(TAG, `← [${msg.platform}] ${isVoice ? "🎤 " : ""}"${text.slice(0, 60)}"${ctxPct >= 0 ? ` (ctx: ${ctxPct}%)` : ""}`);
    // --- Sleep: main transport is available during sleep (sleep uses its own) ---
    // No queueing needed

    // --- Build prompt ---
    const bufKey = `${msg.platform}:${channelId}`;
    let prompt = `[${msg.platform.charAt(0).toUpperCase() + msg.platform.slice(1)}] ${text}`;
    if (msg.mediaPath) {
      prompt += `\nFile saved at: ${msg.mediaPath}`;
    }
    if (isGroup) {
      const context = conversationBuffer.drain(bufKey);
      if (context) {
        prompt = context + text;
        logDebug(TAG, "Prepended group context to prompt");
      }
    }

    const isSessionStart = pendingSessionStart.has(sessionKey);

    if (memory) {
      prompt = preparePrompt(prompt, memory, chatId, sessionKey, text, pendingSessionStart, seenSessions, msg.messageId);
    }

    if (!isSessionStart) {
      prompt = interceptLargeMessage(prompt).text;
    }

    // --- Send to transport ---
    const activeTransport = codingMode.has(sessionKey) && codingMode.getTransport()
      ? codingMode.getTransport()! : transport;

    const responsePromise = activeTransport.sendPrompt(sessionKey, prompt);

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

    // --- Intermediate streaming ---
    let intermediateDelivered = false;
    let streamMsgId: number | undefined;
    let streamBuffer = "";
    let streamTimer: ReturnType<typeof setInterval> | undefined;

    if (adapter.editMessage) {
      // Edit-in-place streaming (ACP + platforms that support editMessage)
      const rawVal = parseInt(process.env["STREAM_FLUSH_SEC"] ?? "3", 10);
      const FLUSH_INTERVAL = rawVal === 0 ? 0 : Math.max(2, Math.min(180, rawVal)) * 1000;
      let lastFlushed = "";

      transport.onIntermediateResponse = (chunk: string) => {
        streamBuffer += chunk;
      };

      if (FLUSH_INTERVAL > 0) {
        streamTimer = setInterval(async () => {
          const text = streamBuffer.replace(/^\[lang:\w{2}\]\s*/i, "").trim();
          if (!text || text === lastFlushed) return;
          try {
            if (!streamMsgId) {
              streamMsgId = await adapter.sendMessage(channelId, text + " ▍", { threadId: msg.threadId });
              intermediateDelivered = true;
            } else {
              await adapter.editMessage!(channelId, streamMsgId, text + " ▍");
            }
            lastFlushed = text;
          } catch { /* edit may fail if text unchanged or too fast */ }
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
    transport.onIntermediateResponse = undefined;
    logDebug(TAG, `Response (${response.length} chars): "${response.trim().slice(0, 120)}"`);

    // --- Extract clean answer ---
    const cleanAnswer = transport.answerOnly;
    let userResponse = (fullModeChats.has(sessionKey) ? response : (cleanAnswer || response))
      .replace(/^\[lang:\w{2}\]\s*/i, ""); // strip lang tag from display

    // --- Empty response ---
    if (!userResponse || !userResponse.trim()) {
      if (!intermediateDelivered) {
        logWarn(TAG, "Empty response from transport");
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "🤷");
        await adapter.sendMessage(channelId, "🤷 Kiro returned an empty response. Try again or /reset.", { threadId: msg.threadId });
      }
      return;
    }

    // --- Clear 👀 reaction ---
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }

    // --- <NO_REPLY> → silently drop (group chats) ---
    if (userResponse.trim() === "<NO_REPLY>" || userResponse.trim() === "(no response)") {
      logDebug(TAG, "LLM returned <NO_REPLY>, dropping silently");
      return;
    }

    // --- Standalone emoji → try reaction, fallback to message ---
    const trimmed = userResponse.trim();
    const isEmojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]{1,2}$/u.test(trimmed);
    if (isEmojiOnly && adapter.setReaction && msg.messageId) {
      try {
        await adapter.setReaction(channelId, msg.messageId, trimmed);
        logDebug(TAG, `Emoji reaction: ${trimmed}`);
      } catch {
        await adapter.sendMessage(channelId, trimmed, { threadId: msg.threadId });
        logDebug(TAG, `Emoji as message (reaction failed): ${trimmed}`);
      }
      return;
    }

    // --- [REACT:emoji] — extract reaction, deliver remaining text if any ---
    const reactMatch = userResponse.trim().match(/^\[REACT:(.+?)\]\s*([\s\S]*)/);
    if (reactMatch) {
      const emoji = reactMatch[1]!;
      const remaining = reactMatch[2]?.trim() ?? "";
      if (adapter.setReaction && msg.messageId) {
        const fallback = TELEGRAM_ALLOWED_REACTIONS.has(emoji) ? emoji : (REACTION_FALLBACK_MAP[emoji] ?? null);
        if (fallback) {
          await adapter.setReaction(channelId, msg.messageId, fallback);
          logDebug(TAG, `Reaction: ${emoji}${emoji !== fallback ? ` → ${fallback}` : ""}`);
        }
      }
      if (!remaining) return;
      userResponse = remaining; // continue with text after reaction
    }

    // --- Deliver response ---
    let lastSentMsgId: number | undefined;
    if (streamMsgId && adapter.editMessage) {
      // ACP edit-in-place: final edit removes cursor ▍
      try {
        await adapter.editMessage(channelId, streamMsgId, userResponse);
        lastSentMsgId = streamMsgId;
      } catch { /* final edit may fail if identical */ }
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

    // --- Record to memory ---
    if (memory) {
      memory.recordMessage({
        role: "assistant", content: cleanAnswer || response,
        timestamp: Date.now(), chatId, sessionId: sessionKey,
        platformMessageId: lastSentMsgId,
      });
    }

    // --- TTS for voice notes ---
    if (isVoice && ttsConfig && !fullModeChats.has(sessionKey) && adapter.sendVoice) {
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

    // --- Context window management (graduated thresholds) ---
    {
      const pct = transport.contextPercent;
      if (pct >= 0) {
        const failures = compactFailures.get(sessionKey) ?? 0;

        if (pct >= CTX_COMPACT_PCT && failures < COMPACT_MAX_FAILURES) {
          const aggressive = pct >= CTX_AGGRESSIVE_PCT;
          logInfo(TAG, `📦 Context at ${pct}% (${aggressive ? "aggressive" : "compact"} threshold) — compacting`);
          writeRestartReason(`compaction: ctx at ${pct}%`);
          await adapter.sendMessage(channelId, `📦 Context at ${pct}% — compacting...`, { threadId: msg.threadId });

          try {
            // Safety-net transcript
            if (memory) {
              memory.maintenance.checkAutoCompact({
                chatId, sessionId: sessionKey, contextPercent: pct,
                sendCompactCommand: async () => "",
              }).catch(() => {});
            }

            await runCompaction(transport, sessionKey, memory ?? null, memoryConfig.memoryDir);
            pendingSessionStart.add(sessionKey);
            ctxWarned.delete(sessionKey);
            compactFailures.delete(sessionKey);

            await adapter.sendMessage(channelId, "📦 Compaction complete.", { threadId: msg.threadId });
            if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, chatId);
          } catch (err) {
            const count = (compactFailures.get(sessionKey) ?? 0) + 1;
            compactFailures.set(sessionKey, count);
            logError(TAG, `Compaction failed (${count}/${COMPACT_MAX_FAILURES})`, err);
            if (count >= COMPACT_MAX_FAILURES) {
              await adapter.sendMessage(channelId, "⚠️ Compaction failing repeatedly — consider /reset", { threadId: msg.threadId });
            }
          }
        } else if (pct >= CTX_WARN_PCT && !ctxWarned.has(sessionKey)) {
          ctxWarned.add(sessionKey);
          logInfo(TAG, `⚠️ Context at ${pct}% — warning threshold`);
          await adapter.sendMessage(channelId, `⚠️ Context window at ${pct}% — will auto-compact at ${CTX_COMPACT_PCT}%`, { threadId: msg.threadId });
        } else if (pct >= CTX_COMPACT_PCT && failures >= COMPACT_MAX_FAILURES) {
          logDebug(TAG, `Context at ${pct}% but compaction circuit breaker active (${failures} failures)`);
        }
      }
    }
  } catch (err) {
    logError(TAG, `Error for ${sessionKey} — ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }

    // Auto-reset on context window overflow (ValidationException / -32603 repeated)
    const errStr = String(err instanceof Error ? err.message : JSON.stringify(err));
    if (errStr.includes("ValidationException") || errStr.includes("-32603")) {
      logWarn(TAG, `Context overflow detected — auto-resetting session`);
      await resetAndPrepare({ transport, sessionKey, reason: `ctx-overflow: ${errStr.slice(0, 100)}`, pendingSessionStart });
      await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(() => {});
    } else {
      await adapter.sendMessage(channelId, "❌ Something went wrong. Try /reset to start fresh.", { threadId: msg.threadId }).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    busyChats.delete(sessionKey);
    idleSave.reset(sessionKey, chatId);

    // Drain queued messages
    const queued = deps.messageQueue.get(sessionKey);
    if (queued?.length) {
      const next = queued.shift()!;
      if (queued.length === 0) deps.messageQueue.delete(sessionKey);
      logInfo(TAG, `Draining queued message for ${sessionKey} (${queued.length} remaining)`);
      handleInboundMessage(next.msg, next.adapter, deps).catch(e => logError(TAG, "Queue drain error", e));
    }
  }
}

/** Build session-start prompt with SOUL + context + greeting, send to transport, push response to adapter. */
export async function startSession(
  transport: IKiroTransport,
  memory: MemoryManager,
  chatId: number,
  sessionKey: string,
  greeting: string,
  sendResponse: (text: string) => Promise<unknown>,
): Promise<void> {
  const prompt = buildSessionStartPrompt(greeting, memory, chatId);
  logInfo(TAG, `Session start for ${sessionKey} — prompt ${prompt.length} chars`);
  const response = await transport.sendPrompt(sessionKey, prompt);
  if (response?.trim() && response.trim() !== "<NO_REPLY>" && response.trim() !== "(no response)") {
    await sendResponse(response);
  }
}

/** Single path for session-start injection: SOUL + memory wake-up + context + restart reason. */
function buildSessionStartPrompt(
  prompt: string,
  memory: MemoryManager,
  chatId: number,
): string {
  const soul = loadSoulBundle();
  if (soul) {
    prompt = soul + "\n\n" + prompt;
    logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
  }
  // ABM v2: inject core memories + dailies (1% of context budget)
  try {
    const { buildWakeUp } = require("../memory/wake-up-builder.js") as typeof import("../memory/wake-up-builder.js");
    const ctxWindow = parseInt(process.env["CONTEXT_WINDOW_SIZE"] ?? "", 10) || 128000;
    const wakeUp = buildWakeUp(memory.getDatabase(), ctxWindow);
    if (wakeUp) {
      prompt = prompt + "\n\n" + wakeUp;
      logInfo(TAG, `Injected ABM wake-up (${wakeUp.length} chars, budget=${Math.floor(ctxWindow * 0.01)} tokens)`);
    }
  } catch { /* wake-up builder not available */ }
  const ctx = buildSessionStartContext(memory, chatId);
  if (ctx) {
    prompt = ctx + "\n\n" + prompt;
    logInfo(TAG, `Injected session-start context (${ctx.length} chars)`);
  }
  const reason = readAndClearRestartReason();
  if (reason) {
    prompt = `[SESSION START REASON] ${reason}\n\n` + prompt;
    logInfo(TAG, `Injected restart reason: ${reason}`);
  }
  if (prompt.length < 5000) {
    logWarn(TAG, `Session-start prompt suspiciously small (${prompt.length} chars) — SOUL may be missing`);
  }
  return prompt;
}

/** Inject session-start context if pending, record user message. */
function preparePrompt(
  prompt: string,
  memory: MemoryManager,
  chatId: number,
  sessionKey: string,
  text: string,
  pending: Set<string>,
  seen: Set<string>,
  platformMessageId?: number,
): string {
  const isSessionStart = pending.has(sessionKey) || !seen.has(sessionKey);
  if (isSessionStart) {
    prompt = buildSessionStartPrompt(prompt, memory, chatId);
  }
  seen.add(sessionKey);
  pending.delete(sessionKey);
  memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), chatId, sessionId: sessionKey, platformMessageId });
  return prompt;
}
