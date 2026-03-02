import type Database from "better-sqlite3";

import { logDebug, logWarn } from "./logger.js";
import type { MemoryIndex } from "./memory-index.js";
import { sanitizeFtsQuery } from "./memory-index.js";
import type { MemorySearchParams, MemorySearchResult } from "../types/memory.js";

const TAG = "memory-search-tool";
const MS_PER_DAY = 86_400_000;

/**
 * Apply temporal decay to search results.
 *
 * Each result's score is multiplied by `2^(-age_in_days / halfLifeDays)` where
 * `age_in_days = (now - source_timestamp) / 86400000`.
 *
 * Returns a new array with adjusted scores. On any computation error the
 * original results are returned unchanged (graceful degradation).
 */
export function applyTemporalDecay(
  results: MemorySearchResult[],
  now: number,
  halfLifeDays: number,
): MemorySearchResult[] {
  try {
    return results.map((r) => {
      const ageDays = (now - r.source_timestamp) / MS_PER_DAY;
      const multiplier = Math.pow(2, -ageDays / halfLifeDays);
      return { ...r, score: r.score * multiplier };
    });
  } catch (err) {
    logWarn(TAG, `Temporal decay computation failed, returning base scores — ${err}`);
    return results;
  }
}

/**
 * Tokenize a string into a set of lowercased whitespace-split tokens.
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const t of text.toLowerCase().split(/\s+/)) {
    if (t) tokens.add(t);
  }
  return tokens;
}

/**
 * Compute token-level Jaccard similarity between two token sets.
 * Returns `|intersection| / |union|`, or 0 when both sets are empty.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Apply Maximal Marginal Relevance (MMR) re-ranking to diversify results.
 *
 * The first selected result is the highest-scored entry. Each subsequent
 * selection picks the candidate that maximises:
 *
 *   `MMR_score = lambda * relevance - (1 - lambda) * max_similarity_to_selected`
 *
 * Similarity is token-level Jaccard on the `content` (content_en) fields.
 *
 * When fewer than 2 results are provided, the input is returned as-is.
 * On any computation error the pre-MMR order is returned (graceful degradation).
 */
export function applyMMR(
  results: MemorySearchResult[],
  lambda: number,
): MemorySearchResult[] {
  if (results.length < 2) return results;

  try {
    // Normalise scores to [0, 1] for the MMR formula
    const maxScore = Math.max(...results.map((r) => r.score));
    const normFactor = maxScore > 0 ? maxScore : 1;

    // Pre-tokenize all candidates
    const tokenSets = results.map((r) => tokenize(r.content));

    const selected: MemorySearchResult[] = [];
    const selectedTokenSets: Set<string>[] = [];
    const remaining = new Set(results.map((_, i) => i));

    // First pick: highest scored entry
    let bestIdx = 0;
    for (const idx of remaining) {
      if (results[idx]!.score > results[bestIdx]!.score) bestIdx = idx;
    }
    selected.push(results[bestIdx]!);
    selectedTokenSets.push(tokenSets[bestIdx]!);
    remaining.delete(bestIdx);

    // Subsequent picks via MMR
    while (remaining.size > 0) {
      let bestMMR = -Infinity;
      let bestCandidate = -1;

      for (const idx of remaining) {
        const relevance = results[idx]!.score / normFactor;

        // Max similarity to any already-selected result
        let maxSim = 0;
        for (const selTokens of selectedTokenSets) {
          const sim = jaccardSimilarity(tokenSets[idx]!, selTokens);
          if (sim > maxSim) maxSim = sim;
        }

        const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
        if (mmrScore > bestMMR || bestCandidate === -1) {
          bestMMR = mmrScore;
          bestCandidate = idx;
        }
      }

      selected.push(results[bestCandidate]!);
      selectedTokenSets.push(tokenSets[bestCandidate]!);
      remaining.delete(bestCandidate);
    }

    return selected;
  } catch (err) {
    logWarn(TAG, `MMR re-ranking failed, returning pre-MMR order — ${err}`);
    return results;
  }
}


// ---------------------------------------------------------------------------
// MemorySearchTool — agent-callable memory recall
// ---------------------------------------------------------------------------

export type MemorySearchToolConfig = {
  searchTimeoutMs: number;
  decayHalflifeDays: number;
  mmrLambda: number;
};

export class MemorySearchTool {
  constructor(
    private db: Database.Database,
    private memoryIndex: MemoryIndex,
    private config: MemorySearchToolConfig,
  ) {}

