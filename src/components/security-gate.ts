/**
 * Fail-closed security gate that authorizes messages against a whitelist
 * of allowed user IDs and optionally allowed channel IDs.
 * Unauthorized messages are silently dropped — no response, no side effects.
 *
 * Works for both Telegram (numeric IDs as strings) and Discord (snowflake IDs).
 * If allowedChannelIds contains "*", all channels are permitted.
 */
export class SecurityGate {
  private readonly allowedUserIds: Set<string>;
  private readonly allowedChannelIds: Set<string> | null;
  private readonly allChannels: boolean;

  constructor(allowedUserIds: Set<string>, allowedChannelIds?: Set<string>) {
    if (allowedUserIds.size === 0) {
      throw new Error("SecurityGate requires at least one allowed user ID");
    }
    if (allowedChannelIds && allowedChannelIds.size === 0) {
      throw new Error("SecurityGate requires at least one allowed channel ID (or \"*\" for all)");
    }
    this.allowedUserIds = allowedUserIds;
    this.allowedChannelIds = allowedChannelIds ?? null;
    this.allChannels = allowedChannelIds?.has("*") ?? true;
  }

  /** Returns true iff the user is whitelisted and (if configured) the channel is permitted. */
  authorize(userId: string, channelId?: string): boolean {
    if (!this.allowedUserIds.has(userId)) return false;
    if (this.allChannels || !channelId) return true;
    return this.allowedChannelIds!.has(channelId);
  }
}
