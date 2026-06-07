/**
 * Integration: recall quality feedback — #824.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHarness, detectCitations, type IntegrationHarness } from "./harness.js";

describe("recall quality integration (#824)", () => {
  let h: IntegrationHarness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => h.cleanup());

  it("emoji rejection → rejected_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Hermes is a figure from Greek mythology",
      contentOriginal: "hermes", memoryType: "fact", emotionScore: 0, topic: "mythology",
    });

    const result = await h.memory.recallSearch({ translated: ["hermes"], userId: "u1" });
    const ids = result.results.filter(r => r.id != null).map(r => r.id!);
    expect(ids.length).toBeGreaterThan(0);

    // Simulate negative emoji reaction
    h.memory.bumpRejectedCount(ids);

    const db = h.memory.getDatabase()!;
    const row = db.prepare("SELECT rejected_count FROM extracted_memories WHERE id = ?").get(ids[0]!) as { rejected_count: number };
    expect(row.rejected_count).toBe(1);
  });

  it("positive emoji → cited_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "User works at Acme Corp as a senior engineer",
      contentOriginal: "acme", memoryType: "fact", emotionScore: 0, topic: "work",
    });

    const result = await h.memory.recallSearch({ translated: ["Acme", "engineer"], userId: "u1" });
    const ids = result.results.filter(r => r.id != null).map(r => r.id!);

    h.memory.bumpCitedCount(ids);

    const db = h.memory.getDatabase()!;
    const row = db.prepare("SELECT cited_count FROM extracted_memories WHERE id = ?").get(ids[0]!) as { cited_count: number };
    expect(row.cited_count).toBe(1);
  });

  it("quality scoring: high-cited ranks above high-rejected", async () => {
    // Store two memories with same topic
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Project Alpha uses React with TypeScript for the frontend",
      contentOriginal: "alpha react", memoryType: "fact", emotionScore: 0, topic: "projects",
    });
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Project Alpha originally used Vue but migrated to React",
      contentOriginal: "alpha vue", memoryType: "fact", emotionScore: 0, topic: "projects",
    });

    const db = h.memory.getDatabase()!;
    const rows = db.prepare("SELECT id FROM extracted_memories ORDER BY id").all() as Array<{ id: number }>;
    const [goodId, badId] = [rows[0]!.id, rows[1]!.id];

    // Simulate history: good memory cited 5 times, bad memory rejected 3 times
    for (let i = 0; i < 5; i++) h.memory.bumpCitedCount([goodId]);
    for (let i = 0; i < 3; i++) h.memory.bumpRejectedCount([badId]);
    // Both need recall_count for the formula to kick in
    for (let i = 0; i < 5; i++) h.memory.bumpRecallCount([goodId, badId]);

    const result = await h.memory.recallSearch({ translated: ["Project", "Alpha", "React"], userId: "u1" });
    expect(result.results.length).toBe(2);
    // Good memory should rank higher
    const goodIdx = result.results.findIndex(r => r.id === goodId);
    const badIdx = result.results.findIndex(r => r.id === badId);
    expect(goodIdx).toBeLessThan(badIdx);
  });

  it("no citation detected for unrelated response", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "The database migration completed successfully last Tuesday",
      contentOriginal: "migration", memoryType: "event", emotionScore: 0, topic: "devops",
    });

    const result = await h.memory.recallSearch({ translated: ["database", "migration"], userId: "u1" });
    const hits = result.results.filter(r => r.id != null).map(r => ({ id: r.id!, contentEn: r.content }));

    // Response talks about something completely different
    const response = "Sure, I can help you write a React component for the login form.";
    const cited = detectCitations(response, hits);
    expect(cited).toEqual([]);
  });
});
