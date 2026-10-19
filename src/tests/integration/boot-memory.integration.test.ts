/**
 * Integration: boot phase — memory initialization + schema correctness.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";

describe("boot-memory integration", () => {
  let h: IntegrationHarness;

  afterEach(() => h?.cleanup());

  it("phaseMemory creates DB with full schema + functional store/recall", async () => {
    h = await createHarness();
    const db = memoryDb(h.memory);

    // Verify critical columns exist
    const cols = db.prepare("PRAGMA table_info(extracted_memories)").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    for (const expected of ["cited_count", "rejected_count", "recall_timestamps", "created_by", "emotion_tags", "topic", "tier"]) {
      expect(colNames).toContain(expected);
    }

    // Verify FTS indexes exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("extracted_memories_fts");
    expect(tableNames).toContain("content_en_trigram");
    expect(tableNames).toContain("content_original_trigram");

    // Verify functional round-trip through the owned contract
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Boot test memory", contentOriginal: "boot",
      memoryType: "fact", emotionScore: 0, emotionTags: "trust",
    });
    const result = await h.recallOwned("recall_normal", "Boot test memory");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.excerpt).toContain("Boot test memory");
    expect(result.status).toBe("evidence");
  });
});
