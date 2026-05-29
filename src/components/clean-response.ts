/**
 * Strip LLM response tags and echoed internal context from responses.
 * Single source of truth — used by message pipeline, startup greeting, and any other response path.
 */

const REACT_RE = /\[REACT:(.+?)\]/;
const NO_REPLY_RE = /\s*\[NO_REPLY\]\s*/gi;
const LANG_TAG_RE = /^\[lang:\w{2}\]\s*/i;
const TOPICS_RE = /\[TOPICS:\s*(.+?)\]/i;

// Internal context markers — strip if model echoes them back
const CONTEXT_BLOCK_RE = /\[CONTEXT[^\]]*\][\s\S]*?\[\/CONTEXT\]/gi;
const MEMORY_BLOCK_RE = /\[MEMORY CONTEXT[^\]]*\][\s\S]*?\[\/MEMORY CONTEXT\]/gi;
const COMPACT_BLOCK_RE = /\[COMPACTED CONVERSATION\][\s\S]*?\[\/COMPACTED CONVERSATION\]/gi;
const SESSION_REASON_RE = /\[SESSION START REASON\][^\n]*/gi;
const CURRENT_USER_RE = /\[CURRENT USER\][^\[]*/gi;
const FLASHBACK_RE = /\[Flashback\][^\n]*/gi;
const CURRENT_TIME_RE = /\[Current time:[^\]]*\]/gi;

export interface CleanedResponse {
  /** Text with all tags stripped. May be empty. */
  text: string;
  /** Emoji extracted from [REACT:emoji], if present. */
  reactionEmoji?: string;
  /** True if [NO_REPLY] was present in the original. */
  noReply: boolean;
  /** Keywords extracted from [TOPICS: kw1, kw2, kw3], if present. */
  topics?: string[];
}

/** Strip known LLM tags and echoed internal context from a response string. */
export function cleanResponse(raw: string): CleanedResponse {
  const noReply = NO_REPLY_RE.test(raw);
  NO_REPLY_RE.lastIndex = 0;
  let text = raw.replace(NO_REPLY_RE, "").replace(LANG_TAG_RE, "").trim();

  // Extract structured tags before stripping
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

  // Strip echoed internal context — model should never output these
  text = text
    .replace(CONTEXT_BLOCK_RE, "")
    .replace(MEMORY_BLOCK_RE, "")
    .replace(COMPACT_BLOCK_RE, "")
    .replace(SESSION_REASON_RE, "")
    .replace(CURRENT_USER_RE, "")
    .replace(FLASHBACK_RE, "")
    .replace(CURRENT_TIME_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, reactionEmoji, noReply, topics };
}
