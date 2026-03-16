/** Clamp a value to [-5, +5]. Non-integer or missing values default to 0. */
export function clampEmotionScore(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isInteger(n)) return 0;
  return Math.max(-5, Math.min(5, n));
}

const EMOJI_SCORES: Record<string, number> = {
  "❤️": 4, "🔥": 4, "🎉": 4, "👏": 4, "❤": 4,
  "👍": 3, "😂": 3, "🤩": 3, "💯": 3, "⚡": 3,
  "😊": 2, "🙏": 2, "🤔": 1, "😮": 1,
  "👎": -3, "😢": -3, "😡": -4, "🤮": -4, "💩": -5,
};

/** Map a reaction emoji to an emotion score [-5, +5]. Unknown emojis default to +1. */
export function emojiToScore(emoji: string): number {
  return EMOJI_SCORES[emoji] ?? 1;
}
