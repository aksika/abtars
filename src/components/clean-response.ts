/**
 * Strip LLM response tags ([NO-REPLY], [REACT:emoji], [TOPICS:...], [lang:xx]) and return clean parts.
 * Single source of truth — used by message pipeline, startup greeting, and any other response path.
 */

const REACT_RE = /\[REACT:(.+?)\]/;
const NO_REPLY_RE = /\s*\[NO-REPLY\]\s*/gi;
const LANG_TAG_RE = /^\[lang:\w{2}\]\s*/i;
const TOPICS_RE = /\[TOPICS:\s*(.+?)\]/i;

export interface CleanedResponse {
  /** Text with all tags stripped. May be empty. */
  text: string;
  /** Emoji extracted from [REACT:emoji], if present. */
  reactionEmoji?: string;
  /** True if [NO-REPLY] was present in the original. */
  noReply: boolean;
  /** Keywords extracted from [TOPICS: kw1, kw2, kw3], if present. */
  topics?: string[];
}

/** Strip known LLM tags from a response string. */
export function cleanResponse(raw: string): CleanedResponse {
  const noReply = NO_REPLY_RE.test(raw);
  NO_REPLY_RE.lastIndex = 0; // reset global regex
  let text = raw.replace(NO_REPLY_RE, "").replace(LANG_TAG_RE, "").trim();
  let reactionEmoji: string | undefined;
  let topics: string[] | undefined;
  const reactMatch = text.match(REACT_RE);
  if (reactMatch) {
    reactionEmoji = reactMatch[1]!;
    text = text.replace(reactMatch[0], "").trim();
  }
  const topicsMatch = text.match(TOPICS_RE);
  if (topicsMatch) {
    topics = topicsMatch[1]!.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length >= 2);
    text = text.replace(topicsMatch[0], "").trim();
  }
  return { text, reactionEmoji, noReply, topics };
}
