/**
 * Shared message-handling pipeline for all platforms.
 * Handles: command dispatch → sleep check → prompt build → transport →
 * streaming → response delivery → memory → auto-compact.
 */

import { logInfo, logWarn, logError, logDebug } from "./logger.js";
import { handleCommand, type CommandContext, type Reply } from "./command-handlers.js";
import { interceptLargeMessage } from "./message-interceptor.js";
import { buildSessionStartContext } from "./session-context.js";
import { loadSoulBundle } from "./soul-loader.js";
import { TmuxClient } from "./tmux-client.js";
import { AcpTransport } from "./acp-transport.js";
import { transcribeAudio, type SttConfig } from "./stt.js";
import { synthesizeSpeech, type TtsConfig } from "./tts.js";
import type { IKiroTransport } from "./kiro-transport.js";
import type { MemoryManager } from "./memory-manager.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";
import type { SleepQueue } from "./sleep-queue.js";
import type { ConversationBuffer } from "./conversation-buffer.js";
import type { RunningJob } from "./cron-queue.js";
import type { InboundMessage, PlatformAdapter } from "../types/platform.js";

const TAG = "pipeline";

export interface PipelineDeps {
  transport: IKiroTransport;
  codingMode: CodingMode;
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  nlmConfig: { enabled: boolean; [k: string]: unknown };
  sleepQueue: SleepQueue;
  idleSave: IdleSave;
  conversationBuffer: ConversationBuffer;
  config: { agentTransport: string; workingDir: string; discordA2aEnabled?: boolean; discordA2aChannelId?: string };
  startedAt: number;
  sttConfig: SttConfig | null;
  ttsConfig: TtsConfig | null;
  // Shared mutable state
  busyChats: Set<string>;
  fullModeChats: Set<string>;
  pendingSessionStart: Set<string>;
  seenSessions: Set<string>;
  updateCtxStart: (memoryDir: string, chatId: number) => void;
  cronCurrentJob?: () => RunningJob | null;
  enqueueCron?: (entryId: string) => string | null;
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
  const {
    transport, codingMode, memory, memoryConfig, nlmConfig,
    sleepQueue, idleSave, conversationBuffer, config, startedAt,
    sttConfig, ttsConfig,
    busyChats, fullModeChats, pendingSessionStart, seenSessions, updateCtxStart,
  } = deps;

  const { sessionKey, channelId, text: rawText, isVoice, isGroup } = msg;
  const chatId = parseInt(channelId, 10) || 0;
  let text = rawText;

