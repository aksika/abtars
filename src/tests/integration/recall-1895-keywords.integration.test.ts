/**
 * #1895 — explicit keywords through the real bridge-to-abmind composition.
 *
 * Real `createClientRuntime` over a seeded real MemoryManager: accepted
 * keyword arrays must reach abmind's `translated` verbatim (case, order,
 * duplicates, literal boolean words, no silent cap) with explicit intent,
 * and deliberate searches must never skip — even on turns where the ambient
 * contract skips. Uses the production bilingual shape (English `content_en`
 * plus distinct Hungarian `content_original`).
 */
import { describe, it, expect, vi } from "vitest";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
import { createClientRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import type { AbmindClientLike } from "../../components/abmind-client-contract.js";

const USER = "u1";

function seedRow(h: IntegrationHarness, contentEn: string, contentOriginal: string): number {
  const db = memoryDb(h.memory);
  const now = Date.now();
  const row = db.prepare(`INSERT INTO extracted_memories
    (user_id, content_en, content_original, memory_type, source_timestamp, created_at,
     classification, emotion_score, confidence, recall_count, relevance_score)
    VALUES (?, ?, ?, 'fact', ?, ?, 1, 0, 3, 0, 0)`)
    .run(USER, contentEn, contentOriginal, now, now);
  return Number(row.lastInsertRowid);
}

/** Two rare topical memories plus twelve source-courtesy memories. */
function seedStore(h: IntegrationHarness): { r: number } {
  const r = seedRow(h, "migration owns the staging rollback procedure", "a migráció kezeli az élesítési visszagörgetést");
  seedRow(h, "migration runs the nightly data reload", "a migráció futtatja az éjszakai adatbetöltést");
  for (let i = 0; i < 12; i++) {
    seedRow(h, `daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
  }
  return { r };
}

function bridgeRuntime(h: IntegrationHarness): AbtarsMemoryRuntime {
  const client = {
    capabilities: { version: 1, methods: ["private.recall"], domains: ["system", "private"], features: { private_read: "true" } },
    routeSnapshot: {},
    privateMemory: {
      recall: (params: unknown) =>
        h.memory.recallSearch(params as Parameters<IntegrationHarness["recallSearch"]>[0]) as unknown as Promise<unknown>,
    },
    sleep: {},
    negotiate: async () => ({}),
    close: async () => {},
  };
  return createClientRuntime(client as unknown as AbmindClientLike);
}

describe("#1895 explicit keywords — real runtime-to-abmind composition", () => {
  it("accepted arrays reach abmind verbatim with explicit intent", async () => {
    const h = await createHarness();
    try {
      seedStore(h);
      const spy = vi.spyOn(h.memory, "recallSearch");
      const runtime = bridgeRuntime(h);
      const keywords = ["Migration", "AND", "rollback", "rollback", ...Array.from({ length: 20 }, (_, i) => `term${i}`)];
      await runtime.recall({ query: keywords.join(" "), userId: USER, limit: 5, keywords, intent: "explicit" });
      expect(spy).toHaveBeenCalledTimes(1);
      const params = spy.mock.calls[0]![0];
      expect(params.translated).toEqual(keywords);
      expect(params.intent).toBe("explicit");
      spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("explicit common courtesy turn searches where ambient skips", async () => {
    const h = await createHarness();
    try {
      seedStore(h);
      const runtime = bridgeRuntime(h);
      const ambient = await runtime.recall({ query: "köszi", original: "köszi", userId: USER, limit: 5 });
      expect(ambient.searchSkipped).toBe(true);
      const explicit = await runtime.recall({
        query: "köszi", original: "köszi", userId: USER, limit: 5,
        keywords: ["köszi"], intent: "explicit",
      });
      expect(explicit.searchSkipped).toBeUndefined();
      expect(explicit.stageOutcomes?.["Sf"]?.status).toBe("completed");
    } finally {
      h.cleanup();
    }
  });

  it("explicit topical keywords return the seeded memory", async () => {
    const h = await createHarness();
    try {
      const { r } = seedStore(h);
      const runtime = bridgeRuntime(h);
      const result = await runtime.recall({
        query: "migration", userId: USER, limit: 5,
        keywords: ["migration"], intent: "explicit",
      });
      expect(result.searchSkipped).toBeUndefined();
      expect(result.hits.map((hit) => hit.memoryId)).toContain(r);
    } finally {
      h.cleanup();
    }
  });
});
