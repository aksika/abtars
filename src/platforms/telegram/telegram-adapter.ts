/**
 * Telegram platform adapter — wraps TelegramApi, TelegramPoller, SecurityGate.
 * Handles Telegram-specific pre-processing (voice, reactions, groups, mentions)
 * then delegates to the shared message pipeline.
 */

import { TelegramApi } from "./telegram-api.js";
import { TelegramPoller } from "./telegram-poller.js";
import { SecurityGate } from "../../components/security-gate.js";
import { ResponseFormatter } from "../../components/response-formatter.js";
import { formatReactionSignal } from "../../components/reaction-signal.js";
import { routeReaction } from "../../components/reaction-router.js";
import { emojiToScore } from "../../memory/emotion-utils.js";
import { logInfo, logWarn, logError, logDebug } from "../../components/logger.js";
import { writeRestartReason } from "../../components/restart-reason.js";
import { handleInboundMessage, type PipelineDeps } from "../../components/message-pipeline.js";
import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import type { TelegramUpdate } from "../../types/index.js";
import type { ConversationBuffer } from "../../components/conversation-buffer.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { MemoryManager } from "../../memory/memory-manager.js";

const TAG = "telegram";

export interface TelegramAdapterConfig {
  botToken: string;
  allowedUserIds: Set<number>;
  pollTimeoutS: number;
}

export interface TelegramAdapterDeps {
  pipeline: PipelineDeps;
  conversationBuffer: ConversationBuffer;
  transport: IKiroTransport;
  memory: MemoryManager | null;
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram" as const;
  readonly capabilities: PlatformCapabilities = {
    voice: true,
    reactions: true,
    typing: true,
    threads: true,
  };

  private readonly api: TelegramApi;
  private readonly securityGate: SecurityGate;
  private readonly formatter = new ResponseFormatter();
  private readonly config: TelegramAdapterConfig;
  private readonly deps: TelegramAdapterDeps;
  private poller: TelegramPoller | null = null;
  private botUsername = "";

  constructor(config: TelegramAdapterConfig, deps: TelegramAdapterDeps) {
    this.api = new TelegramApi(config.botToken);
    this.securityGate = new SecurityGate(new Set([...config.allowedUserIds].map(String)));
    this.config = config;
    this.deps = deps;
  }

  async start(): Promise<void> {
    const botInfo = await this.api.getMe();
    this.botUsername = botInfo.username?.toLowerCase() ?? "";
    logInfo(TAG, `🤖 Bot: @${botInfo.username}`);

    await this.api.setMyCommands([
      { command: "new", description: "Fresh session (keeps mode)" },
      { command: "reset", description: "Fresh session + exit coding" },
      { command: "compact", description: "Compact context window" },
      { command: "status", description: "Bridge status" },
      { command: "stop", description: "Stop current response" },
      { command: "tasks", description: "Scheduled tasks" },
      { command: "memory", description: "Memory stats" },
      { command: "facts", description: "Core knowledge" },
      { command: "coding", description: "Switch to coding agent" },
      { command: "default", description: "Switch to default agent" },
      { command: "full", description: "Raw output, TTS off" },
      { command: "short", description: "Clean output, TTS on" },
      { command: "help", description: "Show all commands" },
    ]).catch((err) => logWarn(TAG, `setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`));

    this.poller = new TelegramPoller(this.api, this.config.pollTimeoutS, (u) => this.handleUpdate(u));
    this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
  }

  authorize(msg: InboundMessage): boolean {
    return this.securityGate.authorize(msg.senderId);
  }

  async sendMessage(channelId: string, text: string, opts?: SendOpts): Promise<number | undefined> {
    const chatId = parseInt(channelId, 10);
    const sendOpts: Record<string, unknown> = {};
    if (opts?.threadId) sendOpts.message_thread_id = parseInt(opts.threadId, 10);
    if (opts?.parseMode) sendOpts.parse_mode = opts.parseMode;
    if (opts?.reply_markup) sendOpts.reply_markup = opts.reply_markup;
    return this.api.sendMessage(chatId, text, sendOpts);
  }

