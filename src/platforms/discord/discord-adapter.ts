/**
 * Discord platform adapter — wraps DiscordApi, DiscordPoller, DiscordSecurityGate.
 * Handles Discord-specific pre-processing (mention stripping, A2A routing, sender prefix)
 * then delegates to the shared message pipeline.
 */

import { DiscordApi } from "./discord-api.js";
import { DiscordPoller } from "./discord-poller.js";
import { SecurityGate } from "../../components/security-gate.js";
import { loadUsers } from "../../components/user-registry.js";
import { BOT_COMMANDS } from "../../components/command-registry.js";
import { ResponseFormatter } from "../../components/response-formatter.js";
import { formatReactionSignal } from "../../components/reactions.js";

export const DISCORD_CAPABILITIES: PlatformCapabilities = { voice: false, reactions: true, typing: true, threads: true };
import { emojiToScore } from "abmind";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { getEnv } from "../../components/env-schema.js";
import { handleInboundMessage, type PipelineDeps } from "../../components/message-pipeline.js";
import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import type { DiscordInboundMessage } from "../../types/index.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { IMemorySystem } from "abmind";
import type { ConversationBuffer } from "../../components/conversation-buffer.js";

const TAG = "discord";

export interface DiscordAdapterConfig {
  botToken: string;
  appId: string;
  allowedUserIds: Set<string>;
}

export interface DiscordAdapterDeps {
  pipeline: PipelineDeps;
  transport: IKiroTransport;
  memory: IMemorySystem | null;
  conversationBuffer: ConversationBuffer;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord" as const;
  readonly capabilities: PlatformCapabilities = DISCORD_CAPABILITIES;

  private readonly api: DiscordApi;
  private readonly securityGate: SecurityGate;
  private readonly formatter = new ResponseFormatter();
  private readonly config: DiscordAdapterConfig;
  private readonly deps: DiscordAdapterDeps;
  private poller: DiscordPoller | null = null;

  constructor(config: DiscordAdapterConfig, deps: DiscordAdapterDeps) {
    this.api = new DiscordApi(config.botToken);
    this.securityGate = new SecurityGate(loadUsers());
    this.config = config;
    this.deps = deps;
  }

