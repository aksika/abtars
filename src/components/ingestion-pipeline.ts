import fs from "node:fs";
import type Database from "better-sqlite3";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { VectorIndex } from "./vector-index.js";
import type { MemoryConfig } from "./memory-config.js";
import type { IngestionSource, IngestionResult, IngestedDocument } from "../types/memory.js";
import { logInfo } from "./logger.js";
import { YoutubeTranscript } from "youtube-transcript";
import { PDFParse } from "pdf-parse";
import type { BrowserManager } from "./browser-manager.js";
import { WebScraper } from "./web-scraper.js";

const TAG = "ingestion-pipeline";

/**
 * Accepts external documents (YouTube URLs, PDFs, text/markdown files)
 * and vectorizes them into long-term memory via the EmbeddingProvider
 * and VectorIndex.
 */
export class IngestionPipeline {
  private readonly db: Database.Database;
  readonly embeddingProvider: EmbeddingProvider;
  private readonly vectorIndex: VectorIndex;
  private readonly config: MemoryConfig;
  private readonly browserManager?: BrowserManager;

  constructor(
    db: Database.Database,
    embeddingProvider: EmbeddingProvider,
    vectorIndex: VectorIndex,
    config: MemoryConfig,
    browserManager?: BrowserManager,
  ) {
    this.db = db;
    this.embeddingProvider = embeddingProvider;
    this.vectorIndex = vectorIndex;
    this.config = config;
    this.browserManager = browserManager;
  }

  /**
   * Ingest a document from a URL or file path.
   * Extracts text, chunks it, generates embeddings, and stores metadata.
   */
  async ingest(source: IngestionSource, chatId: number): Promise<IngestionResult> {
    let text: string;

    switch (source.type) {
      case "youtube":
        text = await this.extractYouTube(source.identifier);
        break;
      case "pdf":
        text = await this.extractPdf(source.identifier);
        break;
      case "text":
      case "markdown":
        try {
          text = fs.readFileSync(source.identifier, "utf-8");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to read ${source.type} file "${source.identifier}": ${msg}`);
        }
        break;
      case "webpage": {
        if (!this.browserManager) {
          throw new Error(
            `Cannot ingest webpage "${source.identifier}": no BrowserManager provided to IngestionPipeline.`,
          );
        }
        const scraper = new WebScraper(this.browserManager);
        text = await scraper.extractText(source.identifier);
        if (!text || text.trim().length === 0) {
          throw new Error(
            `Failed to extract text from webpage "${source.identifier}": page returned no readable content.`,
          );
        }
        break;
      }
      default:
        throw new Error(`Unsupported source type: ${source.type}`);
    }

    const chunks = this.chunkText(text, this.config.ingestChunkMaxTokens);
    const timestamp = Date.now();

    // Store each chunk as a message + embedding (task 5.3 will flesh this out)
    for (const chunk of chunks) {
      // Insert a message record for the chunk
      const result = this.db
        .prepare(
          `INSERT INTO messages (chat_id, session_id, role, content, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(chatId, `ingest:${source.identifier}`, "compaction", chunk, timestamp);

      // Index the embedding
      await this.vectorIndex.index(Number(result.lastInsertRowid), chunk);
    }

    // Record ingestion metadata
    this.db
      .prepare(
        `INSERT INTO ingested_documents (chat_id, source_type, identifier, chunk_count, ingested_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(chatId, source.type, source.identifier, chunks.length, timestamp);

    logInfo(TAG, `Ingested ${chunks.length} chunks from ${source.type}: ${source.identifier}`);

    return {
      sourceType: source.type,
      identifier: source.identifier,
      chunkCount: chunks.length,
      timestamp,
    };
  }

  /** List all previously ingested documents, optionally filtered by chatId. */
  listIngested(chatId?: number): IngestedDocument[] {
    if (chatId !== undefined) {
      return this.db
        .prepare(
          `SELECT id, chat_id AS chatId, source_type AS sourceType, identifier,
                  chunk_count AS chunkCount, ingested_at AS ingestedAt
           FROM ingested_documents WHERE chat_id = ?
           ORDER BY ingested_at DESC`,
        )
        .all(chatId) as IngestedDocument[];
    }

    return this.db
      .prepare(
        `SELECT id, chat_id AS chatId, source_type AS sourceType, identifier,
                chunk_count AS chunkCount, ingested_at AS ingestedAt
         FROM ingested_documents
         ORDER BY ingested_at DESC`,
      )
      .all() as IngestedDocument[];
  }

  /** Extract transcript text from a YouTube URL. */
  private async extractYouTube(url: string): Promise<string> {
    try {
      const transcriptItems = await YoutubeTranscript.fetchTranscript(url);
      if (!transcriptItems || transcriptItems.length === 0) {
        throw new Error("No transcript segments returned");
      }
      return transcriptItems.map((item) => item.text).join(" ");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to extract YouTube transcript from "${url}": ${msg}`);
    }
  }

  /** Extract text from a PDF file. */
  private async extractPdf(filePath: string): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: "${filePath}"`);
      }
      const dataBuffer = fs.readFileSync(filePath);
      const pdf = new PDFParse({ data: new Uint8Array(dataBuffer) });
      const result = await pdf.getText();
      await pdf.destroy();
      if (!result.text || result.text.trim().length === 0) {
        throw new Error("PDF contained no extractable text");
      }
      return result.text;
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Failed to extract")) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to extract text from PDF "${filePath}": ${msg}`);
    }
  }

  /**
   * Split text into chunks of approximately maxTokens size.
   * Uses a simple whitespace-based approximation (1 token ≈ 4 chars).
   * Stub — full implementation in task 5.3.
   */
  chunkText(text: string, maxTokens: number): string[] {
    const approxCharsPerToken = 4;
    const maxChars = maxTokens * approxCharsPerToken;
    const chunks: string[] = [];

    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= maxChars) {
        chunks.push(remaining.trim());
        break;
      }

      // Find a break point near maxChars (prefer sentence/paragraph boundaries)
      let breakPoint = remaining.lastIndexOf("\n", maxChars);
      if (breakPoint <= 0) breakPoint = remaining.lastIndexOf(". ", maxChars);
      if (breakPoint <= 0) breakPoint = remaining.lastIndexOf(" ", maxChars);
      if (breakPoint <= 0) breakPoint = maxChars;

      const chunk = remaining.slice(0, breakPoint + 1).trim();
      if (chunk.length > 0) chunks.push(chunk);
      remaining = remaining.slice(breakPoint + 1);
    }

    return chunks;
  }
}
