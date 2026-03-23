import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { VectorSearchResult } from "../types/index.js";
import { EmbeddingProvider } from "./embedding-provider.js";
import { logError } from "./logger.js";

const TAG = "vector-index";

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns a value in [-1, 1] where 1 = identical direction, 0 = orthogonal.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

/**
 * SQLite-backed vector store for semantic search.
 *
 * Stores embedding vectors as serialized Float32Arrays in the `embeddings` table.
 * Cosine similarity is computed in JavaScript since SQLite lacks native vector ops.
 */
export class VectorIndex {
  private readonly db: Database.Database;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(db: Database.Database, embeddingProvider: EmbeddingProvider) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
  }

  /** Store embedding for a message. */
  async index(messageId: number, content: string): Promise<void> {
    try {
      const vector = await this.embeddingProvider.embed(content, this.db);
      const contentHash = createHash("sha256").update(content).digest("hex");
      const buffer = Buffer.from(vector.buffer);

      // Update the cached embedding row to link it to this message,
      // or insert if not already cached
      this.db
        .prepare(
          `INSERT OR REPLACE INTO embeddings (content_hash, message_id, vector, model_version)
           VALUES (?, ?, ?, ?)`,
        )
        .run(contentHash, messageId, buffer, this.embeddingProvider.modelVersion);
    } catch (err) {
      logError(TAG, `Failed to index embedding for message ${messageId}`, err);
    }
  }

  /** Find semantically similar messages. */
  async search(
    query: string,
    opts?: { chatId?: number; limit?: number },
  ): Promise<VectorSearchResult[]> {
    try {
      if (!this.embeddingProvider.isReady) return [];

      const queryVector = await this.embeddingProvider.embed(query, this.db);
      const limit = opts?.limit ?? 10;

      // Load embeddings matching the current model version,
      // optionally filtered by chatId via JOIN with messages.
      // Only same-model embeddings are compared so cosine similarity is meaningful.
      const currentModel = this.embeddingProvider.modelVersion;
      let sql: string;
      const params: (number | string)[] = [];

      if (opts?.chatId !== undefined) {
        sql = `SELECT e.message_id, e.vector
               FROM embeddings e
               JOIN messages m ON m.id = e.message_id
               WHERE e.message_id IS NOT NULL AND m.chat_id = ?
                 AND e.model_version = ?`;
        params.push(opts.chatId, currentModel);
      } else {
        sql = `SELECT message_id, vector FROM embeddings
               WHERE message_id IS NOT NULL AND model_version = ?`;
        params.push(currentModel);
      }

      const rows = this.db.prepare(sql).all(...params) as Array<{
        message_id: number;
        vector: Buffer;
      }>;

      // Compute cosine similarity for each row
      const scored: VectorSearchResult[] = [];
      for (const row of rows) {
        const storedVector = new Float32Array(new Uint8Array(row.vector).buffer);
        const score = cosineSimilarity(queryVector, storedVector);
        scored.push({ messageId: row.message_id, score });
      }

      // Sort by descending similarity and return top results
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } catch (err) {
      logError(TAG, "Vector search failed", err);
      return [];
    }
  }

  /** Remove embeddings for a session. */
  removeSession(chatId: number, sessionId: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM embeddings WHERE message_id IN (
             SELECT id FROM messages WHERE chat_id = ? AND session_id = ?
           )`,
        )
        .run(chatId, sessionId);
    } catch (err) {
      logError(TAG, "Failed to remove session embeddings", err);
    }
  }
}
