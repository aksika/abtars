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
import { ConversationBuffer } from "./components/conversation-buffer.js";
import { DiscordApi } from "./components/discord-api.js";
import { DiscordPoller } from "./components/discord-poller.js";
import { DiscordSecurityGate } from "./components/discord-security-gate.js";
import { ChannelAdapter } from "./components/channel-adapter.js";
import { B2BRouter } from "./components/b2b-router.js";
import type { IKiroTransport } from "./components/kiro-transport.js";
import type { TelegramUpdate, DiscordInboundMessage } from "./types/index.js";

/**
 * Parse --telegram / --discord / --all CLI flags.
 * No flags → telegram only (default).
 * --all → every platform.
 * Individual flags can be combined: --telegram --discord
 */
function parsePlatformFlags(): { telegram: boolean; discord: boolean } {
  const args = process.argv.slice(2);
  if (args.includes("--all")) return { telegram: true, discord: true };
  const hasTelegram = args.includes("--telegram");
  const hasDiscord = args.includes("--discord");
  if (!hasTelegram && !hasDiscord) return { telegram: true, discord: false };
  return { telegram: hasTelegram, discord: hasDiscord };
}

/** Strip the bot's own Discord mention tag from text. Other mentions are preserved. */
function stripDiscordMentions(text: string, botAppId: string): string {
  return text.replace(new RegExp(`<@!?${botAppId}>`, "g"), "").replace(/\s{2,}/g, " ").trim();
}

