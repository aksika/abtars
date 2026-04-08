/**
 * recall-engine — single recall pipeline shared by agentbridge-recall CLI and dashboard.
 *
 * Stages:
 *   S1: Extracted memories — English FTS5 (Darwinism-boosted)
 *   S2: Extracted memories — Original language FTS5
 *   S3: Extracted memories — LIKE fallback (content_en + content_original)
 *   S4: Messages — FTS5 (relaxed OR)
 *   S5: Messages — LIKE (wide net)
 *   S6: Consolidation file search (daily/weekly/quarterly .md)
 *   S7: Keyword-free fallback (exclusive: recent messages OR latest daily summary)
 *   Se: Embedding sidecar (async, future — gated by EMBEDDING_ENABLED)
 *
 * Short-circuit: if S1+S2+S3 ≥ threshold → skip S4-S7.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import type { SearchResult, MemorySearchResult } from "./mem-types.js";
import { searchConsolidationFiles, getLatestConsolidationFile } from "./consolidation-search.js";
import { applyMMR } from "./mmr.js";
import { readFileSync } from "node:fs";
import { embedText, vectorSearch, loadEmbedConfig } from "./ollama-embed.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type RecallHit = {
  content: string;
  date: string;
  source: string;
  score: number;
  source_ids?: string;
  contentOriginal?: string;
  memoryType?: string;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
};

export type StageResult = {
  hits: RecallHit[];
  ms: number;
};

export type RecallResult = {
  results: RecallHit[];
  stages: Record<string, StageResult>;
  shortCircuitAfter: string | null;
  extractedIds: number[];
};

export type RecallParams = {
  translated: string[];
  original?: string;
  chatId: number;
  limit?: number;
  maxClassification?: number;
  timeStart?: number;
  timeEnd?: number;
  stages?: string[];
  shortCircuitThreshold?: number;
  entity?: string;
  topic?: string;
  tier?: "core" | "general";
  includeExpired?: boolean;
  resolution?: "signal" | "compact" | "standard" | "full";
};

export type RecallDeps = {
  db: Database.Database;
  index: MemoryIndex;
  memoryDir: string;
  ctxStartPath: string;
};

// ── Constants ───────────────────────────────────────────────────────────────

const ALL_STAGES = ["S1", "S2", "S3", "Se", "S4", "S5", "S6", "S7", "Ss"];
const DEFAULT_LIMIT = 10;
const DEFAULT_SHORT_CIRCUIT = 10;

// ── Helpers ─────────────────────────────────────────────────────────────────

function readCtxStart(path: string, chatId: number): number {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, number>;
    return data[String(chatId)] ?? 0;
  } catch { return 0; }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function recallSearch(deps: RecallDeps, params: RecallParams): Promise<RecallResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const threshold = params.shortCircuitThreshold ?? DEFAULT_SHORT_CIRCUIT;
  const activeStages = new Set(params.stages ?? ALL_STAGES);
  const query = params.translated.join(" ");
  const searchOpts = {
    chatId: params.chatId,
    startTime: params.timeStart,
    endTime: params.timeEnd,
    limit: limit * 3,
    maxClassification: params.maxClassification ?? 2,
  };

  // --- Se: fire embedding async at start ---
  const embedConfig = loadEmbedConfig();
  let embeddingPromise: Promise<Float32Array | null> | null = null;
  if (embedConfig.enabled && activeStages.has("Se")) {
    embeddingPromise = embedText(embedConfig, query);
  }

  const allResults: RecallHit[] = [];
  const seen = new Set<string>();
  const extractedIds: number[] = [];
  const stages: Record<string, StageResult> = {};
  let shortCircuitAfter: string | null = null;

  // Entity pre-filter: if --entity provided, only return memories linked to that entity
  let entityFilter: Set<number> | null = null;
  if (params.entity) {
    const rows = deps.db.prepare(
      `SELECT me.memory_id FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE e.name = ? COLLATE NOCASE`
    ).all(params.entity) as Array<{ memory_id: number }>;
    entityFilter = new Set(rows.map(r => r.memory_id));
  }

  const addExtracted = (r: MemorySearchResult, source: string, hits: RecallHit[]): void => {
    if (entityFilter && r.id !== undefined && !entityFilter.has(r.id)) return;
    const key = `${r.created_at}:${r.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (r.id !== undefined) extractedIds.push(r.id);
    const hit: RecallHit = {
      content: r.content, date: new Date(r.created_at).toISOString(), source, score: r.score,
      ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}),
      contentOriginal: r.content_original, memoryType: r.memory_type,
      trust: r.trust, integrity: r.integrity, credibility: r.credibility, classification: r.classification,
    };
    hits.push(hit);
    allResults.push(hit);
  };

  const addMessage = (r: SearchResult, source: string, hits: RecallHit[]): void => {
    const key = `${r.record.timestamp}:${r.record.content.slice(0, 80)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const hit: RecallHit = {
      content: `[${r.record.role}] ${r.record.content}`,
      date: new Date(r.record.timestamp).toISOString(), source, score: r.score,
    };
    hits.push(hit);
    allResults.push(hit);
  };

  // --- S1: Extracted memories — English FTS5 ---
  if (activeStages.has("S1")) {
    const t = performance.now();
    const hits: RecallHit[] = [];
    for (const r of deps.index.searchExtracted(query, searchOpts)) addExtracted(r, "S1:extracted_en", hits);
    stages["S1"] = { hits, ms: elapsed(t) };
  }

  // --- S2: Extracted memories — Original language FTS5 ---
  if (activeStages.has("S2") && params.original) {
    const t = performance.now();
    const hits: RecallHit[] = [];
    for (const r of deps.index.searchOriginal(params.original, { chatId: params.chatId, limit: limit * 3, maxClassification: params.maxClassification ?? 2 })) {
      addExtracted(r, "S2:extracted_orig", hits);
    }
    stages["S2"] = { hits, ms: elapsed(t) };
  }

  // --- S3: Extracted memories — LIKE fallback ---
  if (activeStages.has("S3")) {
    const t = performance.now();
    const hits: RecallHit[] = [];
    const allKw = [...params.translated];
    if (params.original) allKw.push(params.original);
    const conditions = ["1=1"];
    const bindParams: (string | number)[] = [];
    if (params.chatId) { conditions.push("chat_id = ?"); bindParams.push(params.chatId); }
    if (params.timeStart) { conditions.push("created_at >= ?"); bindParams.push(params.timeStart); }
    if (params.timeEnd) { conditions.push("created_at <= ?"); bindParams.push(params.timeEnd); }
    if (params.maxClassification !== undefined) { conditions.push("COALESCE(classification, 0) <= ?"); bindParams.push(params.maxClassification); }
    if (params.topic) { conditions.push("topic = ?"); bindParams.push(params.topic); }
    if (params.tier) { conditions.push("tier = ?"); bindParams.push(params.tier); }
    if (!params.includeExpired) { conditions.push("valid_to IS NULL"); }
    conditions.push(`(${allKw.map(kw => { bindParams.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); return "(strip_diacritics(content_en) LIKE '%' || strip_diacritics(?) || '%' OR strip_diacritics(content_original) LIKE '%' || strip_diacritics(?) || '%' OR strip_diacritics(preserved_keyword) LIKE '%' || strip_diacritics(?) || '%')"; }).join(" OR ")})`);
    const rows = deps.db.prepare(
      `SELECT id, content_en, content_original, memory_type, created_at, source_message_ids, trust, integrity, credibility, classification FROM extracted_memories WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ?`
    ).all(...bindParams, limit * 3) as Array<{
      id: number; content_en: string; content_original: string | null; memory_type: string | null;
      created_at: number; source_message_ids: string | null;
      trust: number | null; integrity: number | null; credibility: number | null; classification: number | null;
    }>;
    for (const r of rows) {
      const key = `${r.created_at}:${r.content_en.slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (r.id !== undefined) extractedIds.push(r.id);
      const hit: RecallHit = {
        content: r.content_en, date: new Date(r.created_at).toISOString(),
        source: "S3:extracted_like", score: 0.95,
        ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}),
        contentOriginal: r.content_original ?? undefined, memoryType: r.memory_type ?? undefined,
        trust: r.trust ?? undefined, integrity: r.integrity ?? undefined,
        credibility: r.credibility ?? undefined, classification: r.classification ?? undefined,
      };
      hits.push(hit);
      allResults.push(hit);
    }
    stages["S3"] = { hits, ms: elapsed(t) };
  }

  // --- Se: merge embedding results ---
  if (embeddingPromise) {
    const t = performance.now();
    const queryVector = await embeddingPromise;
    if (queryVector) {
      const seHits: RecallHit[] = [];
      const vecResults = vectorSearch(deps.db, queryVector, {
        chatId: params.chatId, limit: limit * 3, threshold: embedConfig.threshold,
        maxClassification: params.maxClassification ?? 2,
      });
      for (const r of vecResults) {
        const key = `${r.created_at}:${r.content_en.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        extractedIds.push(r.id);
        const hit: RecallHit = {
          content: r.content_en, date: new Date(r.created_at).toISOString(),
          source: "Se:embedding", score: r.score,
          ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}),
          contentOriginal: r.content_original ?? undefined, memoryType: r.memory_type ?? undefined,
          trust: r.trust ?? undefined, integrity: r.integrity ?? undefined,
          credibility: r.credibility ?? undefined, classification: r.classification ?? undefined,
        };
        seHits.push(hit);
        allResults.push(hit);
      }
      stages["Se"] = { hits: seHits, ms: elapsed(t) };
    }
  }

  // --- Short-circuit check ---
  if (allResults.length >= threshold) {
    shortCircuitAfter = "S3";
  }

  if (!shortCircuitAfter) {
    // --- S4: Messages — FTS5 ---
    if (activeStages.has("S4") && query.trim()) {
      const t = performance.now();
      const hits: RecallHit[] = [];
      for (const r of deps.index.search(query, searchOpts, "or")) addMessage(r, "S4:messages_fts", hits);
      stages["S4"] = { hits, ms: elapsed(t) };
    }

    // --- S5: Messages — LIKE ---
    if (activeStages.has("S5") && allResults.length < limit) {
      const t = performance.now();
      const hits: RecallHit[] = [];
      const allKw = [...params.translated];
      if (params.original) allKw.push(params.original);
      const conditions = ["chat_id = ?"];
      const bindParams: (string | number)[] = [params.chatId];
      if (params.timeStart) { conditions.push("timestamp >= ?"); bindParams.push(params.timeStart); }
      if (params.timeEnd) { conditions.push("timestamp <= ?"); bindParams.push(params.timeEnd); }
      conditions.push(`(${allKw.map(kw => { bindParams.push(kw); return "strip_diacritics(content) LIKE '%' || strip_diacritics(?) || '%'"; }).join(" OR ")})`);
      const rows = deps.db.prepare(
        `SELECT role, content, timestamp FROM messages WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT 20`
      ).all(...bindParams) as Array<{ role: string; content: string; timestamp: number }>;
      for (const r of rows) {
        const key = `${r.timestamp}:${r.content.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const hit: RecallHit = { content: `[${r.role}] ${r.content}`, date: new Date(r.timestamp).toISOString(), source: "S5:messages_like", score: 0.3 };
          hits.push(hit);
          allResults.push(hit);
        }
      }
      stages["S5"] = { hits, ms: elapsed(t) };
    }

    // --- S6: Consolidation files ---
    if (activeStages.has("S6")) {
      const t = performance.now();
      const hits: RecallHit[] = [];
      const allKw = [...params.translated];
      if (params.original) allKw.push(params.original);
      const consolidationResults = searchConsolidationFiles(deps.memoryDir, allKw, {
        startTime: params.timeStart, endTime: params.timeEnd,
      });
      for (const c of consolidationResults) {
        const key = `${c.timestamp}:${c.content.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const hit: RecallHit = { content: c.content, date: new Date(c.timestamp).toISOString(), source: `S6:consolidation:${c.tier}`, score: 0.5 };
          hits.push(hit);
          allResults.push(hit);
        }
      }
      stages["S6"] = { hits, ms: elapsed(t) };
    }

    // --- S7: Keyword-free fallback ---
    if (activeStages.has("S7") && allResults.length === 0) {
      const t = performance.now();
      const hits: RecallHit[] = [];
      const ctxStart = readCtxStart(deps.ctxStartPath, params.chatId);

      const recentRows = deps.db.prepare(
        `SELECT role, content, timestamp FROM messages WHERE chat_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`
      ).all(params.chatId, ctxStart || Date.now(), limit) as Array<{ role: string; content: string; timestamp: number }>;
      const recentTs = recentRows[0]?.timestamp ?? 0;

      const dailySummary = getLatestConsolidationFile(deps.memoryDir, "daily");
      const dailyTs = dailySummary?.timestamp ?? 0;

      if (dailyTs > recentTs && dailySummary) {
        const key = `${dailySummary.timestamp}:${dailySummary.content.slice(0, 80)}`;
        if (!seen.has(key)) {
          seen.add(key);
          const hit: RecallHit = { content: dailySummary.content, date: new Date(dailySummary.timestamp).toISOString(), source: "S7:fallback:daily", score: 0.1 };
          hits.push(hit);
          allResults.push(hit);
        }
      } else {
        for (const r of recentRows) {
          const key = `${r.timestamp}:${r.content.slice(0, 80)}`;
          if (!seen.has(key)) {
            seen.add(key);
            const hit: RecallHit = { content: `[${r.role}] ${r.content}`, date: new Date(r.timestamp).toISOString(), source: "S7:fallback:recent", score: 0.1 };
            hits.push(hit);
            allResults.push(hit);
          }
        }
      }
      stages["S7"] = { hits, ms: elapsed(t) };
    }
  }

  // --- Ss: Signature-based semantic search (Hamming distance) ---
  if (activeStages.has("Ss")) {
    const t = performance.now();
    const hits: RecallHit[] = [];
    try {
      const { generateSignature, hammingSimilarity } = await import("./signature-generator.js");
      const queryText = [...params.translated, params.original ?? ""].join(" ");
      const querySig = generateSignature(queryText);

      const conditions = ["signature IS NOT NULL"];
      const bindParams: (string | number)[] = [];
      if (params.topic) { conditions.push("topic = ?"); bindParams.push(params.topic); }
      if (params.tier) { conditions.push("tier = ?"); bindParams.push(params.tier); }
      if (!params.includeExpired) { conditions.push("valid_to IS NULL"); }

      const rows = deps.db.prepare(
        `SELECT id, content_en, content_compressed, content_original, memory_type, created_at, signature, emotion_score
         FROM extracted_memories WHERE ${conditions.join(" AND ")}`
      ).all(...bindParams) as Array<{
        id: number; content_en: string | null; content_compressed: string | null;
        content_original: string | null; memory_type: string | null;
        created_at: number; signature: Buffer; emotion_score: number | null;
      }>;

      const scored: Array<{ row: typeof rows[0]; sim: number }> = [];
      for (const row of rows) {
        const sig = new Uint8Array(row.signature);
        const sim = hammingSimilarity(querySig, sig);
        // Emotional recall boost: weight by |emotion_score|
        const emotionBoost = 1 + 0.02 * Math.abs(row.emotion_score ?? 0);
        scored.push({ row, sim: sim * emotionBoost });
      }
      scored.sort((a, b) => b.sim - a.sim);

      for (const { row, sim } of scored.slice(0, limit * 2)) {
        if (sim < 0.55) break; // threshold
        const key = `${row.created_at}:${(row.content_en ?? row.content_compressed ?? "").slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const hit: RecallHit = {
          content: params.resolution === "full"
            ? (row.content_en ?? row.content_compressed ?? "")
            : (row.content_compressed ?? row.content_en ?? ""),
          date: new Date(row.created_at).toISOString(),
          source: "Ss:signature",
          score: sim,
          contentOriginal: row.content_original ?? undefined,
          memoryType: row.memory_type ?? undefined,
        };
        hits.push(hit);
        allResults.push(hit);
        extractedIds.push(row.id);
      }
    } catch { /* signature module not available */ }
    stages["Ss"] = { hits, ms: elapsed(t) };
  }

  // --- Post-processing ---
  allResults.sort((a, b) => b.score - a.score);
  const reranked = applyMMR(allResults, 0.7);

  return {
    results: reranked.slice(0, limit),
    stages,
    shortCircuitAfter,
    extractedIds,
  };
}