  async editMessage(channelId: string, messageId: number, text: string): Promise<void> {
    const chatId = parseInt(channelId, 10);
    await this.api.editMessageText(chatId, messageId, text);
  }

  chunkResponse(text: string): string[] {
    return this.formatter.chunkText(text);
  }

  async sendTyping(channelId: string, threadId?: string): Promise<void> {
    await this.api.sendChatAction(parseInt(channelId, 10), "typing", threadId ? parseInt(threadId, 10) : undefined);
  }

  async setReaction(channelId: string, messageId: number, emoji: string): Promise<void> {
    if (messageId <= 0) return;
    try {
      const reaction = emoji ? [{ type: "emoji" as const, emoji }] : [];
      await this.api.setMessageReaction(parseInt(channelId, 10), messageId, reaction);
    } catch (err) {
      logDebug(TAG, `React failed (${emoji || "remove"}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async downloadVoice(fileId: string): Promise<Buffer> {
    const fileInfo = await this.api.getFile(fileId);
    if (!fileInfo.file_path) throw new Error("No file_path returned");
    return this.api.downloadFile(fileInfo.file_path);
  }

  async sendVoice(channelId: string, audio: Buffer, opts?: SendOpts): Promise<void> {
    const sendOpts: Record<string, unknown> = {};
    if (opts?.threadId) sendOpts.message_thread_id = parseInt(opts.threadId, 10);
    await this.api.sendVoice(parseInt(channelId, 10), audio, sendOpts);
  }

  injectMessage(msg: InboundMessage): void {
    if (!this.poller) return;
    this.poller.injectUpdate({
      update_id: 0,
      message: {
        message_id: 0,
        from: { id: parseInt(msg.channelId, 10), is_bot: false, first_name: "queued" },
        chat: { id: parseInt(msg.channelId, 10), type: "private" },
        date: Math.floor(Date.now() / 1000),
        text: msg.text,
        ...(msg.threadId ? { message_thread_id: parseInt(msg.threadId, 10) } : {}),
      },
    });
  }

  // --- Internal: Telegram update handler ---

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    logDebug(TAG, `Update: ${JSON.stringify(update).slice(0, 200)}`);

    if (update.callback_query) {
      await this.api.answerCallbackQuery(update.callback_query.id);
      const data = update.callback_query.data ?? "";
      if (data.startsWith("model:")) {
        const newModel = data.slice(6);
        const transport = this.deps.transport;
        if ("setModel" in transport && typeof (transport as { setModel: unknown }).setModel === "function") {
          (transport as { setModel: (m: string) => void }).setModel(newModel);
          const chatId = update.callback_query.message?.chat?.id;
          if (chatId) await this.api.sendMessage(chatId, `🤖 Model switched → ${newModel}`);
        }
      }
      return;
    }

    if (update.message_reaction) {
      await this.handleReaction(update);
      return;
    }

    const message = update.message;
    if (!message?.from) return;

    const hasText = Boolean(message.text);
    const hasVoice = Boolean(message.voice || message.audio);
    const hasPhoto = Boolean(message.photo?.length);
    const hasDocument = Boolean(message.document);
    if (!hasText && !hasVoice && !hasPhoto && !hasDocument) return;

    const chatId = message.chat.id;
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    const threadId = isGroup ? message.message_thread_id : undefined;
    const messageId = message.message_id;
    const senderName = message.from.first_name || message.from.username || `id:${message.from.id}`;
    const bufKey = threadId != null ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;

    let text = message.text ?? "";
    let isVoiceNote = false;
    let voiceFileId: string | undefined;

    // --- Voice note pre-processing ---
    if (hasVoice && !hasText) {
      if (!this.deps.pipeline.sttConfig) {
        if (isGroup) {
          this.deps.conversationBuffer.push(bufKey, senderName, "[voice note - STT disabled]");
        } else if (this.securityGate.authorize(String(message.from?.id))) {
          await this.api.sendMessage(chatId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { message_thread_id: threadId });
        }
        return;
      }

      if (!this.securityGate.authorize(String(message.from?.id))) {
        if (isGroup) this.deps.conversationBuffer.push(bufKey, senderName, "[voice note]");
        return;
      }

      // For groups: we need to transcribe first to check for bot mention
      if (isGroup) {
        try {
          await this.setReaction(String(chatId), messageId, "👀");
          const voiceFile = message.voice || message.audio;
          const audioBuffer = await this.downloadVoice(voiceFile!.file_id);
          const { transcribeAudio } = await import("../../components/stt.js");
          const transcript = await transcribeAudio(audioBuffer, "voice.ogg", this.deps.pipeline.sttConfig!);

          if (!transcript) {
            await this.setReaction(String(chatId), messageId, "");
            this.deps.conversationBuffer.push(bufKey, senderName, "[voice note - empty]");
            return;
          }

          const mentionRe = new RegExp(`@?${this.botUsername}\\b`, "i");
          if (!mentionRe.test(transcript) && !transcript.startsWith("/")) {
            await this.setReaction(String(chatId), messageId, "");
            this.deps.conversationBuffer.push(bufKey, senderName, `[voice] ${transcript}`);
            logDebug(TAG, `Buffered voice transcript: "${transcript.slice(0, 60)}"`);
            return;
          }
          text = transcript.replace(mentionRe, "").trim();
          isVoiceNote = true;
          if (!text) { await this.setReaction(String(chatId), messageId, ""); return; }
        } catch (err) {
          logError(TAG, "Voice transcription failed", err);
          await this.setReaction(String(chatId), messageId, "");
          return;
        }
      } else {
        // DM voice: let pipeline handle STT
        isVoiceNote = true;
        voiceFileId = (message.voice || message.audio)!.file_id;
      }
    }

    // --- Group text filtering ---
    if (!isVoiceNote && isGroup) {
      const mentionRe = new RegExp(`@${this.botUsername}\\b`, "i");
      const isMention = mentionRe.test(text);
      const isCommand = text.startsWith("/");

      if (!isMention && !isCommand) {
        this.deps.conversationBuffer.push(bufKey, senderName, text);
        logDebug(TAG, `Buffered group msg from ${senderName}: "${text.slice(0, 60)}"`);
        return;
      }

      if (isMention) {
        text = text.replace(mentionRe, "").trim();
        if (!text) return;
      }
    }

    // --- Security ---
    if (!isVoiceNote && !this.securityGate.authorize(String(message.from?.id))) {
      if (isGroup) this.deps.conversationBuffer.push(bufKey, senderName, text);
      logWarn(TAG, `Unauthorized user ${message.from.id}`);
      return;
    }

    // --- Photo/document handling ---
    let mediaPath: string | undefined;

    if ((hasPhoto || hasDocument) && this.securityGate.authorize(String(message.from?.id))) {
      try {
        const { saveInboundMedia } = await import("../../components/media-utils.js");
        let fileId: string;
        let extHint: string | undefined;
        let claimedMime: string | undefined;

        if (hasPhoto) {
          const photo = message.photo![message.photo!.length - 1]!;
          fileId = photo.file_id;
          extHint = ".jpg";
        } else {
          fileId = message.document!.file_id;
          extHint = message.document!.file_name ? "." + (message.document!.file_name.split(".").pop() ?? "") : undefined;
          claimedMime = message.document!.mime_type;
        }

        const buf = await this.downloadVoice(fileId); // reuse file download
        const saved = await saveInboundMedia(buf, chatId, { extHint, claimedMime });
        if (saved) {
          mediaPath = saved.path;
          if (!text) text = message.caption ?? `User sent a ${saved.isImage ? "photo" : "file"}.`;
        } else {
          if (!text) text = "⚠️ File too large (max 16MB).";
        }
      } catch (err) {
        logWarn(TAG, `Media download failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!text) text = "⚠️ Failed to download media.";
      }
    }

