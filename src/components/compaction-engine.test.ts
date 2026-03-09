import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { TranscriptParser } from "./transcript-parser.js";
import { TranscriptWriter } from "./transcript-writer.js";
import { CompactionEngine } from "./compaction-engine.js";
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

/** Create a transcript file with some messages so compact() has content to read. */
function seedTranscript(baseDir: string, chatId: number, sessionId: string, messages: string[]): void {
  const writer = new TranscriptWriter(baseDir);
  for (let i = 0; i < messages.length; i++) {
    writer.append({
      role: "user",
      content: messages[i]!,
      timestamp: Date.now() + i,
      chatId,
      sessionId,
    });
  }
}

describe("CompactionEngine", () => {
  let tmpDir: string;
  let db: Database.Database;
  let memoryIndex: MemoryIndex;
  let transcriptParser: TranscriptParser;
  let engine: CompactionEngine;
  let config: MemoryConfig;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-test-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
    memoryIndex = new MemoryIndex(db);
    transcriptParser = new TranscriptParser();
    config = makeConfig(tmpDir);
    engine = new CompactionEngine(db, transcriptParser, memoryIndex, config);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compact() stores summary in DB and writes daily .md file", async () => {
    const chatId = 42;
    const sessionId = "sess-abc";
    seedTranscript(tmpDir, chatId, sessionId, ["Hello there", "How are you?"]);

    const mockLlm = async (_prompt: string, _content: string) => "User greeted the assistant.";

    const result = await engine.compact({ chatId, sessionId, llmCall: mockLlm });

    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(chatId);
    expect(result!.sourceSessionId).toBe(sessionId);
    expect(result!.tier).toBe("daily");
    expect(result!.summary).toBe("User greeted the assistant.");
    expect(result!.id).toBeGreaterThan(0);

    // Verify file on disk
    expect(existsSync(result!.filePath)).toBe(true);
    const fileContent = readFileSync(result!.filePath, "utf-8");
    expect(fileContent).toBe("User greeted the assistant.");

    // Verify DB row
    const rows = engine.getCompactions(chatId, { tier: "daily" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("User greeted the assistant.");
  });

  it("compact() indexes compaction in FTS (searchable)", async () => {
    const chatId = 55;
    const sessionId = "sess-fts";
    seedTranscript(tmpDir, chatId, sessionId, ["Tell me about quantum physics"]);

    const mockLlm = async () => "Discussed quantum entanglement and superposition phenomena.";

    await engine.compact({ chatId, sessionId, llmCall: mockLlm });

    // Search for a distinctive word from the compaction summary
    const results = memoryIndex.search("entanglement", { chatId });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.role).toBe("compaction");
    expect(results[0]!.record.content).toContain("entanglement");
  });

  it("getCompactions() returns empty for chat with no compactions", () => {
    const results = engine.getCompactions(999);
    expect(results).toEqual([]);
  });

  it("multiple compactions on same day append to existing daily file", async () => {
    const chatId = 77;
    const sessionId1 = "sess-1";
    const sessionId2 = "sess-2";
    seedTranscript(tmpDir, chatId, sessionId1, ["First conversation"]);
    seedTranscript(tmpDir, chatId, sessionId2, ["Second conversation"]);

    const mockLlm1 = async () => "Summary of first conversation.";
    const mockLlm2 = async () => "Summary of second conversation.";

    const result1 = await engine.compact({ chatId, sessionId: sessionId1, llmCall: mockLlm1 });
    const result2 = await engine.compact({ chatId, sessionId: sessionId2, llmCall: mockLlm2 });

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();

    // Both should point to the same daily file (same date)
    expect(result1!.filePath).toBe(result2!.filePath);

    // File should contain both summaries separated by ---
    const fileContent = readFileSync(result1!.filePath, "utf-8");
    expect(fileContent).toContain("Summary of first conversation.");
    expect(fileContent).toContain("Summary of second conversation.");
    expect(fileContent).toContain("---");

    // DB should have 2 rows
    const rows = engine.getCompactions(chatId);
    expect(rows).toHaveLength(2);
  });

  it("LLM failure returns null without throwing", async () => {
    const chatId = 88;
    const sessionId = "sess-fail";
    seedTranscript(tmpDir, chatId, sessionId, ["Some message"]);

    const failingLlm = async () => {
      throw new Error("LLM timeout");
    };

    const result = await engine.compact({ chatId, sessionId, llmCall: failingLlm });
    expect(result).toBeNull();

    // No compactions should be stored
    const rows = engine.getCompactions(chatId);
    expect(rows).toHaveLength(0);
  });

  it("consolidate() writes target file and deletes source files", async () => {
    const chatId = 33;

    // Create source daily files
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    mkdirSync(dailyDir, { recursive: true });
    const sourceFiles = [
      join(dailyDir, "2024-01-01.md"),
      join(dailyDir, "2024-01-02.md"),
      join(dailyDir, "2024-01-03.md"),
    ];
    writeFileSync(sourceFiles[0]!, "Day 1 summary");
    writeFileSync(sourceFiles[1]!, "Day 2 summary");
    writeFileSync(sourceFiles[2]!, "Day 3 summary");

    const mockLlm = async () => "Weekly consolidated summary of the week.";

    const result = await engine.consolidate({
      chatId,
      sourceTier: "daily",
      targetTier: "weekly",
      sourceFiles,
      llmCall: mockLlm,
    });

    expect(result).not.toBeNull();
    expect(result!.chatId).toBe(chatId);
    expect(result!.tier).toBe("weekly");
    expect(result!.summary).toBe("Weekly consolidated summary of the week.");
    expect(result!.sourceSessionId).toBe("consolidation");

    // Target file should exist
    expect(existsSync(result!.filePath)).toBe(true);
    const targetContent = readFileSync(result!.filePath, "utf-8");
    expect(targetContent).toBe("Weekly consolidated summary of the week.");

    // Source files should be deleted
    for (const f of sourceFiles) {
      expect(existsSync(f)).toBe(false);
    }

    // DB row should exist
    const rows = engine.getCompactions(chatId, { tier: "weekly" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe("Weekly consolidated summary of the week.");
  });

  it("consolidate() indexes result in FTS", async () => {
    const chatId = 44;
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    mkdirSync(dailyDir, { recursive: true });
    const sourceFiles = [join(dailyDir, "2024-02-01.md")];
    writeFileSync(sourceFiles[0]!, "Some daily content");

    const mockLlm = async () => "Consolidated photosynthesis research findings.";

    await engine.consolidate({
      chatId,
      sourceTier: "daily",
      targetTier: "weekly",
      sourceFiles,
      llmCall: mockLlm,
    });

    const results = memoryIndex.search("photosynthesis", { chatId });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.role).toBe("compaction");
  });

  it("getCompactions() filters by tier", async () => {
    const chatId = 66;
    const sessionId = "sess-tier";
    seedTranscript(tmpDir, chatId, sessionId, ["Message for tier test"]);

    // Create a daily compaction
    const mockLlm = async () => "Daily tier summary.";
    await engine.compact({ chatId, sessionId, llmCall: mockLlm });

    // Create a weekly consolidation
    const dailyDir = join(tmpDir, "memory", "daily", String(chatId));
    mkdirSync(dailyDir, { recursive: true });
    const sourceFile = join(dailyDir, "2024-03-01.md");
    writeFileSync(sourceFile, "Source content");

    const weeklyLlm = async () => "Weekly tier summary.";
    await engine.consolidate({
      chatId,
      sourceTier: "daily",
      targetTier: "weekly",
      sourceFiles: [sourceFile],
      llmCall: weeklyLlm,
    });

    // All compactions
    const all = engine.getCompactions(chatId);
    expect(all).toHaveLength(2);

    // Filter by daily
    const daily = engine.getCompactions(chatId, { tier: "daily" });
    expect(daily).toHaveLength(1);
    expect(daily[0]!.tier).toBe("daily");

    // Filter by weekly
    const weekly = engine.getCompactions(chatId, { tier: "weekly" });
    expect(weekly).toHaveLength(1);
    expect(weekly[0]!.tier).toBe("weekly");

    // Filter by monthly (none)
    const monthly = engine.getCompactions(chatId, { tier: "monthly" });
    expect(monthly).toHaveLength(0);
  });

  it("compact() returns null for empty transcript", async () => {
    const chatId = 11;
    const sessionId = "sess-empty";
    // Don't seed any transcript — file doesn't exist

    const mockLlm = async () => "Should not be called";

    const result = await engine.compact({ chatId, sessionId, llmCall: mockLlm });
    expect(result).toBeNull();
  });
});


