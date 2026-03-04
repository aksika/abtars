import type { RecallAnalysis } from "../types/index.js";
import { logWarn } from "./logger.js";

const TAG = "intent-detector";

/** Configuration for recall-intent cue phrase matching. */
export type IntentDetectorConfig = {
  cuePhrasesEn: string[];
  cuePhrasesHu: string[];
};

/** Default English recall-intent cue phrases. */
export const DEFAULT_CUE_PHRASES_EN: readonly string[] = [
  "do you recall",
  "I told you",
  "you said",
  "we discussed",
  "we talked about",
  "you mentioned",
  "I mentioned",
  "as I said",
  "I said",
  "remember",
];

/** Default Hungarian recall-intent cue phrases. */
export const DEFAULT_CUE_PHRASES_HU: readonly string[] = [
  "ugye mondtam",
  "mint mondtam",
  "emlékszel",
  "mondtam",
  "mondtad",
  "beszéltünk",
  "említettem",
  "említetted",
];

/**
 * Escape special regex characters in a string so it can be used
 * as a literal pattern inside a RegExp.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Stateless component that analyzes user messages for recall-intent cues
 * and temporal references using regex pattern matching. No LLM calls.
 */
export class IntentDetector {
  private readonly cuePatterns: RegExp[];

  constructor(config: IntentDetectorConfig) {
    // Build regex patterns from all cue phrases (case-insensitive).
    // Sort by length descending so longer phrases match first during stripping.
    const allPhrases = [...config.cuePhrasesEn, ...config.cuePhrasesHu].sort(
      (a, b) => b.length - a.length,
    );
    this.cuePatterns = allPhrases.map(
      (phrase) => new RegExp(`\\b${escapeRegex(phrase)}\\b`, "gi"),
    );
  }

  /**
   * Analyze a user message for recall-intent cues and temporal references.
   * Returns a no-intent result on any internal error (fail-open).
   */
  analyze(message: string, now?: Date): RecallAnalysis {
    try {
      // 1. Check if any cue phrase matches in the message
      let hasRecallIntent = false;
      let stripped = message;

      for (const pattern of this.cuePatterns) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        if (pattern.test(message)) {
          hasRecallIntent = true;
        }
        // Strip matched cue phrases from the message
        pattern.lastIndex = 0;
        stripped = stripped.replace(pattern, "");
      }

      // 2. Clean up extra whitespace from stripping
      const strippedQuery = stripped.replace(/\s+/g, " ").trim();

      // 3. Check if topic keywords remain after stripping
      const hasTopicKeywords = strippedQuery.length > 0;

      // 4. Parse temporal reference
      const temporalRange = this.parseTemporalReference(message, now);

      return {
        hasRecallIntent,
        temporalRange,
        strippedQuery,
        hasTopicKeywords,
      };
    } catch (err) {
      logWarn(TAG, `analyze() failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        hasRecallIntent: false,
        temporalRange: null,
        strippedQuery: message,
        hasTopicKeywords: true,
      };
    }
  }

  /**
   * Parse a temporal reference from the message into start/end timestamps.
   * Returns null if no recognizable temporal expression is found.
   *
   * Supports English and Hungarian temporal expressions.
   * All timestamps are in Unix milliseconds.
   */
  parseTemporalReference(
    message: string,
    now?: Date,
  ): { startTime: number; endTime: number } | null {
    try {
      const ref = now ?? new Date();
      const lower = message.toLowerCase();

      // --- "N days ago" / "N napja" ---
      const nDaysAgoMatch =
        lower.match(/(\d+)\s*days?\s*ago/i) ?? lower.match(/(\d+)\s*napja/i);
      if (nDaysAgoMatch) {
        const n = Number(nDaysAgoMatch[1]);
        if (Number.isNaN(n)) return null;
        const day = new Date(ref);
        day.setDate(day.getDate() - n);
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        const end = new Date(day);
        end.setHours(23, 59, 59, 999);
        if (start.getTime() > end.getTime()) return null;
        return { startTime: start.getTime(), endTime: end.getTime() };
      }

      // --- "N weeks ago" / "N hete" ---
      const nWeeksAgoMatch =
        lower.match(/(\d+)\s*weeks?\s*ago/i) ?? lower.match(/(\d+)\s*hete/i);
      if (nWeeksAgoMatch) {
        const n = Number(nWeeksAgoMatch[1]);
        if (Number.isNaN(n)) return null;
        const target = new Date(ref);
        target.setDate(target.getDate() - n * 7);
        // Monday of that week (ISO: Monday = 1)
        const dayOfWeek = target.getDay(); // 0=Sun, 1=Mon, ...
        const mondayOffset = (dayOfWeek + 6) % 7;
        const monday = new Date(target);
        monday.setDate(monday.getDate() - mondayOffset);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);
        if (monday.getTime() > sunday.getTime()) return null;
        return { startTime: monday.getTime(), endTime: sunday.getTime() };
      }

      // --- "yesterday" / "tegnap" ---
      if (/\byesterday\b/i.test(lower) || /\btegnap\b/i.test(lower)) {
        const day = new Date(ref);
        day.setDate(day.getDate() - 1);
        const start = new Date(day);
        start.setHours(0, 0, 0, 0);
        const end = new Date(day);
        end.setHours(23, 59, 59, 999);
        return { startTime: start.getTime(), endTime: end.getTime() };
      }

      // --- "today" / "ma" ---
      if (/\btoday\b/i.test(lower) || /\bma\b/i.test(lower)) {
        const start = new Date(ref);
        start.setHours(0, 0, 0, 0);
        return { startTime: start.getTime(), endTime: ref.getTime() };
      }

      // --- "last month" / "múlt hónapban" ---
      if (
        /\blast\s+month\b/i.test(lower) ||
        /\bm[uú]lt\s+h[oó]napban\b/i.test(lower)
      ) {
        const year = ref.getFullYear();
        const month = ref.getMonth(); // 0-indexed current month
        const start = new Date(year, month - 1, 1);
        start.setHours(0, 0, 0, 0);
        // Last day of previous month: day 0 of current month
        const end = new Date(year, month, 0);
        end.setHours(23, 59, 59, 999);
        return { startTime: start.getTime(), endTime: end.getTime() };
      }

      // --- "last week" / "múlt héten" ---
      if (
        /\blast\s+week\b/i.test(lower) ||
        /\bm[uú]lt\s+h[eé]ten\b/i.test(lower)
      ) {
        const sevenDaysAgo = new Date(ref);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const start = new Date(sevenDaysAgo);
        start.setHours(0, 0, 0, 0);
        const yesterday = new Date(ref);
        yesterday.setDate(yesterday.getDate() - 1);
        const end = new Date(yesterday);
        end.setHours(23, 59, 59, 999);
        return { startTime: start.getTime(), endTime: end.getTime() };
      }

      // --- "this week" / "ezen a héten" ---
      if (
        /\bthis\s+week\b/i.test(lower) ||
        /\bezen\s+a\s+h[eé]ten\b/i.test(lower)
      ) {
        const dayOfWeek = ref.getDay(); // 0=Sun, 1=Mon, ...
        const mondayOffset = (dayOfWeek + 6) % 7;
        const monday = new Date(ref);
        monday.setDate(monday.getDate() - mondayOffset);
        monday.setHours(0, 0, 0, 0);
        return { startTime: monday.getTime(), endTime: ref.getTime() };
      }

      return null;
    } catch (err) {
      logWarn(
        TAG,
        `parseTemporalReference() failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
