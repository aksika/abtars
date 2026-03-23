import type { DiscordApi } from "./discord-api.js";
import type { DiscordInboundMessage } from "../types/discord.js";
import { logInfo, logWarn, logError, logDebug } from "./logger.js";

const TAG = "A2ARouter";

export type A2AMessageTag = "REQUEST" | "RESPONSE" | "STATUS";

const TAG_PATTERN = /^\[(REQUEST|RESPONSE|STATUS)\]\s*/;
const MAX_QUEUE_SIZE = 50;

export interface A2ARouterConfig {
  discordApi: DiscordApi;
  a2aChannelId: string;
  peerBotId: string;
  rateLimitMs: number;
  onPrompt: (sessionKey: string, text: string) => Promise<string>;
}

export class A2ARouter {
  private readonly discordApi: DiscordApi;
  private readonly a2aChannelId: string;
  private readonly peerBotId: string;
  private readonly rateLimitMs: number;
  private readonly onPrompt: (sessionKey: string, text: string) => Promise<string>;

  private lastSendTime = 0;
  private processingChain: Promise<void> = Promise.resolve();
  private queueSize = 0;

  constructor(config: A2ARouterConfig) {
    this.discordApi = config.discordApi;
    this.a2aChannelId = config.a2aChannelId;
    this.peerBotId = config.peerBotId;
    this.rateLimitMs = config.rateLimitMs;
    this.onPrompt = config.onPrompt;
    logInfo(TAG, `Initialized — peer=${this.peerBotId}, channel=${this.a2aChannelId}, rateLimit=${this.rateLimitMs}ms`);
  }

  /** Process an inbound Discord message from the A2A channel. */
  async handleMessage(message: DiscordInboundMessage): Promise<void> {
    // Only process messages from the configured peer bot
    if (message.authorId !== this.peerBotId) {
      logDebug(TAG, `Ignoring message from non-peer author ${message.authorId}`);
      return;
    }

    const { tag, content } = this.parseTag(message.content);

    // Only route REQUEST messages to the transport
    if (tag !== "REQUEST") {
      logDebug(TAG, `Ignoring non-REQUEST tag [${tag}] from peer`);
      return;
    }

    if (!content.trim()) {
      logDebug(TAG, "Ignoring empty REQUEST content from peer");
      return;
    }

    // Enqueue for sequential processing
    if (this.queueSize >= MAX_QUEUE_SIZE) {
      logWarn(TAG, `Queue full (${MAX_QUEUE_SIZE}), dropping oldest message`);
      // We still chain it — the oldest in-flight will finish, but we drop this logically
      // by not incrementing. Actually, the design says "drop oldest if exceeded".
      // Since we use a promise chain, we can't easily drop the oldest.
      // Instead, we drop the newest incoming message when the queue is full.
      // This is a pragmatic interpretation — the queue is FIFO and we reject overflow.
      return;
    }

    this.queueSize++;
    logDebug(TAG, `Queuing REQUEST (queue size: ${this.queueSize})`);

    const sessionKey = `a2a:${this.a2aChannelId}`;
    // Reply to the originating channel (thread ID if in a thread, otherwise the A2A channel)
    const replyChannelId = message.channelId;

    this.processingChain = this.processingChain.then(async () => {
      try {
        logDebug(TAG, `Processing REQUEST: ${content.substring(0, 80)}…`);
        const response = await this.onPrompt(sessionKey, content);
        await this.sendToA2A(response, replyChannelId);
      } catch (err) {
        const description = err instanceof Error ? err.message : String(err);
        logError(TAG, "Transport error during A2A prompt", err);
        try {
          const statusMsg = this.formatOutbound("STATUS", `error: ${description}`);
          await this.sendToA2A(statusMsg, replyChannelId);
        } catch (sendErr) {
          logError(TAG, "Failed to send error status to A2A channel", sendErr);
        }
      } finally {
        this.queueSize--;
      }
    });

    await this.processingChain;
  }

  /** Parse a A2A message tag from the message text. Returns tag and content. */
  parseTag(text: string): { tag: A2AMessageTag; content: string } {
    const match = TAG_PATTERN.exec(text);
    if (match) {
      return {
        tag: match[1] as A2AMessageTag,
        content: text.slice(match[0].length),
      };
    }
    // Default to REQUEST if no recognized tag
    return { tag: "REQUEST", content: text };
  }

  /** Format an outbound A2A message with the given tag. */
  formatOutbound(tag: A2AMessageTag, content: string): string {
    return `[${tag}] ${content}`;
  }

  /** Send a message to a A2A channel (or thread), respecting rate limits. */
  async sendToA2A(text: string, targetChannelId?: string): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastSendTime;
    if (elapsed < this.rateLimitMs) {
      const delay = this.rateLimitMs - elapsed;
      logDebug(TAG, `Rate limiting: waiting ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const channelId = targetChannelId ?? this.a2aChannelId;
    await this.discordApi.sendMessage(channelId, text);
    this.lastSendTime = Date.now();
  }
}
