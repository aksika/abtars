import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { MemoryConfig } from "./memory-config.js";
import type { CompactedMemory, MemoryTier } from "../types/index.js";
import { TranscriptParser } from "./transcript-parser.js";
import { MemoryIndex } from "./memory-index.js";
import { logError, logInfo } from "./logger.js";

const TAG = "compaction-engine";

const DAILY_PROMPT =
  "Extract the key facts learned about the user today, major decisions made, and tasks completed. Discard pleasantries, formatting, and minor step-by-step reasoning. Output a dense summary in English.";

const WEEKLY_PROMPT =
  "Synthesize these daily summaries into a single weekly summary. Identify overarching themes, completed projects, and persistent user preferences. Drop transient details that no longer matter. Output the summary in English.";

const QUARTERLY_PROMPT =
  "Consolidate these weekly summaries into a quarterly overview. Focus on major accomplishments, evolving preferences, and significant decisions across the quarter. Remove week-level granularity. Output the summary in English.";

// Legacy prompts kept for backward compatibility with existing monthly/yearly files
const MONTHLY_PROMPT =
  "Consolidate these weekly summaries into a monthly overview. Focus on major accomplishments, evolving preferences, and significant decisions. Remove week-level granularity.";

const YEARLY_PROMPT =
  "Create a yearly summary from these monthly summaries. Capture the most important themes, long-term preferences, and significant milestones. Also extract a list of permanent, immutable facts about the user that should be remembered forever.\n\nYou will also receive the current User_Core_Facts file. Merge the newly extracted facts with the existing ones, producing a single holistically deduplicated list. Remove redundant or contradictory entries while preserving all unique facts. Output the merged facts separately.";

/** Consolidation thresholds: number of source-tier summaries needed to trigger target-tier consolidation. */
export const CONSOLIDATION_THRESHOLDS = {
  weekly: 7,      // 7 daily summaries → 1 weekly
  quarterly: 12,  // 12 weekly summaries → 1 quarterly
} as const;

function getTierPrompt(tier: MemoryTier): string {
  switch (tier) {
    case "daily":
      return DAILY_PROMPT;
    case "weekly":
      return WEEKLY_PROMPT;
    case "quarterly":
      return QUARTERLY_PROMPT;
    case "monthly":
      return MONTHLY_PROMPT;
    case "yearly":
      return YEARLY_PROMPT;
  }
}

/**
 * Handles daily compaction and tier consolidation: loading transcripts,
 * calling the LLM, and persisting results as markdown files + SQLite rows.
 */
export class CompactionEngine {
  private readonly db: Database.Database;
  private readonly transcriptParser: TranscriptParser;
  private readonly memoryIndex: MemoryIndex;
  private readonly config: MemoryConfig;

  constructor(
    db: Database.Database,
    transcriptParser: TranscriptParser,
    memoryIndex: MemoryIndex,
    config: MemoryConfig,
  ) {
    this.db = db;
    this.transcriptParser = transcriptParser;
    this.memoryIndex = memoryIndex;
    this.config = config;
  }

  /** Run daily compaction for a chat session. */
  async compact(params: {
    chatId: number;
    sessionId: string;
    llmCall: (prompt: string, content: string) => Promise<string>;
    compactionDate?: Date;
  }): Promise<CompactedMemory | null> {
    try {
      const transcriptPath = join(
        this.config.memoryDir,
        "transcripts",
        String(params.chatId),
        `${params.sessionId}.jsonl`,
      );

      const messages = this.transcriptParser.parse(transcriptPath);
      if (messages.length === 0) {
        logInfo(TAG, `No messages to compact for chat ${params.chatId}, session ${params.sessionId}`);
        return null;
      }

      const content = messages
        .map((m) => `[${m.role}] ${m.content}`)
        .join("\n");

      const summary = await params.llmCall(DAILY_PROMPT, content);

      const now = new Date();
      const dateStr = params.compactionDate
        ? params.compactionDate.toISOString().slice(0, 10)
        : now.toISOString().slice(0, 10); // YYYY-MM-DD
      const dailyDir = join(this.config.memoryDir, "memory", "daily", String(params.chatId));
      mkdirSync(dailyDir, { recursive: true });
      const filePath = join(dailyDir, `${dateStr}.md`);

      // Append to existing daily file if it already exists
      if (existsSync(filePath)) {
        appendFileSync(filePath, `\n---\n\n${summary}`);
      } else {
        writeFileSync(filePath, summary);
      }

      const timestamp = now.getTime();

      // Insert row into compactions table
      const result = this.db
        .prepare(
          `INSERT INTO compactions (chat_id, source_session_id, tier, timestamp, summary, file_path)
           VALUES (?, ?, 'daily', ?, ?, ?)`,
        )
        .run(params.chatId, params.sessionId, timestamp, summary, filePath);

      const compactionId = Number(result.lastInsertRowid);

      // Index the compaction in messages table with role='compaction' so it's FTS-searchable
      this.memoryIndex.index({
        role: "compaction",
        content: summary,
        timestamp,
        chatId: params.chatId,
        sessionId: params.sessionId,
      });

      logInfo(TAG, `Daily compaction created for chat ${params.chatId}: ${filePath}`);

      return {
        id: compactionId,
        chatId: params.chatId,
        sourceSessionId: params.sessionId,
        tier: "daily",
        timestamp,
        summary,
        filePath,
      };
    } catch (err) {
      logError(TAG, `Failed to compact chat ${params.chatId}, session ${params.sessionId}`, err);
      return null;
    }
  }

