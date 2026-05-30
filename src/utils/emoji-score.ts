/** Inline emoji-to-score map (avoids hard dep on abmind for adapters). */
const EMOJI_SCORES: Record<string, number> = {
  "❤️": 4, "🔥": 4, "🎉": 3, "👏": 4, "❤": 4,
  "👍": 3, "😂": 3, "🤩": 4, "💯": 3, "⚡": 3,
  "😊": 2, "🙏": 2, "🤔": 1, "😮": 1,
  "👎": -3, "😢": -3, "😡": -4, "🤮": -4, "💩": -5,
};

export function emojiToScore(emoji: string): number {
  return EMOJI_SCORES[emoji] ?? 1;
}
