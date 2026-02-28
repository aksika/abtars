import { loadAndValidateConfig } from "./components/config.js";
import { SecurityGate } from "./components/security-gate.js";
import { ResponseFormatter } from "./components/response-formatter.js";
import { TelegramApi } from "./components/telegram-api.js";
import { TelegramPoller } from "./components/telegram-poller.js";
import { TmuxClient } from "./components/tmux-client.js";
import { AcpTransport } from "./components/acp-transport.js";
import { transcribeAudio, type SttConfig } from "./components/stt.js";
import { synthesizeSpeech, type TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, logDebug } from "./components/logger.js";
import { loadMemoryConfig } from "./components/memory-config.js";
import { MemoryManager } from "./components/memory-manager.js";
import { DiscordApi } from "./components/discord-api.js";
import { DiscordPoller } from "./components/discord-poller.js";
import { DiscordSecurityGate } from "./components/discord-security-gate.js";
import { ChannelAdapter } from "./components/channel-adapter.js";
import { B2BRouter } from "./components/b2b-router.js";
import type { IKiroTransport } from "./components/kiro-transport.js";
import type { TelegramUpdate, DiscordInboundMessage } from "./types/index.js";

async function main(): Promise<void> {
  const config = await loadAndValidateConfig();
  setLogLevel(config.logLevel);

  // Initialize memory layer
  const memoryConfig = loadMemoryConfig();
  let memory: MemoryManager | null = null;
  if (memoryConfig.memoryEnabled) {
    memory = new MemoryManager(memoryConfig);
    await memory.initialize();
    logInfo("main", `🧠 Memory enabled (dir=${memoryConfig.memoryDir})`);
  } else {
    logInfo("main", "🧠 Memory disabled");
  }

  logInfo("main", `🚀 Bridge starting (log=${config.logLevel})`);

  const telegramApi = new TelegramApi(config.telegramBotToken);
  const securityGate = new SecurityGate(config.allowedUserIds);
  const formatter = new ResponseFormatter();

  let transport: IKiroTransport;

  if (config.kiroTransport === "tmux") {
    logInfo("main", `🖥️  tmux transport (session: ${config.tmuxSession})`);
    transport = new TmuxClient(
      config.tmuxSession,
      config.tmuxCaptureDelaySec,
      config.tmuxMaxWaitSec,
    );
  } else {
    logInfo("main", "🔌 ACP transport");
    transport = new AcpTransport(config.kiroCLIPath, config.workingDir);
  }

  await transport.initialize();
  logInfo("main", "✅ Transport ready");

  // Fetch bot username for @mention detection in groups
  const botInfo = await telegramApi.getMe();
  const botUsername = botInfo.username?.toLowerCase() ?? "";
  logInfo("main", `🤖 Bot: @${botInfo.username}`);

  // STT config
  const sttConfig: SttConfig | null = config.sttEnabled
    ? { provider: "groq", apiKey: config.groqApiKey, model: config.sttModel }
    : null;
  if (sttConfig) {
    logInfo("main", `🎤 STT enabled (${sttConfig.provider}/${sttConfig.model || "whisper-large-v3"})`);
  }

  // TTS config
  const ttsConfig: TtsConfig | null = config.ttsEnabled
    ? { voice: config.ttsVoice }
    : null;
  if (ttsConfig) {
    logInfo("main", `🔊 TTS enabled (Edge TTS / ${ttsConfig.voice})`);
  }

  const busyChats = new Set<string>();

  // Group conversation history buffer — keyed by "chatId:threadId"
  const GROUP_HISTORY_LIMIT = 50;
  type HistoryEntry = { sender: string; text: string; ts: number };
  const groupHistory = new Map<string, HistoryEntry[]>();

  function historyKey(chatId: number, threadId?: number): string {
    return threadId != null ? `${chatId}:${threadId}` : `${chatId}`;
  }

  function pushHistory(chatId: number, threadId: number | undefined, sender: string, text: string): void {
    const key = historyKey(chatId, threadId);
    let entries = groupHistory.get(key);
    if (!entries) {
      entries = [];
      groupHistory.set(key, entries);
    }
    entries.push({ sender, text, ts: Date.now() });
    // Trim to limit
    while (entries.length > GROUP_HISTORY_LIMIT) entries.shift();
  }

  function drainHistory(chatId: number, threadId?: number): string {
    const key = historyKey(chatId, threadId);
    const entries = groupHistory.get(key);
    if (!entries || entries.length === 0) return "";
    const lines = entries.map((e) => `[${e.sender}]: ${e.text}`);
    groupHistory.delete(key); // Clear after draining
    return "--- Recent conversation context ---\n" + lines.join("\n") + "\n--- End context ---\n\n";
  }

  /** Set an emoji reaction on a message. Pass empty string to remove. Silently ignores failures. */
  async function react(chatId: number, messageId: number, emoji: string): Promise<void> {
    try {
      const reaction = emoji ? [{ type: "emoji" as const, emoji }] : [];
      await telegramApi.setMessageReaction(chatId, messageId, reaction);
    } catch (err) {
      logDebug("main", `React failed (${emoji || "remove"}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    logDebug("main", `Update: ${JSON.stringify(update).slice(0, 200)}`);

    if (update.callback_query) {
      await telegramApi.answerCallbackQuery(update.callback_query.id);
      return;
    }

    // Handle emoji reactions on messages
    if (update.message_reaction) {
      const reaction = update.message_reaction;
      const user = reaction.user;
      if (!user || user.is_bot) return;

      const oldEmojis = new Set(reaction.old_reaction.map((r) => r.emoji));
      const added = reaction.new_reaction.filter((r) => !oldEmojis.has(r.emoji));
      if (added.length > 0) {
        const senderName = user.first_name || user.username || `id:${user.id}`;
        const emojis = added.map((r) => r.emoji).join("");
        logInfo("main", `Reaction ${emojis} from ${senderName} on msg ${reaction.message_id}`);
      }
      return;
    }

    const message = update.message;
    if (!message?.from) return;

    const hasText = Boolean(message.text);
    const hasVoice = Boolean(message.voice || message.audio);
    if (!hasText && !hasVoice) return;

    const chatId = message.chat.id;
    const threadId = message.message_thread_id;
    const messageId = message.message_id;
    const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
    const senderName = message.from.first_name || message.from.username || `id:${message.from.id}`;

    let text = message.text ?? "";
    let isVoiceNote = false;

    // --- Voice note handling ---
    if (hasVoice && !hasText) {
      if (!sttConfig) {
        if (isGroup) {
          pushHistory(chatId, threadId, senderName, "[voice note - STT disabled]");
        } else if (securityGate.authorize(message)) {
          await telegramApi.sendMessage(chatId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { message_thread_id: threadId });
        }
        return;
      }

      // Only transcribe for authorized users
      if (!securityGate.authorize(message)) {
        if (isGroup) pushHistory(chatId, threadId, senderName, "[voice note]");
        return;
      }

      try {
        await react(chatId, messageId, "👀");
        const voiceFile = message.voice || message.audio;
        const fileInfo = await telegramApi.getFile(voiceFile!.file_id);
        if (!fileInfo.file_path) throw new Error("No file_path returned");
        const audioBuffer = await telegramApi.downloadFile(fileInfo.file_path);
        const transcript = await transcribeAudio(audioBuffer, "voice.ogg", sttConfig);

        if (!transcript) {
          await react(chatId, messageId, "");
          if (isGroup) {
            pushHistory(chatId, threadId, senderName, "[voice note - empty]");
          } else {
            await telegramApi.sendMessage(chatId, "🤷 Couldn't transcribe the voice note.", { message_thread_id: threadId });
          }
          return;
        }

        // In groups: check if transcript mentions the bot
        if (isGroup) {
          const mentionRe = new RegExp(`@?${botUsername}\\b`, "i");
          if (!mentionRe.test(transcript) && !transcript.startsWith("/")) {
            await react(chatId, messageId, "");
            pushHistory(chatId, threadId, senderName, `[voice] ${transcript}`);
            logDebug("main", `Buffered voice transcript: "${transcript.slice(0, 60)}"`);
            return;
          }
          text = transcript.replace(mentionRe, "").trim();
        } else {
          text = transcript;
        }

        isVoiceNote = true;
        if (!text) { await react(chatId, messageId, ""); return; }
      } catch (err) {
        logError("main", "Voice transcription failed", err);
        await react(chatId, messageId, "");
        if (!isGroup) {
          await telegramApi.sendMessage(chatId, "❌ Voice transcription failed.", { message_thread_id: threadId });
        }
        return;
      }
    }

    // --- Text message group filtering ---
    if (!isVoiceNote && isGroup) {
      const mentionRe = new RegExp(`@${botUsername}\\b`, "i");
      const isMention = mentionRe.test(text);
      const isCommand = text.startsWith("/");

      if (!isMention && !isCommand) {
        pushHistory(chatId, threadId, senderName, text);
        logDebug("main", `Buffered group msg from ${senderName}: "${text.slice(0, 60)}"`);
        return;
      }

      if (isMention) {
        text = text.replace(mentionRe, "").trim();
        if (!text) return;
      }
    }

    // Security gate — only authorized users can trigger responses (voice already checked above)
    if (!isVoiceNote && !securityGate.authorize(message)) {
      if (isGroup) pushHistory(chatId, threadId, senderName, text);
      logWarn("main", `Unauthorized user ${message.from.id}`);
      return;
    }

    const sessionKey = `telegram:${chatId}`;

    if (text === "/new" || text === "/reset") {
      await transport.resetSession(sessionKey);
      if (isGroup) groupHistory.delete(historyKey(chatId, threadId));
      await telegramApi.sendMessage(chatId, "🔄 New session started.", { message_thread_id: threadId });
      logInfo("main", "Session reset");
      return;
    }

    if (text === "/status") {
      const status = transport.isReady ? "✅ Connected" : "❌ Disconnected";
      const mode = config.kiroTransport.toUpperCase();
      await telegramApi.sendMessage(chatId, `${status} (${mode} transport)`, { message_thread_id: threadId });
      return;
    }

    if (text === "/stop" || text === "/cancel") {
      await transport.sendInterrupt();
      busyChats.delete(sessionKey); // Unblock the chat
      await telegramApi.sendMessage(chatId, "🛑 Ctrl+C sent to Kiro.", { message_thread_id: threadId });
      logInfo("main", "Ctrl+C interrupt sent");
      return;
    }

    if (text === "/compact") {
      if (memory) {
        // Compaction requires an LLM call which we don't have a generic interface for yet
        await telegramApi.sendMessage(chatId, "📦 Compaction is not yet wired to an LLM. Coming soon.", { message_thread_id: threadId });
      } else {
        await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
      }
      return;
    }

    if (text === "/facts") {
      if (memory) {
        const facts = memory.readUserCoreFacts(chatId);
        const msg = facts ? `📋 Your facts:\n\n${facts}` : "📋 No facts stored yet.";
        await telegramApi.sendMessage(chatId, msg, { message_thread_id: threadId });
      } else {
        await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
      }
      return;
    }

    if (text === "/scratchpad") {
      if (memory) {
        const pad = memory.readScratchpad(chatId);
        const msg = pad ? `📝 Scratchpad:\n\n${pad}` : "📝 Scratchpad is empty.";
        await telegramApi.sendMessage(chatId, msg, { message_thread_id: threadId });
      } else {
        await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
      }
      return;
    }

    if (busyChats.has(sessionKey)) {
      await telegramApi.sendMessage(chatId, "⏳ Previous request still in progress...", { message_thread_id: threadId });
      return;
    }

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      // Record user message in memory
      if (memory) {
        memory.recordMessage({
          role: "user",
          content: text,
          timestamp: Date.now(),
          chatId,
          sessionId: sessionKey,
        });
      }

      busyChats.add(sessionKey);
      logInfo("main", `← ${isVoiceNote ? "🎤 " : ""}"${text.slice(0, 60)}"`);

      // In groups, prepend buffered conversation context
      let prompt = text;
      if (isGroup) {
        const context = drainHistory(chatId, threadId);
        if (context) {
          prompt = context + text;
          logDebug("main", `Prepended group context to prompt`);
        }
      }

      // Send prompt to Kiro, then react with 👀 (shows after message is forwarded)
      // TODO: Wire memory.assembleContext() when we have a direct LLM integration
      const responsePromise = transport.sendPrompt(sessionKey, prompt);

      // React + typing start right after sendPrompt kicks off (message is in tmux now)
      if (!isVoiceNote) await react(chatId, messageId, "👀");
      await telegramApi.sendChatAction(chatId, "typing", threadId);
      typingInterval = setInterval(() => {
        telegramApi.sendChatAction(chatId, "typing", threadId).catch(() => {});
      }, 8000);

      const response = await responsePromise;
      logDebug("main", `Response (${response.length} chars): "${response.slice(0, 120)}"`);

      if (!response || !response.trim()) {
        logWarn("main", "Empty response from transport");
        await react(chatId, messageId, "🤷");
        await telegramApi.sendMessage(chatId, "🤷 Kiro returned an empty response. Try again or /reset.", { message_thread_id: threadId });
        return;
      }

      const chunks = formatter.chunkText(response);
      logDebug("main", `Sending ${chunks.length} chunk(s)`);
      for (const chunk of chunks) {
        if (chunk.trim()) {
          await telegramApi.sendChatAction(chatId, "typing", threadId);
          await telegramApi.sendMessage(chatId, chunk, { message_thread_id: threadId });
        }
      }

      // Record assistant response in memory
      if (memory) {
        memory.recordMessage({
          role: "assistant",
          content: response,
          timestamp: Date.now(),
          chatId,
          sessionId: sessionKey,
        });
      }

      // TTS: if inbound was a voice note, also reply with a voice note
      if (isVoiceNote && ttsConfig) {
        try {
          await telegramApi.sendChatAction(chatId, "record_voice", threadId);
          // Use answer-only (last "> " block) for TTS — skips tool noise
          const ttsText = ("answerOnly" in transport && (transport as TmuxClient).answerOnly)
            ? (transport as TmuxClient).answerOnly
            : response;
          const audio = await synthesizeSpeech(ttsText, ttsConfig);
          if (audio) {
            await telegramApi.sendVoice(chatId, audio, { message_thread_id: threadId });
            logInfo("main", `🔊 Voice reply sent (${audio.length} bytes)`);
          }
        } catch (err) {
          logWarn("main", `TTS failed: ${err instanceof Error ? err.message : String(err)}`);
          // Text was already sent, so just log the TTS failure
        }
      }

      // Remove 👀 reaction — response delivered
      await react(chatId, messageId, "");
      logInfo("main", `→ Sent ${chunks.length} chunk(s) to chat ${chatId}`);
    } catch (err) {
      logError("main", `Error for chat ${chatId}`, err);
      await react(chatId, messageId, "");
      await telegramApi.sendMessage(chatId, "❌ Something went wrong. Try /reset to start fresh.", { message_thread_id: threadId });
    } finally {
      clearInterval(typingInterval);
      busyChats.delete(sessionKey);
    }
  }

  const telegramPoller = new TelegramPoller(telegramApi, config.pollTimeoutS, handleUpdate);
  try {
    telegramPoller.start();
    logInfo("main", "📡 Telegram polling started");
  } catch (err) {
    logError("main", "Telegram failed to start — continuing with Discord only", err);
  }

  // --- Discord wiring (conditional) ---
  let discordPoller: DiscordPoller | null = null;

  if (config.discordEnabled) {
    const discordApi = new DiscordApi(config.discordBotToken!);
    const discordSecurityGate = new DiscordSecurityGate(
      config.discordAllowedUserIds!,
      config.discordAllowedChannelIds!,
    );
    const channelAdapter = new ChannelAdapter();

    let b2bRouter: B2BRouter | null = null;
    if (config.discordB2bEnabled) {
      b2bRouter = new B2BRouter({
        discordApi,
        b2bChannelId: config.discordB2bChannelId!,
        peerBotId: config.discordB2bPeerBotId!,
        rateLimitMs: config.discordB2bRateLimitMs,
        onPrompt: (sessionKey, text) => transport.sendPrompt(sessionKey, text),
      });
      logInfo("main", `🤝 B2B router enabled (channel=${config.discordB2bChannelId})`);
    }

    const handleDiscordMessage = async (message: DiscordInboundMessage): Promise<void> => {
      logDebug("main", `Discord message from ${message.authorUsername} in ${message.channelId}`);

      // B2B channel messages go to B2BRouter
      if (b2bRouter && message.channelId === config.discordB2bChannelId) {
        await b2bRouter.handleMessage(message);
        return;
      }

      // Security gate — validate user + channel
      if (!discordSecurityGate.authorize(message.authorId, message.channelId)) {
        logDebug("main", `Discord: unauthorized user=${message.authorId} channel=${message.channelId}`);
        return;
      }

      const bridgeMsg = channelAdapter.fromDiscord(message);
      const sessionKey = channelAdapter.sessionKey("discord", message.channelId);
      const text = bridgeMsg.text.trim();

      if (!text) return;

      // Command handling
      if (text === "/new" || text === "/reset") {
        await transport.resetSession(sessionKey);
        await discordApi.sendMessage(message.channelId, "🔄 New session started.");
        logInfo("main", `Discord session reset for ${sessionKey}`);
        return;
      }

      if (text === "/status") {
        const status = transport.isReady ? "✅ Connected" : "❌ Disconnected";
        const mode = config.kiroTransport.toUpperCase();
        await discordApi.sendMessage(message.channelId, `${status} (${mode} transport)`);
        return;
      }

      if (text === "/b2b-reset") {
        if (config.discordB2bEnabled) {
          const b2bSessionKey = `b2b:${config.discordB2bChannelId}`;
          await transport.resetSession(b2bSessionKey);
          await discordApi.sendMessage(message.channelId, "🔄 B2B session reset.");
          logInfo("main", `B2B session reset by user ${message.authorId}`);
        } else {
          await discordApi.sendMessage(message.channelId, "B2B is not enabled.");
        }
        return;
      }

      // Busy check
      if (busyChats.has(sessionKey)) {
        await discordApi.sendMessage(message.channelId, "⏳ Previous request still in progress...");
        return;
      }

      try {
        busyChats.add(sessionKey);
        logInfo("main", `← Discord: "${text.slice(0, 60)}"`);

        const response = await transport.sendPrompt(sessionKey, text);

        if (!response || !response.trim()) {
          logWarn("main", "Empty response from transport (Discord)");
          await discordApi.sendMessage(message.channelId, "🤷 Kiro returned an empty response. Try again or /reset.");
          return;
        }

        const chunks = formatter.chunkForPlatform(response, "discord");
        logDebug("main", `Discord: sending ${chunks.length} chunk(s)`);
        for (const chunk of chunks) {
          if (chunk.trim()) {
            await discordApi.sendMessage(message.channelId, chunk);
          }
        }
        logInfo("main", `→ Discord: sent ${chunks.length} chunk(s) to ${message.channelId}`);
      } catch (err) {
        logError("main", `Discord error for channel ${message.channelId}`, err);
        await discordApi.sendMessage(message.channelId, "❌ Something went wrong. Try /reset to start fresh.").catch(() => {});
      } finally {
        busyChats.delete(sessionKey);
      }
    }

    discordPoller = new DiscordPoller(discordApi, handleDiscordMessage);
    try {
      await discordPoller.start();
      logInfo("main", "📡 Discord polling started");
    } catch (err) {
      logError("main", "Discord failed to start — continuing with Telegram only", err);
      discordPoller = null;
    }
  }

  function shutdown(): void {
    logInfo("main", "🛑 Shutting down...");
    telegramPoller.stop();
    if (discordPoller) discordPoller.stop();
    transport.destroy();
    memory?.close();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
