import type { Message } from "discord.js";
import type { DiscordInboundMessage } from "../types/discord.js";
import type { DiscordApi } from "./discord-api.js";
import { logInfo, logDebug, logWarn } from "./logger.js";

const TAG = "DiscordPoller";

/**
 * Event-driven listener for Discord messages via the Gateway WebSocket.
 * Mirrors TelegramPoller in lifecycle (start/stop) but uses discord.js
 * event handlers instead of long-polling. Reconnection and heartbeat
 * are handled by discord.js internally.
 */
export class DiscordPoller {
  private readonly api: DiscordApi;
  private readonly onMessage: (message: DiscordInboundMessage) => void | Promise<void>;
  private started = false;

  constructor(
    api: DiscordApi,
    onMessage: (message: DiscordInboundMessage) => void | Promise<void>,
  ) {
    this.api = api;
    this.onMessage = onMessage;
  }

  /** Connect to Gateway and start listening. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.api.connect();

    this.api.onMessage((raw: Message) => {
      // Filter out self-messages
      const botId = this.api.botUserId;
      if (botId && raw.author.id === botId) {
        logDebug(TAG, `Ignoring self-message ${raw.id}`);
        return;
      }

      const inbound = toDiscordInboundMessage(raw);
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
function toDiscordInboundMessage(raw: Message): DiscordInboundMessage {
  return {
    id: raw.id,
    channelId: raw.channelId,
    authorId: raw.author.id,
    authorUsername: raw.author.username,
    authorIsBot: raw.author.bot ?? false,
    content: raw.content,
    timestamp: raw.createdTimestamp,
  };
}
