/**
 * Fail-closed security gate for Discord messages.
 * Validates both user ID and channel ID against whitelists.
 * Unauthorized messages are silently dropped — no response, no side effects.
 */
export class DiscordSecurityGate {
  private readonly allowedUserIds: Set<string>;
  private readonly allowedChannelIds: Set<string>;

  constructor(allowedUserIds: Set<string>, allowedChannelIds: Set<string>) {
    if (allowedUserIds.size === 0) {
      throw new Error(
        "DiscordSecurityGate requires at least one allowed user ID",
      );
    }
    if (allowedChannelIds.size === 0) {
      throw new Error(
        "DiscordSecurityGate requires at least one allowed channel ID",
      );
    }
    this.allowedUserIds = allowedUserIds;
    this.allowedChannelIds = allowedChannelIds;
  }

  /** Returns true iff the author is in the user whitelist AND the channel is in the channel whitelist. */
  authorize(authorId: string, channelId: string): boolean {
    return (
      this.allowedUserIds.has(authorId) &&
      this.allowedChannelIds.has(channelId)
    );
  }
}
