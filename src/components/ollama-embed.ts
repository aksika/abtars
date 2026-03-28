/**
 * Ollama embedding client — generates vector embeddings via local ollama API.
 * Gated by EMBEDDING_ENABLED env var. When disabled, all methods return null/empty.
 */

import { logInfo, logWarn } from "./logger.js";
import type Database from "better-sqlite3";

const TAG = "ollama-embed";

export type OllamaEmbedConfig = {
  enabled: boolean;
  model: string;
  url: string;
  threshold: number;
};

export function loadEmbedConfig(): OllamaEmbedConfig {
  return {
    enabled: process.env["EMBEDDING_ENABLED"] === "true",
    model: process.env["EMBEDDING_MODEL"] ?? "nomic-embed-text",
    url: process.env["EMBEDDING_URL"] ?? "http://localhost:11434",
    threshold: parseFloat(process.env["EMBEDDING_SIMILARITY_THRESHOLD"] ?? "0.5"),
  };
}

let warnedOnce = false;

export async function embedText(config: OllamaEmbedConfig, text: string): Promise<Float32Array | null> {
  if (!config.enabled) return null;
  try {
    const res = await fetch(`${config.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json() as { embeddings: number[][] };
    return new Float32Array(data.embeddings[0]!);
  } catch (err) {
    if (!warnedOnce) {
      logWarn(TAG, `ollama unavailable — Se disabled: ${err instanceof Error ? err.message : String(err)}`);
      warnedOnce = true;
    }
    return null;
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search extracted_memories by vector similarity.
 * Returns ids + scores above threshold, sorted descending.
 */
export function vectorSearch(
  db: Database.Database,
  queryVector: Float32Array,
  opts: { chatId?: number; limit?: number; threshold: number; maxClassification?: number },
): Array<{ id: number; content_en: string; content_original: string | null; source_timestamp: number; memory_type: string | null; score: number; trust: number | null; integrity: number | null; credibility: number | null; classification: number | null; source_message_ids: string | null }> {
  const conditions = ["embedding IS NOT NULL"];
  const params: (number)[] = [];
  if (opts.chatId) { conditions.push("chat_id = ?"); params.push(opts.chatId); }
  if (opts.maxClassification !== undefined) { conditions.push("COALESCE(classification, 0) <= ?"); params.push(opts.maxClassification); }

  const rows = db.prepare(
    `SELECT id, content_en, content_original, source_timestamp, memory_type, embedding, trust, integrity, credibility, classification, source_message_ids FROM extracted_memories WHERE ${conditions.join(" AND ")}`
  ).all(...params) as Array<{
    id: number; content_en: string; content_original: string | null; source_timestamp: number;
    memory_type: string | null; embedding: Buffer; trust: number | null; integrity: number | null;
    credibility: number | null; classification: number | null; source_message_ids: string | null;
  }>;

  const results: typeof rows extends (infer R)[] ? (R & { score: number })[] : never = [];
  for (const row of rows) {
    const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
    const score = cosineSimilarity(queryVector, stored);
    if (score >= opts.threshold) {
      results.push({ ...row, score });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, opts.limit ?? 10) as any;
}

/**
 * Batch-embed all extracted_memories that have NULL embedding.
 * Returns count of newly embedded memories.
 */
export async function batchEmbed(
  config: OllamaEmbedConfig,
  db: Database.Database,
): Promise<number> {
  if (!config.enabled) return 0;

  const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; content_en: string }>;
  if (rows.length === 0) return 0;

  logInfo(TAG, `Batch embedding ${rows.length} memories...`);
  const update = db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?");
  let count = 0;

  for (const row of rows) {
    const vec = await embedText(config, row.content_en);
    if (vec) {
      update.run(Buffer.from(vec.buffer), row.id);
      count++;
    }
  }

  logInfo(TAG, `Batch embedded ${count}/${rows.length} memories`);
  return count;
}
