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

    // Verify the new-model durable columns exist (#1939: legacy table gone).
    const cols = db.prepare("PRAGMA table_info(long_term_memories)").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);
    for (const expected of ["content", "content_original", "classification", "revision", "semantic_revision", "provenance", "evidence"]) {
      expect(colNames).toContain(expected);
    }

    // Verify the recall projection tables and FTS indexes exist.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);
    expect(tableNames).toContain("long_term_memories");
    expect(tableNames).toContain("recall_documents");
    expect(tableNames).toContain("recall_fts");
    expect(tableNames).toContain("recall_trigram_en");
    expect(tableNames).toContain("recall_trigram_orig");
    expect(tableNames).not.toContain("extracted_memories");

    // Verify functional round-trip through the owned contract
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Boot test memory", contentOriginal: "boot",
      memoryType: "fact", emotionScore: 0,
    });
    const result = await h.recallOwned("recall_normal", "Boot test memory");
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.excerpt).toContain("Boot test memory");
    expect(result.status).toBe("evidence");
  });
});
