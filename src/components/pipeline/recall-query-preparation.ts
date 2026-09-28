/**
 * recall-query-preparation.ts — #1867 bridge-side query preparation.
 *
 * The bridge owns turn context and query composition (user text + session
 * priming); abmind owns query semantics and candidate retrieval. This module
 * turns one joined message into discrete retrieval terms so #1861's
 * document-frequency weighting and coverage ordering participate on the
 * auto-recall path — both are inert for single joined strings (the
 * raw-message path in trigram-search.ts).
 *
 * Paths, in order:
 * 1. Genuine translation (non-English-gated, bounded, injected seam):
 *    concise English terms from a text-producing capability through
 *    dispatchBackground. Never Laya: Laya scores supplied variants only and
 *    never writes or translates search text.
 * 2. English-token extraction fallback (always available, in-process,
 *    microsecond latency, fully private): tokens likely to appear in
 *    content_en via abmind's extractEnglishTokens. Never claimed translation.
 * 3. Joined-query fallback: today's behavior, when extraction finds nothing
 *    and translation is unavailable or fails. A term-preparation failure
 *    falls back here rather than emitting no query.
 *
 * Query-preparation comparison (milestone 1, 2026-09-29):
 * - Extraction: zero added latency, no exfil, no failure mode (pure
 *   function); quality limited to proper nouns + English cognates.
 * - Bounded spin translation (dispatchBackground type S, non-English turns
 *   only): genuine terms at the cost of one oneshot model call; privacy
 *   delta is nil (the turn itself goes to the provider seconds later);
 *   timeout/error falls back to extraction, then to joined.
 * - Laya translation: rejected — scoring-only contract.
 * - Hardcoded word lists (stopwords or glossaries): rejected — they cannot
 *   track Hungarian turns or domain jargon; corpus df measures both.
 */

import { logDebug } from "../logger.js";
import { abmind } from "../../utils/abmind-lazy.js";

const TAG = "pipeline";

/** Upper bound on discrete terms per recall: keeps the porter OR probe bounded. */
export const MAX_QUERY_TERMS = 12;
/** Translation input is one turn; truncate absurd lengths before the model call. */
export const TRANSLATION_MAX_CHARS = 500;
/** Default foreground bound for the translation call on non-English turns. */
export const TRANSLATION_TIMEOUT_MS_DEFAULT = 5000;

export function translationTimeoutMs(): number {
  const raw = parseInt(process.env["RECALL_TRANSLATION_TIMEOUT_MS"] ?? String(TRANSLATION_TIMEOUT_MS_DEFAULT), 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : TRANSLATION_TIMEOUT_MS_DEFAULT;
}

export interface RecallQueryPreparationDeps {
  /** Token extractor; defaults to abmind's extractEnglishTokens when loaded. */
  extractTokens?: (text: string) => string[];
}

export interface PreparedRecallQuery {
  /** Today's joined query (text + priming) — always present, the fallback. */
  query: string;
  /** Discrete terms when preparation found any; absent means joined fallback. */
  terms?: string[];
  /** Raw user message for original-language matching. */
  original: string;
}

function defaultExtractTokens(text: string): string[] {
  const extract = abmind()?.extractEnglishTokens;
  if (typeof extract === "function") {
    try {
      return extract(text) ?? [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Merge term sources in first-seen order, trimming, dropping empties, capping. */
export function mergeQueryTerms(sources: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const source of sources) {
    for (const raw of source) {
      const term = raw.trim();
      if (!term || seen.has(term)) continue;
      seen.add(term);
      out.push(term);
      if (out.length >= MAX_QUERY_TERMS) return out;
    }
  }
  return out;
}

/**
 * Split one turn into discrete retrieval terms. Pure and synchronous:
 * extraction only, never translation. Returns no `terms` when extraction
 * finds nothing — the caller keeps today's joined query.
 */
export function prepareRecallQuery(
  text: string,
  priming: readonly string[],
  deps: RecallQueryPreparationDeps = {},
): PreparedRecallQuery {
  const query = [...new Set([text, ...priming])].join(" ");
  const extract = deps.extractTokens ?? defaultExtractTokens;
  let extracted: string[] = [];
  try {
    extracted = extract(text) ?? [];
  } catch {
    extracted = [];
  }
  const terms = mergeQueryTerms([extracted, priming]);
  return terms.length > 0 ? { query, terms, original: text } : { query, original: text };
}

function letterCount(text: string): number {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/**
 * Non-English gate: the text carries letters but extraction covers less than
 * half of the letter content, so the English and embedding paths would
 * otherwise search on a minority of the turn. English turns (extraction
 * covers ~everything) never pay for translation.
 */
export function needsTranslation(text: string, extracted: readonly string[]): boolean {
  const total = letterCount(text);
  if (total < 3) return false;
  const covered = letterCount(extracted.join(" "));
  return covered / total < 0.5;
}

/** Minimal structural surface for the translation call (Spin satisfies it). */
export interface TranslationCaller {
  dispatchBackground(opts: { prompt: string; timeoutMs?: number }): Promise<string>;
}

/**
 * Genuine English terms for a non-English turn via a bounded oneshot model
 * call (dispatchBackground, type S: transient, terminates after the call, no
 * decorators). Any failure — timeout, non-text outcome, unparseable output —
 * throws, and the caller falls back to extraction, then to the joined query.
 * Never returns an empty query: empty parses yield [] and the caller falls
 * back.
 */
export async function translateRecallTerms(
  caller: TranslationCaller,
  text: string,
  opts?: { timeoutMs?: number; maxChars?: number },
): Promise<string[]> {
  const input = text.slice(0, opts?.maxChars ?? TRANSLATION_MAX_CHARS).trim();
  if (!input) return [];
  const t0 = Date.now();
  const raw = await caller.dispatchBackground({
    // Type S is dispatchBackground's default: transient oneshot, terminates
    // after the call, no decorators — the lightest model-call path.
    prompt: `Translate the following user message into concise English search terms. Reply with one term per line, no numbering, no explanation.\n\n${input}`,
    timeoutMs: opts?.timeoutMs ?? translationTimeoutMs(),
  });
  const terms = mergeQueryTerms([raw.split(/[^\p{L}\p{N}_-]+/u).filter((t) => t.length > 2)]);
  logDebug(TAG, `Recall translation: ${terms.length} terms in ${Date.now() - t0}ms`);
  return terms;
}
