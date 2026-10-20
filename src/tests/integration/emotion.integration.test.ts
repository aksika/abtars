/**
 * Integration: emotion — #829 (no regex, agent/emoji tags only).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";

describe("emotion integration (#829)", () => {
  let h: IntegrationHarness;

  beforeEach(async () => { h = await createHarness(); });
  afterEach(() => h.cleanup());

  it("store without emotionTags → NULL (no regex fallback)", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "I am so happy and excited about this project",
      contentOriginal: "boldog vagyok", memoryType: "fact", emotionScore: 0, topic: "mood",
    });

    const db = memoryDb(h.memory);
    const row = db.prepare("SELECT emotion_tags, emotion_score FROM extracted_memories LIMIT 1").get() as { emotion_tags: string | null; emotion_score: number };
    expect(row.emotion_tags).toBeNull(); // NO regex detection
    expect(row.emotion_score).toBe(0);
  });

  it("store with agent-provided tags → stored + score derived", async () => {
    await h.memory.editor.instantStore({
      userId: "u1", contentEn: "Completed the refactoring successfully",
      contentOriginal: "kész", memoryType: "event", emotionScore: 0,
      emotionTags: "pride,excitement", topic: "work",
    });

    const db = memoryDb(h.memory);
    const row = db.prepare("SELECT emotion_tags, emotion_score FROM extracted_memories LIMIT 1").get() as { emotion_tags: string; emotion_score: number };
    expect(row.emotion_tags).toBe("pride,excitement");
    expect(row.emotion_score).toBe(4); // pride=4, excitement=4 → max abs = 4
  });
});
