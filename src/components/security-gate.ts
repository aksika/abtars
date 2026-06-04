/**
 * Fail-closed security gate that authorizes messages against the user registry.
 * Unauthorized messages are silently dropped — no response, no side effects.
 * Per-user channel gating via UserEntry.allowedChats.
 */
import type { UserEntry, UserRegistry } from "./user-registry.js";

export interface AuthResult {
  authorized: boolean;
  user?: UserEntry;
}

export class SecurityGate {
  private readonly registry: UserRegistry;

  constructor(registry: UserRegistry) {
    if (registry.users.length === 0) {
      throw new Error("SecurityGate requires at least one user in registry");
    }
    this.registry = registry;
  }

  /** Authorize a platform user. Checks allowedChats if set. */
  authorize(platformUserId: string, platform: string, channelId?: string): AuthResult {
    const key = `${platform}:${platformUserId}`;
    const user = this.registry.byPlatformId.get(key);
    if (!user) return { authorized: false };
    if (!this.chatAllowed(user, channelId)) return { authorized: false };
    return { authorized: true, user };
  }

  /** Authorize by platform user ID string (tries both platforms). */
  authorizeById(userId: string, channelId?: string): boolean {
    const tg = this.registry.byPlatformId.get(`telegram:${userId}`);
    const dc = this.registry.byPlatformId.get(`discord:${userId}`);
    const user = tg ?? dc;
    if (!user) return false;
    return this.chatAllowed(user, channelId);
  }

  private chatAllowed(user: UserEntry, channelId?: string): boolean {
    if (!user.allowedChats || user.allowedChats.length === 0) return true;
    if (!channelId) return true;
    return user.allowedChats.includes(channelId);
  }
}
