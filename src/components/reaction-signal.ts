/** Telegram-allowed reaction emojis (API rejects anything not in this set). */
export const TELEGRAM_ALLOWED_REACTIONS = new Set([
  "👍","👎","❤","🔥","🥰","👏","😁","🤔","🤯","😱","🤬","😢","🎉","🤩","🤮","💩",
  "🙏","👌","🕊","🤡","🥱","🥴","😍","🐳","❤🔥","🌚","🌭","💯","🤣","⚡","🍌",
  "🏆","💔","🤨","😐","🍓","🍾","💋","🖕","😈","😴","😭","🤓","👻","👨💻","👀",
  "🎃","🙈","😇","😨","🤝","✍","🤗","🫡","🎅","🎄","☃","💅","🤪","🗿","🆒",
  "💘","🙉","🦄","😘","💊","🙊","😎","👾","🤷♂","🤷","🤷♀","😡",
]);

/** Map unsupported emojis to the closest Telegram-allowed equivalent. */
export const REACTION_FALLBACK_MAP: Record<string, string> = {
  "😅": "🤣", "😂": "🤣", "😆": "😁", "😄": "😁", "😃": "😁",
  "🙂": "😁", "😊": "😁", "☺": "😁", "😉": "😁", "🫠": "🤪",
  "😞": "😢", "😔": "😢", "😟": "😢", "😕": "🤔", "🫤": "🤨",
  "😤": "😡", "😠": "😡", "💪": "👏", "🤞": "🙏", "✅": "👍",
  "❌": "👎", "😬": "🙈", "🫣": "🙈", "🤭": "🙊", "💀": "👻",
};

/**
 * Format a reaction signal string for forwarding to the agent transport.
 * @param senderName - Display name of the user who reacted
 * @param emojis - Array of emoji characters that were added
 * @returns Formatted reaction signal string
 */
export function formatReactionSignal(senderName: string, emojis: string[]): string {
  return `[${senderName} reaction: ${emojis.join(" ")}]`;
}
