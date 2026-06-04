/**
 * reactions.ts — Unified reaction handling.
 * Merged from: reaction-router.ts, reaction-signal.ts, reaction-handler.ts.
 * Allowed list, fallback map, routing, formatting, API call + text fallback.
 */

import { logAndSwallow } from "./log-and-swallow.js";
import type { PlatformAdapter, Platform } from "../types/index.js";
import { logDebug } from "./logger.js";

const TAG = "reaction";

// ── Telegram allowed reactions (API rejects anything not in this set) ───────

export const TELEGRAM_ALLOWED_REACTIONS = new Set([
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩",
  "🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤🔥","🌚","🌭","💯","🤣","⚡","🍌",
  "🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨💻","👀",
  "🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿","🆒",
  "💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷♂","🤷","🤷♀","😡",
]);

export const REACTION_FALLBACK_MAP: Record<string, string> = {
  "😅": "🤣", "😂": "🤣", "😆": "😁", "😄": "😁", "😃": "😁",
  "🙂": "😁", "😊": "😁", "☺": "😁", "😉": "😁", "🫠": "🤪",
  "😞": "😢", "😔": "😢", "😟": "😢", "😕": "🤔", "🫤": "🤨",
  "😤": "😡", "😠": "😡", "💪": "👏", "🤞": "🙏", "✅": "👍",
  "❌": "👎", "😬": "🙈", "🫣": "🙈", "🤭": "🙊", "💀": "👻",
};

// ── Routing ─────────────────────────────────────────────────────────────────

export type ReactionRouteResult = "transport" | "buffer" | "discard";

export function routeReaction(isAuthorized: boolean, chatType: string): ReactionRouteResult {
  if (!isAuthorized) return "discard";
  if (chatType === "group" || chatType === "supergroup") return "buffer";
  return "transport";
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatReactionSignal(senderName: string, emojis: string[]): string {
  return `[${senderName} reaction: ${emojis.join(" ")}]`;
}

// ── Try reaction (platform-aware) ───────────────────────────────────────────

/**
 * Try to set an emoji reaction on a message. Platform-aware:
 * - Telegram: checks allowed list + fallback map, falls back to text.
 * - Discord: passes any emoji through directly (accepts all Unicode).
 * - No setReaction API: sends emoji as text message.
 */
export async function tryReaction(
  adapter: PlatformAdapter,
  channelId: string,
  messageId: number | string | undefined,
  emoji: string,
  threadId?: string,
  platform?: Platform,
): Promise<boolean> {
  if (!adapter.setReaction || !messageId) {
    await adapter.sendMessage(channelId, emoji, { threadId });
    logDebug(TAG, `No reaction API — sent ${emoji} as text`);
    return true;
  }

  // Discord: any emoji works, pass through directly
  if (platform && platform !== "telegram") {
    try {
      await adapter.setReaction(channelId, messageId, emoji);
      logDebug(TAG, `Reaction: ${emoji}`);
      return true;
    } catch {
      await adapter.sendMessage(channelId, emoji, { threadId });
      return true;
    }
  }

  // Telegram: check allowed list + fallback map
  const fallback = TELEGRAM_ALLOWED_REACTIONS.has(emoji) ? emoji : (REACTION_FALLBACK_MAP[emoji] ?? null);
  if (fallback) {
    try {
      await adapter.setReaction(channelId, messageId, fallback);
      logDebug(TAG, `Reaction: ${emoji}${emoji !== fallback ? ` → ${fallback}` : ""}`);
      return true;
    } catch (err) { logAndSwallow("reactions", "op", err); }
  }

  await adapter.sendMessage(channelId, emoji, { threadId });
  logDebug(TAG, `Reaction ${emoji} not supported — sent as text`);
  return true;
}
