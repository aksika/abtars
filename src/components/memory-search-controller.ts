/**
 * Memory search controller — handles GET /api/memory/search requests.
 *
 * Executes a multi-layer recall pipeline across raw messages (L1),
 * extracted memories (L2), compaction summaries (L3), original-language
 * memories (L4), and a placeholder cloud layer (L5).
 *
 * Results are deduplicated, scored, sorted descending, and capped at 10.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import { logWarn } from "./logger.js";
import type { WebSearchResult, MemorySearchResponse } from "./dashboard-config.js";
import { searchConsolidationFiles } from "./consolidation-search.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MemorySearchDeps = {
  memoryIndex: MemoryIndex;
  db: Database.Database;
  memoryDir?: string;
};

const TAG = "memory-search-ctrl";
const VALID_LAYERS = new Set(["L1", "L2", "L3", "L4", "L5"]);
const DEFAULT_LAYERS = ["L1", "L2", "L3", "L4"];
const MAX_RESULTS = 10;

// ── Controller ──────────────────────────────────────────────────────────────

export class MemorySearchController {
  private readonly memoryIndex: MemoryIndex;
  private readonly db: Database.Database;
  private readonly memoryDir: string | undefined;

  constructor(deps: MemorySearchDeps) {
    this.memoryIndex = deps.memoryIndex;
    this.db = deps.db;
    this.memoryDir = deps.memoryDir;
  }

  /** List distinct chat IDs that have stored messages. */
  listChats(): { status: number; body: object } {
    try {
      const rows = this.db
        .prepare("SELECT DISTINCT chat_id FROM messages ORDER BY chat_id")
        .all() as Array<{ chat_id: number }>;
      return { status: 200, body: { chatIds: rows.map((r) => r.chat_id) } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listChats failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  /**
   * Handle `GET /api/memory/search?keywords=...&chatId=...&layers=...&original=...&timeStart=...&timeEnd=...`
   */
  async handle(
    params: URLSearchParams,
  ): Promise<{ status: number; body: object }> {
    // ── Parse & validate params ───────────────────────────────────────
    const keywordsRaw = params.get("keywords")?.trim() ?? "";
    if (!keywordsRaw) {
      return { status: 400, body: { error: "keywords required" } };
    }

    const chatIdRaw = params.get("chatId")?.trim() ?? "";
    const chatId = chatIdRaw ? Number(chatIdRaw) : undefined;
    if (chatIdRaw && !Number.isFinite(chatId!)) {
      return { status: 400, body: { error: "chatId must be a number" } };
    }

    const keywords = keywordsRaw
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (keywords.length === 0) {
      return { status: 400, body: { error: "keywords required" } };
    }

    const layersRaw = params.get("layers")?.trim();
    const requestedLayers = layersRaw
      ? layersRaw.split(",").map((l) => l.trim()).filter((l) => VALID_LAYERS.has(l))
      : DEFAULT_LAYERS;

    const original = params.get("original")?.trim() ?? "";
    const mode: "or" | "and" = params.get("mode")?.trim().toLowerCase() === "and" ? "and" : "or";
    const timeStart = parseOptionalNumber(params.get("timeStart"));
    const timeEnd = parseOptionalNumber(params.get("timeEnd"));

    // ── Execute search layers ─────────────────────────────────────────
    const allResults: WebSearchResult[] = [];
    const layerStatuses: Record<string, { status: "ok" | "not_implemented" | "skipped" }> = {};
    const query = keywords.join(" ");

    const searchOpts = {
      chatId: chatId as number | undefined,
      startTime: timeStart,
      endTime: timeEnd,
      limit: 20,
    };

    // L1: Raw Messages — FTS5 + relaxed FTS5 + substring
    if (requestedLayers.includes("L1")) {
      try {
        const l1Results = this.searchL1(query, searchOpts, mode);
        allResults.push(...l1Results);
        layerStatuses["L1"] = { status: "ok" };
      } catch (err) {
        logWarn(TAG, `L1 search failed: ${err instanceof Error ? err.message : String(err)}`);
        layerStatuses["L1"] = { status: "ok" };
      }
    } else {
      layerStatuses["L1"] = { status: "skipped" };
    }

    // L2: Extracted Memories — FTS5 on extracted_memories
    if (requestedLayers.includes("L2")) {
      try {
        const l2Results = this.searchL2(query, searchOpts, mode);
        allResults.push(...l2Results);
        layerStatuses["L2"] = { status: "ok" };
      } catch (err) {
        logWarn(TAG, `L2 search failed: ${err instanceof Error ? err.message : String(err)}`);
        layerStatuses["L2"] = { status: "ok" };
      }
    } else {
      layerStatuses["L2"] = { status: "skipped" };
    }

    // L3: Compaction Summaries — LIKE on compactions table
    if (requestedLayers.includes("L3")) {
      try {
        const l3Results = this.searchL3(keywords, chatId, timeStart, timeEnd, mode);
        allResults.push(...l3Results);
        layerStatuses["L3"] = { status: "ok" };
      } catch (err) {
        logWarn(TAG, `L3 search failed: ${err instanceof Error ? err.message : String(err)}`);
        layerStatuses["L3"] = { status: "ok" };
      }
    } else {
      layerStatuses["L3"] = { status: "skipped" };
    }

    // L4: Original Language — searchOriginal (only with `original` param)
    if (requestedLayers.includes("L4")) {
      if (original) {
        try {
          const l4Results = this.searchL4(original, chatId, mode);
          allResults.push(...l4Results);
          layerStatuses["L4"] = { status: "ok" };
        } catch (err) {
          logWarn(TAG, `L4 search failed: ${err instanceof Error ? err.message : String(err)}`);
          layerStatuses["L4"] = { status: "ok" };
        }
      } else {
        layerStatuses["L4"] = { status: "skipped" };
      }
    } else {
      layerStatuses["L4"] = { status: "skipped" };
    }

    // L5: Cloud — not implemented
    if (requestedLayers.includes("L5")) {
      layerStatuses["L5"] = { status: "not_implemented" };
    } else {
      layerStatuses["L5"] = { status: "skipped" };
    }

    // ── Deduplicate, sort, limit ──────────────────────────────────────
    const deduplicated = deduplicateResults(allResults);
    deduplicated.sort((a, b) => b.score - a.score);
    const limited = deduplicated.slice(0, MAX_RESULTS);

    const response: MemorySearchResponse = {
      results: limited,
      layers: layerStatuses,
    };

    return { status: 200, body: response };
  }



  // ── Layer search methods ────────────────────────────────────────────────

  /**
   * L1: FTS5 full-text + relaxed FTS5 + substring search on raw messages.
   */
  private searchL1(
    query: string,
    opts: { chatId?: number; startTime?: number; endTime?: number; limit?: number },
    mode: "or" | "and",
  ): WebSearchResult[] {
    const results: WebSearchResult[] = [];

    // FTS5 search
    const ftsResults = this.memoryIndex.search(query, opts, mode);
    for (const r of ftsResults) {
      results.push({
        content: r.record.content,
        date: new Date(r.record.timestamp).toISOString(),
        source: "L1:fts",
        score: r.score,
      });
    }

    // Substring search
    const substringResults = this.memoryIndex.substringSearch(query, opts, mode);
    for (const r of substringResults) {
      results.push({
        content: r.record.content,
        date: new Date(r.record.timestamp).toISOString(),
        source: "L1:substring",
        score: r.score * 0.6,
      });
    }

    return results;
  }

  /**
   * L2: FTS5 search on extracted_memories via MemoryIndex.searchExtracted.
   */
  private searchL2(
    query: string,
    opts: { chatId?: number; startTime?: number; endTime?: number; limit?: number },
    mode: "or" | "and",
  ): WebSearchResult[] {
    const extracted = this.memoryIndex.searchExtracted(query, opts, mode);
    return extracted.map((r) => ({
      content: r.content,
      date: new Date(r.source_timestamp).toISOString(),
      source: "L2:extracted",
      score: r.score,
      contentOriginal: r.content_original,
      memoryType: r.memory_type,
      trust: r.trust,
      integrity: r.integrity,
      credibility: r.credibility,
      classification: r.classification,
    }));
  }

  /**
   * L3: Search consolidation .md files from disk.
   */
  private searchL3(
    keywords: string[],
    _chatId: number | undefined,
    timeStart?: number,
    timeEnd?: number,
    _mode: "or" | "and" = "or",
  ): WebSearchResult[] {
    if (!this.memoryDir) return [];
    const results = searchConsolidationFiles(this.memoryDir, keywords, {
      startTime: timeStart,
      endTime: timeEnd,
    });
    return results.map((r) => ({
      content: r.content,
      date: new Date(r.timestamp).toISOString(),
      source: `L3:compaction:${r.tier}`,
      score: 1.0,
    }));
  }

  /**
   * L4: Original-language substring search via MemoryIndex.searchOriginal.
   */
  private searchL4(original: string, chatId: number | undefined, mode: "or" | "and" = "or"): WebSearchResult[] {
    const results = this.memoryIndex.searchOriginal(original, {
      chatId: chatId,
      limit: 20,
      boostPreserved: true,
    }, mode);

    return results.map((r) => ({
      content: r.content_original || r.content,
      date: new Date(r.source_timestamp).toISOString(),
      source: "L4:original",
      score: r.score,
      contentOriginal: r.content_original,
      memoryType: r.memory_type,
      trust: r.trust,
      integrity: r.integrity,
      credibility: r.credibility,
      classification: r.classification,
    }));
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Deduplicate results by `timestamp + content_prefix` (first 50 chars).
 * Keeps the entry with the highest score when duplicates are found.
 */
function deduplicateResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Map<string, WebSearchResult>();
  for (const r of results) {
    const prefix = r.content.slice(0, 50);
    const key = `${r.date}|${prefix}`;
    const existing = seen.get(key);
    if (!existing || r.score > existing.score) {
      seen.set(key, r);
    }
  }
  return Array.from(seen.values());
}

/** Parse an optional numeric string, returning undefined if invalid. */
function parseOptionalNumber(raw: string | null): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
