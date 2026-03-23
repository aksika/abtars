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
  channelId: string; // Discord channel snowflake ID (thread ID if in a thread)
  parentChannelId: string | null; // Parent channel ID if message is in a thread
  channelName: string | null; // Channel name (e.g. "general"), null if unavailable
  authorId: string; // Discord user snowflake ID
  authorUsername: string; // Discord username
  authorIsBot: boolean; // whether the author is a bot
  content: string; // message text content
  timestamp: number; // Unix ms
  mentionsBotId: boolean; // whether the bot was @mentioned
  mentionsEveryone: boolean; // whether @everyone or @here was used
};