  async start(): Promise<void> {
    this.poller = new DiscordPoller(this.api, this.config.appId, (m) => this.handleMessage(m));
    this.api.onReaction((reaction, user) => this.handleReaction(reaction, user));
    this.api.onInteraction((interaction) => this.handleInteraction(interaction));
    await this.poller.start();

    // Register slash commands (idempotent)
    await this.api.registerCommands([...BOT_COMMANDS]).catch(err =>
      logWarn(TAG, `Slash command registration failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Handle Discord slash command interactions. */
  private async handleInteraction(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    // Interactive model picker for /model and /models
    if (interaction.commandName === "model" || interaction.commandName === "models") {
      await this.handleModelPicker(interaction);
      return;
    }

    await interaction.deferReply();

    const registry = loadUsers();
    const userEntry = registry.byPlatformId.get(`discord:${interaction.user.id}`);
    if (!this.securityGate.authorizeById(interaction.user.id, interaction.channelId)) {
      await interaction.editReply("⛔ Unauthorized.");
      return;
    }

    const commandText = `/${interaction.commandName}`;
    const userId = userEntry?.userId ?? "unknown";
    const channelId = interaction.channelId;

    // Wrap adapter so pipeline responses route through the interaction reply
    let initialReplied = false;
    const interactionAdapter: PlatformAdapter = {
      ...this,
      sendMessage: async (_ch: string, text: string): Promise<string | undefined> => {
        if (!text?.trim()) return undefined;
        const chunks = text.length <= 2000 ? [text] : text.match(/.{1,2000}/gs) ?? [text];
        let lastId: string | undefined;
        for (const chunk of chunks) {
          if (!initialReplied) {
            initialReplied = true;
            const sent = await interaction.editReply(chunk);
            lastId = sent.id;
          } else {
            const sent = await interaction.followUp(chunk);
            lastId = sent.id;
          }
        }
        return lastId;
      },
      editMessage: async (_ch: string, _messageId: number | string, text: string): Promise<void> => {
        // For interaction replies, editReply edits the initial deferred response
        await interaction.editReply(text);
      },
    };

    const msg: InboundMessage = {
      text: commandText,
      channelId,
      userId,
      senderId: interaction.user.id,
      senderName: interaction.user.username ?? "unknown",
      platform: "discord",
      timestamp: Date.now(),
      isGroup: !!interaction.guildId,
      isVoice: false,
    };

    await handleInboundMessage(msg, interactionAdapter, this.deps.pipeline);
  }

  /** Interactive model picker — ephemeral select menus. */
  private async handleModelPicker(interaction: import("discord.js").ChatInputCommandInteraction): Promise<void> {
    const { ActionRowBuilder, StringSelectMenuBuilder } = await import("discord.js");
    const { loadTransport } = await import("../../components/transport-config.js");
    const tc = loadTransport();
    if (!tc) { await interaction.reply({ content: "No transport config.", ephemeral: true }); return; }

    const providers = Object.entries(tc.providers).map(([id, p]) => ({ id, name: (p as any).name ?? id }));
    if (providers.length === 0) {
      await interaction.reply({ content: "No providers configured.", ephemeral: true });
      return;
    }

    const menu = new StringSelectMenuBuilder()
      .setCustomId("model_picker_provider")
      .setPlaceholder("Select provider")
      .addOptions(providers.slice(0, 25).map(p => ({ label: p.name, value: p.id })));

    const row = new ActionRowBuilder<import("discord.js").StringSelectMenuBuilder>().addComponents(menu);
    await interaction.reply({ content: "🔧 Select provider:", components: [row], ephemeral: true });

    // Handle provider selection → show models
    this.api.onSelectMenu("model_picker_provider", async (selectInteraction) => {
      const providerId = selectInteraction.values[0]!;
      const provider = tc.providers[providerId];
      if (!provider) { await selectInteraction.update({ content: "Provider not found.", components: [] }); return; }

      const { getModelsForProvider } = await import("../../components/transport-config.js");
      const models = getModelsForProvider(providerId).filter((m) => m.entry.status === "alive" || !m.entry.status).slice(0, 25);
      if (models.length === 0) { await selectInteraction.update({ content: `No models for ${providerId}.`, components: [] }); return; }

      const modelMenu = new StringSelectMenuBuilder()
        .setCustomId("model_picker_model")
        .setPlaceholder("Select model")
        .addOptions(models.map((m) => ({ label: m.id, value: m.id })));

      const modelRow = new ActionRowBuilder<import("discord.js").StringSelectMenuBuilder>().addComponents(modelMenu);
      await selectInteraction.update({ content: `Provider: **${providerId}**\nSelect model:`, components: [modelRow] });

      // Handle model selection → apply
      this.api.onSelectMenu("model_picker_model", async (modelInteraction) => {
        const modelId = modelInteraction.values[0]!;
        // Route through command handler as /model <provider> <model>
        await modelInteraction.update({ content: `✅ Switching to **${providerId}/${modelId}**...`, components: [] });

        // Trigger the actual switch via the command pipeline
        const msg: InboundMessage = {
          text: `/model ${providerId} ${modelId}`,
          channelId: modelInteraction.channelId,
          userId: interaction.user.id,
          senderId: interaction.user.id,
          senderName: interaction.user.username ?? "unknown",
          platform: "discord",
          timestamp: Date.now(),
          isGroup: !!interaction.guildId,
          isVoice: false,
        };
        await handleInboundMessage(msg, this, this.deps.pipeline);
      });
    });
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
  }

  authorize(msg: InboundMessage): boolean {
    // Discord security uses string IDs + channel check
    return this.securityGate.authorizeById(msg.senderId, msg.channelId);
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<string | undefined> {
    const id = await this.api.sendMessage(channelId, text);
    return id || undefined;
  }

  async sendTyping(channelId: string): Promise<void> {
    await this.api.sendTyping(channelId);
  }

  async setReaction(channelId: string, messageId: number | string, emoji: string): Promise<void> {
    await this.api.setReaction(channelId, String(messageId), emoji);
  }

  async editMessage(channelId: string, messageId: number | string, text: string): Promise<void> {
    await this.api.editMessage(channelId, String(messageId), text);
  }

  chunkResponse(text: string): string[] {
    return this.formatter.chunkForPlatform(text, "discord");
  }

  injectMessage(msg: InboundMessage): void {
    // Discord doesn't support synthetic injection the same way.
    // For sleep replay, we call handleInboundMessage directly.
    handleInboundMessage(msg, this, this.deps.pipeline).catch((err) => {
      logWarn(TAG, `Failed to replay queued message: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // --- Internal: Discord message handler ---

  private async handleMessage(message: DiscordInboundMessage): Promise<void> {
    logDebug(TAG, `Message from ${message.authorUsername} in ${message.channelId}`);

    const effectiveChannelId = message.parentChannelId ?? message.channelId;

    if (!this.securityGate.authorizeById(message.authorId, effectiveChannelId)) {
      logDebug(TAG, `Unauthorized user=${message.authorId} channel=${effectiveChannelId}`);
      return;
    }

    const rawText = message.content.trim();
    if (!rawText && !message.attachments?.length) return;

    // Strip bot's own mention
    let text = rawText.replace(new RegExp(`<@!?${this.config.appId}>`, "g"), "").replace(/\s{2,}/g, " ").trim();

    // Download attachments
    let mediaPath: string | undefined;
    if (message.attachments?.length) {
      try {
        const { saveInboundMedia } = await import("../../components/media-utils.js");
        const att = message.attachments[0]!; // handle first attachment
        const res = await fetch(att.url);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const extHint = att.filename ? "." + (att.filename.split(".").pop() ?? "") : undefined;
          const saved = await saveInboundMedia(buf, message.channelId, { extHint, claimedMime: att.contentType });
          if (saved) {
            mediaPath = saved.path;
            if (!text) text = `User sent a ${saved.isImage ? "photo" : "file"}.`;
          }
        }
      } catch (err) {
        logWarn(TAG, `Attachment download failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!text) return;

    // Mention filter: in non-DM channels, check DISCORD_GROUP_MENTIONS mode.
    const isDM = message.isDM;
    if (!isDM) {
      const mentionMode = getEnv().discordGroupMentions; // "required" | "optional"

      if (mentionMode === "optional") {
        // Skip messages that mention someone else (not us, not @everyone)
        if (message.hasUserMentions && !message.mentionsBotId && !message.mentionsBotRole && !message.mentionsEveryone) {
          logDebug(TAG, `Skipped — mentions another user (optional mode, channel=${effectiveChannelId})`);
          return;
        }
      } else {
        // Required mode: must be explicitly addressed
        let isReplyToBot = false;
        if (message.replyReferenceMessageId && this.config.appId) {
          try {
            const referenced = await this.api.fetchMessage(message.channelId, message.replyReferenceMessageId);
            isReplyToBot = referenced?.authorId === this.config.appId;
          } catch (err) { logAndSwallow(TAG, "fetchMessage reply ref", err); }
        }

        const addressed = message.mentionsBotId || message.mentionsBotRole || isReplyToBot;
        if (!addressed) {
          logDebug(TAG, `Skipped — not addressed (channel=${effectiveChannelId})`);
          return;
        }
      }
    }

    const channelLabel = message.parentChannelId ? message.channelName ?? "thread" : message.channelName ?? "DM";
    const senderPrefix = isDM ? "" : `[${message.authorUsername}${message.authorIsBot ? " (bot)" : ""}] in #${channelLabel}: `;

    const inbound: InboundMessage = {
      platform: "discord",
      channelId: message.channelId,
      userId: loadUsers().byPlatformId.get("discord:" + message.authorId)?.userId ?? "unknown",
      senderId: message.authorId,
      senderName: message.authorUsername,
      text: senderPrefix + text,
      timestamp: message.timestamp,
      isGroup: !isDM,
      isVoice: false,
      mediaPath,
      rawPlatformData: message,
    };

    // #512: commands bypass sequential await
    if (text.startsWith("/") && !text.startsWith("//")) {
      handleInboundMessage(inbound, this, this.deps.pipeline).catch(err => logAndSwallow(TAG, "handleInboundMessage command", err));
      return;
    }

    await handleInboundMessage(inbound, this, this.deps.pipeline);
  }

  private async handleReaction(
    reaction: import("discord.js").MessageReaction,
    user: import("discord.js").User,
  ): Promise<void> {
    const channelId = reaction.message.channelId;
    const messageId = Number(reaction.message.id);
    const emoji = reaction.emoji.name ?? "";
    if (!emoji) return;

    const isAuthorized = this.securityGate.authorizeById(user.id, channelId);
    const senderName = user.username || `id:${user.id}`;
    logInfo(TAG, `Reaction ${emoji} from ${senderName} on msg ${reaction.message.id}`);

    // Emotion scoring on authorized reactions
    if (isAuthorized && this.deps.memory) {
      const score = emojiToScore(emoji);
      const resolvedUserId = loadUsers().byPlatformId.get("discord:" + user.id)?.userId ?? "unknown";
      const updated = this.deps.memory.updateEmotionByPlatformId(resolvedUserId, messageId, score);
      if (updated) logDebug(TAG, `Emotion score ${score} set on msg ${reaction.message.id}`);
    }

    if (!isAuthorized) {
      logDebug(TAG, `Unauthorized reaction from ${user.id}, discarding`);
      return;
    }

    // Buffer reaction signal for next message context
    const signal = formatReactionSignal(senderName, [emoji]);
    const bufKey = `discord:${channelId}`;
    this.deps.conversationBuffer.push(bufKey, senderName, signal);
    logDebug(TAG, `Buffered reaction signal for channel ${channelId}`);
  }
}
