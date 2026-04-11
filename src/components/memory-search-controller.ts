/**
 * Memory search controller — handles GET /api/memory/search requests.
 *
 * Delegates to IMemorySystem for all search operations.
 * Returns per-stage breakdown for dashboard investigation.
 */

import type { IMemorySystem } from "abmind/imemory-system.js";
import { logWarn } from "./logger.js";
import type { MemorySearchResponse, WebSearchResult } from "./dashboard/dashboard-config.js";
import type { RecallHit } from "abmind/recall-engine.js";

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
      const chatIds = this.deps.memory.getDistinctChatIds();
      return { status: 200, body: { chatIds } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listChats failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  listAll(): { status: number; body: object } {
    try {
      const memories = this.deps.memory.getAllExtractedMemories();
      const entities = this.deps.memory.getAllEntities();
      const links = this.deps.memory.getAllEntityLinks();
      return { status: 200, body: { memories, entities, links } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listAll failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  async handle(params: URLSearchParams): Promise<{ status: number; body: object }> {
    const keywordsRaw = params.get("keywords")?.trim() ?? "";
    if (!keywordsRaw) return { status: 400, body: { error: "keywords required" } };

    const chatIdRaw = params.get("chatId")?.trim() ?? "";
    const chatId = chatIdRaw ? Number(chatIdRaw) : undefined;
    if (chatIdRaw && !Number.isFinite(chatId!)) return { status: 400, body: { error: "chatId must be a number" } };

    const translated = keywordsRaw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    if (translated.length === 0) return { status: 400, body: { error: "keywords required" } };

    const original = params.get("original")?.trim() || undefined;
    const timeStart = parseOptionalNumber(params.get("timeStart"));
    const timeEnd = parseOptionalNumber(params.get("timeEnd"));
    const stagesRaw = params.get("stages")?.trim();
    const stages = stagesRaw ? stagesRaw.split(",").map((s) => s.trim()).filter((s) => VALID_STAGES.has(s)) : undefined;
    const entity = params.get("entity")?.trim() || undefined;

    try {
      const result = await this.deps.memory.recallSearch(
        { translated, original, chatId: chatId ?? 0, limit: 10, timeStart, timeEnd, stages, entity },
      );
      this.deps.memory.bumpRecallCount(result.extractedIds);

      const webResults = result.results.map(hitToWebResult);
      const stageStatuses: Record<string, { status: string; hits: number; ms: number }> = {};
      for (const [name, stage] of Object.entries(result.stages)) {
        stageStatuses[name] = { status: "ok", hits: stage.hits.length, ms: stage.ms };
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
