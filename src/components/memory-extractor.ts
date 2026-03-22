import type Database from "better-sqlite3";
import type { ExtractedMemory } from "../types/memory.js";
import { clampEmotionScore } from "./emotion-utils.js";
import { logDebug, logError, logWarn } from "./logger.js";

const TAG = "memory-extractor";

/**
 * LLM prompt for extracting structured memories from conversation transcripts.
 *
 * Instructs the model to:
 * 1. Extract facts, decisions, preferences, and notable events
 * 2. Produce each memory in English (content_en) and original language (content_original)
 * 3. Set content_original = content_en when conversation is already in English
 * 4. Detect explicit keyword preservation intent and set preserve_original + preserved_keyword
 * 5. Discard greetings, filler, step-by-step reasoning, and formatting artifacts
 */
const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the following conversation transcript and extract meaningful memories.

RULES:
- Extract ONLY: facts, decisions, preferences, and notable events
- DISCARD: greetings, filler words, small talk, step-by-step reasoning, formatting artifacts, and conversational noise
- For EACH extracted memory, produce:
  - "content_en": the memory expressed in English
  - "content_original": the memory in the original conversation language
  - "memory_type": one of "fact", "decision", "preference", "event"
  - "emotion_score": integer from -5 to +5 representing emotional valence
    -5 = angry, -3 = frustrated, -1 = slightly negative,
     0 = neutral, +1 = slightly positive, +3 = pleased, +5 = happy
  - "preserve_original": boolean, default false
  - "preserved_keyword": string or null
- If the conversation is already in English, set content_original = content_en (identical values)

TRANSLATION QUALITY (critical for non-English conversations):
- Translate the MEANING, not the literal words. Idioms must be expressed as their English equivalent or explained.
  BAD:  "User said it's not their table" (literal translation of "nem az én asztalom")
  GOOD: "User said it's not their responsibility"
- For jokes, sarcasm, or irony: prefix with tone context so the memory isn't mistaken for a literal statement.
  BAD:  "User wants to mass-delete the production database"
  GOOD: "User joked about mass-deleting the production database"
- For cultural references (people, shows, events) unknown outside the source culture, add brief context in parentheses.
  GOOD: "User enjoyed Megasztár (Hungarian talent show similar to X Factor)"
- Include relevant semantic keywords in content_en that someone would search for later, even if the original didn't use those exact words.

- KEYWORD PRESERVATION: If the user explicitly asks to remember a specific word or phrase in their language (patterns like "remember if I say X it means Y", "if I say X", "jegyezd meg hogy X", "remember that X means"), set preserve_original to true and set preserved_keyword to the specific word/phrase the user wants preserved
- Return ONLY a valid JSON array of objects. No markdown, no explanation, no wrapping.
- If there is nothing meaningful to extract, return an empty array: []

