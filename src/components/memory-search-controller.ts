/**
 * Memory search controller — handles GET /api/memory/search requests.
 *
 * Delegates to the shared recall-engine for all search operations.
 * Returns per-stage breakdown for dashboard investigation.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import { logWarn } from "./logger.js";
import type { MemorySearchResponse } from "./dashboard-config.js";
import { recallSearch } from "./recall-engine.js";
import type { RecallHit } from "./recall-engine.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type MemorySearchDeps = {
  memoryIndex: MemoryIndex;
  db: Database.Database;
  memoryDir?: string;
  ctxStartPath?: string;
};

const TAG = "memory-search-ctrl";
const VALID_STAGES = new Set(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "Se"]);

// ── Controller ──────────────────────────────────────────────────────────────

export class MemorySearchController {
  private readonly deps: MemorySearchDeps;

  constructor(deps: MemorySearchDeps) {
    this.deps = deps;
  }

  /** List distinct chat IDs that have stored messages. */
  listChats(): { status: number; body: object } {
    try {
      const rows = this.deps.db
        .prepare("SELECT DISTINCT chat_id FROM messages ORDER BY chat_id")
        .all() as Array<{ chat_id: number }>;
      return { status: 200, body: { chatIds: rows.map((r) => r.chat_id) } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listChats failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  /** All extracted memories + entities + links for visualization. */
  listAll(): { status: number; body: object } {
    try {
      const memories = this.deps.db.prepare(
        `SELECT id, content_en, content_original, memory_type, source_timestamp, emotion_score,
                recall_count, relevance_score, classification, trust, integrity, credibility, created_at,
                CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_embedding
         FROM extracted_memories ORDER BY created_at DESC`
      ).all() as Array<Record<string, unknown>>;

      const entities = this.deps.db.prepare("SELECT id, name, type, summary FROM entities").all() as Array<Record<string, unknown>>;

      const links = this.deps.db.prepare("SELECT memory_id, entity_id FROM memory_entities").all() as Array<Record<string, unknown>>;

      return { status: 200, body: { memories, entities, links } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `listAll failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }

  /**
   * Handle `GET /api/memory/search?keywords=...&chatId=...&stages=...&original=...`
   */
  async handle(
    params: URLSearchParams,
  ): Promise<{ status: number; body: object }> {
    const keywordsRaw = params.get("keywords")?.trim() ?? "";
    if (!keywordsRaw) {
      return { status: 400, body: { error: "keywords required" } };
    }

    const chatIdRaw = params.get("chatId")?.trim() ?? "";
    const chatId = chatIdRaw ? Number(chatIdRaw) : undefined;
    if (chatIdRaw && !Number.isFinite(chatId!)) {
      return { status: 400, body: { error: "chatId must be a number" } };
    }

    const translated = keywordsRaw.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
    if (translated.length === 0) {
      return { status: 400, body: { error: "keywords required" } };
    }

    const original = params.get("original")?.trim() || undefined;
    const timeStart = parseOptionalNumber(params.get("timeStart"));
    const timeEnd = parseOptionalNumber(params.get("timeEnd"));

    // Stage filter — dashboard can request specific stages for investigation
    const stagesRaw = params.get("stages")?.trim();
    const stages = stagesRaw
      ? stagesRaw.split(",").map((s) => s.trim()).filter((s) => VALID_STAGES.has(s))
      : undefined;

    const entity = params.get("entity")?.trim() || undefined;

    try {
      const result = await recallSearch(
        {
          db: this.deps.db,
          index: this.deps.memoryIndex,
          memoryDir: this.deps.memoryDir ?? "",
          ctxStartPath: this.deps.ctxStartPath ?? "",
        },
        { translated, original, chatId: chatId ?? 0, limit: 10, timeStart, timeEnd, stages, entity },
      );

      // Bump recall count
      this.deps.memoryIndex.bumpRecallCount(result.extractedIds);

      // Map to dashboard response format
      const webResults = result.results.map(hitToWebResult);
      const stageStatuses: Record<string, { status: string; hits: number; ms: number }> = {};
      for (const [name, stage] of Object.entries(result.stages)) {
        stageStatuses[name] = { status: "ok", hits: stage.hits.length, ms: stage.ms };
      }

      const response: MemorySearchResponse = {
        results: webResults,
        layers: stageStatuses,
      };

      return { status: 200, body: response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `search failed: ${msg}`);
      return { status: 500, body: { error: msg } };
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function hitToWebResult(hit: RecallHit) {
  return {
    content: hit.content,
    date: hit.date,
    source: hit.source,
    score: hit.score,
    ...(hit.contentOriginal ? { contentOriginal: hit.contentOriginal } : {}),
    ...(hit.memoryType ? { memoryType: hit.memoryType } : {}),
    ...(hit.trust !== undefined ? { trust: hit.trust } : {}),
    ...(hit.integrity !== undefined ? { integrity: hit.integrity } : {}),
    ...(hit.credibility !== undefined ? { credibility: hit.credibility } : {}),
    ...(hit.classification !== undefined ? { classification: hit.classification } : {}),
  };
}

function parseOptionalNumber(raw: string | null): number | undefined {
  if (!raw || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
