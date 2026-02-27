import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { logError, logWarn, logInfo } from "./logger.js";

const TAG = "embedding-provider";

/**
 * Local-only embedding generation using @xenova/transformers (optional dependency).
 *
 * If the package is not installed, the provider stays in a not-ready state
 * and embed() throws so callers (VectorIndex) can catch and skip gracefully.
 * Embeddings are cached in SQLite keyed by SHA-256 hash of the source text.
 */
export class EmbeddingProvider {
  private pipeline: any = null;
  private readonly modelName: string;

  constructor(modelName?: string) {
    this.modelName = modelName ?? "Xenova/all-MiniLM-L6-v2";
  }

  /** Load the ONNX model. Call once at startup. */
  async initialize(): Promise<void> {
    try {
      const transformers = await import("@xenova/transformers");
      const pipelineFn =
        typeof transformers.pipeline === "function"
          ? transformers.pipeline
          : (transformers as any).default?.pipeline;

      if (!pipelineFn) {
        logWarn(TAG, "Could not find pipeline function in @xenova/transformers");
        return;
      }

      this.pipeline = await pipelineFn("feature-extraction", this.modelName);
      logInfo(TAG, `Embedding model loaded: ${this.modelName}`);
    } catch (err) {
      logWarn(TAG, `@xenova/transformers not available — vector search disabled`);
      this.pipeline = null;
    }
  }

  /**
   * Generate an embedding vector for the given text.
   *
   * 1. Compute SHA-256 hash of text
   * 2. Check embeddings cache in SQLite
   * 3. If cached, deserialize Buffer → Float32Array and return
   * 4. If not cached, compute embedding via pipeline
   * 5. Store in cache with message_id = NULL (linked later by VectorIndex.index())
   * 6. Return the Float32Array
   */
  async embed(text: string, db: Database.Database): Promise<Float32Array> {
    if (!this.pipeline) {
      throw new Error("Embedding model not loaded");
    }

    const contentHash = createHash("sha256").update(text).digest("hex");

    // Check cache
    const cached = db
      .prepare("SELECT vector FROM embeddings WHERE content_hash = ?")
      .get(contentHash) as { vector: Buffer } | undefined;

    if (cached) {
      return new Float32Array(new Uint8Array(cached.vector).buffer);
    }

    // Compute embedding
    const output = await this.pipeline(text, { pooling: "mean", normalize: true });
    const vector: Float32Array = output.data instanceof Float32Array
      ? output.data
      : new Float32Array(output.data);

    // Store in cache (message_id is NULL — linked when VectorIndex.index() is called)
    const buffer = Buffer.from(vector.buffer);
    db.prepare(
      "INSERT OR REPLACE INTO embeddings (content_hash, message_id, vector) VALUES (?, NULL, ?)",
    ).run(contentHash, buffer);

    return vector;
  }

  /** Check if the model is loaded and ready. */
  get isReady(): boolean {
    return this.pipeline !== null;
  }
}