/** Send a platform context announcement to the transport so the LLM knows which platform is active. */
async function announcePlatform(
  transport: IKiroTransport,
  platform: string,
): Promise<void> {
  const ts = new Date().toISOString();
  const msg = `[SYSTEM] Platform: ${platform} | Connected at: ${ts} | Refer to your CHATS.md steering for ${platform}-specific behavior.`;
  const sessionKey = `system:${platform.toLowerCase()}`;
  try {
    await transport.sendPrompt(sessionKey, msg);
    logInfo("main", `📢 Announced ${platform} platform to transport`);
  } catch (err) {
    logWarn("main", `Failed to announce ${platform} platform: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const platforms = parsePlatformFlags();
  const config = await loadAndValidateConfig();
  setLogLevel(config.logLevel);

  const enabledList = [
    platforms.telegram && "telegram",
    platforms.discord && "discord",
  ].filter(Boolean).join(", ");
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${config.logLevel})`);

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

  const formatter = new ResponseFormatter();

  // Shared conversation buffer for both platforms
  const conversationBuffer = new ConversationBuffer(50);

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

  // Wire LLM callback into memory so compaction and context assembly can use the LLM
  if (memory) {
    memory.setLlmCall(async (prompt: string, content: string) => {
      return transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
    });
    logInfo("main", "🧠 Memory LLM callback registered");
  }

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

  // --- Telegram wiring (conditional) ---
  let telegramPoller: TelegramPoller | null = null;

  if (platforms.telegram) {
    const telegramApi = new TelegramApi(config.telegramBotToken);
    const securityGate = new SecurityGate(config.allowedUserIds);

    const botInfo = await telegramApi.getMe();
    const botUsername = botInfo.username?.toLowerCase() ?? "";
    logInfo("main", `🤖 Telegram bot: @${botInfo.username}`);

    const react = async (chatId: number, messageId: number, emoji: string): Promise<void> => {
      try {
        const reaction = emoji ? [{ type: "emoji" as const, emoji }] : [];
        await telegramApi.setMessageReaction(chatId, messageId, reaction);
      } catch (err) {
        logDebug("main", `React failed (${emoji || "remove"}): ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const tgBufferKey = (chatId: number, threadId?: number): string =>
      threadId != null ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;

    const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
      logDebug("main", `Update: ${JSON.stringify(update).slice(0, 200)}`);

      if (update.callback_query) {
        await telegramApi.answerCallbackQuery(update.callback_query.id);
        return;
      }

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
      const bufKey = tgBufferKey(chatId, threadId);

      let text = message.text ?? "";
      let isVoiceNote = false;

      // --- Voice note handling ---
      if (hasVoice && !hasText) {
        if (!sttConfig) {
          if (isGroup) {
            conversationBuffer.push(bufKey, senderName, "[voice note - STT disabled]");
          } else if (securityGate.authorize(message)) {
            await telegramApi.sendMessage(chatId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { message_thread_id: threadId });
          }
          return;
        }

        if (!securityGate.authorize(message)) {
          if (isGroup) conversationBuffer.push(bufKey, senderName, "[voice note]");
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
              conversationBuffer.push(bufKey, senderName, "[voice note - empty]");
            } else {
              await telegramApi.sendMessage(chatId, "🤷 Couldn't transcribe the voice note.", { message_thread_id: threadId });
            }
            return;
          }

          if (isGroup) {
            const mentionRe = new RegExp(`@?${botUsername}\\b`, "i");
            if (!mentionRe.test(transcript) && !transcript.startsWith("/")) {
              await react(chatId, messageId, "");
              conversationBuffer.push(bufKey, senderName, `[voice] ${transcript}`);
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
          conversationBuffer.push(bufKey, senderName, text);
          logDebug("main", `Buffered group msg from ${senderName}: "${text.slice(0, 60)}"`);
          return;
        }

        if (isMention) {
          text = text.replace(mentionRe, "").trim();
          if (!text) return;
        }
      }

      if (!isVoiceNote && !securityGate.authorize(message)) {
        if (isGroup) conversationBuffer.push(bufKey, senderName, text);
        logWarn("main", `Unauthorized user ${message.from.id}`);
        return;
      }

      const sessionKey = `telegram:${chatId}`;

      if (text === "/new" || text === "/reset") {
        await transport.resetSession(sessionKey);
        if (isGroup) conversationBuffer.clear(bufKey);
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
        busyChats.delete(sessionKey);
        await telegramApi.sendMessage(chatId, "🛑 Ctrl+C sent to Kiro.", { message_thread_id: threadId });
        logInfo("main", "Ctrl+C interrupt sent");
        return;
      }

      if (text === "/compact") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const llm = memory.getLlmCall();
        if (!llm) {
          await telegramApi.sendMessage(chatId, "⚠️ LLM is not available. Cannot run compaction.", { message_thread_id: threadId });
          return;
        }
        try {
          const result = await memory.compactSession({ chatId, sessionId: sessionKey, llmCall: llm });
          const msg = result
            ? `📦 Compaction complete:\n\n${result.summary}`
            : "📦 Nothing to compact — no messages found for this session.";
          await telegramApi.sendMessage(chatId, msg, { message_thread_id: threadId });
        } catch (err) {
          logError("main", "Compaction failed", err);
          await telegramApi.sendMessage(chatId, "❌ Compaction failed. Check logs for details.", { message_thread_id: threadId });
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

      if (text === "/ingest list") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const docs = memory.listIngestedDocuments(chatId);
          if (docs.length === 0) {
            await telegramApi.sendMessage(chatId, "📄 No ingested documents yet.", { message_thread_id: threadId });
          } else {
            const lines = docs.map((d) => {
              const date = new Date(d.ingestedAt).toISOString().slice(0, 10);
              return `• [${d.sourceType}] ${d.identifier} — ${d.chunkCount} chunks (${date})`;
            });
            await telegramApi.sendMessage(chatId, `📄 Ingested documents:\n\n${lines.join("\n")}`, { message_thread_id: threadId });
          }
        } catch (err) {
          logError("main", "Failed to list ingested documents", err);
          await telegramApi.sendMessage(chatId, "❌ Failed to list ingested documents.", { message_thread_id: threadId });
        }
        return;
      }

      if (text.startsWith("/ingest ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const arg = text.slice("/ingest ".length).trim();
        if (!arg) {
          await telegramApi.sendMessage(chatId, "Usage: /ingest <url_or_path> or /ingest list", { message_thread_id: threadId });
          return;
        }
        // Auto-detect source type
        let sourceType: "youtube" | "pdf" | "text" | "markdown";
        if (arg.startsWith("http") && (arg.includes("youtube.com") || arg.includes("youtu.be"))) {
          sourceType = "youtube";
        } else if (arg.endsWith(".pdf")) {
          sourceType = "pdf";
        } else if (arg.endsWith(".md")) {
          sourceType = "markdown";
        } else {
          sourceType = "text";
        }
        try {
          await telegramApi.sendMessage(chatId, `📥 Ingesting ${sourceType} source: ${arg}...`, { message_thread_id: threadId });
          const result = await memory.ingestDocument({ type: sourceType, identifier: arg }, chatId);
          await telegramApi.sendMessage(chatId, `✅ Ingested ${result.chunkCount} chunks from [${result.sourceType}] ${result.identifier}`, { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Ingestion failed", err);
          await telegramApi.sendMessage(chatId, `❌ Ingestion failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reflect list") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const channelKey = String(chatId);
          const reflections = memory.listReflections(channelKey);
          if (reflections.length === 0) {
            await telegramApi.sendMessage(chatId, "🪞 No reflections yet.", { message_thread_id: threadId });
          } else {
            const lines = reflections.map((r) => `• ${r.date} — ${r.preview}`);
            await telegramApi.sendMessage(chatId, `🪞 Reflections:\n\n${lines.join("\n")}`, { message_thread_id: threadId });
          }
        } catch (err) {
          logError("main", "Failed to list reflections", err);
          await telegramApi.sendMessage(chatId, "❌ Failed to list reflections.", { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reflect" || text.startsWith("/reflect ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const channelKey = String(chatId);
          const arg = text.slice("/reflect".length).trim();
          const windowDays = arg ? parseInt(arg, 10) : undefined;
          if (arg && (isNaN(windowDays!) || windowDays! <= 0)) {
            await telegramApi.sendMessage(chatId, "Usage: /reflect [days] or /reflect list", { message_thread_id: threadId });
            return;
          }
          await telegramApi.sendMessage(chatId, "🪞 Generating reflection...", { message_thread_id: threadId });
          const reflection = await memory.reflect(channelKey, windowDays);
          await telegramApi.sendMessage(chatId, `🪞 Reflection (${reflection.date}):\n\n${reflection.content}`, { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Reflection failed", err);
          await telegramApi.sendMessage(chatId, `❌ Reflection failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reembed") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          await telegramApi.sendMessage(chatId, "🔄 Re-embedding all stored content with current model...", { message_thread_id: threadId });
          let lastReported = 0;
          await memory.reembed((processed, total) => {
            if (total === 0) return;
            const pct = Math.floor((processed / total) * 100);
            if (pct >= lastReported + 25 || processed === total) {
              lastReported = pct;
              telegramApi.sendMessage(chatId, `🔄 Re-embedding: ${processed}/${total} (${pct}%)`, { message_thread_id: threadId }).catch(() => {});
            }
          });
          await telegramApi.sendMessage(chatId, "✅ Re-embedding complete.", { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Re-embedding failed", err);
          await telegramApi.sendMessage(chatId, `❌ Re-embedding failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text.startsWith("/forget ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const args = text.slice("/forget ".length).trim();

        if (args.startsWith("topic ")) {
          const topic = args.slice("topic ".length).trim();
          if (!topic) {
            await telegramApi.sendMessage(chatId, "Usage: /forget topic <topic>", { message_thread_id: threadId });
            return;
          }
          try {
            const result = await memory.forgetTopic(chatId, topic);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions related to "${topic}".`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget topic failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        if (args.startsWith("range ")) {
          const rangeParts = args.slice("range ".length).trim().split(/\s+/);
          if (rangeParts.length < 2) {
            await telegramApi.sendMessage(chatId, "Usage: /forget range <start-date> <end-date> (YYYY-MM-DD)", { message_thread_id: threadId });
            return;
          }
          const startDate = new Date(rangeParts[0]!);
          const endDate = new Date(rangeParts[1]!);
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            await telegramApi.sendMessage(chatId, "❌ Invalid date format. Use YYYY-MM-DD.", { message_thread_id: threadId });
            return;
          }
          // Set endDate to end of day
          endDate.setHours(23, 59, 59, 999);
          try {
            const result = memory.forgetRange(chatId, startDate, endDate);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions in date range.`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget range failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        if (args.startsWith("session ")) {
          const sessionId = args.slice("session ".length).trim();
          if (!sessionId) {
            await telegramApi.sendMessage(chatId, "Usage: /forget session <session-id>", { message_thread_id: threadId });
            return;
          }
          try {
            const result = memory.forgetSession(chatId, sessionId);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions for session.`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget session failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        // Unknown subcommand
        await telegramApi.sendMessage(chatId, "Usage: /forget topic <topic> | /forget range <start> <end> | /forget session <id>", { message_thread_id: threadId });
        return;
      }

      if (busyChats.has(sessionKey)) {
        await telegramApi.sendMessage(chatId, "⏳ Previous request still in progress...", { message_thread_id: threadId });
        return;
      }

      let typingInterval: ReturnType<typeof setInterval> | undefined;
      try {
        busyChats.add(sessionKey);
        logInfo("main", `← ${isVoiceNote ? "🎤 " : ""}"${text.slice(0, 60)}"`);

        // Prepend buffered conversation context
        let prompt = text;
        if (isGroup) {
          const context = conversationBuffer.drain(bufKey);
          if (context) {
            prompt = context + text;
            logDebug("main", `Prepended group context to prompt`);
          }
        }

        if (memory) {
          // Assemble context BEFORE recording — prevents self-echo in search results
          prompt = await memory.assembleContext({ chatId, userInput: prompt, systemPrompt: "" });
          memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), chatId, sessionId: sessionKey });
        }

        const responsePromise = transport.sendPrompt(sessionKey, prompt);

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

        if (memory) {
          // Store answerOnly (stripped of echoed context) to prevent context-echo pollution
          const cleanResponse = ("answerOnly" in transport && (transport as TmuxClient).answerOnly)
            ? (transport as TmuxClient).answerOnly
            : response;
          memory.recordMessage({ role: "assistant", content: cleanResponse || response, timestamp: Date.now(), chatId, sessionId: sessionKey });
        }

        if (isVoiceNote && ttsConfig) {
          try {
            await telegramApi.sendChatAction(chatId, "record_voice", threadId);
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
          }
        }

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
    };

    telegramPoller = new TelegramPoller(telegramApi, config.pollTimeoutS, handleUpdate);
    try {
      telegramPoller.start();
      logInfo("main", "📡 Telegram polling started");
      announcePlatform(transport, "TELEGRAM").catch(() => {});
    } catch (err) {
      logError("main", "Telegram failed to start", err);
    }
  } else {
    logInfo("main", "📡 Telegram disabled (no --telegram flag)");
  }

  // --- Discord wiring (conditional) ---
  let discordPoller: DiscordPoller | null = null;

  if (platforms.discord && config.discordEnabled) {
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

      const effectiveChannelId = message.parentChannelId ?? message.channelId;

      // Security gate
      if (!discordSecurityGate.authorize(message.authorId, effectiveChannelId)) {
        logDebug("main", `Discord: unauthorized user=${message.authorId} channel=${effectiveChannelId}`);
        return;
      }

      const bridgeMsg = channelAdapter.fromDiscord(message);
      const sessionKey = channelAdapter.sessionKey("discord", message.channelId);
      const bufKey = `discord:${message.channelId}`;
      const rawText = bridgeMsg.text.trim();

      if (!rawText) return;

      // Pass all messages through — Kiro (the LLM) decides whether to respond
      // based on the DISCORD_SKILL.md steering file. The bridge only handles
      // security (allowed users/channels) and transport.
      // Strip Kiro's own mention tag before forwarding so the model sees clean text.
      let text = stripDiscordMentions(rawText, config.discordAppId!);
      if (!text) return;

      // Include sender context so Kiro knows who's talking
      const senderPrefix = `[${message.authorUsername}${message.authorIsBot ? " (bot)" : ""}] in #${message.channelName ?? "unknown"}: `;

      // B2B routing — peer bot messages in the B2B channel go through the B2B router
      if (b2bRouter && message.authorIsBot && effectiveChannelId === config.discordB2bChannelId) {
        const cleanedMessage = { ...message, content: text };
        await b2bRouter.handleMessage(cleanedMessage);
        return;
      }

      // Command handling
      if (text === "/new" || text === "/reset") {
        await transport.resetSession(sessionKey);
        conversationBuffer.clear(bufKey);
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

      if (text === "/ingest list") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        try {
          const docs = memory.listIngestedDocuments(chatId);
          if (docs.length === 0) {
            await discordApi.sendMessage(message.channelId, "📄 No ingested documents yet.");
          } else {
            const lines = docs.map((d) => {
              const date = new Date(d.ingestedAt).toISOString().slice(0, 10);
              return `• [${d.sourceType}] ${d.identifier} — ${d.chunkCount} chunks (${date})`;
            });
            await discordApi.sendMessage(message.channelId, `📄 Ingested documents:\n\n${lines.join("\n")}`);
          }
        } catch (err) {
          logError("main", "Failed to list ingested documents (Discord)", err);
          await discordApi.sendMessage(message.channelId, "❌ Failed to list ingested documents.");
        }
        return;
      }

      if (text.startsWith("/ingest ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const arg = text.slice("/ingest ".length).trim();
        if (!arg) {
          await discordApi.sendMessage(message.channelId, "Usage: /ingest <url_or_path> or /ingest list");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        // Auto-detect source type
        let sourceType: "youtube" | "pdf" | "text" | "markdown";
        if (arg.startsWith("http") && (arg.includes("youtube.com") || arg.includes("youtu.be"))) {
          sourceType = "youtube";
        } else if (arg.endsWith(".pdf")) {
          sourceType = "pdf";
        } else if (arg.endsWith(".md")) {
          sourceType = "markdown";
        } else {
          sourceType = "text";
        }
        try {
          await discordApi.sendMessage(message.channelId, `📥 Ingesting ${sourceType} source: ${arg}...`);
          const result = await memory.ingestDocument({ type: sourceType, identifier: arg }, chatId);
          await discordApi.sendMessage(message.channelId, `✅ Ingested ${result.chunkCount} chunks from [${result.sourceType}] ${result.identifier}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Ingestion failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Ingestion failed: ${errMsg}`);
        }
        return;
      }

      if (text === "/reflect list") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          const channelKey = message.channelId;
          const reflections = memory.listReflections(channelKey);
          if (reflections.length === 0) {
            await discordApi.sendMessage(message.channelId, "🪞 No reflections yet.");
          } else {
            const lines = reflections.map((r) => `• ${r.date} — ${r.preview}`);
            await discordApi.sendMessage(message.channelId, `🪞 Reflections:\n\n${lines.join("\n")}`);
          }
        } catch (err) {
          logError("main", "Failed to list reflections (Discord)", err);
          await discordApi.sendMessage(message.channelId, "❌ Failed to list reflections.");
        }
        return;
      }

      if (text === "/reflect" || text.startsWith("/reflect ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          const channelKey = message.channelId;
          const arg = text.slice("/reflect".length).trim();
          const windowDays = arg ? parseInt(arg, 10) : undefined;
          if (arg && (isNaN(windowDays!) || windowDays! <= 0)) {
            await discordApi.sendMessage(message.channelId, "Usage: /reflect [days] or /reflect list");
            return;
          }
          await discordApi.sendMessage(message.channelId, "🪞 Generating reflection...");
          const reflection = await memory.reflect(channelKey, windowDays);
          await discordApi.sendMessage(message.channelId, `🪞 Reflection (${reflection.date}):\n\n${reflection.content}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Reflection failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Reflection failed: ${errMsg}`);
        }
        return;
      }

      if (text === "/reembed") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          await discordApi.sendMessage(message.channelId, "🔄 Re-embedding all stored content with current model...");
          let lastReported = 0;
          await memory.reembed((processed, total) => {
            if (total === 0) return;
            const pct = Math.floor((processed / total) * 100);
            if (pct >= lastReported + 25 || processed === total) {
              lastReported = pct;
              discordApi.sendMessage(message.channelId, `🔄 Re-embedding: ${processed}/${total} (${pct}%)`).catch(() => {});
            }
          });
          await discordApi.sendMessage(message.channelId, "✅ Re-embedding complete.");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Re-embedding failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Re-embedding failed: ${errMsg}`);
        }
        return;
      }

      if (text.startsWith("/forget ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        const args = text.slice("/forget ".length).trim();

        if (args.startsWith("topic ")) {
          const topic = args.slice("topic ".length).trim();
          if (!topic) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget topic <topic>");
            return;
          }
          try {
            const result = await memory.forgetTopic(chatId, topic);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions related to "${topic}".`);
          } catch (err) {
            logError("main", "Forget topic failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        if (args.startsWith("range ")) {
          const rangeParts = args.slice("range ".length).trim().split(/\s+/);
          if (rangeParts.length < 2) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget range <start-date> <end-date> (YYYY-MM-DD)");
            return;
          }
          const startDate = new Date(rangeParts[0]!);
          const endDate = new Date(rangeParts[1]!);
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            await discordApi.sendMessage(message.channelId, "❌ Invalid date format. Use YYYY-MM-DD.");
            return;
          }
          // Set endDate to end of day
          endDate.setHours(23, 59, 59, 999);
          try {
            const result = memory.forgetRange(chatId, startDate, endDate);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions in date range.`);
          } catch (err) {
            logError("main", "Forget range failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        if (args.startsWith("session ")) {
          const sessionId = args.slice("session ".length).trim();
          if (!sessionId) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget session <session-id>");
            return;
          }
          try {
            const result = memory.forgetSession(chatId, sessionId);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings, ${result.compactionsRemoved} compactions for session.`);
          } catch (err) {
            logError("main", "Forget session failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        // Unknown subcommand
        await discordApi.sendMessage(message.channelId, "Usage: /forget topic <topic> | /forget range <start> <end> | /forget session <id>");
        return;
      }

      if (busyChats.has(sessionKey)) {
        await discordApi.sendMessage(message.channelId, "⏳ Previous request still in progress...");
        return;
      }

      try {
        busyChats.add(sessionKey);
        logInfo("main", `← Discord: "${text.slice(0, 60)}"`);

        // Build prompt with sender context
        let prompt = senderPrefix + text;
        const context = conversationBuffer.drain(bufKey);
        if (context) {
          prompt = context + prompt;
          logDebug("main", `Discord: prepended conversation context to prompt`);
        }

        if (memory) {
          const chatId = parseInt(message.channelId, 10) || 0;
          prompt = await memory.assembleContext({ chatId, userInput: prompt, systemPrompt: "" });
        }

        const response = await transport.sendPrompt(sessionKey, prompt);

        if (!response || !response.trim()) {
          logWarn("main", "Empty response from transport (Discord)");
          await discordApi.sendMessage(message.channelId, "🤷 Kiro returned an empty response. Try again or /reset.");
          return;
        }

        // LLM opted out of responding (per CHATS.md steering)
        if (response.trim() === "<NO_REPLY>") {
          logDebug("main", "Discord: LLM returned <NO_REPLY>, skipping");
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
    };

    discordPoller = new DiscordPoller(discordApi, config.discordAppId!, handleDiscordMessage);
    try {
      await discordPoller.start();
      logInfo("main", "📡 Discord polling started");
      announcePlatform(transport, "DISCORD").catch(() => {});
    } catch (err) {
      logError("main", "Discord failed to start", err);
      discordPoller = null;
    }
  } else if (platforms.discord) {
    logWarn("main", "Discord flag set but DISCORD_BOT_TOKEN not configured — skipping");
  } else {
    logInfo("main", "📡 Discord disabled (no --discord/--all flag)");
  }

  function shutdown(): void {
    logInfo("main", "🛑 Shutting down...");
    if (telegramPoller) telegramPoller.stop();
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
