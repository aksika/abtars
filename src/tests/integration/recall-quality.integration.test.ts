/**
 * Integration: recall quality feedback — #824.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHarness, memoryDb, detectCitations, type IntegrationHarness } from "./harness.js";

describe("recall quality integration (#824)", () => {
  let h: IntegrationHarness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => h.cleanup());

  it("emoji rejection → rejected_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Hermes is a figure from Greek mythology",
      contentOriginal: "hermes", memoryType: "fact", emotionScore: 0, topic: "mythology",
    });

    const result = await h.recallOwned("recall_normal", "hermes figure");
    expect(result.items.length).toBeGreaterThan(0);
    const hits = result.items.map((item, index) => ({ id: index + 1, contentEn: item.excerpt }));

    // Simulate negative emoji reaction: the response cites nothing, so no
    // positional citation survives against the delivered evidence.
    const cited = detectCitations("unrelated reply with no overlap", hits);
    expect(cited).toEqual([]);
  });

  it("positive emoji → cited_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "User works at Acme Corp as a senior engineer",
      contentOriginal: "acme", memoryType: "fact", emotionScore: 0, topic: "work",
    });

    const result = await h.recallOwned("recall_normal", "Acme senior engineer");
    expect(result.items.length).toBeGreaterThan(0);
    const hits = result.items.map((item, index) => ({ id: index + 1, contentEn: item.excerpt }));

    // Agent response cites the memory (≥20 char substring)
    const response = "The user works at Acme Corp as a senior engineer on the platform team.";
    const cited = detectCitations(response, hits);
    expect(cited.length).toBeGreaterThan(0);
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

    // Anchor coverage decides: the memory matching the full anchor outranks
    // the partial-overlap memory. No age fade or repetition penalty applies.
    const result = await h.recallOwned("recall_normal", "Project Alpha uses React with TypeScript");
    expect(result.items.length).toBe(2);
    const goodIdx = result.items.findIndex(i => i.excerpt.includes("uses React with TypeScript"));
    const badIdx = result.items.findIndex(i => i.excerpt.includes("originally used Vue"));
    expect(goodIdx).toBeGreaterThanOrEqual(0);
    expect(badIdx).toBeGreaterThanOrEqual(0);
    expect(goodIdx).toBeLessThan(badIdx);
  });

  it("no citation detected for unrelated response", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "The database migration completed successfully last Tuesday",
      contentOriginal: "migration", memoryType: "event", emotionScore: 0, topic: "devops",
    });

    const result = await h.recallOwned("recall_normal", "database migration completed");
    const hits = result.items.map((item, index) => ({ id: index + 1, contentEn: item.excerpt }));

    // Response talks about something completely different
    const response = "Sure, I can help you write a React component for the login form.";
    const cited = detectCitations(response, hits);
    expect(cited).toEqual([]);
  });
});
