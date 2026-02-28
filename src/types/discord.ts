/** Discord and cross-platform bridge types. */

export type Platform = "telegram" | "discord";

export type BridgeMessage = {
  platform: Platform;
  channelId: string; // platform-prefixed: "discord:123" or "telegram:456"
  senderId: string;
  senderDisplayName: string;
  text: string;
  timestamp: number;
  rawPlatformData?: unknown;
};

export type DiscordInboundMessage = {
  id: string; // Discord message snowflake ID
  channelId: string; // Discord channel snowflake ID
  authorId: string; // Discord user snowflake ID
  authorUsername: string; // Discord username
  authorIsBot: boolean; // whether the author is a bot
  content: string; // message text content
  timestamp: number; // Unix ms
};