  // --- Voice transcription ---
  if (isVoice && msg.voiceFileId && adapter.downloadVoice && sttConfig) {
    try {
      if (adapter.setReaction && msg.messageId) {
        await adapter.setReaction(channelId, msg.messageId, "👀");
      }
      const audioBuffer = await adapter.downloadVoice(msg.voiceFileId);
      const transcript = await transcribeAudio(audioBuffer, "voice.ogg", sttConfig);
      if (!transcript) {
        if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "");
        await adapter.sendMessage(channelId, "🤷 Couldn't transcribe the voice note.", { threadId: msg.threadId });
        return;
      }
      text = transcript;
    } catch (err) {
      logError(TAG, "Voice transcription failed", err);
      if (adapter.setReaction && msg.messageId) await adapter.setReaction(channelId, msg.messageId, "");
      await adapter.sendMessage(channelId, "❌ Voice transcription failed.", { threadId: msg.threadId });
      return;
    }
  } else if (isVoice && !sttConfig) {
    await adapter.sendMessage(channelId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { threadId: msg.threadId });
    return;
  }

  // --- Command handling ---
  const reply: Reply = (replyText, opts) => adapter.sendMessage(channelId, replyText, { threadId: msg.threadId, ...opts });
  const cmdCtx: CommandContext = {
    sessionKey, chatId, platform: msg.platform, reply,
    transport, config, startedAt,
    memory, memoryConfig, nlmConfig,
    codingMode, idleSave,
    busyChats, fullModeChats, pendingSessionStart,
    updateCtxStart,
    cronCurrentJob: deps.cronCurrentJob?.() ?? null,
    enqueueCron: deps.enqueueCron,
    conversationBuffer: isGroup ? conversationBuffer : undefined,
    bufKey: isGroup ? `${msg.platform}:${channelId}` : undefined,
  };
  if (await handleCommand(text, cmdCtx)) return;

  // // prefix → pass-through to Kiro
  if (text.startsWith("//")) text = text.slice(1);

  // --- Busy check ---
  if (busyChats.has(sessionKey)) {
    await adapter.sendMessage(channelId, "⏳ Previous request still in progress...", { threadId: msg.threadId });
    return;
  }

  let typingInterval: ReturnType<typeof setInterval> | undefined;
  try {
    busyChats.add(sessionKey);
    const ctxPct = "contextPercent" in transport ? (transport as { contextPercent: number }).contextPercent : -1;
    logInfo(TAG, `← [${msg.platform}] ${isVoice ? "🎤 " : ""}"${text.slice(0, 60)}"${ctxPct >= 0 ? ` (ctx: ${ctxPct}%)` : ""}`);
    // --- Sleep queue ---
    if (sleepQueue.isActive) {
      const isFirst = sleepQueue.enqueue({
        sessionKey, channelId, text,
        threadId: msg.threadId, platform: msg.platform,
      });
      if (isFirst) {
        await adapter.sendMessage(channelId, "Oh good morning, I am just waking up, give me a minute please.. I answer you soon ☕", { threadId: msg.threadId });
      }
      busyChats.delete(sessionKey);
      return;
    }

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

    if (memory) {
      prompt = preparePrompt(prompt, memory, chatId, sessionKey, text, pendingSessionStart, seenSessions, msg.messageId);
    }

    prompt = interceptLargeMessage(prompt).text;

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

    if (transport instanceof TmuxClient) {
      (transport as TmuxClient).onIntermediateResponse = (chunk: string) => {
        intermediateDelivered = true;
        const chunks = adapter.chunkResponse(chunk);
        for (const c of chunks) {
          if (c.trim()) {
            adapter.sendTyping?.(channelId, msg.threadId).catch(() => {});
            adapter.sendMessage(channelId, c, { threadId: msg.threadId }).catch(() => {});
          }
        }
      };
    } else if (transport instanceof AcpTransport && adapter.editMessage) {
      const rawVal = parseInt(process.env["STREAM_FLUSH_SEC"] ?? "3", 10);
      const FLUSH_INTERVAL = rawVal === 0 ? 0 : Math.max(2, Math.min(180, rawVal)) * 1000;
      let lastFlushed = "";

      (transport as AcpTransport).onIntermediateResponse = (chunk: string) => {
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
    }

    const response = await responsePromise;

    if (transport instanceof TmuxClient) {
      (transport as TmuxClient).onIntermediateResponse = undefined;
    }
    if (transport instanceof AcpTransport) {
      clearInterval(streamTimer);
      (transport as AcpTransport).onIntermediateResponse = undefined;
    }
    logDebug(TAG, `Response (${response.length} chars): "${response.slice(0, 120)}"`);

    // --- Extract clean answer ---
    const cleanAnswer = ("answerOnly" in transport && (transport as TmuxClient).answerOnly)
      ? (transport as TmuxClient).answerOnly : "";
    const userResponse = (fullModeChats.has(sessionKey) ? response : (cleanAnswer || response))
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

    // --- <NO_REPLY> → silently drop (group chats) ---
    if (userResponse.trim() === "<NO_REPLY>") {
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

    // --- [REACT:emoji] ---
    if (adapter.setReaction && msg.messageId) {
      const reactMatch = userResponse.trim().match(/^\[REACT:(.+)\]$/);
      if (reactMatch) {
        const emoji = reactMatch[1]!;
        // Telegram only allows specific reactions — map unsupported to closest allowed
        const TELEGRAM_ALLOWED = new Set(["👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩","🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤‍🔥","🌚","🌭","💯","🤣","⚡","🍌","🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨‍💻","👀","🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿","🆒","💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷‍♂","🤷","🤷‍♀","😡"]);
        const FALLBACK_MAP: Record<string, string> = {
          "😅": "🤣", "😂": "🤣", "😆": "😁", "😄": "😁", "😃": "😁",
          "🙂": "😁", "😊": "😁", "☺": "😁", "😉": "😁", "🫠": "🤪",
          "😞": "😢", "😔": "😢", "😟": "😢", "😕": "🤔", "🫤": "🤨",
          "😤": "😡", "😠": "😡", "💪": "👏", "🤞": "🙏", "✅": "👍",
          "❌": "👎", "😬": "🙈", "🫣": "🙈", "🤭": "🙊", "💀": "👻",
        };
        const fallback = TELEGRAM_ALLOWED.has(emoji) ? emoji : (FALLBACK_MAP[emoji] ?? null);
        if (fallback) {
          await adapter.setReaction(channelId, msg.messageId, fallback);
        } else {
          await adapter.sendMessage(channelId, emoji, { threadId: msg.threadId });
        }
        logDebug(TAG, `Reaction-only response: ${emoji}${fallback && emoji !== fallback ? ` → ${fallback}` : ""}${!fallback ? " (sent as message)" : ""}`);
        return;
      }
    }

    // --- Deliver response ---
    let lastSentMsgId: number | undefined;
    if (!intermediateDelivered) {
      const chunks = adapter.chunkResponse(userResponse);
      logDebug(TAG, `Sending ${chunks.length} chunk(s)`);
      for (const chunk of chunks) {
        if (chunk.trim()) {
          await adapter.sendTyping?.(channelId, msg.threadId);
          lastSentMsgId = await adapter.sendMessage(channelId, chunk, { threadId: msg.threadId });
        }
      }
    } else if (streamMsgId && adapter.editMessage) {
      // ACP edit-in-place: final edit removes cursor ▍
      try {
        await adapter.editMessage(channelId, streamMsgId, userResponse);
        lastSentMsgId = streamMsgId;
      } catch { /* final edit may fail if identical */ }
    } else if (transport instanceof TmuxClient) {
      // Send any tail not yet delivered by intermediate streaming
      const delivered = (transport as TmuxClient).intermediateDeliveredText;
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

    const ctxAfter = "contextPercent" in transport ? (transport as { contextPercent: number }).contextPercent : -1;
    logInfo(TAG, `→ [${msg.platform}] Response delivered${intermediateDelivered ? " (streamed)" : ""}${ctxAfter >= 0 ? ` (ctx: ${ctxAfter}%)` : ""}`);

    // --- Auto-compact ---
    if (memory && "contextPercent" in transport) {
      const pct = (transport as { contextPercent: number }).contextPercent;
      const threshold = memory.getConfig().searchEnhancements.compactThresholdPct;
      if (pct >= threshold) {
        logInfo(TAG, `⚠️ Context window at ${pct}% (threshold: ${threshold}%) — auto-compacting`);
        await adapter.sendMessage(channelId, `📦 Context window at ${pct}% — auto-compacting...`, { threadId: msg.threadId });
        try {
          await memory.checkAutoCompact({
            chatId, sessionId: sessionKey, contextPercent: pct,
            sendCompactCommand: (sk, cmd) => transport.sendPrompt(sk, cmd),
          });
          await adapter.sendMessage(channelId, "📦 Auto-compaction complete.", { threadId: msg.threadId });
          if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, chatId);
        } catch (err) {
          logError(TAG, "Auto-compaction failed", err);
        }
      }
    }
  } catch (err) {
    logError(TAG, `Error for ${sessionKey}`, err);
    if (adapter.setReaction && msg.messageId) {
      await adapter.setReaction(channelId, msg.messageId, "").catch(() => {});
    }
    await adapter.sendMessage(channelId, "❌ Something went wrong. Try /reset to start fresh.", { threadId: msg.threadId }).catch(() => {});
  } finally {
    clearInterval(typingInterval);
    busyChats.delete(sessionKey);
    idleSave.reset(sessionKey, chatId);
  }
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
    const soul = loadSoulBundle();
    if (soul) {
      prompt = soul + "\n\n" + prompt;
      logInfo(TAG, `Injected soul bundle (${soul.length} chars)`);
    }
    const ctx = buildSessionStartContext(memory, chatId);
    if (ctx) {
      prompt = ctx + "\n\n" + prompt;
      logInfo(TAG, `Injected session-start context (${ctx.length} chars)`);
    }
  }
  seen.add(sessionKey);
  pending.delete(sessionKey);
  memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), chatId, sessionId: sessionKey, platformMessageId });
  return prompt;
}
