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
 * #1894 — ambient auto-recall is translation-free and LLM-free: extraction
 * plus priming composition, then the joined-query fallback when extraction
 * finds nothing. Source-language matching rides on the raw turn (`original`),
 * which abmind's lexical probes match against both stored language fields.
 * A term-preparation failure falls back rather than emitting no query.
 */

import { abmind } from "../../utils/abmind-lazy.js";

/** Upper bound on discrete terms per recall: keeps the porter OR probe bounded. */
export const MAX_QUERY_TERMS = 12;

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
