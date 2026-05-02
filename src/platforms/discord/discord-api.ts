import { logAndSwallow } from "../../components/log-and-swallow.js";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type User,
  type TextChannel,
} from "discord.js";
import { logInfo, logError, logDebug, logWarn } from "../../components/logger.js";

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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
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

  /** Register a handler for MESSAGE_REACTION_ADD events. */
  onReaction(handler: (reaction: MessageReaction, user: User) => void | Promise<void>): void {
    this.client.on("messageReactionAdd", async (reaction, user) => {
      if (user.bot) return;
      try {
        if (reaction.partial) await reaction.fetch();
        if (user.partial) await (user as any).fetch();
      } catch { return; }
      try {
        const result = handler(reaction as MessageReaction, user as User);
        if (result instanceof Promise) result.catch((err: unknown) => logError(TAG, "Reaction handler error", err));
      } catch (err) { logError(TAG, "Reaction handler error", err); }
    });
  }

  /** Register a handler for slash command interactions. */
  onInteraction(handler: (interaction: any) => void | Promise<void>): void {
    this.client.on("interactionCreate", async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      try {
        const result = handler(interaction);
        if (result instanceof Promise) result.catch((err: unknown) => logError(TAG, "Interaction handler error", err));
      } catch (err) { logError(TAG, "Interaction handler error", err); }
    });
  }

  /** Register global application commands. Idempotent — Discord diffs and updates. */
  async registerCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    if (!this.client.application) {
      logWarn(TAG, "Cannot register commands — application not available");
      return;
    }
    await this.client.application.commands.set(commands.map(c => ({ name: c.name, description: c.description, type: 1 })) as any);
    logInfo(TAG, `Registered ${commands.length} slash commands`);
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

  /** Send typing indicator to a channel. */
  async sendTyping(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased()) await (channel as TextChannel).sendTyping();
    } catch (err) { logAndSwallow("discord_api", "op", err); }
  }

  /** Add or remove a reaction on a message. Empty emoji = remove bot's reactions. */
  async setReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      if (!emoji) {
        // Remove bot's reactions
        const botId = this.client.user?.id;
        if (botId) {
          for (const reaction of message.reactions.cache.values()) {
            await reaction.users.remove(botId).catch(() => {});
          }
        }
      } else {
        await message.react(emoji);
      }
    } catch (err) { logAndSwallow("discord_api", "op", err); }
  }

  /** Edit a previously sent message. */
  async editMessage(channelId: string, messageId: string, text: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.edit(text);
    } catch (err) { logAndSwallow("discord_api", "op", err); }
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
