/**
 * Memory search controller — handles GET /api/memory/search requests.
 *
 * Delegates to the bounded daemon-backed runtime for search operations.
 */

import type { AbtarsMemoryRuntime, RuntimeRecallHit } from "./memory-runtime.js";
import { logWarn } from "./logger.js";
import type { MemorySearchResponse, WebSearchResult } from "./dashboard/dashboard-config.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MemorySearchDeps = {
  memoryRuntime: Pick<AbtarsMemoryRuntime, "recall">;
  defaultUserId: string;
};

const TAG = "memory-search-ctrl";

// ── Controller ──────────────────────────────────────────────────────────────

export class MemorySearchController {
  private readonly deps: MemorySearchDeps;

  constructor(deps: MemorySearchDeps) {
    this.deps = deps;
  }

  listChats(): { status: number; body: object } {
    return { status: 501, body: { error: "chat enumeration is not exposed by the bounded memory runtime" } };
  }

  listAll(): { status: number; body: object } {
    return { status: 501, body: { error: "memory enumeration is not exposed by the bounded memory runtime" } };
  }

  async handle(params: URLSearchParams): Promise<{ status: number; body: object }> {
    const keywordsRaw = params.get("keywords")?.trim() ?? "";
    if (!keywordsRaw) return { status: 400, body: { error: "keywords required" } };

    const userIdRaw = params.get("userId")?.trim() ?? "";
    const userId = userIdRaw || this.deps.defaultUserId;

    const translated = keywordsRaw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    if (translated.length === 0) return { status: 400, body: { error: "keywords required" } };

    const parseNumber = (value: string | null): number | undefined => {
      if (!value) return undefined;
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const stagesRaw = params.get("stages")?.trim();
    const stages = stagesRaw ? stagesRaw.split(",").map(s => s.trim()).filter(Boolean) : undefined;

    try {
      const result = await this.deps.memoryRuntime.recall({
        query: translated.join(" "),
        original: params.get("original")?.trim() || keywordsRaw,
        userId,
        limit: 10,
        timeStart: parseNumber(params.get("timeStart")),
        timeEnd: parseNumber(params.get("timeEnd")),
        stages,
      });

      const response: MemorySearchResponse = {
        results: result.hits.map(hitToWebResult),
        layers: { runtime: { status: "ok", hits: result.hits.length, ms: 0 } },
      };
      return { status: 200, body: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `search failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }
}

function hitToWebResult(hit: RuntimeRecallHit): WebSearchResult {
  return {
    content: hit.content,
    date: hit.date,
    source: hit.source ?? "abmind.runtime",
    score: hit.score,
    contentOriginal: hit.contentOriginal,
    memoryType: hit.memoryType,
    trust: hit.trust,
    integrity: hit.integrity,
    credibility: hit.credibility,
    classification: hit.classification,
    emotionScore: hit.emotionScore,
  };
}