    // --- Reply context ---
    const reply = message.reply_to_message;
    if (reply?.text) {
      const replyFrom = reply.from?.first_name ?? "someone";
      text = `[Replying to ${replyFrom}: "${reply.text.slice(0, 500)}"]\n${text}`;
    }

    // --- Dispatch to pipeline ---
    const inbound: InboundMessage = {
      platform: "telegram",
      channelId: String(chatId),
      sessionKey: `telegram:${chatId}`,
      senderId: String(message.from.id),
      senderName,
      text,
      timestamp: message.date * 1000,
      threadId: threadId != null ? String(threadId) : undefined,
      messageId,
      isGroup,
      isVoice: isVoiceNote,
      voiceFileId,
      mediaPath,
      rawPlatformData: message,
    };

    // /stop, /ctrlc, /restart bypass the pipeline queue
    const trimText = (text ?? "").trim();
    if (trimText === "/stop" || trimText === "/ctrlc") {
      await this.deps.pipeline.transport.sendInterrupt();
      this.deps.pipeline.busyChats.delete(`telegram:${chatId}`);
      await this.api.sendMessage(chatId, "🛑 Stopped.");
      logInfo(TAG, "Immediate cancel via /stop");
      return;
    }
    if (trimText === "/restart") {
      await this.api.sendMessage(chatId, "♻️ Restarting bridge...");
      writeRestartReason("user-restart");
      setTimeout(() => this.deps.pipeline.requestShutdown?.(), 500);
      return;
    }

