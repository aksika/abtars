import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { MessageRecord } from "./mem-types.js";
import type { MemoryIndex } from "./memory-index.js";
import { logError } from "./mem-logger.js";

const TAG = "message-store";

/** Handles message recording, loading, and emotion score updates. */
export class MessageStore {
  constructor(
    private readonly db: Database.Database,
    private readonly config: MemoryConfig,
    private readonly memoryIndex: MemoryIndex,
  ) {}

  private writeCounter = 0;
  private diskBudgetCallback: (() => void) | null = null;

  /** Register a callback to run disk budget enforcement periodically. */
  setDiskBudgetCallback(fn: () => void): void { this.diskBudgetCallback = fn; }

  /** Record a conversation message to FTS index + optional backup. Never throws. */
  recordMessage(record: MessageRecord): void {
    try {
      if (!record.content.trim()) return;
      this.memoryIndex.index(record);

      if (process.env["DEBUG_MODE"] === "true" || process.env["DEBUG_MODE"] === "1") {
        this.db.prepare(
          "INSERT INTO chat_backup (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
        ).run(record.chatId, record.sessionId, record.role, record.content, record.timestamp);
      }

      if (this.config.maxMessagesPerChat > 0) {
        this.memoryIndex.prune(record.chatId, this.config.maxMessagesPerChat);
      }

      this.writeCounter++;
      if (this.writeCounter % 100 === 0) this.diskBudgetCallback?.();
    } catch (err) {
      logError(TAG, "Failed to record message", err);
    }
  }

  /** Load the most recent N messages from a session. */
  loadRecentMessages(chatId: number, sessionId: string, count: number): MessageRecord[] {
    try {
      const rows = this.db.prepare(
        "SELECT role, content, timestamp, chat_id AS chatId, session_id AS sessionId FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY timestamp DESC LIMIT ?",
      ).all(chatId, sessionId, count) as MessageRecord[];
      return rows.reverse();
    } catch (err) {
      logError(TAG, `Failed to load recent messages for chat ${chatId} session ${sessionId}`, err);
      return [];
    }
  }

  /** Update emotion_score on a message by platform ID. Returns true if updated. */
  updateEmotionByPlatformId(
    chatId: number | string,
    platformMessageId: number,
    score: number,
    editMemoryFn: (params: { messageId: number; chatId: number; emotionScore: number }) => void,
  ): boolean {
    try {
      const result = this.db.prepare(
        "UPDATE messages SET emotion_score = ? WHERE chat_id = ? AND platform_message_id = ?",
      ).run(score, chatId, platformMessageId);
      if (result.changes === 0) return false;
      editMemoryFn({
        messageId: platformMessageId,
        chatId: typeof chatId === "string" ? parseInt(chatId, 10) : chatId,
        emotionScore: score,
      });
      return true;
    } catch (err) {
      logError(TAG, "Failed to update emotion score", err);
      return false;
    }
  }

  /** Get the timestamp of the most recent user message (optionally excluding system markers). */
  getLastMessageTimestamp(excludeSystem = false): number {
    try {
      const sql = excludeSystem
        ? "SELECT MAX(timestamp) as ts FROM messages WHERE content NOT LIKE '%[SYSTEM%'"
        : "SELECT MAX(timestamp) as ts FROM messages WHERE role = 'user'";
      const row = this.db.prepare(sql).get() as { ts: number | null } | undefined;
      return row?.ts ?? 0;
    } catch { return 0; }
  }

  /** Get recent messages since a timestamp, ordered newest first. */
  getMessagesSince(sinceTimestamp: number, limit: number): Array<{ role: string; content: string; timestamp: number }> {
    try {
      return this.db.prepare(
        "SELECT role, content, timestamp FROM messages WHERE timestamp > ? ORDER BY timestamp DESC LIMIT ?",
      ).all(sinceTimestamp, limit) as Array<{ role: string; content: string; timestamp: number }>;
    } catch { return []; }
  }

  /** Get recent extracted memories (English content), newest first. */
  getRecentExtractedMemories(limit: number): string[] {
    try {
      const rows = this.db.prepare(
        "SELECT content_en FROM extracted_memories ORDER BY created_at DESC LIMIT ?",
      ).all(limit) as Array<{ content_en: string }>;
      return rows.map(r => r.content_en);
    } catch { return []; }
  }

  /** Get all extracted memories with attributes (for dashboard visualization). */
  getAllExtractedMemories(): Array<Record<string, unknown>> {
    try {
      return this.db.prepare(
        `SELECT id, content_en, content_original, memory_type, created_at, emotion_score,
                recall_count, relevance_score, classification, trust, integrity, credibility,
                CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END as has_embedding
         FROM extracted_memories ORDER BY created_at DESC`
      ).all() as Array<Record<string, unknown>>;
    } catch { return []; }
  }

  /** Get all entities. */
  getAllEntities(): Array<Record<string, unknown>> {
    try { return this.db.prepare("SELECT id, name, type, summary FROM entities").all() as Array<Record<string, unknown>>; }
    catch { return []; }
  }

  /** Get all memory-entity links. */
  getAllEntityLinks(): Array<Record<string, unknown>> {
    try { return this.db.prepare("SELECT memory_id, entity_id FROM memory_entities").all() as Array<Record<string, unknown>>; }
    catch { return []; }
  }

  /** Get distinct chat IDs from messages. */
  getDistinctChatIds(): number[] {
    try {
      return (this.db.prepare("SELECT DISTINCT chat_id FROM messages ORDER BY chat_id").all() as Array<{ chat_id: number }>)
        .map(r => r.chat_id);
    } catch { return []; }
  }
}