// Feature: auto-daily-compaction, Property 3: Compaction File Named by Message Date
describe("CompactionEngine — Property 3: Compaction File Named by Message Date", () => {
  let tmpDir: string;
  let db: Database.Database;
  let memoryIndex: MemoryIndex;
  let transcriptParser: TranscriptParser;
  let engine: CompactionEngine;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ce-prop3-"));
    db = initializeDatabase(join(tmpDir, "test.db"));
    memoryIndex = new MemoryIndex(db);
    transcriptParser = new TranscriptParser();
    const config = makeConfig(tmpDir);
    engine = new CompactionEngine(db, transcriptParser, memoryIndex, config);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("file path contains the compactionDate (YYYY-MM-DD), not today's date", async () => {
    /**
     * **Validates: Requirements 3.1, 3.2, 3.3**
     *
     * For any session with messages, when compact() is called with a
     * compactionDate derived from the earliest message timestamp, the
     * resulting file path should contain a date string matching the
     * calendar date of that earliest message (YYYY-MM-DD), not the
     * current execution date.
     */

    // Generate dates that are NOT today, to distinguish message date from current date
    const pastDateArb = fc
      .date({
        min: new Date("2020-01-01T00:00:00Z"),
        max: new Date("2024-12-31T00:00:00Z"),
      })
      .filter((d) => d.toISOString().slice(0, 10) !== new Date().toISOString().slice(0, 10));

    const chatIdArb = fc.integer({ min: 1, max: 99999 });

    // Use a run counter to generate unique session IDs across iterations
    let runIndex = 0;

    await fc.assert(
      fc.asyncProperty(pastDateArb, chatIdArb, async (compactionDate, chatId) => {
        const sessionId = `sess-prop3-${runIndex++}`;

        // Seed a transcript so compact() has content to process
        seedTranscript(tmpDir, chatId, sessionId, ["Test message for property 3"]);

        const mockLlm = async () => "Property 3 summary.";

        const result = await engine.compact({
          chatId,
          sessionId,
          llmCall: mockLlm,
          compactionDate,
        });

        expect(result).not.toBeNull();

        const expectedDateStr = compactionDate.toISOString().slice(0, 10);

        // File path must land in working/{YYYY-MM-DD}/transcript_{chatId}.md
        expect(result!.filePath).toContain(join("working", expectedDateStr));
        expect(result!.filePath).toContain(`transcript_${chatId}.md`);

        // Verify the file actually exists at that path
        expect(existsSync(result!.filePath)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
