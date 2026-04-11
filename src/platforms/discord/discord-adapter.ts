/**
 * Discord platform adapter — wraps DiscordApi, DiscordPoller, DiscordSecurityGate.
 * Handles Discord-specific pre-processing (mention stripping, A2A routing, sender prefix)
 * then delegates to the shared message pipeline.
 */

import { DiscordApi } from "./discord-api.js";
import { DiscordPoller } from "./discord-poller.js";
import { SecurityGate } from "../../components/security-gate.js";
import { ResponseFormatter } from "../../components/response-formatter.js";
import { A2ARouter } from "../../components/a2a-router.js";
import { interceptLargeMessage } from "../../components/message-interceptor.js";
import { formatReactionSignal } from "../../components/reaction-signal.js";
import { emojiToScore } from "../../memory/emotion-utils.js";
import { logInfo, logWarn, logDebug } from "../../components/logger.js";
import { handleInboundMessage, type PipelineDeps } from "../../components/message-pipeline.js";
import type { PlatformAdapter, PlatformCapabilities, InboundMessage, SendOpts } from "../../types/platform.js";
import type { DiscordInboundMessage } from "../../types/index.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { IMemorySystem } from "../../memory/imemory-system.js";
import type { ConversationBuffer } from "../../components/conversation-buffer.js";

const TAG = "discord";

export interface DiscordAdapterConfig {
  botToken: string;
  appId: string;
  allowedUserIds: Set<string>;
  allowedChannelIds: Set<string>;
  a2aEnabled: boolean;
  a2aChannelId?: string;
  a2aPeerBotId?: string;
  a2aRateLimitMs: number;
}

export interface DiscordAdapterDeps {
  pipeline: PipelineDeps;
  transport: IKiroTransport;
  memory: IMemorySystem | null;
  conversationBuffer: ConversationBuffer;
}

export class DiscordAdapter implements PlatformAdapter {
  readonly name = "discord" as const;
  readonly capabilities: PlatformCapabilities = {
    voice: false,
    reactions: true,
    typing: false,
    threads: true,
  };

  private readonly api: DiscordApi;
  private readonly securityGate: SecurityGate;
  private readonly formatter = new ResponseFormatter();
  private readonly config: DiscordAdapterConfig;
  private readonly deps: DiscordAdapterDeps;
  private poller: DiscordPoller | null = null;
  private a2aRouter: A2ARouter | null = null;

  constructor(config: DiscordAdapterConfig, deps: DiscordAdapterDeps) {
    this.api = new DiscordApi(config.botToken);
    this.securityGate = new SecurityGate(config.allowedUserIds, config.allowedChannelIds);
    this.config = config;
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.config.a2aEnabled && this.config.a2aChannelId && this.config.a2aPeerBotId) {
      this.a2aRouter = new A2ARouter({
        discordApi: this.api,
        a2aChannelId: this.config.a2aChannelId,
        peerBotId: this.config.a2aPeerBotId,
        rateLimitMs: this.config.a2aRateLimitMs,
        onPrompt: (sessionKey, text) =>
          this.deps.transport.sendPrompt(sessionKey, interceptLargeMessage(text).text),
      });
      logInfo(TAG, `🤝 A2A router enabled (channel=${this.config.a2aChannelId})`);
    }

    this.poller = new DiscordPoller(this.api, this.config.appId, (m) => this.handleMessage(m));
    this.api.onReaction((reaction, user) => this.handleReaction(reaction, user));
    await this.poller.start();
  }

  stop(): void {
    this.poller?.stop();
    this.poller = null;
  }

  authorize(msg: InboundMessage): boolean {
    // Discord security uses string IDs + channel check
    return this.securityGate.authorize(msg.senderId, msg.channelId);
  }

  async sendMessage(channelId: string, text: string, _opts?: SendOpts): Promise<number | undefined> {
    await this.api.sendMessage(channelId, text);
    return undefined; // Discord sendMessage doesn't return message ID in current API wrapper
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

    if (!this.securityGate.authorize(message.authorId, effectiveChannelId)) {
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

    // A2A routing
    if (this.a2aRouter && message.authorIsBot && effectiveChannelId === this.config.a2aChannelId) {
      await this.a2aRouter.handleMessage({ ...message, content: text });
      return;
    }

    // Build sender prefix for LLM context
    const channelLabel = message.parentChannelId ? message.channelName ?? "thread" : message.channelName ?? "DM";
    const senderPrefix = `[${message.authorUsername}${message.authorIsBot ? " (bot)" : ""}] in #${channelLabel}: `;

    const inbound: InboundMessage = {
      platform: "discord",
      channelId: message.channelId,
      sessionKey: `discord:${message.channelId}`,
      senderId: message.authorId,
      senderName: message.authorUsername,
      text: senderPrefix + text,
      timestamp: message.timestamp,
      isGroup: true,
      isVoice: false,
      mediaPath,
      rawPlatformData: message,
    };

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

    const isAuthorized = this.securityGate.authorize(user.id, channelId);
    const senderName = user.username || `id:${user.id}`;
    logInfo(TAG, `Reaction ${emoji} from ${senderName} on msg ${reaction.message.id}`);

    // Emotion scoring on authorized reactions
    if (isAuthorized && this.deps.memory) {
      const score = emojiToScore(emoji);
      const updated = this.deps.memory.updateEmotionByPlatformId(channelId, messageId, score);
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
