/**
 * #1877 AC1 — flags reach the rule, provably, on one seeded store.
 *
 * Same old low-score fact dropped without flags and injected with them, a
 * recent fact injected either way, and the recorded hit score confirms
 * `score < 1.0` so the age branch (not the floor) decided. Assertions run
 * through the production predicate over the real bridge-to-abmind
 * composition; fixture text is fictional and independent of live memory.
 */
import { describe, it, expect } from "vitest";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
import { createClientRuntime, shouldInjectRecallHit, stripRecallFlagsForTool, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import type { AbmindClientLike } from "../../components/abmind-client-contract.js";

const USER = "u1";
const DAY = 86400000;

const OLD_FLAGGED = "the midnight exemption canary kept its standing lantern inside the old harbor archive ledger";
const OLD_PLAIN = "the midnight exemption canary dropped its standing lantern beside the old harbor archive ledger";
const RECENT_PLAIN = "the midnight exemption canary lit a recent lantern near the new garden shed";

function seedRow(h: IntegrationHarness, contentEn: string, createdAt: number, importanceFlags: string | null): number {
  const db = memoryDb(h.memory);
  const row = db.prepare(`INSERT INTO extracted_memories
    (user_id, content_en, content_original, memory_type, source_timestamp, created_at,
     classification, emotion_score, confidence, recall_count, relevance_score, importance_flags)
    VALUES (?, ?, ?, 'fact', ?, ?, 1, 0, 3, 0, 0, ?)`)
    .run(USER, contentEn, contentEn, createdAt, createdAt, importanceFlags);
  return Number(row.lastInsertRowid);
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

describe("#1877 exemption — flags cross the boundary and decide injection", () => {
  it("old flagged fact injects, old plain fact drops, recent fact injects either way", async () => {
    const h = await createHarness();
    try {
      const now = Date.now();
      const flaggedId = seedRow(h, OLD_FLAGGED, now - 30 * DAY, "standing-constraint");
      const plainId = seedRow(h, OLD_PLAIN, now - 30 * DAY, null);
      const recentId = seedRow(h, RECENT_PLAIN, now - 1 * DAY, null);

      const runtime = bridgeRuntime(h);
      const result = await runtime.recall({
        query: "midnight exemption canary lantern",
        original: "midnight exemption canary lantern",
        userId: USER,
        limit: 10,
      });
      const byId = new Map(result.hits.map((hit) => [hit.memoryId, hit]));
      const flagged = byId.get(flaggedId);
      const plain = byId.get(plainId);
      const recent = byId.get(recentId);
      expect(flagged, "flagged old fact absent from recall").toBeDefined();
      expect(plain, "plain old fact absent from recall").toBeDefined();
      expect(recent, "recent fact absent from recall").toBeDefined();

      // Flags cross on the flagged row only.
      expect(flagged?.importanceFlags).toBe("standing-constraint");
      expect(plain?.importanceFlags).toBeUndefined();

      // The old pair must clear the floor and stay below 1.0, proving the
      // age branch (not the floor, not the score>=1.0 bypass) decides. The
      // recent control is exempt from the age branch by recency either way.
      for (const hit of [flagged, plain]) {
        expect(hit!.score).toBeGreaterThan(0.70);
        expect(hit!.score).toBeLessThan(1.0);
      }
      expect(recent!.score).toBeGreaterThan(0.70);

      const at = Date.now();
      expect(shouldInjectRecallHit(plain!, at)).toBe(false);
      expect(shouldInjectRecallHit(flagged!, at)).toBe(true);
      expect(shouldInjectRecallHit(recent!, at)).toBe(true);

      // Tool contract: stripping is a no-op on rows that never carried flags.
      const serialized = JSON.stringify({ ...result, hits: stripRecallFlagsForTool(result.hits) });
      expect(serialized).not.toContain("standing-constraint");
    } finally {
      h.cleanup();
    }
  });
});
