import type { Platform, BridgeMessage, DiscordInboundMessage } from "../types/discord.js";
import type { TelegramMessage } from "../types/telegram.js";

/**
 * Stateless adapter that normalizes platform-specific messages
 * into a common BridgeMessage format.
 */
export class ChannelAdapter {
  /** Normalize a Telegram message into a BridgeMessage. */
  fromTelegram(message: TelegramMessage): BridgeMessage {
    const chatId = message.chat.id;
    const senderId = message.from?.id ?? 0;
    const senderDisplayName = message.from?.first_name ?? String(senderId);

    return {
      platform: "telegram",
      channelId: `telegram:${chatId}`,
      senderId: String(senderId),
      senderDisplayName,
      text: message.text ?? "",
      timestamp: message.date * 1000,
      rawPlatformData: message,
    };
  }

  /** Normalize a Discord inbound message into a BridgeMessage. */
  fromDiscord(message: DiscordInboundMessage): BridgeMessage {
    return {
      platform: "discord",
      channelId: `discord:${message.channelId}`,
      senderId: message.authorId,
      senderDisplayName: message.authorUsername,
      text: message.content,
      timestamp: message.timestamp,
      rawPlatformData: message,
    };
  }

  /** Generate a platform-prefixed session key. */
  sessionKey(platform: Platform, channelId: string): string {
    return `${platform}:${channelId}`;
  }
}
