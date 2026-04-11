import { localISO } from "./local-time.js";
/**
 * recall-engine — simplified recall pipeline (v2).
 *
 * Stages:
 *   Sf: Three-query fuzzy search (porter FTS5 + trigram content_en + trigram content_original)
 *   Ss: Signature Hamming distance (semantic approximate, no ollama, cap 5, threshold 0.65)
 *   Se: Embedding cosine similarity (async, optional — needs ollama)
 *   S6: Consolidation file search (daily/weekly/quarterly .md)
 *
 * Priority ordering: Sf → Se → Ss → S6. Dedup by memory ID. MMR reranking (λ=0.7).
 * If Sf fills the limit, Ss and Se are skipped for performance.
 * S6 always runs (different data source).
 * No S7 fallback — return empty on zero results.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import { searchConsolidationFiles } from "./consolidation-search.js";
import { applyMMR } from "./mmr.js";
import { embedText, vectorSearch, loadEmbedConfig } from "./ollama-embed.js";
import { trigramSearch } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";

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
  timelineContext?: string;
  interferenceWarning?: string;
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
  emotion?: string;
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

const ALL_STAGES = ["Sf", "Ss", "Se", "S6"];
const DEFAULT_LIMIT = 10;
const SS_THRESHOLD = 0.65;
const SS_CAP = 5;

// ── Helpers ─────────────────────────────────────────────────────────────────

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function recallSearch(deps: RecallDeps, params: RecallParams): Promise<RecallResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const activeStages = new Set(params.stages ?? ALL_STAGES);
  const query = params.translated.join(" ");

  // --- Se: fire embedding async at start ---
  const embedConfig = loadEmbedConfig();
  let embeddingPromise: Promise<Float32Array | null> | null = null;
  if (embedConfig.enabled && activeStages.has("Se")) {
    embeddingPromise = embedText(embedConfig, query);
  }

  const seenIds = new Set<number>();
  const extractedIds: number[] = [];
  const stages: Record<string, StageResult> = {};

  // Entity pre-filter
  let entityFilter: Set<number> | null = null;
  if (params.entity) {
    const rows = deps.db.prepare(
      `SELECT me.memory_id FROM memory_entities me JOIN entities e ON e.id = me.entity_id WHERE e.name = ? COLLATE NOCASE`,
    ).all(params.entity) as Array<{ memory_id: number }>;
    entityFilter = new Set(rows.map(r => r.memory_id));
  }

  // Collect results in priority order
  const sfHits: RecallHit[] = [];
  const seHits: RecallHit[] = [];
  const ssHits: RecallHit[] = [];
  const s6Hits: RecallHit[] = [];

  // --- Sf: Three-query fuzzy search ---
  if (activeStages.has("Sf")) {
    const t = performance.now();
    const sfOpts: SfOptions = {
      translated: params.translated,
      original: params.original,
      chatId: params.chatId,
      limit,
      maxClassification: params.maxClassification ?? 2,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      topic: params.topic,
      tier: params.tier,
      emotion: params.emotion,
      includeExpired: params.includeExpired,
      entityFilter: entityFilter ?? undefined,
      resolution: params.resolution,
    };
    const sf = trigramSearch(deps.db, sfOpts);
    for (const h of sf.hits) sfHits.push(h);
    for (const id of sf.extractedIds) { seenIds.add(id); extractedIds.push(id); }
    stages["Sf"] = { hits: sfHits, ms: elapsed(t) };
  }

  const sfFull = sfHits.length >= limit;

  // --- Se: merge embedding results (skip if Sf full) ---
  if (embeddingPromise && !sfFull) {
    const t = performance.now();
    const queryVector = await embeddingPromise;
    if (queryVector) {
      const vecResults = vectorSearch(deps.db, queryVector, {
        chatId: params.chatId, limit: limit * 3, threshold: embedConfig.threshold,
        maxClassification: params.maxClassification ?? 2,
      });
      for (const r of vecResults) {
        if (seenIds.has(r.id)) continue;
        if (entityFilter && !entityFilter.has(r.id)) continue;
        seenIds.add(r.id);
        extractedIds.push(r.id);
        seHits.push({
          content: r.content_en, date: localISO(new Date(r.created_at)),
          source: "Se:embedding", score: r.score,
          ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}),
          contentOriginal: r.content_original ?? undefined, memoryType: r.memory_type ?? undefined,
          trust: r.trust ?? undefined, integrity: r.integrity ?? undefined,
          credibility: r.credibility ?? undefined, classification: r.classification ?? undefined,
        });
      }
      stages["Se"] = { hits: seHits, ms: elapsed(t) };
    }
  } else if (embeddingPromise) {
    // Sf full — don't await, just discard
    embeddingPromise.catch(() => {});
  }

  // --- Ss: Signature Hamming (skip if Sf full) ---
  if (activeStages.has("Ss") && !sfFull) {
    const t = performance.now();
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
        `SELECT id, content_en, content_original, memory_type, created_at, signature, emotion_score
         FROM extracted_memories WHERE ${conditions.join(" AND ")}`,
      ).all(...bindParams) as Array<{
        id: number; content_en: string | null; content_original: string | null;
        memory_type: string | null; created_at: number; signature: Buffer; emotion_score: number | null;
      }>;

      const scored: Array<{ row: typeof rows[0]; sim: number }> = [];
      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        if (entityFilter && !entityFilter.has(row.id)) continue;
        const sig = new Uint8Array(row.signature);
        scored.push({ row, sim: hammingSimilarity(querySig, sig) });
      }
      scored.sort((a, b) => b.sim - a.sim);

      for (const { row, sim } of scored.slice(0, SS_CAP)) {
        if (sim < SS_THRESHOLD) break;
        seenIds.add(row.id);
        extractedIds.push(row.id);
        ssHits.push({
          content: row.content_en ?? "",
          date: localISO(new Date(row.created_at)),
          source: "Ss:signature", score: sim,
          contentOriginal: row.content_original ?? undefined,
          memoryType: row.memory_type ?? undefined,
        });
      }
    } catch { /* signature module not available */ }
    stages["Ss"] = { hits: ssHits, ms: elapsed(t) };
  }

  // --- S6: Consolidation files (always runs) ---
  if (activeStages.has("S6")) {
    const t = performance.now();
    const allKw = [...params.translated];
    if (params.original) allKw.push(params.original);
    const consolidationResults = searchConsolidationFiles(deps.memoryDir, allKw, {
      startTime: params.timeStart, endTime: params.timeEnd,
    });
    const s6Seen = new Set<string>();
    for (const c of consolidationResults) {
      const key = `${c.timestamp}:${c.content.slice(0, 80)}`;
      if (s6Seen.has(key)) continue;
      s6Seen.add(key);
      s6Hits.push({
        content: c.content, date: localISO(new Date(c.timestamp)),
        source: `S6:consolidation:${c.tier}`, score: 0.5,
      });
    }
    stages["S6"] = { hits: s6Hits, ms: elapsed(t) };
  }

  // --- Merge in priority order, MMR rerank ---
  const allResults = [...sfHits, ...seHits, ...ssHits, ...s6Hits];
  const reranked = applyMMR(allResults, 0.7);
  const finalResults = reranked.slice(0, limit);

  // --- Timeline context enrichment ---
  if (extractedIds.length > 0) {
    try {
      const { buildTimelines, renderTimeline } = await import("./timeline-builder.js");
      // Load sibling memories for recalled IDs (same topic)
      const topics = new Set<string>();
      for (const hit of finalResults) {
        const topicMatch = hit.content.match(/\|([a-z]+)\|/);
        if (topicMatch) topics.add(topicMatch[1]!);
      }
      if (topics.size > 0) {
        const topicList = [...topics].map(t => `'${t}'`).join(",");
        const siblings = deps.db.prepare(
          `SELECT id, content_en, topic, memory_type, emotion_tags, importance_flags, confidence, created_at, emotion_context
           FROM extracted_memories WHERE topic IN (${topicList}) AND valid_to IS NULL AND content_en IS NOT NULL
           ORDER BY created_at`,
        ).all() as Array<{ id: number; content_en: string; topic: string; memory_type: string | null; emotion_tags: string | null; importance_flags: string | null; confidence: number | null; created_at: number; emotion_context: string | null }>;
        const timelines = buildTimelines(siblings);
        const idToTimeline = new Map<number, string>();
        for (const tl of timelines) {
          const rendered = renderTimeline(tl);
          for (const id of rendered.memoryIds) idToTimeline.set(id, rendered.rendered);
        }
        for (let i = 0; i < finalResults.length; i++) {
          const id = extractedIds[i];
          if (id !== undefined && idToTimeline.has(id)) {
            finalResults[i]!.timelineContext = idToTimeline.get(id);
          }
        }
      }
    } catch { /* timeline builder not available */ }
  }

  // --- Interference detection: flag similar-but-different results ---
  try {
    const { detectInterference } = await import("./brain-patterns.js");
    for (let i = 0; i < finalResults.length; i++) {
      for (let j = i + 1; j < finalResults.length; j++) {
        const a = finalResults[i]!, b = finalResults[j]!;
        const topicA = a.content.match(/\|([a-z]+)\|/)?.[1] ?? "";
        const topicB = b.content.match(/\|([a-z]+)\|/)?.[1] ?? "";
        if (detectInterference(a.content, b.content, topicA, topicB)) {
          a.interferenceWarning = `⚠️ Conflicts with another result — verify which is current`;
          b.interferenceWarning = `⚠️ Conflicts with another result — verify which is current`;
        }
      }
    }
  } catch { /* brain-patterns not available */ }

  return {
    results: finalResults,
    stages,
    shortCircuitAfter: sfFull ? "Sf" : null,
    extractedIds,
  };
}