    await handleInboundMessage(inbound, this, this.deps.pipeline);
  }

  private async handleReaction(update: TelegramUpdate): Promise<void> {
    const reaction = update.message_reaction!;
    const user = reaction.user;
    if (!user) { logDebug(TAG, "Reaction update missing user field"); return; }
    if (user.is_bot) return;

    const oldEmojis = new Set(reaction.old_reaction.map((r) => r.emoji));
    const added = reaction.new_reaction.filter((r) => !oldEmojis.has(r.emoji));
    if (added.length === 0) return;

    const senderName = user.first_name || user.username || `id:${user.id}`;
    const emojis = added.map((r) => r.emoji);
    logInfo(TAG, `Reaction ${emojis.join("")} from ${senderName} on msg ${reaction.message_id}`);

    const isAuthorized = this.securityGate.authorize(String(user.id));
    const signal = formatReactionSignal(senderName, emojis);
    const chatId = reaction.chat.id;
    const route = routeReaction(isAuthorized, reaction.chat.type);

    if (isAuthorized && this.deps.memory) {
      const score = emojiToScore(emojis[0]!);
      const updated = this.deps.memory.updateEmotionByPlatformId(chatId, reaction.message_id, score);
      if (updated) logDebug(TAG, `Emotion score ${score} set on platform msg ${reaction.message_id}`);
    }

    if (route === "discard") {
      logDebug(TAG, `Unauthorized reaction from user ${user.id}, discarding`);
      return;
    }

    if (route === "buffer") {
      const bufKey = `tg:${chatId}`;
      this.deps.conversationBuffer.push(bufKey, senderName, signal);
      logDebug(TAG, `Buffered reaction signal for group ${chatId}`);
    } else {
      const sessionKey = `telegram:${chatId}`;
      try {
        await this.deps.transport.sendPrompt(sessionKey, signal);
        logDebug(TAG, `Sent reaction signal to transport for chat ${chatId}`);
      } catch (err) {
        logError(TAG, `Failed to send reaction signal for chat ${chatId}`, err);
      }
    }
  }
}
