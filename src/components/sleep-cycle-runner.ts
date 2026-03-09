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

  /** Check and run any pending consolidations. Called on session start. */
  async runPendingConsolidations(params: {
    llmCall: (prompt: string, content: string) => Promise<string>;
  }): Promise<void> {
    try {
      // Run consolidation checks in order: daily→weekly, weekly→quarterly
      await this.runWeeklyRollups(params.llmCall);
      await this.runQuarterlyRollups(params.llmCall);
    } catch (err) {
      logError(TAG, "Failed to run pending consolidations", err);
    }
  }

  /** Run daily→weekly rollups for any weeks with 7+ daily files. */
  async runWeeklyRollups(
    llmCall: (prompt: string, content: string) => Promise<string>,
  ): Promise<void> {
    const dailyDir = join(this.config.memoryDir, "daily");
    const files = this.listFiles(dailyDir);
    if (files.length === 0) return;

    const grouped = this.groupDailyByWeek(files);

    for (const [weekKey, weekFiles] of grouped) {
      if (weekFiles.length >= 7) {
        logInfo(TAG, `Weekly rollup triggered for week ${weekKey}: ${weekFiles.length} daily files`);
        try {
          await this.compactionEngine.consolidate({
            sourceTier: "daily",
            targetTier: "weekly",
            sourceFiles: weekFiles,
            llmCall,
          });
        } catch (err) {
          logError(TAG, `Weekly rollup failed for week ${weekKey}`, err);
          // Retain source files, will retry on next session start
        }
      }
    }
  }

  /** Run weekly→quarterly rollups for any quarters with 4+ weekly files. */
  private async runQuarterlyRollups(
    llmCall: (prompt: string, content: string) => Promise<string>,
  ): Promise<void> {
    const weeklyDir = join(this.config.memoryDir, "weekly");
    const files = this.listFiles(weeklyDir);
    if (files.length === 0) return;

    const grouped = this.groupWeeklyByQuarter(files);

    for (const [quarterKey, quarterFiles] of grouped) {
      if (quarterFiles.length >= 4) {
        logInfo(TAG, `Quarterly rollup triggered for ${quarterKey}: ${quarterFiles.length} weekly files`);
        try {
          await this.compactionEngine.consolidate({
            sourceTier: "weekly",
            targetTier: "quarterly",
            sourceFiles: quarterFiles,
            llmCall,
          });
        } catch (err) {
          logError(TAG, `Quarterly rollup failed for ${quarterKey}`, err);
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
   * Group daily files by ISO week. Daily files are named daily_YYYYMMDD.md.
   * Returns a Map keyed by "YYYY-Wxx" with arrays of full file paths.
   */
  groupDailyByWeek(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const filePath of files) {
      const name = basename(filePath, ".md"); // daily_YYYYMMDD
      const match = name.match(/^daily_(\d{4})(\d{2})(\d{2})$/);
      if (!match) continue;

      const year = Number(match[1]);
      const month = Number(match[2]) - 1; // 0-indexed
      const day = Number(match[3]);

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
   * Group weekly files by quarter. Weekly files are named YYYY-Wxx.md.
   * Determines the quarter by computing the Thursday of the ISO week (ISO standard).
   * Returns a Map keyed by "YYYY-Qn" with arrays of full file paths.
   */
  private groupWeeklyByQuarter(files: string[]): Map<string, string[]> {
    const groups = new Map<string, string[]>();

    for (const filePath of files) {
      const name = basename(filePath, ".md"); // YYYY-Wxx
      const match = name.match(/^(\d{4})-W(\d{2})$/);
      if (!match) continue;

      const year = Number(match[1]);
      const week = Number(match[2]);

      // Find the Thursday of this ISO week to determine the quarter
      // Jan 4 is always in ISO week 1
      const jan4 = new Date(Date.UTC(year, 0, 4));
      const jan4DayOfWeek = jan4.getUTCDay() || 7;
      // Monday of week 1
      const mondayWeek1 = new Date(jan4.getTime());
      mondayWeek1.setUTCDate(jan4.getUTCDate() - (jan4DayOfWeek - 1));
      // Thursday of the target week
      const thursday = new Date(mondayWeek1.getTime());
      thursday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7 + 3);

      const quarter = Math.ceil((thursday.getUTCMonth() + 1) / 3);
      const quarterKey = `${thursday.getUTCFullYear()}-Q${quarter}`;
      const group = groups.get(quarterKey) ?? [];
      group.push(filePath);
      groups.set(quarterKey, group);
    }

    return groups;
  }
}
