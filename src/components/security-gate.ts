import type { TelegramMessage } from "../types/index.js";

/**
 * Fail-closed security gate that authorizes Telegram messages
 * against a whitelist of allowed user IDs. Unauthorized messages
 * are silently dropped — no response, no side effects.
 */
export class SecurityGate {
  private readonly allowedUserIds: Set<number>;

  constructor(allowedUserIds: Set<number>) {
    if (allowedUserIds.size === 0) {
      throw new Error("SecurityGate requires at least one allowed user ID");
    }
    this.allowedUserIds = allowedUserIds;
  }

  /** Returns true iff the message sender is in the whitelist. */
  authorize(message: TelegramMessage): boolean {
    const userId = message.from?.id;
    if (userId === undefined) return false;
    return this.allowedUserIds.has(userId);
  }

  /** Returns true iff the given user ID is in the whitelist. */
  authorizeUserId(userId: number): boolean {
    return this.allowedUserIds.has(userId);
  }

}