  /** Consolidate source files into a higher tier. */
  async consolidate(params: {
    chatId: number;
    sourceTier: MemoryTier;
    targetTier: MemoryTier;
    sourceFiles: string[];
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<CompactedMemory | null> {
    try {
      // Read all source files' content
      const contents: string[] = [];
      for (const file of params.sourceFiles) {
        try {
          contents.push(readFileSync(file, "utf-8"));
        } catch (err) {
          logError(TAG, `Failed to read source file: ${file}`, err);
        }
      }

      if (contents.length === 0) {
        logInfo(TAG, `No source content to consolidate for chat ${params.chatId}`);
        return null;
      }

      const concatenated = contents.join("\n\n---\n\n");
      const prompt = getTierPrompt(params.targetTier);

      const summary = await params.llmCall(prompt, concatenated);

      // Determine target file path based on tier
      const targetDir = join(
        this.config.memoryDir,
        "memory",
        params.targetTier,
        String(params.chatId),
      );
      mkdirSync(targetDir, { recursive: true });

      const now = new Date();
      const fileName = this.getConsolidationFileName(params.targetTier, now);
      const filePath = join(targetDir, fileName);

      writeFileSync(filePath, summary);

      // Delete source files
      for (const file of params.sourceFiles) {
        try {
          unlinkSync(file);
        } catch (err) {
          logError(TAG, `Failed to delete source file: ${file}`, err);
        }
      }

      const timestamp = now.getTime();

      // Insert row into compactions table
      const result = this.db
        .prepare(
          `INSERT INTO compactions (chat_id, source_session_id, tier, timestamp, summary, file_path)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(params.chatId, "consolidation", params.targetTier, timestamp, summary, filePath);

      const compactionId = Number(result.lastInsertRowid);

      // Index in FTS
      this.memoryIndex.index({
        role: "compaction",
        content: summary,
        timestamp,
        chatId: params.chatId,
        sessionId: "consolidation",
      });

      logInfo(
        TAG,
        `Consolidated ${params.sourceFiles.length} ${params.sourceTier} files into ${params.targetTier} for chat ${params.chatId}: ${filePath}`,
      );

      return {
        id: compactionId,
        chatId: params.chatId,
        sourceSessionId: "consolidation",
        tier: params.targetTier,
        timestamp,
        summary,
        filePath,
      };
    } catch (err) {
      logError(TAG, `Failed to consolidate ${params.sourceTier} → ${params.targetTier} for chat ${params.chatId}`, err);
      return null;
    }
  }

  /** Load compactions for a chat, optionally filtered by tier. */
  getCompactions(chatId: number, opts?: { tier?: MemoryTier; limit?: number }): CompactedMemory[] {
    const conditions: string[] = ["chat_id = ?"];
    const params: (string | number)[] = [chatId];

    if (opts?.tier) {
      conditions.push("tier = ?");
      params.push(opts.tier);
    }

    const limit = opts?.limit ?? 100;
    params.push(limit);

    const sql = `
      SELECT id, chat_id, source_session_id, tier, timestamp, summary, file_path
      FROM compactions
      WHERE ${conditions.join(" AND ")}
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      id: number;
      chat_id: number;
      source_session_id: string;
      tier: string;
      timestamp: number;
      summary: string;
      file_path: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      chatId: row.chat_id,
      sourceSessionId: row.source_session_id,
      tier: row.tier as MemoryTier,
      timestamp: row.timestamp,
      summary: row.summary,
      filePath: row.file_path,
    }));
  }

  /**
   * Check if any consolidation thresholds are met for a chat.
   * Returns the source and target tier if consolidation should run, or null if not needed.
   * Checks daily→weekly first (7 daily summaries), then weekly→quarterly (12 weekly summaries).
   */
  checkConsolidationThresholds(chatId: number): { sourceTier: MemoryTier; targetTier: MemoryTier } | null {
    // Count daily compactions for this chat
    const dailyCount = this.db
      .prepare("SELECT COUNT(*) as cnt FROM compactions WHERE chat_id = ? AND tier = 'daily'")
      .get(chatId) as { cnt: number };

    if (dailyCount.cnt >= CONSOLIDATION_THRESHOLDS.weekly) {
      return { sourceTier: "daily", targetTier: "weekly" };
    }

    // Count weekly compactions for this chat
    const weeklyCount = this.db
      .prepare("SELECT COUNT(*) as cnt FROM compactions WHERE chat_id = ? AND tier = 'weekly'")
      .get(chatId) as { cnt: number };

    if (weeklyCount.cnt >= CONSOLIDATION_THRESHOLDS.quarterly) {
      return { sourceTier: "weekly", targetTier: "quarterly" };
    }

    return null;
  }

  /** Generate the file name for a consolidation based on tier and date. */
  private getConsolidationFileName(tier: MemoryTier, date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");

    switch (tier) {
      case "weekly": {
        // ISO week number
        const weekNum = this.getISOWeek(date);
        return `${year}-W${String(weekNum).padStart(2, "0")}.md`;
      }
      case "quarterly": {
        // Quarter number (1-4) based on month
        const quarter = Math.ceil((date.getMonth() + 1) / 3);
        return `${year}-Q${quarter}.md`;
      }
      case "monthly":
        return `${year}-${month}.md`;
      case "yearly":
        return `${year}.md`;
      default:
        // daily fallback
        return `${date.toISOString().slice(0, 10)}.md`;
    }
  }

  /** Calculate ISO week number for a date. */
  private getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }
}
