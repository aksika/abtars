import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { TranscriptParser } from "./transcript-parser.js";
import { CompactionEngine } from "./compaction-engine.js";
import { SleepCycleRunner } from "./sleep-cycle-runner.js";
import { MEMORY_CONFIG_DEFAULTS, type MemoryConfig } from "./memory-config.js";
import type Database from "better-sqlite3";

vi.mock("./logger.js", () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

function makeConfig(memoryDir: string): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir };
}

/** Create a flat daily .md file with the new naming pattern: daily_YYYYMMDD.md */
function createDailyFile(baseDir: string, dateStr: string, content?: string): string {
  const dir = join(baseDir, "daily");
  mkdirSync(dir, { recursive: true });
  // dateStr comes in as "YYYY-MM-DD", convert to "YYYYMMDD" for filename
  const compact = dateStr.replace(/-/g, "");
  const filePath = join(dir, `daily_${compact}.md`);
  writeFileSync(filePath, content ?? `Summary for ${dateStr}`);
  return filePath;
}

/** Create a flat weekly .md file: YYYY-Wxx.md */
function createWeeklyFile(baseDir: string, weekStr: string, content?: string): string {
  const dir = join(baseDir, "weekly");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${weekStr}.md`);
  writeFileSync(filePath, content ?? `Weekly summary for ${weekStr}`);
  return filePath;
}

describe("SleepCycleRunner", () => {
  let tmpDir: string;
  let db: Database.Database;
  let memoryIndex: MemoryIndex;
  let transcriptParser: TranscriptParser;
  let engine: CompactionEngine;
  let runner: SleepCycleRunner;
  let config: MemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scr-test-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
    memoryIndex = new MemoryIndex(db);
    transcriptParser = new TranscriptParser();
    config = makeConfig(tmpDir);
    engine = new CompactionEngine(db, transcriptParser, memoryIndex, config);
    runner = new SleepCycleRunner(engine, config);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("no rollup needed when fewer than 7 daily files", async () => {
    // Create 5 daily files in the same ISO week (Mon 2024-01-01 to Fri 2024-01-05)
    createDailyFile(tmpDir, "2024-01-01");
    createDailyFile(tmpDir, "2024-01-02");
    createDailyFile(tmpDir, "2024-01-03");
    createDailyFile(tmpDir, "2024-01-04");
    createDailyFile(tmpDir, "2024-01-05");

    const mockLlm = vi.fn(async () => "Should not be called");

    await runner.runPendingConsolidations({ llmCall: mockLlm });

    // LLM should not have been called
    expect(mockLlm).not.toHaveBeenCalled();

    // Daily files should still exist
    const dailyDir = join(tmpDir, "daily");
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remaining).toHaveLength(5);
  });

  it("weekly rollup triggered with 7+ daily files in same ISO week", async () => {
    // ISO week 1 of 2024: Mon 2024-01-01 through Sun 2024-01-07
    createDailyFile(tmpDir, "2024-01-01");
    createDailyFile(tmpDir, "2024-01-02");
    createDailyFile(tmpDir, "2024-01-03");
    createDailyFile(tmpDir, "2024-01-04");
    createDailyFile(tmpDir, "2024-01-05");
    createDailyFile(tmpDir, "2024-01-06");
    createDailyFile(tmpDir, "2024-01-07");

    const mockLlm = vi.fn(async () => "Weekly consolidated summary.");

    await runner.runPendingConsolidations({ llmCall: mockLlm });

    // LLM should have been called once for the weekly rollup
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Daily files should be deleted
    const dailyDir = join(tmpDir, "daily");
    const remainingDaily = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remainingDaily).toHaveLength(0);

    // Weekly file should exist in flat layout (no chatId subdirectory)
    const weeklyDir = join(tmpDir, "weekly");
    expect(existsSync(weeklyDir)).toBe(true);
    const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(weeklyFiles).toHaveLength(1);
  });

  it("quarterly rollup triggered with 4+ weekly files in same quarter", async () => {
    // Create 4 weekly files all falling in Q1 2024 (January)
    // W01 (Jan 1-7), W02 (Jan 8-14), W03 (Jan 15-21), W04 (Jan 22-28)
    createWeeklyFile(tmpDir, "2024-W01");
    createWeeklyFile(tmpDir, "2024-W02");
    createWeeklyFile(tmpDir, "2024-W03");
    createWeeklyFile(tmpDir, "2024-W04");

    const mockLlm = vi.fn(async () => "Quarterly consolidated summary.");

    await runner.runPendingConsolidations({ llmCall: mockLlm });

    // LLM should have been called once for the quarterly rollup
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Weekly files should be deleted
    const weeklyDir = join(tmpDir, "weekly");
    const remainingWeekly = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(remainingWeekly).toHaveLength(0);

    // Quarterly file should exist in flat layout
    const quarterlyDir = join(tmpDir, "quarterly");
    expect(existsSync(quarterlyDir)).toBe(true);
    const quarterlyFiles = readdirSync(quarterlyDir).filter((f) => f.endsWith(".md"));
    expect(quarterlyFiles).toHaveLength(1);
  });

  it("failed consolidation retains source files unchanged", async () => {
    // Create 7 daily files in the same ISO week
    createDailyFile(tmpDir, "2024-01-01");
    createDailyFile(tmpDir, "2024-01-02");
    createDailyFile(tmpDir, "2024-01-03");
    createDailyFile(tmpDir, "2024-01-04");
    createDailyFile(tmpDir, "2024-01-05");
    createDailyFile(tmpDir, "2024-01-06");
    createDailyFile(tmpDir, "2024-01-07");

    const failingLlm = vi.fn(async () => {
      throw new Error("LLM timeout");
    });

    await runner.runPendingConsolidations({ llmCall: failingLlm });

    // Daily files should still exist (retained on failure)
    const dailyDir = join(tmpDir, "daily");
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remaining).toHaveLength(7);

    // No weekly file should have been created
    const weeklyDir = join(tmpDir, "weekly");
    expect(existsSync(weeklyDir)).toBe(false);
  });

  it("multiple weeks with different file counts — only weeks with 7+ trigger rollup", async () => {
    // ISO week 1 of 2024 (Mon Jan 1 - Sun Jan 7): 7 files → should trigger
    createDailyFile(tmpDir, "2024-01-01");
    createDailyFile(tmpDir, "2024-01-02");
    createDailyFile(tmpDir, "2024-01-03");
    createDailyFile(tmpDir, "2024-01-04");
    createDailyFile(tmpDir, "2024-01-05");
    createDailyFile(tmpDir, "2024-01-06");
    createDailyFile(tmpDir, "2024-01-07");

    // ISO week 2 of 2024 (Mon Jan 8 - Sun Jan 14): only 3 files → should NOT trigger
    createDailyFile(tmpDir, "2024-01-08");
    createDailyFile(tmpDir, "2024-01-09");
    createDailyFile(tmpDir, "2024-01-10");

    const mockLlm = vi.fn(async () => "Weekly consolidated summary for week 1.");

    await runner.runPendingConsolidations({ llmCall: mockLlm });

    // LLM should have been called exactly once (only for week 1)
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Week 1 daily files should be deleted, week 2 files remain
    const dailyDir = join(tmpDir, "daily");
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(["daily_20240108.md", "daily_20240109.md", "daily_20240110.md"]);

    // Weekly file should exist for week 1
    const weeklyDir = join(tmpDir, "weekly");
    expect(existsSync(weeklyDir)).toBe(true);
    const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(weeklyFiles).toHaveLength(1);
  });

  describe("groupDailyByWeek", () => {
    it("parses daily_YYYYMMDD.md filenames and groups by ISO week", () => {
      const files = [
        "/fake/memory/daily/daily_20240101.md",
        "/fake/memory/daily/daily_20240102.md",
        "/fake/memory/daily/daily_20240108.md",
      ];

      const grouped = runner.groupDailyByWeek(files);

      // 2024-01-01 and 2024-01-02 are in ISO week 1
      // 2024-01-08 is in ISO week 2
      expect(grouped.size).toBe(2);
      expect(grouped.get("2024-W01")).toHaveLength(2);
      expect(grouped.get("2024-W02")).toHaveLength(1);
    });

    it("ignores files that don't match the daily_YYYYMMDD.md pattern", () => {
      const files = [
        "/fake/memory/daily/daily_20240101.md",
        "/fake/memory/daily/random_file.md",
        "/fake/memory/daily/2024-01-02.md", // old format
      ];

      const grouped = runner.groupDailyByWeek(files);

      expect(grouped.size).toBe(1);
      expect(grouped.get("2024-W01")).toHaveLength(1);
    });
  });
});
