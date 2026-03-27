import type Database from "better-sqlite3";
import type { MessageRecord, SearchResult } from "../types/index.js";
import type { ExtractedMemory, MemorySearchResult } from "../types/memory.js";
import { logWarn } from "./logger.js";

/** Weight applied to the log1p emotion boost in search ranking. */
export const EMOTION_BOOST_WEIGHT = 0.5;

/** Strip diacritical marks (accents) from a string using Unicode NFD decomposition. */
function stripAccents(str: string): string {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/**
 * Sanitize a raw query string for safe use in an FTS5 MATCH clause.
 *
 * Wraps each whitespace-delimited token in double quotes (stripping any
 * internal quotes) with a trailing `*` for prefix matching. Quoting
 * neutralizes all FTS5 operators (OR, NOT, NEAR, ^, *, :, -, etc.)
 * without needing a blacklist. Prefix matching is critical for
 * agglutinative languages (e.g. Hungarian) where "jelszó" needs to
 * match "jelszóra", "jelszót", etc.
 * Returns empty string if no valid tokens remain.
 */
export function sanitizeFtsQuery(query: string, mode: "or" | "and" = "and"): string {
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return "";
  const joiner = mode === "or" ? " OR " : " ";
  return tokens.map((t) => `"${t.replace(/"/g, "")}"*`).join(joiner);
}

/**
 * SQLite FTS5 full-text search index over conversation messages.
 *
 * Messages are inserted into the `messages` table; an AFTER INSERT trigger
 * automatically populates the `messages_fts` virtual table. Searches use
 * BM25 ranking via FTS5's built-in `rank` column.
 */
export class MemoryIndex {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Index a message for full-text search by inserting into the messages table.
   * The FTS trigger auto-indexes the content. Returns the inserted message id.
   */
  index(record: MessageRecord): number {
    const stmt = this.db.prepare(
      `INSERT INTO messages (chat_id, session_id, role, content, timestamp, platform_message_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      record.chatId,
      record.sessionId,
      record.role,
      record.content,
      record.timestamp,
      record.platformMessageId ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /**
   * Search messages by query using FTS5 BM25 ranking.
   *
   * FTS5 `rank` values are negative (more negative = more relevant),
   * so we ORDER BY rank ASC and convert to positive scores for output.
   */
  search(
    query: string,
    opts?: {
      chatId?: number;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
    mode: "or" | "and" = "and",
  ): SearchResult[] {
    if (!query.trim()) return [];

    const sanitizedQuery = sanitizeFtsQuery(query, mode);
    if (!sanitizedQuery) return [];

    const conditions: string[] = ["messages_fts MATCH ?"];
    const params: (string | number)[] = [sanitizedQuery];

    if (opts?.chatId !== undefined) {
      conditions.push("m.chat_id = ?");
      params.push(opts.chatId);
    }
    if (opts?.startTime !== undefined) {
      conditions.push("m.timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts?.endTime !== undefined) {
      conditions.push("m.timestamp <= ?");
      params.push(opts.endTime);
    }

    const limit = opts?.limit ?? 20;
    params.push(limit);

    const sql = `
      SELECT m.id, m.chat_id, m.session_id, m.role, m.content, m.timestamp, rank
      FROM messages m
      JOIN messages_fts ON messages_fts.rowid = m.id
      WHERE ${conditions.join(" AND ")}
      ORDER BY rank ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      chat_id: number;
      session_id: string;
      role: string;
      content: string;
      timestamp: number;
      rank: number;
    }>;

    return rows.map((row) => ({
      record: {
        role: row.role as MessageRecord["role"],
        content: row.content,
        timestamp: row.timestamp,
        chatId: row.chat_id,
        sessionId: row.session_id,
      },
      score: Math.abs(row.rank),
    }));
  }

  /** Remove all indexed entries for a session. */
  removeSession(chatId: number, sessionId: string): void {
    this.db
      .prepare("DELETE FROM messages WHERE chat_id = ? AND session_id = ?")
      .run(chatId, sessionId);
  }

  /**
   * Substring search — catches compound words that FTS5 prefix matching misses.
   * Uses accent-insensitive matching by fetching all messages for the chat
   * and filtering in JS with Unicode NFD normalization.
   * Tokens shorter than 3 chars are skipped. Results scored by number of matching tokens.
   */
  substringSearch(
    query: string,
    opts?: {
      chatId?: number;
      startTime?: number;
      endTime?: number;
      limit?: number;
    },
    mode: "or" | "and" = "or",
  ): SearchResult[] {
    const tokens = query
      .replace(/[^\w\s\u00C0-\u024F]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3)
      .map((t) => t.toLowerCase());

    if (tokens.length === 0) return [];

    // Normalize tokens: strip accents for accent-insensitive matching
    const normalizedTokens = tokens.map((t) => stripAccents(t));

    // Fetch candidate messages from DB (filtered by chat/time only)
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.chatId !== undefined) {
      conditions.push("chat_id = ?");
      params.push(opts.chatId);
    }
    if (opts?.startTime !== undefined) {
      conditions.push("timestamp >= ?");
      params.push(opts.startTime);
    }
    if (opts?.endTime !== undefined) {
      conditions.push("timestamp <= ?");
      params.push(opts.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT id, chat_id, session_id, role, content, timestamp
      FROM messages
      ${whereClause}
      ORDER BY timestamp DESC
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      chat_id: number;
      session_id: string;
      role: string;
      content: string;
      timestamp: number;
    }>;

    // Score by number of matching tokens (accent-insensitive)
    const limit = opts?.limit ?? 20;
    const results: SearchResult[] = [];

    for (const row of rows) {
      const normalizedContent = stripAccents(row.content.toLowerCase());
      const matchCount = normalizedTokens.filter((t) => normalizedContent.includes(t)).length;
      if (matchCount === 0) continue;
      if (mode === "and" && matchCount < normalizedTokens.length) continue;

      results.push({
        record: {
          role: row.role as MessageRecord["role"],
          content: row.content,
          timestamp: row.timestamp,
          chatId: row.chat_id,
          sessionId: row.session_id,
        },
        score: matchCount / normalizedTokens.length,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Remove oldest entries for a chat beyond the limit, keeping the most recent. */
  prune(chatId: number, maxMessages: number): void {
    this.db
      .prepare(
        `DELETE FROM messages WHERE chat_id = ? AND id NOT IN (
           SELECT id FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
         )`,
      )
      .run(chatId, chatId, maxMessages);
  }

  /**
   * Search extracted memories by English content using FTS5 on extracted_memories_fts.
   *
   * Joins with extracted_memories for metadata. Supports chatId, time range,
   * and limit filters. Returns MemorySearchResult[] with tier="extracted".
   * Returns empty array on error.
   */
  searchExtracted(
    query: string,
    opts?: { chatId?: number; startTime?: number; endTime?: number; limit?: number; maxClassification?: number },
    mode: "or" | "and" = "and",
  ): MemorySearchResult[] {
    try {
      if (!query.trim()) return [];

      const sanitizedQuery = sanitizeFtsQuery(query, mode);
      if (!sanitizedQuery) return [];

      const conditions: string[] = ["extracted_memories_fts MATCH ?"];
      const params: (string | number)[] = [sanitizedQuery];

      // Classification filter — always exclude restricted (3), cap at maxClassification
      const maxCls = Math.min(opts?.maxClassification ?? 2, 2);
      conditions.push("COALESCE(em.classification, 1) <= ?");
      params.push(maxCls);

      if (opts?.chatId !== undefined) {
        conditions.push("em.chat_id = ?");
        params.push(opts.chatId);
      }
      if (opts?.startTime !== undefined) {
        conditions.push("em.source_timestamp >= ?");
        params.push(opts.startTime);
      }
      if (opts?.endTime !== undefined) {
        conditions.push("em.source_timestamp <= ?");
        params.push(opts.endTime);
      }

      const limit = opts?.limit ?? 20;
      params.push(limit);

      const sql = `
        SELECT em.id, em.content_en, em.content_original, em.memory_type,
               em.source_timestamp, em.preserve_original, em.emotion_score,
               em.recall_count, em.relevance_score, em.source_message_ids,
               em.trust, em.integrity, em.credibility, em.classification, rank
        FROM extracted_memories em
        JOIN extracted_memories_fts ON extracted_memories_fts.rowid = em.id
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank * (1.0 + 0.1 * COALESCE(em.recall_count, 0))
                      * CASE WHEN COALESCE(em.relevance_score, 0) > 0 THEN 1.2 ELSE 1.0 END
                      / (0.5 + 0.5 * COALESCE(em.trust, 0) / 3.0)
                      * CASE WHEN COALESCE(em.credibility, 6) <= 2 THEN 0.8 ELSE 1.0 END
               ASC
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        content_en: string;
        content_original: string;
        memory_type: string;
        source_timestamp: number;
        preserve_original: number;
        emotion_score: number;
        recall_count: number;
        relevance_score: number;
        source_message_ids: string | null;
        trust: number | null;
        integrity: number | null;
        credibility: number | null;
        classification: number | null;
        rank: number;
      }>;

      return rows.map((row) => {
        const bm25Score = Math.abs(row.rank);
        const emotionBoost = EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(row.emotion_score));
        const recallBoost = 0.1 * (row.recall_count ?? 0);
        const relevanceBoost = (row.relevance_score ?? 0) > 0 ? 0.2 : 0;
        return {
          id: row.id,
          content: row.content_en,
          content_original: row.content_original,
          memory_type: row.memory_type,
          source_timestamp: row.source_timestamp,
          source_message_ids: row.source_message_ids ?? undefined,
          trust: row.trust ?? 0,
          integrity: row.integrity ?? 2,
          credibility: row.credibility ?? 6,
          classification: row.classification ?? 1,
          tier: "extracted" as const,
          score: (bm25Score + emotionBoost) * (1 + recallBoost) * (1 + relevanceBoost) * (0.5 + 0.5 * (row.trust ?? 0) / 3) * (row.credibility !== null && row.credibility <= 2 ? 1.25 : 1),
        };
      });
    } catch (err) {
      logWarn("memory-index", `searchExtracted failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * Search extracted memories by original-language content using FTS5 on
   * extracted_memories_original_fts. Optionally boosts results where
   * preserve_original is true (score multiplied by 1.5).
   *
   * Returns MemorySearchResult[] with tier="extracted".
   * Returns empty array on error.
   */
  searchOriginal(
    query: string,
    opts?: { chatId?: number; limit?: number; boostPreserved?: boolean; maxClassification?: number },
    mode: "or" | "and" = "and",
  ): MemorySearchResult[] {
    try {
      if (!query.trim()) return [];

      const sanitizedQuery = sanitizeFtsQuery(query, mode);
      if (!sanitizedQuery) return [];

      const conditions: string[] = ["extracted_memories_original_fts MATCH ?"];
      const params: (string | number)[] = [sanitizedQuery];

      // Classification filter — always exclude restricted (3)
      const maxCls = Math.min(opts?.maxClassification ?? 2, 2);
      conditions.push("COALESCE(em.classification, 1) <= ?");
      params.push(maxCls);

      if (opts?.chatId !== undefined) {
        conditions.push("em.chat_id = ?");
        params.push(opts.chatId);
      }

      const limit = opts?.limit ?? 20;
      params.push(limit);

      const sql = `
        SELECT em.id, em.content_en, em.content_original, em.memory_type,
               em.source_timestamp, em.preserve_original, em.emotion_score,
               em.recall_count, em.relevance_score, em.source_message_ids,
               em.trust, em.integrity, em.credibility, em.classification, rank
        FROM extracted_memories em
        JOIN extracted_memories_original_fts ON extracted_memories_original_fts.rowid = em.id
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank * (1.0 + 0.1 * COALESCE(em.recall_count, 0))
                      * CASE WHEN COALESCE(em.relevance_score, 0) > 0 THEN 1.2 ELSE 1.0 END
                      / (0.5 + 0.5 * COALESCE(em.trust, 0) / 3.0)
                      * CASE WHEN COALESCE(em.credibility, 6) <= 2 THEN 0.8 ELSE 1.0 END
               ASC
        LIMIT ?
      `;

      const rows = this.db.prepare(sql).all(...params) as Array<{
        id: number;
        content_en: string;
        content_original: string;
        memory_type: string;
        source_timestamp: number;
        preserve_original: number;
        emotion_score: number;
        recall_count: number;
        relevance_score: number;
        source_message_ids: string | null;
        trust: number | null;
        integrity: number | null;
        credibility: number | null;
        classification: number | null;
        rank: number;
      }>;

      const boostPreserved = opts?.boostPreserved ?? false;

      return rows.map((row) => {
        let score = Math.abs(row.rank);
        if (boostPreserved && row.preserve_original === 1) {
          score *= 1.5;
        }
        const emotionBoost = EMOTION_BOOST_WEIGHT * Math.log(1 + Math.abs(row.emotion_score));
        const recallBoost = 0.1 * (row.recall_count ?? 0);
        const relevanceBoost = (row.relevance_score ?? 0) > 0 ? 0.2 : 0;
        score = (score + emotionBoost) * (1 + recallBoost) * (1 + relevanceBoost) * (0.5 + 0.5 * (row.trust ?? 0) / 3) * (row.credibility !== null && row.credibility <= 2 ? 1.25 : 1);
        return {
          id: row.id,
          content: row.content_en,
          content_original: row.content_original,
          memory_type: row.memory_type,
          source_timestamp: row.source_timestamp,
          source_message_ids: row.source_message_ids ?? undefined,
          trust: row.trust ?? 0,
          integrity: row.integrity ?? 2,
          credibility: row.credibility ?? 6,
          classification: row.classification ?? 1,
          tier: "extracted" as const,
          score,
        };
      });
    } catch (err) {
      logWarn("memory-index", `searchOriginal failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** Bump recall_count and last_recalled_at for the given extracted memory IDs. */
  bumpRecallCount(ids: number[]): void {
    if (ids.length === 0) return;
    try {
      const now = Date.now();
      const stmt = this.db.prepare(
        "UPDATE extracted_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id = ?",
      );
      for (const id of ids) stmt.run(now, id);
    } catch (err) {
      logWarn("memory-index", `bumpRecallCount failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Index an extracted memory in the FTS5 indexes.
   *
   * The FTS5 triggers on extracted_memories handle automatic indexing on INSERT,
   * but this method provides a manual indexing path for cases where the triggers
   * may not have fired (e.g., bulk imports or rebuilds).
   *
   * Always indexes content_en into extracted_memories_fts.
   * Indexes content_original into extracted_memories_original_fts only when
   * preserve_original is true.
   */
  indexExtractedMemory(memory: ExtractedMemory & { id: number }): void {
    try {
      this.db
        .prepare("INSERT INTO extracted_memories_fts(rowid, content_en) VALUES (?, ?)")
        .run(memory.id, memory.content_en);

      if (memory.preserve_original) {
        this.db
          .prepare("INSERT INTO extracted_memories_original_fts(rowid, content_original) VALUES (?, ?)")
          .run(memory.id, memory.content_original);
      }
    } catch (err) {
      logWarn("memory-index", `indexExtractedMemory failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

}
