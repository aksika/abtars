// Feature: instant-memory-store, Property 2: Instant Store Persists Valid Memories
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MemoryConfig } from "./memory-config.js";
import type { InstantStoreParams } from "../types/index.js";
import { initializeDatabase } from "./memory-db.js";

function makeConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    ...MEMORY_CONFIG_DEFAULTS,
    memoryDir: tmpDir,
    ...overrides,
  };
}

const validMemoryType = fc.oneof(
  fc.constant("fact" as const),
  fc.constant("decision" as const),
  fc.constant("preference" as const),
  fc.constant("event" as const),
);

/** Generate a non-empty string (at least 1 printable char). */
const nonEmptyString = fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0);

const validInstantStoreParams: fc.Arbitrary<InstantStoreParams> = fc.record({
  chatId: fc.integer({ min: 1, max: 999999 }),
  contentEn: nonEmptyString,
  contentOriginal: nonEmptyString,
  memoryType: validMemoryType,
  emotionScore: fc.integer({ min: -5, max: 5 }),
  keyword: fc.option(nonEmptyString, { nil: undefined }),
});

describe("instantStore — Property 2: Instant Store Persists Valid Memories", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop2-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 3.1, 3.2, 3.3, 3.4
   *
   * For any valid InstantStoreParams, instantStore() inserts exactly one row
   * with preserve_original = true and all fields matching input.
   */
  it("persists exactly one row with correct fields for any valid params", async () => {
    await fc.assert(
      fc.asyncProperty(validInstantStoreParams, async (params) => {
        // Re-create DB for each iteration to ensure isolation
        const iterDir = mkdtempSync(join(tmpdir(), "is-p2-iter-"));
        const iterManager = new MemoryManager(makeConfig(iterDir));
        await iterManager.initialize();

        try {
          const result = await iterManager.instantStore(params);

          expect(result.stored).toBe(true);
          expect(result.memoriesCount).toBe(1);
          expect(result.error).toBeUndefined();

          // Verify the row in the database
          const db = initializeDatabase(join(iterDir, "memory.db"));
          const row = db
            .prepare("SELECT * FROM extracted_memories WHERE chat_id = ?")
            .get(params.chatId) as Record<string, unknown>;

          expect(row).toBeDefined();
          expect(row.content_en).toBe(params.contentEn.trim());
          expect(row.content_original).toBe(params.contentOriginal.trim());
          expect(row.memory_type).toBe(params.memoryType);
          expect(row.preserve_original).toBe(1); // true stored as 1
          expect(row.emotion_score).toBe(params.emotionScore);

          if (params.keyword) {
            expect(row.preserved_keyword).toBe(params.keyword.trim());
          } else {
            expect(row.preserved_keyword).toBeNull();
          }

          db.close();
        } finally {
          iterManager.close();
          rmSync(iterDir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("instantStore — Property 3: Instant Store Rejects Invalid Inputs", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop3-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 2.2, 3.1
   *
   * For any params with empty contentEn or empty contentOriginal,
   * returns { stored: false } and no DB row inserted.
   */
  it("rejects params with empty contentEn and inserts no row", async () => {
    const paramsWithEmptyContentEn = fc.record({
      chatId: fc.integer({ min: 1, max: 999999 }),
      contentEn: fc.constant(""),
      contentOriginal: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithEmptyContentEn, async (params) => {
        const result = await manager.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects params with empty contentOriginal and inserts no row", async () => {
    const paramsWithEmptyContentOriginal = fc.record({
      chatId: fc.integer({ min: 1, max: 999999 }),
      contentEn: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
      contentOriginal: fc.constant(""),
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithEmptyContentOriginal, async (params) => {
        const result = await manager.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 100 },
    );
  });

  it("rejects params with whitespace-only content and inserts no row", async () => {
    const whitespaceOnly = fc.stringOf(fc.constant(" "), { minLength: 1 });

    const paramsWithWhitespaceContent = fc.record({
      chatId: fc.integer({ min: 1, max: 999999 }),
      contentEn: whitespaceOnly,
      contentOriginal: whitespaceOnly,
      memoryType: validMemoryType,
      emotionScore: fc.integer({ min: -5, max: 5 }),
      keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
    });

    await fc.assert(
      fc.asyncProperty(paramsWithWhitespaceContent, async (params) => {
        const result = await manager.instantStore(params);

        expect(result.stored).toBe(false);
        expect(result.memoriesCount).toBe(0);

        // Verify no row was inserted
        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 100 },
    );
  });
});

import { MemoryExtractor } from "./memory-extractor.js";

describe("instantStore — Property 4: Watermark Advance Prevents Heartbeat Re-Extraction", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "is-prop4-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 4.1, 4.2
   *
   * For any chat where instantStore() succeeds, a subsequent processTranscripts()
   * does not re-extract messages up to that timestamp.
   */
  it("after instantStore succeeds, processTranscripts skips messages at or before the watermark", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 999999 }),
        fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
        async (chatId, content) => {
          const iterDir = mkdtempSync(join(tmpdir(), "is-p4-iter-"));
          const iterManager = new MemoryManager(makeConfig(iterDir));
          await iterManager.initialize();

          try {
            const db = initializeDatabase(join(iterDir, "memory.db"));

            // Insert messages with timestamps in the past (before Date.now())
            const pastTimestamp = Date.now() - 60_000;
            db.prepare(
              "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
            ).run(chatId, "sess-test", "user", content, pastTimestamp);

            // Call instantStore — this advances watermark to Date.now()
            const result = await iterManager.instantStore({
              chatId,
              contentEn: "Test memory",
              contentOriginal: "Test memory",
              memoryType: "fact",
              emotionScore: 0,
            });

            expect(result.stored).toBe(true);

            // Verify watermark was advanced past the message timestamp
            const watermarkRow = db
              .prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE chat_id = ?")
              .get(chatId) as { last_processed_timestamp: number } | undefined;

            expect(watermarkRow).toBeDefined();
            expect(watermarkRow!.last_processed_timestamp).toBeGreaterThanOrEqual(pastTimestamp);

            // Create a MemoryExtractor with a mock LLM that should NOT be called
            let llmCalled = false;
            const extractor = new MemoryExtractor(db, async () => {
              llmCalled = true;
              return "[]";
            });

            // processTranscripts should find no unprocessed messages
            const extracted = await extractor.processTranscripts(chatId);
            expect(extracted).toHaveLength(0);
            expect(llmCalled).toBe(false);

            db.close();
          } finally {
            iterManager.close();
            rmSync(iterDir, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
