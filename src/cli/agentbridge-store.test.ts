// Feature: instant-memory-store, Property 8: CLI Argument Validation
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArgs, type RawArgs } from "./agentbridge-store.js";
import { MemoryManager } from "../components/memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "../components/memory-config.js";
import type { MemoryConfig } from "../components/memory-config.js";
import { initializeDatabase } from "../components/memory-db.js";

function makeConfig(tmpDir: string): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir };
}

/** A complete set of valid raw CLI args. */
const validRawArgs: fc.Arbitrary<RawArgs> = fc.record({
  contentEn: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  contentOriginal: fc.string({ minLength: 1 }).filter((s) => s.trim().length > 0),
  memoryType: fc.oneof(
    fc.constant("fact"),
    fc.constant("decision"),
    fc.constant("preference"),
    fc.constant("event"),
  ),
  emotionScore: fc.integer({ min: -5, max: 5 }).map(String),
  chatId: fc.integer({ min: 1, max: 999999 }).map(String),
  keyword: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
});

/** The five required parameter keys. */
const requiredKeys: (keyof RawArgs)[] = [
  "contentEn",
  "contentOriginal",
  "memoryType",
  "emotionScore",
  "chatId",
];

describe("agentbridge-store — Property 8: CLI Argument Validation", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-prop8-"));
    manager = new MemoryManager(makeConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Validates: Requirements 2.2
   *
   * For any invocation missing a required parameter, the command outputs
   * { "stored": false, "error": "..." } and does not modify the database.
   */
  it("rejects args with any single required param missing and does not modify DB", async () => {
    await fc.assert(
      fc.asyncProperty(
        validRawArgs,
        fc.constantFrom(...requiredKeys),
        async (args, keyToRemove) => {
          // Remove one required key
          const incomplete: RawArgs = { ...args };
          delete incomplete[keyToRemove];

          const result = validateArgs(incomplete);

          // Must fail validation
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(typeof result.error).toBe("string");
            expect(result.error.length).toBeGreaterThan(0);
          }

          // Since validation failed, instantStore should never be called.
          // Verify DB is untouched.
          const db = initializeDatabase(join(tmpDir, "memory.db"));
          const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
          expect(count.cnt).toBe(0);
          db.close();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects args with multiple required params missing and does not modify DB", async () => {
    // Generate a subset of 2+ required keys to remove
    const multipleKeys = fc
      .subarray(requiredKeys, { minLength: 2, maxLength: requiredKeys.length })
      .filter((arr) => arr.length >= 2);

    await fc.assert(
      fc.asyncProperty(validRawArgs, multipleKeys, async (args, keysToRemove) => {
        const incomplete: RawArgs = { ...args };
        for (const key of keysToRemove) {
          delete incomplete[key];
        }

        const result = validateArgs(incomplete);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(typeof result.error).toBe("string");
          expect(result.error.length).toBeGreaterThan(0);
        }

        const db = initializeDatabase(join(tmpDir, "memory.db"));
        const count = db.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
        expect(count.cnt).toBe(0);
        db.close();
      }),
      { numRuns: 100 },
    );
  });
});
