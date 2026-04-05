import { mkdirSync, writeFileSync, appendFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { ForgetResult } from "../types/index.js";
import type { MemoryIndex } from "./memory-index.js";
import type { MemoryEditor } from "./memory-editor.js";
import { logError, logInfo, logWarn } from "../components/logger.js";
import { localDate } from "../components/env-utils.js";

const TAG = "maintenance";

/** Handles disk budget, backup pruning, auto-compact, and forget operations. */
export class MaintenanceService {
  constructor(
    private readonly db: Database.Database,
    private readonly config: MemoryConfig,
    private readonly memoryIndex: MemoryIndex,
    private readonly editor: MemoryEditor,
  ) {}

  /** Enforce disk budget by checking DB size against configured limit. */
  enforceDiskBudget(): void {
    try {
      const dbPath = join(this.config.memoryDir, "memory.db");
      if (existsSync(dbPath)) {
        const dbSize = statSync(dbPath).size;
        if (dbSize > this.config.diskBudgetBytes) {
          logWarn(TAG, `DB size ${(dbSize / 1024 / 1024).toFixed(1)}MB exceeds budget ${(this.config.diskBudgetBytes / 1024 / 1024).toFixed(0)}MB`);
        }
      }
    } catch (err) {
      logError(TAG, "Disk budget enforcement failed", err);
    }
  }

  /** Delete chat_backup rows older than 7 days. */
  pruneBackup(): void {
    try {
      const cutoff = Date.now() - 7 * 24 * 3_600_000;
      const result = this.db.prepare("DELETE FROM chat_backup WHERE timestamp < ?").run(cutoff);
      if (result.changes > 0) logInfo(TAG, `Pruned ${result.changes} chat_backup rows older than 7 days`);
    } catch { /* */ }
  }

  /** Check if context exceeds threshold and write safety-net transcript. */
  async checkAutoCompact(params: {
    chatId: number; sessionId: string; contextPercent: number;
    sendCompactCommand: (sessionKey: string, command: string) => Promise<string>;
  }): Promise<void> {
    const threshold = this.config.searchEnhancements.compactThresholdPct;
    if (params.contextPercent < threshold) return;

    logInfo(TAG, `Auto-compact triggered for chat ${params.chatId} (context ${params.contextPercent}% >= ${threshold}%)`);

    try {
      const messages = this.db.prepare(
        "SELECT role, content FROM messages WHERE chat_id = ? AND session_id = ? ORDER BY timestamp ASC",
      ).all(params.chatId, params.sessionId) as Array<{ role: string; content: string }>;

      if (messages.length > 0) {
        const workingDir = join(this.config.memoryDir, "working", localDate());
        mkdirSync(workingDir, { recursive: true });
        const safetyPath = join(workingDir, `transcript_${params.chatId}.chat`);
        const rawContent = messages.map(m => `[${m.role}] ${m.content}`).join("\n");
        if (existsSync(safetyPath)) appendFileSync(safetyPath, `\n---\n\n${rawContent}`);
        else writeFileSync(safetyPath, rawContent);
        logInfo(TAG, `Safety-net transcript written to ${safetyPath}`);
      }

      await params.sendCompactCommand(params.sessionId, "/compact");
    } catch (err) {
      logError(TAG, `Auto-compact failed for chat ${params.chatId}`, err);
    }
  }

  /** Forget all memories semantically related to a topic. */
  async forgetTopic(chatId: number, topic: string, threshold?: number): Promise<ForgetResult> {
    const empty: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    try {
      const effectiveThreshold = threshold ?? this.config.forgetThreshold;
      const searchResults = this.memoryIndex.search(topic, { chatId, limit: 100 });
      const relevant = searchResults.filter(r => r.score >= effectiveThreshold);
      if (relevant.length === 0) return empty;

      const messageIds: number[] = [];
      for (const r of relevant) {
        const row = this.db.prepare(
          "SELECT id FROM messages WHERE chat_id = ? AND session_id = ? AND timestamp = ? AND role = ?",
        ).get(r.record.chatId, r.record.sessionId, r.record.timestamp, r.record.role) as { id: number } | undefined;
        if (row) messageIds.push(row.id);
      }
      if (messageIds.length === 0) return empty;

      const result = this.editor.cascadeDelete(messageIds, chatId);
      logInfo(TAG, `forgetTopic: removed ${result.messagesRemoved} messages for topic "${topic}"`);
      return result;
    } catch (err) {
      logError(TAG, `forgetTopic failed for chat ${chatId}`, err);
      return empty;
    }
  }

  /** Forget all memories within a date range. */
  forgetRange(chatId: number, startDate: Date, endDate: Date): ForgetResult {
    const empty: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    try {
      const rows = this.db.prepare(
        "SELECT id FROM messages WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?",
      ).all(chatId, startDate.getTime(), endDate.getTime()) as Array<{ id: number }>;
      if (rows.length === 0) return empty;
      return this.editor.cascadeDelete(rows.map(r => r.id), chatId);
    } catch (err) {
      logError(TAG, `forgetRange failed for chat ${chatId}`, err);
      return empty;
    }
  }

  /** Forget all memories for a specific session. */
  forgetSession(chatId: number, sessionId: string): ForgetResult {
    const empty: ForgetResult = { messagesRemoved: 0, embeddingsRemoved: 0, transcriptEntriesRemoved: 0 };
    try {
      const rows = this.db.prepare(
        "SELECT id FROM messages WHERE chat_id = ? AND session_id = ?",
      ).all(chatId, sessionId) as Array<{ id: number }>;
      if (rows.length === 0) return empty;
      return this.editor.cascadeDelete(rows.map(r => r.id), chatId);
    } catch (err) {
      logError(TAG, `forgetSession failed for chat ${chatId}`, err);
      return empty;
    }
  }

  /** Run SQLite integrity check. Returns "ok" or error description. */
  checkIntegrity(): string {
    try {
      const result = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
      return result?.integrity_check ?? "unknown";
    } catch (e) {
      return e instanceof Error ? e.message : "error";
    }
  }
}
