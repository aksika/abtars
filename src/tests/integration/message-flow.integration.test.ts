/**
 * Integration: message flow — store → recall → citation round-trip.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHarness, detectCitations, type IntegrationHarness } from "./harness.js";

describe("message-flow integration", () => {
  let h: IntegrationHarness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => h.cleanup());

  it("store → recall round-trip", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "User prefers TypeScript over JavaScript for all projects",
      contentOriginal: "TypeScript-et preferálja", memoryType: "preference", emotionScore: 0,
      emotionTags: "conviction", topic: "coding",
    });

    const result = await h.memory.recallSearch({ translated: ["TypeScript", "preference"], userId: "u1" });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.content).toContain("TypeScript");
  });

  it("recordMessage persists to DB", () => {
    h.memory.recordMessage({
      role: "user", content: "Hello world", timestamp: Date.now(),
      userId: "u1", sessionId: "sess_1", platformMessageId: 100,
    });

    const db = h.memory.getDatabase()!;
    const row = db.prepare("SELECT content, role FROM messages WHERE platform_message_id = 100").get() as { content: string; role: string };
    expect(row.content).toBe("Hello world");
    expect(row.role).toBe("user");
  });

  it("citation detection → cited_count bumped", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "The deployment pipeline uses GitHub Actions with staging",
      contentOriginal: "deployment", memoryType: "fact", emotionScore: 0, topic: "devops",
    });

    const result = await h.memory.recallSearch({ translated: ["deployment", "GitHub"], userId: "u1" });
    expect(result.results.length).toBeGreaterThan(0);
    const recalledHits = result.results.filter(r => r.id != null).map(r => ({ id: r.id!, contentEn: r.content }));

    // Agent response cites the memory (≥20 char substring)
    const response = "I see that the deployment pipeline uses GitHub Actions with staging environment. I'll configure accordingly.";
    const citedIds = detectCitations(response, recalledHits);
    expect(citedIds.length).toBeGreaterThan(0);

    h.memory.bumpCitedCount(citedIds);

    const db = h.memory.getDatabase()!;
    const row = db.prepare("SELECT cited_count FROM extracted_memories WHERE id = ?").get(citedIds[0]!) as { cited_count: number };
    expect(row.cited_count).toBe(1);
  });

  it("classification gate — class 2 hidden from maxClass 1", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "My salary is 150k annually",
      contentOriginal: "salary", memoryType: "fact", emotionScore: 0,
      classification: 2, topic: "finance",
    });

    const restricted = await h.memory.recallSearch({ translated: ["salary"], userId: "u1", maxClassification: 1 });
    expect(restricted.results.length).toBe(0);

    const allowed = await h.memory.recallSearch({ translated: ["salary"], userId: "u1", maxClassification: 2 });
    expect(allowed.results.length).toBeGreaterThan(0);
  });
});