OUTPUT FORMAT (strict JSON array):
[
  {
    "content_en": "English description of the memory",
    "content_original": "Original language description (same as content_en if English)",
    "memory_type": "fact|decision|preference|event",
    "emotion_score": 0,
    "preserve_original": false,
    "preserved_keyword": null
  }
]`;

/**
 * Uses LLM calls to distill meaningful memories from raw conversation transcripts.
 * Produces ExtractedMemory records with dual-column content (original + English).
 *
 * Tracks processing progress via a per-chat watermark in the extraction_watermarks table.
 * On LLM failure, the watermark is NOT advanced so the segment is retried on the next tick.
 */
export class MemoryExtractor {
  constructor(
    private db: Database.Database,
    private llmCall: (prompt: string, content: string) => Promise<string>,
  ) {}

  /**
   * Process unprocessed transcript segments for a chat.
   * Uses a watermark (last processed timestamp per chat) to avoid reprocessing.
   * Processes segments in chronological order (ascending timestamp).
   */
  async processTranscripts(chatId: number): Promise<ExtractedMemory[]> {
    const watermark = this.getWatermark(chatId);
    logDebug(TAG, `Processing transcripts for chat ${chatId}, watermark=${watermark}`);

    // Query unprocessed messages ordered chronologically (ASC)
    const rows = this.db
      .prepare(
        `SELECT role, content, timestamp FROM messages
         WHERE chat_id = ? AND timestamp > ?
         ORDER BY timestamp ASC`,
      )
      .all(chatId, watermark) as Array<{
        role: string;
        content: string;
        timestamp: number;
      }>;

    if (rows.length === 0) {
      logDebug(TAG, `No unprocessed messages for chat ${chatId}`);
      return [];
    }

    // Process in batches to keep each LLM call under ~3K chars of transcript
    // (prompt is ~1.2K, tmux send-keys limit is ~4K)
    const MAX_BATCH_CHARS = 3000;
    const allMemories: ExtractedMemory[] = [];
    let batch: typeof rows = [];
    let batchChars = 0;

    for (const row of rows) {
      const line = `[${row.role}] ${row.content}\n`;
      if (batchChars + line.length > MAX_BATCH_CHARS && batch.length > 0) {
        const transcript = batch.map((r) => `[${r.role}] ${r.content}`).join("\n");
        const lastTs = batch[batch.length - 1]!.timestamp;
        try {
          const memories = await this.extractFromSegment(transcript, chatId, lastTs);
          if (memories.length > 0) this.insertMemories(memories);
          allMemories.push(...memories);
          this.updateWatermark(chatId, lastTs);
        } catch (err) {
          logError(TAG, `Failed to extract memories for chat ${chatId} (batch)`, err);
          return allMemories;
        }
        batch = [];
        batchChars = 0;
      }
      batch.push(row);
      batchChars += line.length;
    }

    if (batch.length > 0) {
      const transcript = batch.map((r) => `[${r.role}] ${r.content}`).join("\n");
      const lastTs = batch[batch.length - 1]!.timestamp;
      try {
        const memories = await this.extractFromSegment(transcript, chatId, lastTs);
        if (memories.length > 0) this.insertMemories(memories);
        allMemories.push(...memories);
        this.updateWatermark(chatId, lastTs);
      } catch (err) {
        logError(TAG, `Failed to extract memories for chat ${chatId} (final batch)`, err);
        return allMemories;
      }
    }

    logDebug(TAG, `Extracted ${allMemories.length} memories for chat ${chatId}`);
    return allMemories;
  }

  /**
   * Extract structured memories from a transcript segment using LLM.
   * Discards noise (greetings, filler, formatting artifacts).
   * Detects preserve_original intent from explicit user phrasing.
   */
  private async extractFromSegment(
    transcript: string,
    chatId: number,
    timestamp: number,
  ): Promise<ExtractedMemory[]> {
    const response = await this.llmCall(EXTRACTION_PROMPT, transcript);

    const parsed = this.parseResponse(response, chatId, timestamp);
    return parsed;
  }

  /**
   * Parse the LLM response into ExtractedMemory records.
   * Validates each record and discards malformed entries.
   */
  private parseResponse(
    response: string,
    chatId: number,
    timestamp: number,
  ): ExtractedMemory[] {
    // Strip markdown code fences if present
    let cleaned = response.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }

    let items: unknown[];
    try {
      items = JSON.parse(cleaned);
    } catch {
      logWarn(TAG, `LLM returned malformed JSON for chat ${chatId}: ${cleaned.slice(0, 200)}`);
      throw new Error("Malformed JSON response from LLM");
    }

    if (!Array.isArray(items)) {
      logWarn(TAG, `LLM response is not an array for chat ${chatId}`);
      throw new Error("LLM response is not an array");
    }

    const now = Date.now();
    const validTypes = new Set(["fact", "decision", "preference", "event"]);
    const memories: ExtractedMemory[] = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;

      const obj = item as Record<string, unknown>;
      const contentEn = typeof obj.content_en === "string" ? obj.content_en.trim() : "";
      const contentOriginal = typeof obj.content_original === "string" ? obj.content_original.trim() : "";
      const memoryType = typeof obj.memory_type === "string" ? obj.memory_type : "fact";
      const preserveOriginal = obj.preserve_original === true;
      const preservedKeyword = typeof obj.preserved_keyword === "string" && obj.preserved_keyword.trim()
        ? obj.preserved_keyword.trim()
        : undefined;

      // Validate required fields
      if (!contentEn || !contentOriginal) {
        logDebug(TAG, `Skipping memory with empty content for chat ${chatId}`);
        continue;
      }

      if (!validTypes.has(memoryType)) {
        logDebug(TAG, `Skipping memory with invalid type "${memoryType}" for chat ${chatId}`);
        continue;
      }

      memories.push({
        chat_id: chatId,
        content_original: contentOriginal,
        content_en: contentEn,
        memory_type: memoryType as ExtractedMemory["memory_type"],
        source_timestamp: timestamp,
        preserve_original: preserveOriginal,
        preserved_keyword: preserveOriginal ? preservedKeyword : undefined,
        emotion_score: clampEmotionScore(obj.emotion_score),
        created_at: now,
      });
    }

    return memories;
  }

  /**
   * Insert extracted memories into the extracted_memories table.
   * FTS5 triggers handle indexing automatically.
   */
  private insertMemories(memories: ExtractedMemory[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO extracted_memories
         (chat_id, content_original, content_en, memory_type, source_timestamp, preserve_original, preserved_keyword, emotion_score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAll = this.db.transaction((mems: ExtractedMemory[]) => {
      for (const m of mems) {
        stmt.run(
          m.chat_id,
          m.content_original,
          m.content_en,
          m.memory_type,
          m.source_timestamp,
          m.preserve_original ? 1 : 0,
          m.preserved_keyword ?? null,
          m.emotion_score,
          m.created_at,
        );
      }
    });

    insertAll(memories);
  }

  /** Get the watermark (last processed timestamp) for a chat. Returns 0 if no watermark exists. */
  getWatermark(chatId: number): number {
    const row = this.db
      .prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE chat_id = ?")
      .get(chatId) as { last_processed_timestamp: number } | undefined;

    return row?.last_processed_timestamp ?? 0;
  }

  /** Update the watermark after successful processing. Uses UPSERT for idempotency. */
  private updateWatermark(chatId: number, timestamp: number): void {
    this.db
      .prepare(
        `INSERT INTO extraction_watermarks (chat_id, last_processed_timestamp)
         VALUES (?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET last_processed_timestamp = excluded.last_processed_timestamp`,
      )
      .run(chatId, timestamp);
  }
}
