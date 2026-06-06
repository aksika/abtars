/**
 * Memory search controller — handles GET /api/memory/search requests.
 *
 * Delegates to IMemorySystem for all search operations.
 * Returns per-stage breakdown for dashboard investigation.
 */

import type { IMemorySystem, RecallHit } from "abmind";
import { logWarn } from "./logger.js";
import type { MemorySearchResponse, WebSearchResult } from "./dashboard/dashboard-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MemorySearchDeps = {
  memory: IMemorySystem;
};

const TAG = "memory-search-ctrl";
const VALID_STAGES = new Set(["Sf", "Ss", "Se", "S6"]);

// ── Controller ──────────────────────────────────────────────────────────────

export class MemorySearchController {
  private readonly deps: MemorySearchDeps;

  constructor(deps: MemorySearchDeps) {
    this.deps = deps;
  }

  listChats(): { status: number; body: object } {
    try {
      const userIds = this.deps.memory.getDistinctUserIds();
      return { status: 200, body: { userIds } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listChats failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  listAll(): { status: number; body: object } {
    try {
      const memories = this.deps.memory.getAllExtractedMemories();
      return { status: 200, body: { memories } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listAll failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  async handle(params: URLSearchParams): Promise<{ status: number; body: object }> {
    const keywordsRaw = params.get("keywords")?.trim() ?? "";
    if (!keywordsRaw) return { status: 400, body: { error: "keywords required" } };

    const userIdRaw = params.get("userId")?.trim() ?? "";
    const userId = userIdRaw || undefined;

    const translated = keywordsRaw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    if (translated.length === 0) return { status: 400, body: { error: "keywords required" } };

    const original = params.get("original")?.trim() || undefined;
    const timeStart = parseOptionalNumber(params.get("timeStart"));
    const timeEnd = parseOptionalNumber(params.get("timeEnd"));
    const stagesRaw = params.get("stages")?.trim();
    const stages = stagesRaw ? stagesRaw.split(",").map((s) => s.trim()).filter((s) => VALID_STAGES.has(s)) : undefined;

    try {
      const result = await this.deps.memory.recallSearch(
        { translated, original, userId: userId ?? "master", limit: 10, timeStart, timeEnd, stages },
      );

      const webResults = result.results.map(hitToWebResult);
      const stageStatuses: Record<string, { status: string; hits: number; ms: number }> = {};
      for (const [name, stage] of Object.entries(result.stages)) {
        const s = stage as { hits: unknown[]; ms: number };
        stageStatuses[name] = { status: "ok", hits: s.hits.length, ms: s.ms };
      }
      const response: MemorySearchResponse = { results: webResults, layers: stageStatuses };
      return { status: 200, body: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `search failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }
}

function hitToWebResult(hit: RecallHit): WebSearchResult {
  return {
    content: hit.content,
    date: hit.date,
    source: hit.source,
    score: hit.score,
    contentOriginal: hit.contentOriginal,
    memoryType: hit.memoryType,
    trust: hit.trust,
    integrity: hit.integrity,
    credibility: hit.credibility,
    classification: hit.classification,
  };
}

function parseOptionalNumber(val: string | null): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  return Number.isFinite(n) ? n : undefined;
}
