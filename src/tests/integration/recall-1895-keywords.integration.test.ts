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

async function seedRow(h: IntegrationHarness, contentEn: string, contentOriginal: string): Promise<void> {
  const stored = await h.memory.editor.instantStore({
    userId: USER, contentEn, contentOriginal, memoryType: "fact", emotionScore: 0,
  });
  expect(stored.stored).toBe(true);
}

/** Two rare topical memories plus twelve source-courtesy memories. */
async function seedStore(h: IntegrationHarness): Promise<void> {
  await seedRow(h, "migration owns the staging rollback procedure", "a migráció kezeli az élesítési visszagörgetést");
  await seedRow(h, "migration runs the nightly data reload", "a migráció futtatja az éjszakai adatbetöltést");
  for (let i = 0; i < 12; i++) {
    await seedRow(h, `daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
  }
}

function bridgeRuntime(h: IntegrationHarness): AbtarsMemoryRuntime {
  const client = {
    capabilities: { version: 1, methods: ["private.recall"], domains: ["system", "private"], features: { private_read: "true" } },
    routeSnapshot: {},
    privateMemory: {
      // The bridge speaks the owned contract; the in-harness daemon serves
      // it after an explicit projection build, like the operator surface.
      recall: async (params: unknown) => {
        const req = params as { profile: string; identity: { principal: string } };
        const { buildRecallProjection } = await import("abmind");
        const db = memoryDb(h.memory);
        expect(buildRecallProjection(db, req.identity.principal, { verifiedBackup: true }).ok).toBe(true);
        return h.memory.recall(params as never) as unknown as Promise<unknown>;
      },
    },
    sleep: {},
    negotiate: async () => ({}),
    close: async () => {},
  };
  return createClientRuntime(client as unknown as AbmindClientLike);
}

describe("#1928 explicit keywords — real runtime-to-abmind composition", () => {
  it("accepted arrays reach abmind verbatim as the explicit anchor", async () => {
    const h = await createHarness();
    try {
      await seedStore(h);
      const spy = vi.spyOn(h.memory, "recall");
      const runtime = bridgeRuntime(h);
      const keywords = ["Migration", "AND", "rollback", "rollback", ...Array.from({ length: 20 }, (_, i) => `term${i}`)];
      await runtime.recall({ query: keywords.join(" "), userId: USER, profile: "recall_normal", text: keywords.join(" "), keywords, limit: 5 });
      expect(spy).toHaveBeenCalledTimes(1);
      const params = spy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(params["contract"]).toBe("owned-v1");
      expect(params["profile"]).toBe("recall_normal");
      expect((params["query"] as Record<string, unknown>)["keywords"]).toEqual(keywords);
      spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("explicit common courtesy turn searches where fast skips", async () => {
    const h = await createHarness();
    try {
      await seedStore(h);
      const runtime = bridgeRuntime(h);
      const ambient = await runtime.recall({ query: "köszi", userId: USER, profile: "recall_fast", rawTurn: "köszi", limit: 5 });
      expect(ambient.status).toBe("skipped");
      const explicit = await runtime.recall({
        query: "köszi", userId: USER, profile: "recall_normal", text: "köszi", keywords: ["köszi"], limit: 5,
      });
      expect(explicit.status).not.toBe("skipped");
      expect(explicit.hits.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });

  it("explicit topical keywords return the seeded memory", async () => {
    const h = await createHarness();
    try {
      await seedStore(h);
      const runtime = bridgeRuntime(h);
      const result = await runtime.recall({
        query: "migration", userId: USER, profile: "recall_normal", text: "migration", keywords: ["migration"], limit: 5,
      });
      expect(result.status).not.toBe("skipped");
      expect(result.hits.some((hit) => hit.content.includes("staging rollback procedure"))).toBe(true);
    } finally {
      h.cleanup();
    }
  });
});
