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

const EMOJI_TAGS: Record<string, string> = {
  "❤️": "love", "❤": "love", "🔥": "excitement", "🎉": "joy",
  "👏": "pride", "👍": "gratitude", "😂": "humor", "🤩": "excitement",
  "💯": "conviction", "⚡": "determination", "😊": "joy", "🙏": "gratitude",
  "🤔": "curiosity", "😮": "surprise",
  "👎": "frustration", "😢": "grief", "😡": "anger", "🤮": "anger", "💩": "frustration",
};

export function emojiToTag(emoji: string): string {
  return EMOJI_TAGS[emoji] ?? "gratitude";
}
