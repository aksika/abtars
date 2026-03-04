import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from "discord.js";
import { logInfo, logError, logDebug } from "./logger.js";

const TAG = "DiscordApi";

/**
 * Thin wrapper around discord.js Client.
 * Provides typed methods for Gateway connection, message listening, and sending.
 */
export class DiscordApi {
  private readonly client: Client;
  private readonly token: string;
  private ready = false;

  constructor(botToken: string) {
    this.token = botToken;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("clientReady", () => {
      this.ready = true;
      logInfo(TAG, `Connected as ${this.client.user?.tag ?? "unknown"}`);
    });

    this.client.on("error", (err) => {
      logError(TAG, "Client error", err);
    });
  }

  /** Connect to the Discord Gateway. Resolves when the client is ready. */
  async connect(): Promise<void> {
    logInfo(TAG, "Connecting to Discord Gateway…");
    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.client.removeListener("clientReady", onReady);
        this.client.removeListener("error", onError);
      };

      this.client.once("clientReady", onReady);
      this.client.once("error", onError);

      this.client.login(this.token).catch((err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  /** Register a handler for MESSAGE_CREATE events. */
  onMessage(handler: (message: Message) => void | Promise<void>): void {
    this.client.on("messageCreate", (message) => {
      logDebug(TAG, `Message from ${message.author.tag} in #${message.channel.id}`);
      try {
        const result = handler(message);
        if (result instanceof Promise) {
          result.catch((err: unknown) => {
            logError(TAG, "Message handler error", err);
          });
        }
      } catch (err) {
        logError(TAG, "Message handler error", err);
      }
    });
  }

  /** Send a text message to a channel. Returns the sent message ID. */
  async sendMessage(channelId: string, text: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) {
      throw new Error(`Channel ${channelId} is not a text channel`);
    }
    const sent = await (channel as TextChannel).send(text);
    logDebug(TAG, `Sent message ${sent.id} to channel ${channelId}`);
    return sent.id;
  }

  /** Gracefully close the Gateway connection. */
  async disconnect(): Promise<void> {
    logInfo(TAG, "Disconnecting from Discord Gateway…");
    this.ready = false;
    this.client.destroy();
  }

  /** Whether the client is connected and ready. */
  get isReady(): boolean {
    return this.ready;
  }

  /** Get the bot's own user ID (for filtering self-messages). */
  get botUserId(): string | null {
    return this.client.user?.id ?? null;
  }
}
