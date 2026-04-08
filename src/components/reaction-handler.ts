/**
 * reaction-handler.ts — Unified reaction handling.
 * One place for: allowed list check, fallback map, API call, text fallback.
 */

import type { PlatformAdapter } from "../types/index.js";
import { TELEGRAM_ALLOWED_REACTIONS, REACTION_FALLBACK_MAP } from "./reaction-signal.js";
import { logDebug } from "./logger.js";

const TAG = "reaction";

/**
 * Try to send an emoji as a Telegram reaction. Falls back to text message.
 * Returns true if the emoji was handled (caller should not send it again).
 */
export async function tryReaction(
  adapter: PlatformAdapter,
  channelId: string,
  messageId: number | undefined,
  emoji: string,
  threadId?: string,
): Promise<boolean> {
  if (!adapter.setReaction || !messageId) {
    await adapter.sendMessage(channelId, emoji, { threadId });
    logDebug(TAG, `No reaction API — sent ${emoji} as text`);
    return true;
  }

  const fallback = TELEGRAM_ALLOWED_REACTIONS.has(emoji) ? emoji : (REACTION_FALLBACK_MAP[emoji] ?? null);
  if (fallback) {
    try {
      await adapter.setReaction(channelId, messageId, fallback);
      logDebug(TAG, `Reaction: ${emoji}${emoji !== fallback ? ` → ${fallback}` : ""}`);
      return true;
    } catch {
      // API call failed — fall through to text
    }
  }

  // Reaction not supported or API failed — send as text
  await adapter.sendMessage(channelId, emoji, { threadId });
  logDebug(TAG, `Reaction ${emoji} not supported — sent as text`);
  return true;
}
