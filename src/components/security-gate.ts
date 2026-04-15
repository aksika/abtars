/**
 * Fail-closed security gate that authorizes messages against the user registry.
 * Unauthorized messages are silently dropped — no response, no side effects.
 *
 * Resolves platform IDs to UserEntry for role-based access control.
 */
import type { UserEntry, UserRegistry } from "./user-registry.js";

export interface AuthResult {
  authorized: boolean;
  user?: UserEntry;
}

export class SecurityGate {
  private readonly registry: UserRegistry;
  private readonly allowedChannelIds: Set<string> | null;
  private readonly allChannels: boolean;

  constructor(registry: UserRegistry, allowedChannelIds?: Set<string>) {
    if (registry.users.length === 0) {
      throw new Error("SecurityGate requires at least one user in registry");
    }
    if (allowedChannelIds && allowedChannelIds.size === 0) {
      throw new Error("SecurityGate requires at least one allowed channel ID (or \"*\" for all)");
    }
    this.registry = registry;
    this.allowedChannelIds = allowedChannelIds ?? null;
    this.allChannels = allowedChannelIds?.has("*") ?? true;
  }

  /** Authorize a platform user. Returns user entry if authorized. */
  authorize(platformUserId: string, platform: string, channelId?: string): AuthResult {
    const key = `${platform}:${platformUserId}`;
    const user = this.registry.byPlatformId.get(key);
    if (!user) return { authorized: false };
    if (!this.allChannels && channelId && !this.allowedChannelIds!.has(channelId)) {
      return { authorized: false };
    }
    return { authorized: true, user };
  }

  /** Legacy compat — authorize by platform user ID string. */
  authorizeById(userId: string, channelId?: string): boolean {
    // Try telegram first, then discord
    const tg = this.registry.byPlatformId.get(`telegram:${userId}`);
    const dc = this.registry.byPlatformId.get(`discord:${userId}`);
    if (!tg && !dc) return false;
    if (this.allChannels || !channelId) return true;
    return this.allowedChannelIds!.has(channelId);
  }
}
