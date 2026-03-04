import { readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { MemoryConfig } from "./memory-config.js";
import { CompactionEngine } from "./compaction-engine.js";
import { logError, logInfo } from "./logger.js";

const TAG = "sleep-cycle";

export class SleepCycleRunner {
  private readonly compactionEngine: CompactionEngine;
  private readonly config: MemoryConfig;

  constructor(compactionEngine: CompactionEngine, config: MemoryConfig) {
    this.compactionEngine = compactionEngine;
    this.config = config;
  }

  /** Check and run any pending consolidations for a chat. Called on session start. */
  async runPendingConsolidations(params: {
    chatId: number;
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<void> {
    try {
      // Run consolidation checks in order: daily→weekly, weekly→monthly, monthly→yearly
      await this.runWeeklyRollups(params.chatId, params.llmCall);
      await this.runMonthlyRollups(params.chatId, params.llmCall);
      await this.runYearlyRollups(params.chatId, params.llmCall);
    } catch (err) {
      logError(TAG, `Failed to run pending consolidations for chat ${params.chatId}`, err);
    }
  }

  /** Run daily→weekly rollups for any weeks with 7+ daily files. */
  private async runWeeklyRollups(
    chatId: number,
    llmCall: (prompt: string, content: string) => Promise<string>,
  ): Promise<void> {
    const dailyDir = join(this.config.memoryDir, "memory", "daily", String(chatId));
    const files = this.listFiles(dailyDir);
    if (files.length === 0) return;

    const grouped = this.groupDailyByWeek(files);

    for (const [weekKey, weekFiles] of grouped) {
      if (weekFiles.length >= 7) {
        logInfo(TAG, `Weekly rollup triggered for chat ${chatId}, week ${weekKey}: ${weekFiles.length} daily files`);
        try {
          await this.compactionEngine.consolidate({
            chatId,
            sourceTier: "daily",
            targetTier: "weekly",
            sourceFiles: weekFiles,
            llmCall,
          });
        } catch (err) {
          logError(TAG, `Weekly rollup failed for chat ${chatId}, week ${weekKey}`, err);
          // Retain source files, will retry on next session start
        }
      }
    }
  }

  /** Run weekly→monthly rollups for any months with 4+ weekly files. */
  private async runMonthlyRollups(
    chatId: number,
    llmCall: (prompt: string, content: string) => Promise<string>,
  ): Promise<void> {
    const weeklyDir = join(this.config.memoryDir, "memory", "weekly", String(chatId));
    const files = this.listFiles(weeklyDir);
    if (files.length === 0) return;

    const grouped = this.groupWeeklyByMonth(files);

    for (const [monthKey, monthFiles] of grouped) {
      if (monthFiles.length >= 4) {
        logInfo(TAG, `Monthly rollup triggered for chat ${chatId}, month ${monthKey}: ${monthFiles.length} weekly files`);
        try {
          await this.compactionEngine.consolidate({
            chatId,
            sourceTier: "weekly",
            targetTier: "monthly",
            sourceFiles: monthFiles,
            llmCall,
          });
        } catch (err) {
          logError(TAG, `Monthly rollup failed for chat ${chatId}, month ${monthKey}`, err);
        }
      }
    }
  }

  /** Run monthly→yearly rollups for any years with 12+ monthly files. */
  private async runYearlyRollups(
    chatId: number,
    llmCall: (prompt: string, content: string) => Promise<string>,
  ): Promise<void> {
    const monthlyDir = join(this.config.memoryDir, "memory", "monthly", String(chatId));
    const files = this.listFiles(monthlyDir);
    if (files.length === 0) return;

    const grouped = this.groupMonthlyByYear(files);

    for (const [yearKey, yearFiles] of grouped) {
      if (yearFiles.length >= 12) {
        logInfo(TAG, `Yearly rollup triggered for chat ${chatId}, year ${yearKey}: ${yearFiles.length} monthly files`);
        try {
          await this.compactionEngine.consolidate({
            chatId,
            sourceTier: "monthly",
            targetTier: "yearly",
            sourceFiles: yearFiles,
            llmCall,
          });
        } catch (err) {
          logError(TAG, `Yearly rollup failed for chat ${chatId}, year ${yearKey}`, err);
        }
      }
    }
  }

  /** List .md files in a directory, return full paths sorted. Returns empty array if dir doesn't exist. */
  private listFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => join(dir, f));
    } catch {
      // Directory doesn't exist yet — nothing to consolidate
      return [];
    }
  }

  /** Compute ISO week number for a date. */
  private getISOWeek(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }

  /**
   * Group daily files by ISO week. Daily files are named YYYY-MM-DD.md.
   * Returns a Map keyed by "YYYY-Wxx" with arrays of full file paths.
   */
  private groupDailyByWeek(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const filePath of files) {
      const name = basename(filePath, ".md"); // YYYY-MM-DD
      const parts = name.split("-");
      if (parts.length !== 3) continue;

      const year = Number(parts[0]);
      const month = Number(parts[1]) - 1; // 0-indexed
      const day = Number(parts[2]);

      if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) continue;

      const date = new Date(Date.UTC(year, month, day));
      const weekNum = this.getISOWeek(date);
      // Use the ISO year (which may differ from calendar year at year boundaries)
      const d = new Date(Date.UTC(year, month, day));
      const dayOfWeek = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
      const isoYear = d.getUTCFullYear();

      const key = `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
      const group = groups.get(key) ?? [];
      group.push(filePath);
      groups.set(key, group);
    }

    return groups;
  }

  /**
   * Group weekly files by month. Weekly files are named YYYY-Wxx.md.
   * Determines the month by computing the Thursday of the ISO week (ISO standard).
   * Returns a Map keyed by "YYYY-MM" with arrays of full file paths.
   */
  private groupWeeklyByMonth(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const filePath of files) {
      const name = basename(filePath, ".md"); // YYYY-Wxx
      const match = name.match(/^(\d{4})-W(\d{2})$/);
      if (!match) continue;

      const year = Number(match[1]);
      const week = Number(match[2]);

      // Find the Thursday of this ISO week to determine the month
      // Jan 4 is always in ISO week 1
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4DayOfWeek = jan4.getUTCDay() || 7;
      // Monday of week 1
      const mondayWeek1 = new Date(jan4.getTime());
      mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));
      // Thursday of the target week
      const thursday = new Date(mondayWeek1.getTime());
      thursday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7 + 3);

      const monthKey = `${thursday.getUTCFullYear()}-${String(thursday.getUTCMonth() + 1).padStart(2, "0")}`;
      const group = groups.get(monthKey) ?? [];
      group.push(filePath);
      groups.set(monthKey, group);
    }

    return groups;
  }

  /**
   * Group monthly files by year. Monthly files are named YYYY-MM.md.
   * Returns a Map keyed by "YYYY" with arrays of full file paths.
   */
  private groupMonthlyByYear(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const filePath of files) {
      const name = basename(filePath, ".md"); // YYYY-MM
      const match = name.match(/^(\d{4})-(\d{2})$/);
      if (!match) continue;

      const yearKey = match[1]!;
      const group = groups.get(yearKey) ?? [];
      group.push(filePath);
      groups.set(yearKey, group);
    }

    return groups;
  }
}
