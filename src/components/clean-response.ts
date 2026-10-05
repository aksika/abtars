/**
 * Strip LLM response tags and echoed internal context from responses.
 * Single source of truth — used by message pipeline, startup greeting, and any other response path.
 */

const REACT_RE = /\[REACT:(.+?)\]/;
const NO_REPLY_RE = /\s*\[NO[-_]REPLY\]\s*/gi;
const LANG_TAG_RE = /^\[lang:\w{2}\]\s*/i;
const TOPICS_RE = /\[TOPICS:\s*(.+?)\]/i;
// #1913: agent-declared answer support (memory IDs only). Parsed before
// stripping; validated against host-observed evidence by the pipeline, so a
// forged marker degrades to the eligible subset instead of authorizing writes.
const SUPPORT_RE = /\[SUPPORT:\s*([\d\s,]+)\]/gi;
/** Delivery-time strip for the support marker (segments, TTS inputs). */
export const SUPPORT_STRIP_RE = /\s*\[SUPPORT:\s*[\d\s,]+\]\s*/gi;

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
  /** Memory IDs declared via [SUPPORT: id, ...], if present. */
  supportIds?: number[];
}

/** Extract declared support IDs (order-preserving, deduplicated, capped). */
export function extractSupportIds(raw: string): number[] {
  SUPPORT_RE.lastIndex = 0;
  const out: number[] = [];
  const seen = new Set<number>();
  let match: RegExpExecArray | null;
  while ((match = SUPPORT_RE.exec(raw)) !== null) {
    for (const part of match[1]!.split(",")) {
      const id = Number.parseInt(part.trim(), 10);
      if (!Number.isInteger(id) || id <= 0 || id > 2147483647 || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

/** Strip known LLM tags and echoed internal context from a response string. */
export function cleanResponse(raw: string): CleanedResponse {
  const noReply = NO_REPLY_RE.test(raw);
  NO_REPLY_RE.lastIndex = 0;
  let text = raw.replace(NO_REPLY_RE, "").replace(LANG_TAG_RE, "").trim();

  // Extract structured tags before stripping
  let reactionEmoji: string | undefined;
  let topics: string[] | undefined;
  const supportIds = extractSupportIds(text);
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
    .replace(SUPPORT_STRIP_RE, "")
    .replace(CONTEXT_BLOCK_RE, "")
    .replace(MEMORY_BLOCK_RE, "")
    .replace(COMPACT_BLOCK_RE, "")
    .replace(SESSION_REASON_RE, "")
    .replace(CURRENT_USER_RE, "")
    .replace(FLASHBACK_RE, "")
    .replace(CURRENT_TIME_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, reactionEmoji, noReply, topics, ...(supportIds.length > 0 ? { supportIds } : {}) };
}

/**
 * #1651 v2: how a settled model turn should be interpreted, decided by Spin
 * exactly once per turn and consumed downstream as the normalized fact.
 *
 * - `text`     — usable text content (text always wins over either marker)
 * - `reaction` — only a `[REACT:emoji]`; a valid chat control, not domain text
 * - `no_reply` — the model deliberately declined via `[NO_REPLY]`
 * - `empty`    — the provider settled the turn with nothing at all
 *
 * Text wins: `"[NO_REPLY] here you go"` is `text`, mirroring the pipeline's
 * own `if (!userResponse && noReply)` ordering. Spin classifies every settled
 * turn with this and never fabricates a placeholder result.
 */
export type ContentOutcome = "text" | "reaction" | "no_reply" | "empty";

/** Classify a raw provider response into a {@link ContentOutcome}. */
export function classifyContent(raw: string): ContentOutcome {
  const { text, reactionEmoji, noReply } = cleanResponse(raw);
  if (text.trim()) return "text";
  if (reactionEmoji) return "reaction";
  return noReply ? "no_reply" : "empty";
}
