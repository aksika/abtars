import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { MessageRecord } from "../types/index.js";
import type { MemoryIndex } from "./memory-index.js";
import { logError } from "./logger.js";

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
}
