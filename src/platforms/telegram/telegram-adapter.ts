import { getEnv } from "../../components/env-schema.js";
import { BOT_COMMANDS } from "../../components/command-registry.js";
import { abtarsHome } from "../../paths.js";
/**
 * Telegram platform adapter — wraps TelegramApi, TelegramPoller, SecurityGate.
 * Handles Telegram-specific pre-processing (voice, reactions, groups, mentions)
 * then delegates to the shared message pipeline.
 */

import { TelegramApi } from "./telegram-api.js";
import { TelegramPoller } from "./telegram-poller.js";
import { createFileOffsetStore } from "./offset-store.js";
import { SecurityGate } from "../../components/security-gate.js";
import { ResponseFormatter } from "../../components/response-formatter.js";
import { formatReactionSignal, routeReaction } from "../../components/reactions.js";

export const TELEGRAM_CAPABILITIES: PlatformCapabilities = { voice: true, reactions: true, typing: true, threads: true };
import { emojiToScore } from "abmind";
import { logInfo, logWarn, logError, logDebug } from "../../components/logger.js";
import { handleInboundMessage, resetAndPrepare, type PipelineDeps } from "../../components/message-pipeline.js";
import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import type { TelegramUpdate } from "../../types/index.js";
import type { ConversationBuffer } from "../../components/conversation-buffer.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { IMemorySystem } from "abmind";
import { loadUsers } from "../../components/user-registry.js";

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
  memory: IMemorySystem | null;
  sessionManager: { getActiveSessionId(userId: string, platform: string): string };
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram" as const;
  readonly capabilities: PlatformCapabilities = TELEGRAM_CAPABILITIES;

  private readonly api: TelegramApi;
  private readonly securityGate: SecurityGate;
  private readonly formatter = new ResponseFormatter();
  private readonly config: TelegramAdapterConfig;
  private readonly deps: TelegramAdapterDeps;
  private poller: TelegramPoller | null = null;
  private botUsername = "";
  private _pendingSlot: string | undefined;

  constructor(config: TelegramAdapterConfig, deps: TelegramAdapterDeps) {
    this.api = new TelegramApi(config.botToken);
    this.securityGate = new SecurityGate(loadUsers());
    this.config = config;
    this.deps = deps;
  }

  /** Send a system notification to a chat (fire-and-forget). */
  sendNotification(chatId: string, text: string): void {
    this.api.sendMessage(parseInt(chatId, 10), text).catch(() => {});
  }

  /** Reset session after model switch — saves idle state, clears buffer, marks pendingStart. */
  private async resetSessionForModelSwitch(chatId: number, reason = "model-switch"): Promise<void> {
    await this.api.sendMessage(chatId, "⏳ Reinitializing transport…");
    const p = this.deps.pipeline;
    const sessionKey = `telegram:${chatId}`;
    const bufKey = `telegram:${chatId}`;
    await p.idleSave.save(sessionKey, chatId);
    await resetAndPrepare({
      transport: this.deps.transport, sessionKey, reason,
      sessions: p.sessions, conversationBuffer: this.deps.conversationBuffer, bufKey,
    });
    if (p.memoryConfig.memoryEnabled) {
      const reg = loadUsers();
      const user = reg.byPlatformId.get(String(chatId));
      if (user) p.updateCtxStart(p.memoryConfig.memoryDir, user.userId);
    }
  }

  async start(): Promise<void> {
    const botInfo = await this.api.getMe();
    this.botUsername = botInfo.username?.toLowerCase() ?? "";
    logInfo(TAG, `🤖 Bot: @${botInfo.username}`);

    await this.api.setMyCommands(BOT_COMMANDS.map(c => ({ command: c.name, description: c.description })))
      .catch((err) => logWarn(TAG, `setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`));

    const home = abtarsHome();
    const offsetStore = createFileOffsetStore(`${home}/state/telegram-offset`);
    this.poller = new TelegramPoller(this.api, this.config.pollTimeoutS, (u) => this.handleUpdate(u), offsetStore);
    await this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
  }

  authorize(msg: InboundMessage): boolean {
    return this.securityGate.authorizeById(msg.senderId);
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

  /** Send a file from disk as a Telegram document. */
  async sendDocument(channelId: string, filePath: string, caption?: string, opts?: SendOpts): Promise<number> {
    const sendOpts: { message_thread_id?: number } = {};
    if (opts?.threadId) sendOpts.message_thread_id = parseInt(opts.threadId, 10);
    return this.api.sendDocument(parseInt(channelId, 10), filePath, caption, sendOpts);
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
      const data = update.callback_query.data ?? "";
      const chatId = update.callback_query.message?.chat?.id;
      this.api.answerCallbackQuery(update.callback_query.id).catch(() => {});
      if (!chatId) return;

      try {
      if (data.startsWith("mslot:")) {
        // Step 1 result: user picked an agent → show providers (step 2)
        const agent = data.slice(6);
        const { loadTransport, resolveAgent, getAvailableProviders, getModelsForProvider } = await import("../../components/transport-config.js");
        const tc = loadTransport();
        if (!tc) { await this.api.sendMessage(chatId, "❌ transport.json not loaded"); return; }

        // Filter providers by transport layer (exclude tmux — not user-selectable)
        let providers = getAvailableProviders(tc).filter(p => p.config.transport !== "tmux");
        if (agent === "professor") {
          const profResolved = resolveAgent("professor", tc);
          if (profResolved?.provider.cli) {
            // CLI: only same provider (same binary) — skip step 2
            const providerName = profResolved.providerName;
            const models = getModelsForProvider(providerName);
            if (models.length === 0) { await this.api.sendMessage(chatId, `❌ No models for ${providerName}`); return; }
            // Skip to step 3 (slot picker)
            const fallbacks = tc.agents["professor"]?.fallbacks ?? [];
            const slots: Array<{ label: string; key: string }> = [{ label: `★ Main: ${profResolved.model}`, key: `mpos:professor:${providerName}:professor` }];
            for (let i = 0; i < fallbacks.length; i++) slots.push({ label: `↳ Fb${i + 1}: ${fallbacks[i]!.model}`, key: `mpos:professor:${providerName}:professor_fb${i + 1}` });
            if (fallbacks.length < 3) slots.push({ label: `↳ Fb${fallbacks.length + 1}: (add)`, key: `mpos:professor:${providerName}:professor_fb${fallbacks.length + 1}` });
            const buttons = slots.map(s => [{ text: s.label, callback_data: s.key }]);
            await this.api.sendMessage(chatId, `🎯 Which slot? (${providerName})`, { reply_markup: { inline_keyboard: buttons } });
            return;
          }
          // Professor on API: show ALL providers (user can switch transport)
        }

        if (providers.length === 0) { await this.api.sendMessage(chatId, "❌ No compatible providers"); return; }
        const currentProvider = resolveAgent(agent, tc)?.providerName;
        const buttons = providers.map(p => {
          const count = getModelsForProvider(p.name).length;
          const label = p.name === currentProvider ? `✅ ${p.name} (${count})` : `${p.name} (${count})`;
          return [{ text: label, callback_data: `mprov:${agent}:${p.name}` }];
        });
        await this.api.sendMessage(chatId, `🔌 Pick provider:`, { reply_markup: { inline_keyboard: buttons } });

      } else if (data.startsWith("mprov:")) {
        // Step 2 result: user picked provider
        const [, agent, providerName] = data.split(":");
        const { loadTransport, getModelsForProvider, formatRank, formatCost } = await import("../../components/transport-config.js");
        const tc = loadTransport();

        if (agent === "professor") {
          // Professor: show slot picker (step 3)
          const fallbacks = tc?.agents["professor"]?.fallbacks ?? [];
          const profModel = tc?.agents["professor"]?.model ?? "?";
          const slots: Array<{ label: string; key: string }> = [{ label: `★ Main: ${profModel}`, key: `mpos:professor:${providerName}:professor` }];
          for (let i = 0; i < fallbacks.length; i++) slots.push({ label: `↳ Fb${i + 1}: ${fallbacks[i]!.model}`, key: `mpos:professor:${providerName}:professor_fb${i + 1}` });
          if (fallbacks.length < 3) slots.push({ label: `↳ Fb${fallbacks.length + 1}: (add)`, key: `mpos:professor:${providerName}:professor_fb${fallbacks.length + 1}` });
          const buttons = slots.map(s => [{ text: s.label, callback_data: s.key }]);
          await this.api.sendMessage(chatId, `🎯 Which slot? (${providerName})`, { reply_markup: { inline_keyboard: buttons } });
        } else {
          // Subagent: skip slot, go straight to model picker (step 4)
          let models = getModelsForProvider(providerName!);
          const providerConfig = tc?.providers[providerName!];
          if (providerConfig?.transport === "api") models = models.filter(m => !m.entry.status || m.entry.status === "alive");
          if (models.length === 0) { await this.api.sendMessage(chatId, `❌ No alive models for ${providerName}`); return; }
          this._pendingSlot = agent;
          const buttons = models.map(m => [{ text: `${m.id} (${formatRank(m.entry.rank)}, ${formatCost(m.entry.cost)})`, callback_data: `mset:${providerName}:${m.id}` }]);
          await this.api.sendMessage(chatId, `📋 Models on ${providerName}:`, { reply_markup: { inline_keyboard: buttons } });
        }

      } else if (data.startsWith("mpos:")) {
        // Step 3 result (professor only): user picked slot → show models (step 4)
        const [, , providerName, slot] = data.split(":");
        const { getModelsForProvider, formatRank, formatCost, loadTransport } = await import("../../components/transport-config.js");
        const tc = loadTransport();
        const providerConfig = tc?.providers[providerName!];
        let models = getModelsForProvider(providerName!);
        if (providerConfig?.transport === "api") models = models.filter(m => !m.entry.status || m.entry.status === "alive");
        if (models.length === 0) { await this.api.sendMessage(chatId, `❌ No alive models for ${providerName}`); return; }
        const buttons = models.map(m => [{ text: `${m.id} (${formatRank(m.entry.rank)}, ${formatCost(m.entry.cost)})`, callback_data: `mset:${slot}:${providerName}:${m.id}` }]);
        await this.api.sendMessage(chatId, `📋 Pick model for ${slot!.replace("professor_fb", "Fb").replace("professor", "Main")}:`, { reply_markup: { inline_keyboard: buttons } });

      } else if (data.startsWith("mset:")) {
        // Step 4: user picked model — validate + write + switch
        const parts = data.split(":");
        const providerName = parts[1]!;
        const model = parts.slice(2).join(":"); // model may contain colons
        const slot = this._pendingSlot ?? "professor";
        this._pendingSlot = undefined;
        const { loadTransport, writeTransportConfig, resolveAgent, getModelsForProvider, validateProviderReady, formatValidationError } = await import("../../components/transport-config.js");
        const tc = loadTransport();
        if (!tc) { await this.api.sendMessage(chatId, "❌ transport.json not loaded"); return; }

        // Safety net: validate model is served by this provider
        const validModels = getModelsForProvider(providerName);
        if (!validModels.some(m => m.id === model)) {
          await this.api.sendMessage(chatId, `❌ ${model} is not available on ${providerName}. Pick another.`);
          return;
        }

        // #367 — validate provider readiness BEFORE mutating transport.json.
        const providerConfig = tc.providers[providerName];
        if (!providerConfig) { await this.api.sendMessage(chatId, `❌ Provider ${providerName} not found`); return; }
        const validation = validateProviderReady(providerName, providerConfig, getEnv());
        if (!validation.ok) { await this.api.sendMessage(chatId, formatValidationError(providerName, validation)); return; }

        // Liveness check
        const provider = tc.providers[providerName];
        if (provider?.transport === "api") {
          try {
            const endpoint = provider.endpoint ?? "";
            const apiKey = getEnv().getApiKey(provider.apiKeyEnv ?? "API_KEY");
            const headers: Record<string, string> = {};
            if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
            const res = await fetch(`${endpoint}/models`, { headers, signal: AbortSignal.timeout(5000) });
            if (!res.ok) { await this.api.sendMessage(chatId, `⚠️ ${providerName} unreachable (${res.status}). Try another?`); return; }
          } catch { await this.api.sendMessage(chatId, `⚠️ ${providerName} unreachable. Try another?`); return; }
        }

        // Determine agent key
        const agentKey = slot.startsWith("professor_fb") ? "professor" : slot;
        const fbIndex = slot === "professor_fb1" ? 0 : slot === "professor_fb2" ? 1 : -1;

        if (fbIndex >= 0) {
          // Fallback change
          if (!tc.agents["professor"]) tc.agents["professor"] = { model: "", provider: "" };
          if (!tc.agents["professor"]!.fallbacks) tc.agents["professor"]!.fallbacks = [];
          tc.agents["professor"]!.fallbacks[fbIndex] = { model, provider: providerName };
          const { cleanDemotedModels } = await import("../../components/transport-config.js");
          cleanDemotedModels(tc, model);
          writeTransportConfig(tc, `professor fallback ${fbIndex + 1} → ${model} (${providerName})`);
          await this.api.sendMessage(chatId, `✅ Fallback ${fbIndex + 1} → ${model} (${providerName})`);
        } else {
          // Main or subagent change
          const oldProvider = tc.agents[agentKey]?.provider;
          tc.agents[agentKey] = { ...tc.agents[agentKey]!, model, provider: providerName };
          const { cleanDemotedModels } = await import("../../components/transport-config.js");
          cleanDemotedModels(tc, model);
          writeTransportConfig(tc, `${agentKey} → ${model} (${providerName})`);

          const providerChanged = oldProvider !== providerName;
          const isProfessor = agentKey === "professor";

          // Resolve transport types for professor changes
          let oldType: string | undefined;
          let newType: string | undefined;
          let newResolved: ReturnType<typeof resolveAgent> | undefined;
          if (isProfessor && providerChanged) {
            const oldResolved = resolveAgent("_old", { ...tc, agents: { ...tc.agents, _old: { model: "", provider: oldProvider! } } });
            newResolved = resolveAgent("_new", { ...tc, agents: { ...tc.agents, _new: { model, provider: providerName } } });
            oldType = oldResolved?.provider.transport ?? "api";
            newType = newResolved?.provider.transport ?? "api";

            // Cross-transport switch: cascade all subagents to professor's new assignment
            if (oldType !== newType) {
              const resetAgents: string[] = [];
              for (const [a, assignment] of Object.entries(tc.agents)) {
                if (a === "professor") continue;
                const ap = tc.providers[assignment.provider];
                if (ap && ap.transport !== newType) {
                  tc.agents[a] = { model, provider: providerName };
                  resetAgents.push(a);
                }
              }
              if (resetAgents.length > 0) {
                writeTransportConfig(tc, `cascade: ${resetAgents.join(", ")} → ${providerName}`);
              }
            }
          }

          if (isProfessor && !providerChanged && "setModel" in this.deps.transport) {
            // Same provider, different model — hot swap
            await (this.deps.transport as unknown as { setModel: (m: string) => Promise<void> }).setModel(model);
            await this.resetSessionForModelSwitch(chatId);
            await this.api.sendMessage(chatId, `✅ Switched to ${model}`);
          } else if (isProfessor && providerChanged && oldType === newType && "switchProvider" in this.deps.transport) {
            // Same transport type, different provider — hot swap
            try {
              const { FallbackPolicy } = await import("../../components/transport/fallback-policy.js");
              const { ModelHealthRegistry } = await import("../../components/transport/model-health-registry.js");
              const apiKey = getEnv().getApiKey(newResolved?.provider.apiKeyEnv ?? "API_KEY");
              const candidates = [{ endpoint: newResolved!.provider.endpoint!, apiKey, model, maxContext: newResolved!.contextWindow }];
              for (const fb of (tc.agents["professor"]?.fallbacks ?? [])) {
                const fbRes = resolveAgent("_fb", { ...tc, agents: { ...tc.agents, _fb: { model: fb.model, provider: fb.provider } } });
                if (fbRes) candidates.push({ endpoint: fbRes.provider.endpoint!, apiKey: fbRes.provider.apiKeyEnv ? getEnv().getApiKey(fbRes.provider.apiKeyEnv) : apiKey, model: fb.model, maxContext: fbRes.contextWindow });
              }
              const registry = (this.deps.transport as unknown as { policy?: { registry: InstanceType<typeof ModelHealthRegistry> } }).policy?.registry ?? new ModelHealthRegistry();
              const policy = new FallbackPolicy(candidates, registry);
              (this.deps.transport as unknown as { switchProvider: (o: unknown) => void }).switchProvider({ endpoint: newResolved!.provider.endpoint!, apiKey, model, maxContext: newResolved!.contextWindow, policy });
              await this.resetSessionForModelSwitch(chatId);
              await this.api.sendMessage(chatId, `✅ Switched to ${model} (${providerName})`);
            } catch (err) {
              await this.api.sendMessage(chatId, `⚠️ Hot swap failed: ${err instanceof Error ? err.message : String(err)}. Use /reset to apply.`);
            }
          } else if (isProfessor && providerChanged) {
            // Different transport type — auto /reset (rebuild transport + session reset)
            const cascadeNote = oldType !== newType ? " Subagents also reset." : "";
            try {
              if (this.deps.pipeline.rebuildTransport) await this.deps.pipeline.rebuildTransport();
              await this.resetSessionForModelSwitch(chatId, "cross-transport-switch");
              await this.api.sendMessage(chatId, `🔄 Switched to ${model} (${providerName}). Transport rebuilt.${cascadeNote}`);
            } catch (err) {
              await this.api.sendMessage(chatId, `⚠️ Transport rebuild failed: ${err instanceof Error ? err.message : String(err)}. Try /reset manually.`);
            }
          } else {
            await this.api.sendMessage(chatId, `✅ ${agentKey} → ${model} (${providerName})`);
          }
        }
      } else if (data.startsWith("model:")) {
        // Legacy callback — direct model switch
        const newModel = data.slice(6);
        const transport = this.deps.transport;
        if ("setModel" in transport && typeof (transport as { setModel: unknown }).setModel === "function") {
          try {
            await (transport as { setModel: (m: string) => Promise<void> | void }).setModel(newModel);
            await this.resetSessionForModelSwitch(chatId);
            if (chatId) await this.api.sendMessage(chatId, `🤖 Model switched → ${newModel}`);
          } catch (err) {
            if (chatId) await this.api.sendMessage(chatId, `❌ Model switch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      } catch (err) {
        logWarn(TAG, `Callback handler error: ${err instanceof Error ? err.message : String(err)}`);
        this.api.sendMessage(chatId, `⚠️ Action failed — try again.`).catch(() => {});
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
        } else if (this.securityGate.authorizeById(String(message.from?.id))) {
          await this.api.sendMessage(chatId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { message_thread_id: threadId });
        }
        return;
      }

      if (!this.securityGate.authorizeById(String(message.from?.id))) {
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
          const result = await transcribeAudio(audioBuffer, "voice.ogg", this.deps.pipeline.sttConfig!);
          const transcript = result.text;

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
    if (!isVoiceNote && !this.securityGate.authorizeById(String(message.from?.id))) {
      if (isGroup) this.deps.conversationBuffer.push(bufKey, senderName, text);
      logWarn(TAG, `Unauthorized user ${message.from.id}`);
      return;
    }

    // --- Photo/document handling ---
    let mediaPath: string | undefined;

    if ((hasPhoto || hasDocument) && this.securityGate.authorizeById(String(message.from?.id))) {
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
    const resolvedUser = loadUsers().byPlatformId.get("telegram:" + message.from.id)?.userId ?? "unknown";
    const inbound: InboundMessage = {
      platform: "telegram",
      channelId: String(chatId),
      sessionKey: resolvedUser + ":telegram",
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

    // /stop, /ctrlc, /restart now handled in commandMiddleware (platform-agnostic)

    // #512: commands bypass the sequential await — execute immediately even if agent is mid-stream
    if (text.startsWith("/") && !text.startsWith("//")) {
      handleInboundMessage(inbound, this, this.deps.pipeline).catch(() => {});
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

    const isAuthorized = this.securityGate.authorizeById(String(user.id));
    const signal = formatReactionSignal(senderName, emojis);
    const chatId = reaction.chat.id;
    const route = routeReaction(isAuthorized, reaction.chat.type);

    if (isAuthorized && this.deps.memory) {
      const score = emojiToScore(emojis[0]!);
      const updated = this.deps.memory.updateEmotionByPlatformId(loadUsers().byPlatformId.get(`telegram:${chatId}`)?.userId ?? "master", reaction.message_id, score);
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
      const reactionUser = loadUsers().byPlatformId.get("telegram:" + user.id)?.userId ?? "unknown";
      const activeId = this.deps.sessionManager.getActiveSessionId(reactionUser, "telegram");
      const { sessions } = this.deps.pipeline;
      const entry = sessions.getOrCreate(activeId);
      if (entry.busy) {
        entry.queue.push({ msg: { sessionKey: activeId, channelId: String(chatId), senderName, senderId: String(user.id), text: signal, messageId: reaction.message_id, platform: "telegram", timestamp: Date.now(), isGroup: false, isVoice: false }, adapter: this });
        logDebug(TAG, `Queued reaction signal for busy ${activeId} (${entry.queue.length} pending)`);
      } else {
        try {
          await this.deps.transport.sendPrompt(activeId, signal);
          logDebug(TAG, `Sent reaction signal to transport for chat ${chatId}`);
        } catch (err) {
          logError(TAG, `Failed to send reaction signal for chat ${chatId}`, err);
        }
      }
    }
  }
}
