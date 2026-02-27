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

/** Create a daily .md file with some content. */
function createDailyFile(baseDir: string, chatId: number, dateStr: string, content?: string): string {
  const dir = join(baseDir, "memory", "daily", String(chatId));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${dateStr}.md`);
  writeFileSync(filePath, content ?? `Summary for ${dateStr}`);
  return filePath;
}

/** Create a weekly .md file with some content. */
function createWeeklyFile(baseDir: string, chatId: number, weekStr: string, content?: string): string {
  const dir = join(baseDir, "memory", "weekly", String(chatId));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${weekStr}.md`);
  writeFileSync(filePath, content ?? `Weekly summary for ${weekStr}`);
  return filePath;
}

/** Create a monthly .md file with some content. */
function createMonthlyFile(baseDir: string, chatId: number, monthStr: string, content?: string): string {
  const dir = join(baseDir, "memory", "monthly", String(chatId));
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${monthStr}.md`);
  writeFileSync(filePath, content ?? `Monthly summary for ${monthStr}`);
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
    const chatId = 1;
    // Create 5 daily files in the same ISO week (Mon 2024-01-01 to Fri 2024-01-05)
    createDailyFile(tmpDir, chatId, "2024-01-01");
    createDailyFile(tmpDir, chatId, "2024-01-02");
    createDailyFile(tmpDir, chatId, "2024-01-03");
    createDailyFile(tmpDir, chatId, "2024-01-04");
    createDailyFile(tmpDir, chatId, "2024-01-05");

    const mockLlm = vi.fn(async () => "Should not be called");

    await runner.runPendingConsolidations({ chatId, llmCall: mockLlm });

    // LLM should not have been called
    expect(mockLlm).not.toHaveBeenCalled();

    // Daily files should still exist
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remaining).toHaveLength(5);
  });

  it("weekly rollup triggered with 7+ daily files in same ISO week", async () => {
    const chatId = 2;
    // ISO week 1 of 2024: Mon 2024-01-01 through Sun 2024-01-07
    createDailyFile(tmpDir, chatId, "2024-01-01");
    createDailyFile(tmpDir, chatId, "2024-01-02");
    createDailyFile(tmpDir, chatId, "2024-01-03");
    createDailyFile(tmpDir, chatId, "2024-01-04");
    createDailyFile(tmpDir, chatId, "2024-01-05");
    createDailyFile(tmpDir, chatId, "2024-01-06");
    createDailyFile(tmpDir, chatId, "2024-01-07");

    const mockLlm = vi.fn(async () => "Weekly consolidated summary.");

    await runner.runPendingConsolidations({ chatId, llmCall: mockLlm });

    // LLM should have been called once for the weekly rollup
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Daily files should be deleted
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    const remainingDaily = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remainingDaily).toHaveLength(0);

    // Weekly file should exist
    const weeklyDir = join(tmpDir, "memory", "weekly", String(chatId));
    expect(existsSync(weeklyDir)).toBe(true);
    const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(weeklyFiles).toHaveLength(1);
  });

  it("monthly rollup triggered with 4+ weekly files in same month", async () => {
    const chatId = 3;
    // Create 4 weekly files all falling in January 2024
    // W01 (Jan 1-7), W02 (Jan 8-14), W03 (Jan 15-21), W04 (Jan 22-28)
    createWeeklyFile(tmpDir, chatId, "2024-W01");
    createWeeklyFile(tmpDir, chatId, "2024-W02");
    createWeeklyFile(tmpDir, chatId, "2024-W03");
    createWeeklyFile(tmpDir, chatId, "2024-W04");

    const mockLlm = vi.fn(async () => "Monthly consolidated summary.");

    await runner.runPendingConsolidations({ chatId, llmCall: mockLlm });

    // LLM should have been called once for the monthly rollup
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Weekly files should be deleted
    const weeklyDir = join(tmpDir, "memory", "weekly", String(chatId));
    const remainingWeekly = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(remainingWeekly).toHaveLength(0);

    // Monthly file should exist
    const monthlyDir = join(tmpDir, "memory", "monthly", String(chatId));
    expect(existsSync(monthlyDir)).toBe(true);
    const monthlyFiles = readdirSync(monthlyDir).filter((f) => f.endsWith(".md"));
    expect(monthlyFiles).toHaveLength(1);
  });

  it("yearly rollup triggered with 12+ monthly files in same year", async () => {
    const chatId = 4;
    // Create 12 monthly files for 2024
    for (let m = 1; m <= 12; m++) {
      createMonthlyFile(tmpDir, chatId, `2024-${String(m).padStart(2, "0")}`);
    }

    const mockLlm = vi.fn(async () => "Yearly consolidated summary.");

    await runner.runPendingConsolidations({ chatId, llmCall: mockLlm });

    // LLM should have been called once for the yearly rollup
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Monthly files should be deleted
    const monthlyDir = join(tmpDir, "memory", "monthly", String(chatId));
    const remainingMonthly = readdirSync(monthlyDir).filter((f) => f.endsWith(".md"));
    expect(remainingMonthly).toHaveLength(0);

    // Yearly file should exist
    const yearlyDir = join(tmpDir, "memory", "yearly", String(chatId));
    expect(existsSync(yearlyDir)).toBe(true);
    const yearlyFiles = readdirSync(yearlyDir).filter((f) => f.endsWith(".md"));
    expect(yearlyFiles).toHaveLength(1);
  });

  it("failed consolidation retains source files unchanged", async () => {
    const chatId = 5;
    // Create 7 daily files in the same ISO week
    createDailyFile(tmpDir, chatId, "2024-01-01");
    createDailyFile(tmpDir, chatId, "2024-01-02");
    createDailyFile(tmpDir, chatId, "2024-01-03");
    createDailyFile(tmpDir, chatId, "2024-01-04");
    createDailyFile(tmpDir, chatId, "2024-01-05");
    createDailyFile(tmpDir, chatId, "2024-01-06");
    createDailyFile(tmpDir, chatId, "2024-01-07");

    const failingLlm = vi.fn(async () => {
      throw new Error("LLM timeout");
    });

    await runner.runPendingConsolidations({ chatId, llmCall: failingLlm });

    // Daily files should still exist (retained on failure)
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md"));
    expect(remaining).toHaveLength(7);

    // No weekly file should have been created
    const weeklyDir = join(tmpDir, "memory", "weekly", String(chatId));
    expect(existsSync(weeklyDir)).toBe(false);
  });

  it("multiple weeks with different file counts — only weeks with 7+ trigger rollup", async () => {
    const chatId = 6;
    // ISO week 1 of 2024 (Mon Jan 1 - Sun Jan 7): 7 files → should trigger
    createDailyFile(tmpDir, chatId, "2024-01-01");
    createDailyFile(tmpDir, chatId, "2024-01-02");
    createDailyFile(tmpDir, chatId, "2024-01-03");
    createDailyFile(tmpDir, chatId, "2024-01-04");
    createDailyFile(tmpDir, chatId, "2024-01-05");
    createDailyFile(tmpDir, chatId, "2024-01-06");
    createDailyFile(tmpDir, chatId, "2024-01-07");

    // ISO week 2 of 2024 (Mon Jan 8 - Sun Jan 14): only 3 files → should NOT trigger
    createDailyFile(tmpDir, chatId, "2024-01-08");
    createDailyFile(tmpDir, chatId, "2024-01-09");
    createDailyFile(tmpDir, chatId, "2024-01-10");

    const mockLlm = vi.fn(async () => "Weekly consolidated summary for week 1.");

    await runner.runPendingConsolidations({ chatId, llmCall: mockLlm });

    // LLM should have been called exactly once (only for week 1)
    expect(mockLlm).toHaveBeenCalledTimes(1);

    // Week 1 daily files should be deleted
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    const remaining = readdirSync(dailyDir).filter((f) => f.endsWith(".md")).sort();
    // Only week 2 files should remain
    expect(remaining).toHaveLength(3);
    expect(remaining).toEqual(["2024-01-08.md", "2024-01-09.md", "2024-01-10.md"]);

    // Weekly file should exist for week 1
    const weeklyDir = join(tmpDir, "memory", "weekly", String(chatId));
    expect(existsSync(weeklyDir)).toBe(true);
    const weeklyFiles = readdirSync(weeklyDir).filter((f) => f.endsWith(".md"));
    expect(weeklyFiles).toHaveLength(1);
  });
});
