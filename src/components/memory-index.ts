import type Database from "better-sqlite3";
import type { MessageRecord, SearchResult } from "../types/index.js";

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
      `INSERT INTO messages (chat_id, session_id, role, content, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const result = stmt.run(
      record.chatId,
      record.sessionId,
      record.role,
      record.content,
      record.timestamp,
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
  ): SearchResult[] {
    if (!query.trim()) return [];

    const conditions: string[] = ["messages_fts MATCH ?"];
    const params: (string | number)[] = [query];

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
}
