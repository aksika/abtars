import type { Message } from "discord.js";
import type { DiscordInboundMessage } from "../../types/discord.js";
import type { DiscordApi } from "./discord-api.js";
import { logInfo, logDebug, logWarn } from "../../components/logger.js";

const TAG = "DiscordPoller";

/**
 * Event-driven listener for Discord messages via the Gateway WebSocket.
 * Mirrors TelegramPoller in lifecycle (start/stop) but uses discord.js
 * event handlers instead of long-polling. Reconnection and heartbeat
 * are handled by discord.js internally.
 */
export class DiscordPoller {
  private readonly api: DiscordApi;
  private readonly appId: string;
  private readonly onMessage: (message: DiscordInboundMessage) => void | Promise<void>;
  private started = false;

  constructor(
    api: DiscordApi,
    appId: string,
    onMessage: (message: DiscordInboundMessage) => void | Promise<void>,
  ) {
    this.api = api;
    this.appId = appId;
    this.onMessage = onMessage;
  }

  /** Connect to Gateway and start listening. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.api.connect();

    this.api.onMessage((raw: Message) => {
      // Filter out self-messages (use appId from config, fallback to client user id)
      const selfId = this.api.botUserId ?? this.appId;
      if (raw.author.id === selfId) {
        logDebug(TAG, `Ignoring self-message ${raw.id}`);
        return;
      }

      const inbound = toDiscordInboundMessage(raw, this.appId);
      logDebug(TAG, `Dispatching message ${inbound.id} from ${inbound.authorUsername}`);

      try {
        const result = this.onMessage(inbound);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            logWarn(TAG, `Error in message callback: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        logWarn(TAG, `Error in message callback: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    logInfo(TAG, "Started — listening for Discord messages");
  }

  /** Disconnect from Gateway cleanly. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.api.disconnect();
    logInfo(TAG, "Stopped");
  }
}

/** Convert a raw discord.js Message to a DiscordInboundMessage. */
function toDiscordInboundMessage(raw: Message, botId: string | null): DiscordInboundMessage {
  const parentId = (raw.channel as any).parentId ?? null;
  const channelName: string | null = (raw.channel as any).name ?? null;
  // Check both discord.js parsed mentions AND raw content for the bot's mention tag
  const mentionsBotId = botId
    ? (raw.mentions.users.has(botId) || new RegExp(`<@!?${botId}>`).test(raw.content))
    : false;
  logDebug(TAG, `mentionsBotId=${mentionsBotId} (appId=${botId}, mentions=${[...raw.mentions.users.keys()].join(",")}, content=${raw.content.slice(0, 60)})`);
  return {
    id: raw.id,
    channelId: raw.channelId,
    parentChannelId: parentId,
    channelName,
    authorId: raw.author.id,
    authorUsername: raw.author.username,
    authorIsBot: raw.author.bot ?? false,
    content: raw.content,
    timestamp: raw.createdTimestamp,
    mentionsBotId,
    mentionsEveryone: raw.mentions.everyone,
    hasUserMentions: raw.mentions.users.size > 0,
    attachments: raw.attachments.size > 0
      ? [...raw.attachments.values()].map(a => ({ url: a.url, filename: a.name ?? "file", contentType: a.contentType ?? undefined, size: a.size }))
      : undefined,
  };
}
