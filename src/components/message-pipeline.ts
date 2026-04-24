/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { localTime } from "../utils/local-time.js";
import { interceptLargeMessage } from "./message-interceptor.js";
import { runCompaction, compactionSummaries } from "./compaction.js";
import { cleanResponse } from "./clean-response.js";
import { buildSessionStartContext } from "abmind/session-context.js";
import { loadSoulBundle } from "./soul-loader.js";
import { loadUsers } from "./user-registry.js";
import { tryReaction } from "./reactions.js";
import { SessionRegistry } from "./session-registry.js";
import { renderMemory } from "abmind";
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

import { getEnv } from "./env-schema.js";

const TAG = "pipeline";

// Context window thresholds (read once from schema — no more module-level process.env)
const COMPACT_MAX_FAILURES = 3;
const ACTIVE_MEMORY_LIMIT = 5;
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

/** Pipeline dependencies — composed from focused interfaces. */
export interface PipelineDeps extends TransportDeps, MemoryDeps, VoiceDeps {
  sessions: SessionRegistry;
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
    sessions, updateCtxStart,
  } = deps;

  const { sessionKey, channelId, isVoice, isGroup } = msg;
  const chatId = ctx.chatId;
  const text = ctx.text;

  // Resolve userId from sessionKey (adapter already resolved it)
  const registry = loadUsers();
  const userId = sessionKey.includes(":") ? sessionKey.split(":")[0]! : "master";

  const busyEntry = sessions.getOrCreate(sessionKey);
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  let typingTtlTimer: ReturnType<typeof setTimeout> | undefined;
  let silentCheckTimer: ReturnType<typeof setInterval> | undefined;
  try {
    busyEntry.busy = true;
    resetIdleCompactFlag?.(); // re-enable floating compaction on next idle
    const ctxPct = transport.contextPercent;
    logInfo(TAG, `← [${msg.platform}] ${isVoice ? "🎤 " : ""}"${text.slice(0, 60)}"${ctxPct >= 0 ? ` (ctx: ${ctxPct}%)` : ""}`);
    // --- Sleep: main transport is available during sleep (sleep uses its own) ---
    // No queueing needed

    // --- Build prompt ---
    const bufKey = `${msg.platform}:${channelId}`;
    let prompt = `[${localTime()}] ${text}`;
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

    const isSessionStart = sessions.getOrCreate(sessionKey).pendingStart;

    if (memory) {
      prompt = preparePrompt(prompt, memory, userId, sessionKey, text, sessions, msg.messageId);
    }

    // --- Active recall: inject relevant memories on non-session-start turns ---
    if (getEnv().activeMemory && memory && !isSessionStart) {
      const userEntry = registry.byUserId.get(userId);
      const ctxPct = transport.contextPercent;
      if (userEntry?.role !== "guest" && (ctxPct < 0 || ctxPct < getEnv().ctxCompactPct)) {
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

    if (!isSessionStart) {
      prompt = interceptLargeMessage(prompt).text;
    }

    // --- Injection scan on user text for non-master (#157) ---
    const userRole = registry.byUserId.get(userId)?.role;
    if (userRole !== "master" && text.length > 10) {
      const { scanForInjection } = await import("abmind/injection-scanner.js");
      const scan = scanForInjection(text);
      if (!scan.safe) {
        logInfo(TAG, `Injection blocked from ${userId}: ${scan.flags.map(f => f.category).join(", ")}`);
        await adapter.sendMessage(channelId, "⛔ Message blocked — suspicious content detected.", { threadId: msg.threadId });
        return;
      }
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

    // --- Typing TTL + still-working ---
    const TYPING_TTL_MS = getEnv().typingTtlMs;
    const SILENT_THRESHOLD_MS = getEnv().typingSilentThresholdMs;
    let stillWorkingSent = false;
    let lastVisibleOutputAt = Date.now();

    typingTtlTimer = setTimeout(() => {
      if (typingInterval) { clearInterval(typingInterval); typingInterval = undefined; }
    }, TYPING_TTL_MS);

    silentCheckTimer = setInterval(() => {
      if (stillWorkingSent) return;
      if (Date.now() - lastVisibleOutputAt > SILENT_THRESHOLD_MS) {
        stillWorkingSent = true;
        adapter.sendMessage(channelId, "⏱️ Still working...", { threadId: msg.threadId }).catch(() => {});
      }
    }, 10_000);

    // Per-tool-call typing pulse — transport fires this on each tool execution
    transport.onToolCallStart = () => {
      lastVisibleOutputAt = Date.now();
      adapter.sendTyping?.(channelId, msg.threadId).catch(() => {});
    };

    // --- Intermediate streaming ---
    let intermediateDelivered = false;
    let streamMsgId: number | undefined;
    let streamBuffer = "";
    let streamTimer: ReturnType<typeof setInterval> | undefined;

    if (adapter.editMessage) {
      // Edit-in-place streaming (ACP + platforms that support editMessage)
      const FLUSH_INTERVAL = getEnv().streamFlushSec === 0 ? 0 : Math.max(2, Math.min(180, getEnv().streamFlushSec)) * 1000;
      let lastFlushed = "";

      transport.onIntermediateResponse = (chunk: string) => {
        streamBuffer += chunk;
        lastVisibleOutputAt = Date.now();
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
    const rawResponse = sessions.get(sessionKey)?.fullMode ? response : (cleanAnswer || response);
    const { text: cleanedText, reactionEmoji, noReply, topics } = cleanResponse(rawResponse);
    let userResponse = cleanedText;

    // --- Empty response ---
    if (!userResponse) {
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

    // --- Send reaction emoji as separate message (if extracted by cleanResponse) ---
    if (reactionEmoji) {
      await adapter.sendMessage(channelId, reactionEmoji, { threadId: msg.threadId });
    }

    // --- Update priming buffer ---
    if (getEnv().activeMemory) {
      const modelTopics = getEnv().primingModelTopics && topics ? topics : [];
      const regexKw = extractKeywords(text);
      const existing = sessions.get(sessionKey)?.primingTerms ?? [];
      sessions.getOrCreate(sessionKey).primingTerms = [...new Set([...modelTopics, ...regexKw, ...existing])].slice(0, PRIMING_MAX);
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
    if (isVoice && ttsConfig && !sessions.get(sessionKey)?.fullMode && adapter.sendVoice) {
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
        const failures = sessions.getOrCreate(sessionKey).compactFailures;

        if (pct >= getEnv().ctxCompactPct && failures < COMPACT_MAX_FAILURES) {
          const aggressive = pct >= getEnv().ctxAggressivePct;
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

            await runCompaction(transport, sessionKey, sessions);
            { const e = sessions.getOrCreate(sessionKey); e.ctxWarned = false; e.compactFailures = 0; }

            await adapter.sendMessage(channelId, "📦 Compaction complete.", { threadId: msg.threadId });
            if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, userId);
          } catch (err) {
            const entry = sessions.getOrCreate(sessionKey);
            entry.compactFailures++;
            logError(TAG, `Compaction failed (${entry.compactFailures}/${COMPACT_MAX_FAILURES})`, err);
            if (entry.compactFailures >= COMPACT_MAX_FAILURES) {
              await adapter.sendMessage(channelId, "⚠️ Compaction failing repeatedly — consider /reset", { threadId: msg.threadId });
            }
          }
        } else if (pct >= getEnv().ctxWarnPct && !sessions.getOrCreate(sessionKey).ctxWarned) {
          sessions.getOrCreate(sessionKey).ctxWarned = true;
          logInfo(TAG, `⚠️ Context at ${pct}% — warning threshold`);
          await adapter.sendMessage(channelId, `⚠️ Context window at ${pct}% — will auto-compact at ${getEnv().ctxCompactPct}%`, { threadId: msg.threadId });
        } else if (pct >= getEnv().ctxCompactPct && failures >= COMPACT_MAX_FAILURES) {
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
      await resetAndPrepare({ transport, sessionKey, reason: `ctx-overflow: ${errStr.slice(0, 100)}`, sessions });
      await adapter.sendMessage(channelId, "🔄 Context window full — session reset. Send your message again.", { threadId: msg.threadId }).catch(() => {});
    } else if (isTimeout) {
      logWarn(TAG, `Request timeout — not resetting session`);
      await adapter.sendMessage(channelId, "⏱️ Request timed out. Try again or /reset if stuck.", { threadId: msg.threadId }).catch(() => {});
    } else {
      await adapter.sendMessage(channelId, "❌ Something went wrong. Try /reset to start fresh.", { threadId: msg.threadId }).catch(() => {});
    }
  } finally {
    clearInterval(typingInterval);
    clearTimeout(typingTtlTimer);
    clearInterval(silentCheckTimer);
    transport.onToolCallStart = undefined;
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

  const soul = loadSoulBundle(memory);
  if (soul) {
    contextParts.push(soul);
    logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
  }

  // Inject current user identity (profile already in soul bundle via getSessionBundle)
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

  // Compaction path: skip session-context + wake-up (compaction summary has the context)
  const compSummary = compactionSummaries.get(sessionKey ?? "");
  if (compSummary && sessionKey) {
    contextParts.push(`[COMPACTED CONVERSATION]\n${compSummary}\n[/COMPACTED CONVERSATION]`);
    compactionSummaries.delete(sessionKey);
    logInfo(TAG, `Injected compaction summary (${compSummary.length} chars)`);
  } else {
    // Normal path: session-context (daily + recent msgs) + wake-up (time + flashback)
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
  sessions: SessionRegistry,
  platformMessageId?: number,
): string {
  const entry = sessions.getOrCreate(sessionKey);
  const isSessionStart = entry.pendingStart || !entry.seen;
  if (isSessionStart) {
    prompt = buildSessionStartPrompt(prompt, memory, userId, sessionKey);
  }
  entry.seen = true;
  entry.pendingStart = false;
  const userRole = loadUsers().byUserId.get(userId)?.role;
  if (userRole !== "guest") {
    memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), userId, sessionId: sessionKey, platformMessageId });
  }
  return prompt;
}
