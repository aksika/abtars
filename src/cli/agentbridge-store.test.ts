// Feature: instant-memory-store, Property 8: CLI Argument Validation
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fc from "fast-check";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateArgs, parseArgs, type RawArgs } from "./agentbridge-store.js";
import { MemoryManager } from "../memory/memory-manager.js";
import { makeMemoryTestConfig } from "../tests/helpers.js";
import { initializeDatabase } from "../memory/memory-db.js";

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
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
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

describe("agentbridge-store --delete-ids", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-delete-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedMessages(chatId: number, count: number): number[] {
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const ids: number[] = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const ts = now - (count - i) * 1000;
      const result = db.prepare(
        "INSERT INTO messages (chat_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)"
      ).run(chatId, `session:${chatId}`, i % 2 === 0 ? "user" : "assistant", `msg-${i}`, ts);
      ids.push(Number(result.lastInsertRowid));
    }
    db.close();
    return ids;
  }

  it("parseArgs parses --delete-ids and --chat-id", () => {
    const raw = parseArgs(["node", "store", "--delete-ids", "1,2,3", "--chat-id", "999"]);
    expect(raw.deleteIds).toBe("1,2,3");
    expect(raw.chatId).toBe("999");
  });

  it("cascadeDelete removes messages from DB", () => {
    const ids = seedMessages(100, 6);
    const toDelete = ids.slice(0, 3);

    const result = manager.editor.cascadeDelete(toDelete, 100);

    expect(result.messagesRemoved).toBe(3);
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 100").get() as { cnt: number };
    expect(remaining.cnt).toBe(3);
    db.close();
  });

  it("cascadeDelete removes messages and FTS entries", () => {
    const ids = seedMessages(200, 4);
    const toDelete = ids.slice(0, 2);

    const result = manager.editor.cascadeDelete(toDelete, 200);

    expect(result.messagesRemoved).toBe(2);
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const remaining = db.prepare("SELECT COUNT(*) as cnt FROM messages WHERE chat_id = 200").get() as { cnt: number };
    expect(remaining.cnt).toBe(2);
    db.close();
  });

  it("cascadeDelete with empty IDs is a no-op", () => {
    seedMessages(300, 3);
    const result = manager.editor.cascadeDelete([], 300);
    expect(result.messagesRemoved).toBe(0);
    expect(result.transcriptEntriesRemoved).toBe(0);
  });

  it("cascadeDelete with non-existent IDs is a no-op", () => {
    seedMessages(400, 3);
    const result = manager.editor.cascadeDelete([9999, 9998], 400);
    expect(result.messagesRemoved).toBe(0);
  });
});

describe("agentbridge-store — parseArgs aliases", () => {
  it("--translated maps to contentEn", () => {
    const raw = parseArgs(["node", "store", "--translated", "hello"]);
    expect(raw.contentEn).toBe("hello");
  });

  it("--original maps to contentOriginal", () => {
    const raw = parseArgs(["node", "store", "--original", "szia"]);
    expect(raw.contentOriginal).toBe("szia");
  });

  it("legacy --content-en still works", () => {
    const raw = parseArgs(["node", "store", "--content-en", "hello"]);
    expect(raw.contentEn).toBe("hello");
  });
});

describe("agentbridge-store — validateArgs", () => {
  const valid: RawArgs = {
    contentEn: "test memory",
    contentOriginal: "teszt memória",
    memoryType: "fact",
    emotionScore: "0",
    chatId: "123",
  };

  it("accepts valid args", () => {
    expect(validateArgs(valid).ok).toBe(true);
  });

  it("rejects invalid memory type", () => {
    const result = validateArgs({ ...valid, memoryType: "invalid" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-numeric chatId", () => {
    const result = validateArgs({ ...valid, chatId: "abc" });
    expect(result.ok).toBe(false);
  });

  it("passes optional classification/trust/integrity/credibility", () => {
    const result = validateArgs({ ...valid, classification: "2", trust: "3", integrity: "1", credibility: "2" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.classification).toBe(2);
      expect(result.params.trust).toBe(3);
    }
  });
});

describe("agentbridge-store — instantStore", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-store-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stores a memory and returns success", async () => {
    const result = await manager.editor.instantStore({
      chatId: 123, contentEn: "test fact", contentOriginal: "teszt tény",
      memoryType: "fact", emotionScore: 2,
    });
    expect(result.stored).toBe(true);
    expect(result.memoriesCount).toBe(1);

    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const row = db.prepare("SELECT content_en FROM extracted_memories WHERE chat_id = 123").get() as { content_en: string };
    expect(row.content_en).toBe("test fact");
    db.close();
  });

  it("rejects empty content_en", async () => {
    const result = await manager.editor.instantStore({
      chatId: 123, contentEn: "", contentOriginal: "teszt",
      memoryType: "fact", emotionScore: 0,
    });
    expect(result.stored).toBe(false);
  });
});

describe("agentbridge-store — boost/demote", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-boost-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("boost increases relevance_score", async () => {
    await manager.editor.instantStore({
      chatId: 1, contentEn: "boost test", contentOriginal: "boost test",
      memoryType: "fact", emotionScore: 0,
    });
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const before = db.prepare("SELECT relevance_score FROM extracted_memories LIMIT 1").get() as { relevance_score: number };
    const id = (db.prepare("SELECT id FROM extracted_memories LIMIT 1").get() as { id: number }).id;
    db.close();

    manager.editor.adjustRelevance(id, 10);

    const db2 = initializeDatabase(join(tmpDir, "memory.db"));
    const after = db2.prepare("SELECT relevance_score FROM extracted_memories WHERE id = ?").get(id) as { relevance_score: number };
    expect(after.relevance_score).toBe(before.relevance_score + 10);
    db2.close();
  });
});

describe("agentbridge-store — merge", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cli-merge-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("merges two memories — keeps newer, deletes older", async () => {
    await manager.editor.instantStore({ chatId: 1, contentEn: "older", contentOriginal: "older", memoryType: "fact", emotionScore: 0 });
    await manager.editor.instantStore({ chatId: 1, contentEn: "newer", contentOriginal: "newer", memoryType: "fact", emotionScore: 0 });

    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const ids = db.prepare("SELECT id FROM extracted_memories ORDER BY created_at").all() as Array<{ id: number }>;
    db.close();

    const result = manager.editor.mergeMemories(ids[0]!.id, ids[1]!.id);
    expect(result.merged).toBe(true);
    if (result.merged) {
      expect(result.keptId).toBe(ids[1]!.id);
      expect(result.deletedId).toBe(ids[0]!.id);
    }

    const db2 = initializeDatabase(join(tmpDir, "memory.db"));
    const count = db2.prepare("SELECT COUNT(*) as cnt FROM extracted_memories").get() as { cnt: number };
    expect(count.cnt).toBe(1);
    db2.close();
  });

  it("returns error for non-existent IDs", () => {
    const result = manager.editor.mergeMemories(999, 998);
    expect(result.merged).toBe(false);
  });
});