  /**
   * Execute a memory search. Returns ranked, diverse results.
   * Completes within `searchTimeoutMs`, returning whatever is available at timeout.
   * Returns empty array on any error (graceful degradation).
   */
  async search(
    params: MemorySearchParams,
    chatId: number,
  ): Promise<MemorySearchResult[]> {
    try {
      const deadline = Date.now() + this.config.searchTimeoutMs;

      // 1. English keyword search across extracted memories + compacted summaries
      const englishResults = this.searchEnglish(
        params.keywords,
        chatId,
        params.time_range,
      );

      if (Date.now() >= deadline) {
        logDebug(TAG, "Timeout after English search, returning partial results");
        return englishResults;
      }

      // 2. Optional original-language fallback search
      let originalResults: MemorySearchResult[] = [];
      if (params.original_keyword) {
        originalResults = this.searchOriginalLanguage(
          params.original_keyword,
          chatId,
        );
      }

      if (Date.now() >= deadline) {
        logDebug(TAG, "Timeout after original-language search, returning partial results");
        const merged = this.mergeResults(englishResults, originalResults);
        return merged;
      }

      // 3. Merge + deduplicate
      const merged = this.mergeResults(englishResults, originalResults);

      if (Date.now() >= deadline) {
        logDebug(TAG, "Timeout after merge, returning pre-decay results");
        return merged;
      }

      // 4. Apply temporal decay
      let ranked: MemorySearchResult[];
      try {
        ranked = applyTemporalDecay(merged, Date.now(), this.config.decayHalflifeDays);
      } catch {
        logWarn(TAG, "Temporal decay failed, using base scores");
        ranked = merged;
      }

      if (Date.now() >= deadline) {
        logDebug(TAG, "Timeout after decay, returning pre-MMR results");
        ranked.sort((a, b) => b.score - a.score);
        return ranked;
      }

      // 5. Apply MMR re-ranking
      try {
        ranked = applyMMR(ranked, this.config.mmrLambda);
      } catch {
        logWarn(TAG, "MMR re-ranking failed, returning decay-only order");
        ranked.sort((a, b) => b.score - a.score);
      }

      return ranked;
    } catch (err) {
      logWarn(TAG, `Search failed, returning empty results — ${err}`);
      return [];
    }
  }

  /**
   * Search extracted memories and compacted summaries by English keywords.
   * Uses FTS5 OR-style matching on content_en for extracted memories,
   * and LIKE matching on compactions summary (no FTS5 index for compactions).
   */
  private searchEnglish(
    keywords: string[],
    chatId: number,
    timeRange?: { start: number; end: number },
  ): MemorySearchResult[] {
    if (!keywords.length) return [];

    // Build OR-style FTS5 query: "kw1"* OR "kw2"*
    const ftsQuery = sanitizeFtsQuery(keywords.join(" "));
    if (!ftsQuery) return [];

    // Search extracted memories via MemoryIndex
    const extractedResults = this.memoryIndex.searchExtracted(ftsQuery, {
      chatId,
      startTime: timeRange?.start,
      endTime: timeRange?.end,
      limit: 20,
    });

    // Search compacted summaries (weekly + quarterly) via LIKE matching
    const compactionResults = this.searchCompactions(keywords, chatId, timeRange);

    return [...extractedResults, ...compactionResults];
  }

  /**
   * Search the compactions table for matching summaries using LIKE.
   * Returns results with appropriate tier labels.
   */
  private searchCompactions(
    keywords: string[],
    chatId: number,
    timeRange?: { start: number; end: number },
  ): MemorySearchResult[] {
    try {
      const conditions: string[] = ["chat_id = ?", "tier IN ('weekly', 'quarterly')"];
      const params: (string | number)[] = [chatId];

      if (timeRange?.start !== undefined) {
        conditions.push("timestamp >= ?");
        params.push(timeRange.start);
      }
      if (timeRange?.end !== undefined) {
        conditions.push("timestamp <= ?");
        params.push(timeRange.end);
      }

      // OR-style LIKE matching: any keyword matches
      const likeClauses = keywords
        .map((kw) => kw.trim())
        .filter((kw) => kw.length > 0)
        .map((kw) => {
          const escaped = kw.replace(/%/g, "\\%").replace(/_/g, "\\_");
          params.push(`%${escaped}%`);
          return "summary LIKE ? ESCAPE '\\'";
        });

      if (likeClauses.length === 0) return [];
      conditions.push(`(${likeClauses.join(" OR ")})`);

      const sql = `
        SELECT id, tier, timestamp, summary
        FROM compactions
        WHERE ${conditions.join(" AND ")}
        ORDER BY timestamp DESC
        LIMIT 10
      `;

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        tier: string;
        timestamp: number;
        summary: string;
      }>;

      return rows.map((row) => ({
        content: row.summary,
        source_timestamp: row.timestamp,
        tier: row.tier as "weekly" | "quarterly",
        score: 1.0, // base score for LIKE matches
      }));
    } catch (err) {
      logWarn(TAG, `Compaction search failed: ${err}`);
      return [];
    }
  }

  /**
   * Search content_original for original-language keyword.
   * Boosts results where preserve_original is true.
   */
  private searchOriginalLanguage(
    keyword: string,
    chatId: number,
  ): MemorySearchResult[] {
    if (!keyword.trim()) return [];

    return this.memoryIndex.searchOriginal(keyword, {
      chatId,
      limit: 20,
      boostPreserved: true,
    });
  }

  /**
   * Merge and deduplicate English and original-language results.
   * Uses content as dedup key; keeps the higher score when duplicates exist.
   */
  private mergeResults(
    english: MemorySearchResult[],
    original: MemorySearchResult[],
  ): MemorySearchResult[] {
    const map = new Map<string, MemorySearchResult>();

    for (const r of english) {
      const key = r.content;
      const existing = map.get(key);
      if (!existing || r.score > existing.score) {
        map.set(key, r);
      }
    }

    for (const r of original) {
      const key = r.content;
      const existing = map.get(key);
      if (!existing || r.score > existing.score) {
        map.set(key, r);
      }
    }

    return Array.from(map.values());
  }
}
