/** Discord types. */

import type { Platform } from "./platform.js";
export type { Platform };

export type DiscordInboundMessage = {
  id: string; // Discord message snowflake ID
  channelId: string; // Discord channel snowflake ID (thread ID if in a thread)
  parentChannelId: string | null; // Parent channel ID if message is in a thread
  channelName: string | null; // Channel name (e.g. "general"), null if unavailable
  isDM: boolean; // True if no guildId (DM or group DM)
  authorId: string; // Discord user snowflake ID
  authorUsername: string; // Discord username
  authorIsBot: boolean; // whether the author is a bot
  content: string; // message text content
  timestamp: number; // Unix ms
  mentionsBotId: boolean; // whether the bot was @user-mentioned
  mentionsBotRole: boolean; // whether any role the bot holds was @role-mentioned (#388)
  mentionsEveryone: boolean; // whether @everyone or @here was used
  hasUserMentions: boolean; // whether any @user mentions exist in the message
  /** raw.reference?.messageId — for reply-to-bot detection in the adapter (#388). */
  replyReferenceMessageId: string | null;
  attachments?: { url: string; filename: string; contentType?: string; size: number }[];
};
