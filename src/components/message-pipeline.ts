/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { interceptLargeMessage } from "./message-interceptor.js";
import { runCompaction, compactionSummaries } from "./compaction.js";
import { buildSessionStartContext } from "abmind/session-context.js";
import { loadSoulBundle } from "./soul-loader.js";
import { loadUsers, loadUserProfile } from "./user-registry.js";
import { tryReaction } from "./reaction-handler.js";
import type { SttConfig } from "./stt.js";
import { synthesizeSpeech, type TtsConfig } from "./tts.js";
import { writeRestartReason, readAndClearRestartReason } from "./transport/bridge-lock-transport.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import type { MemoryManager } from "abmind/memory-manager.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";
import type { ConversationBuffer } from "./conversation-buffer.js";
import type { RunningJob } from "./cron/cron-queue.js";
import type { InboundMessage, PlatformAdapter } from "../types/platform.js";
import { updateBridgeLockField } from "./transport/bridge-lock-transport.js";

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
  updateCtxStart: (memoryDir: string, userId: string) => void;
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
  enqueueCron?: (entryId: string, manual?: boolean) => string | null;
  requestShutdown?: () => void;
  sleepProgress?: () => { percent: number; step: string } | null;
  loadedCapabilities?: string[];
  selfHealerTask?: { enabled: boolean } | null;
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

  // Resolve userId for memory scoping
  const registry = loadUsers();
  const platformKey = sessionKey.includes(":") ? sessionKey.split(":")[0] + ":" + String(chatId) : sessionKey;
  const userId = registry.byPlatformId.get(platformKey)?.userId ?? "master";

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
      prompt = preparePrompt(prompt, memory, userId, sessionKey, text, pendingSessionStart, seenSessions, msg.messageId);
    }

    if (!isSessionStart) {
      prompt = interceptLargeMessage(prompt).text;
    }

    // --- Send to transport ---
    const codingSession = codingMode.has(sessionKey) ? codingMode.getSession() : null;
    const responsePromise = codingSession
      ? codingSession.sendPrompt(sessionKey, prompt)
      : transport.sendPrompt(sessionKey, prompt);

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

      let flushing = false;
      if (FLUSH_INTERVAL > 0) {
        streamTimer = setInterval(async () => {
          if (flushing) return;
          const text = streamBuffer.replace(/^\[lang:\w{2}\]\s*/i, "").trim();
          if (!text || text === lastFlushed) return;
          flushing = true;
          try {
            if (!streamMsgId) {
              streamMsgId = await adapter.sendMessage(channelId, text + " ▍", { threadId: msg.threadId });
              intermediateDelivered = true;
            } else {
              await adapter.editMessage!(channelId, streamMsgId, text + " ▍");
            }
            lastFlushed = text;
          } catch { /* edit may fail if text unchanged or too fast */ }
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
        await adapter.sendMessage(channelId, "🤷 Model returned an empty response. Try again or /reset.", { threadId: msg.threadId });
      }
      return;
    }

    // --- Clear 👀 reaction ---
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }

    // --- [NO-REPLY] → strip or silently drop ---
    userResponse = userResponse.replace(/\s*\[NO-REPLY\]\s*/gi, "").trim();
    if (!userResponse || userResponse === "(no response)") {
      logDebug(TAG, "LLM returned [NO-REPLY], dropping silently");
      return;
    }

    // --- Standalone emoji → try reaction, fallback to message ---
    const trimmed = userResponse.trim();
    const isEmojiOnly = /^[\p{Emoji_Presentation}\p{Extended_Pictographic}]{1,2}$/u.test(trimmed);
    if (isEmojiOnly) {
      await tryReaction(adapter, channelId, msg.messageId, trimmed, msg.threadId);
      return;
    }

    // --- [REACT:emoji] — extract reaction, deliver remaining text if any ---
    const reactMatch = userResponse.trim().match(/\[REACT:(.+?)\]/);
    if (reactMatch) {
      const emoji = reactMatch[1]!;
      userResponse = userResponse.replace(reactMatch[0], "").trim();
      if (msg.messageId) {
        await tryReaction(adapter, channelId, msg.messageId, emoji, msg.threadId);
      }
      if (!userResponse) {
        // Reaction-only response with no user message to react to — send emoji as text
        if (!msg.messageId) {
          userResponse = emoji;
        } else {
          return;
        }
      }
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

    // --- Record to memory (skip for guests) ---
    const isGuest = registry.byUserId.get(userId)?.role === "guest";
    if (memory && !isGuest) {
      memory.recordMessage({
        role: "assistant", content: cleanAnswer || response,
        timestamp: Date.now(), userId, sessionId: sessionKey,
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
    updateBridgeLockField("lastPromptAt", Date.now());
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
                userId, sessionId: sessionKey, contextPercent: pct,
                sendCompactCommand: async () => "",
              }).catch(() => {});
            }

            await runCompaction(transport, sessionKey, pendingSessionStart);
            ctxWarned.delete(sessionKey);
            compactFailures.delete(sessionKey);

            await adapter.sendMessage(channelId, "📦 Compaction complete.", { threadId: msg.threadId });
            if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, userId);
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

    // Auto-reset on context window overflow (ValidationException or actual context errors)
    const errStr = String(err instanceof Error ? err.message : JSON.stringify(err));
    const isContextOverflow = errStr.includes("ValidationException")
      || (errStr.includes("context window") || errStr.includes("token limit") || errStr.includes("maximum context"));
    const isTimeout = errStr.includes("timed out") || errStr.includes("Prompt already in progress");

    if (isContextOverflow) {
      logWarn(TAG, `Context overflow detected — auto-resetting session`);
      await resetAndPrepare({ transport, sessionKey, reason: `ctx-overflow: ${errStr.slice(0, 100)}`, pendingSessionStart });
      await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(() => {});
    } else if (isTimeout) {
      logWarn(TAG, `Request timeout — not resetting session`);
      await adapter.sendMessage(channelId, "⏱️ Request timed out. Try again or /reset if stuck.", { threadId: msg.threadId }).catch(() => {});
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

/** Single path for session-start injection: SOUL + memory wake-up + context + user identity + restart reason. */
function buildSessionStartPrompt(
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

  const soul = loadSoulBundle();
  if (soul) {
    contextParts.push(soul);
    logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
  }

  // Inject current user identity
  if (sessionKey) {
    try {
      const registry = loadUsers();
      const user = registry.byUserId.get(userId);
      if (user) {
        const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
        contextParts.push(`[CURRENT USER]\nYou are now talking to ${user.userId} (${user.role}, ${CLASS_NAMES[user.maxClass] ?? `class ${user.maxClass}`} clearance).`);
        const profile = loadUserProfile(user.userId);
        if (profile) contextParts.push(profile);
      }
    } catch { /* registry not available */ }
  }

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

  // Inject compaction summary if available
  const compSummary = compactionSummaries.get(sessionKey ?? "");
  if (compSummary && sessionKey) {
    contextParts.push(`[COMPACTED CONVERSATION]\n${compSummary}\n[/COMPACTED CONVERSATION]`);
    compactionSummaries.delete(sessionKey);
    logInfo(TAG, `Injected compaction summary (${compSummary.length} chars)`);
  }

  // Wrap all context, put user instruction after
  const contextBlock = contextParts.length > 0
    ? `[CONTEXT — do not respond to this section]\n${contextParts.join("\n\n")}\n[/CONTEXT]\n\n`
    : "";

  const result = contextBlock + prompt;
  if (result.length < 5000) {
    logWarn(TAG, `Session-start prompt suspiciously small (${result.length} chars) — SOUL may be missing`);
  }
  return result;
}

/** Inject session-start context if pending, record user message. */
function preparePrompt(
  prompt: string,
  memory: MemoryManager,
  userId: string,
  sessionKey: string,
  text: string,
  pending: Set<string>,
  seen: Set<string>,
  platformMessageId?: number,
): string {
  const isSessionStart = pending.has(sessionKey) || !seen.has(sessionKey);
  if (isSessionStart) {
    prompt = buildSessionStartPrompt(prompt, memory, userId, sessionKey);
  }
  seen.add(sessionKey);
  pending.delete(sessionKey);
  const userRole = loadUsers().byUserId.get(userId)?.role;
  if (userRole !== "guest") {
    memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), userId, sessionId: sessionKey, platformMessageId });
  }
  return prompt;
}
