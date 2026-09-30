/**
 * #1877 AC4/AC5 — offline router evidence on the seeded harness.
 *
 * Corpus run through the production router (`shouldAutoRecall`) and the
 * production predicate (`shouldInjectRecallHit`) with the real bridge
 * runtime over a seeded abmind store:
 * - every search-required turn must search AND its required memory must be
 *   actually injected (harness sensitivity — without this the skip set
 *   proves nothing);
 * - every self-contained turn must skip, and baseline retrieval on that
 *   turn must inject none of the required memories (no false skip).
 *
 * Scope limitation (recorded, not hidden): this corpus is small and
 * constructed; the held-out real-traffic measurement is the Molty shadow
 * log (AC6). A false skip here means a skip decision on a turn where
 * baseline retrieval injected a required memory.
 */
import { describe, it, expect } from "vitest";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
import { createClientRuntime, shouldInjectRecallHit, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import { shouldAutoRecall } from "../../components/pipeline/recall-router.js";
import type { AbmindClientLike } from "../../components/abmind-client-contract.js";

const USER = "u1";
const DAY = 86400000;

interface SearchTurn {
  text: string;
  keyword: string;
  label: string;
}

const SEARCH_TURNS: SearchTurn[] = [
  { text: "what did we decide about the deploy yesterday?", keyword: "deploy", label: "prior decision EN" },
  { text: "actually you got the migration date wrong, fix it", keyword: "migration", label: "correction EN" },
  { text: "remind me what you told me about the paradox", keyword: "paradox", label: "past reference EN" },
  { text: "we agreed to always run the backup first", keyword: "backup", label: "action with constraint EN" },
  { text: "what did Anna say about the frontend project?", keyword: "frontend", label: "named person + project EN" },
  { text: "javítsd ki, tévedtél a határidővel kapcsolatban", keyword: "deadline", label: "correction HU" },
  { text: "Ki oldotta fel az éjféli tesztelő paradoxont?", keyword: "midnight", label: "question HU" },
  { text: "megbeszéltük, hogy soha nem deployolunk pénteken", keyword: "friday", label: "prior decision HU" },
];

const SKIP_TURNS: Array<{ text: string; label: string }> = [
  { text: "hi", label: "greeting EN" },
  { text: "hello", label: "greeting EN" },
  { text: "szia", label: "greeting HU" },
  { text: "thanks", label: "acknowledgement EN" },
  { text: "ok", label: "acknowledgement EN" },
  { text: "köszi", label: "acknowledgement HU" },
  { text: "igen", label: "filler-only HU" },
  { text: "rendben", label: "acknowledgement HU" },
];

function seedRequired(h: IntegrationHarness, keyword: string, createdAt: number): number {
  const db = memoryDb(h.memory);
  const content = `upstream note: ${keyword} is governed by the standing constraint`;
  const row = db.prepare(`INSERT INTO extracted_memories
    (user_id, content_en, content_original, memory_type, source_timestamp, created_at,
     classification, emotion_score, confidence, recall_count, relevance_score, importance_flags)
    VALUES (?, ?, ?, 'fact', ?, ?, 1, 0, 3, 0, 0, 'standing-constraint')`)
    .run(USER, content, content, createdAt, createdAt);
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

describe("#1877 offline router evidence", () => {
  it("searches every search-required turn and injects its required memory; skipped turns inject no required memory", async () => {
    const h = await createHarness();
    try {
      const now = Date.now();
      const requiredIds = new Set<number>();
      const idByKeyword = new Map<string, number>();
      for (const turn of SEARCH_TURNS) {
        const id = seedRequired(h, turn.keyword, now - 30 * DAY);
        idByKeyword.set(turn.keyword, id);
        requiredIds.add(id);
      }
      const runtime = bridgeRuntime(h);

      let skips = 0;
      for (const turn of SEARCH_TURNS) {
        const routing = shouldAutoRecall(turn.text, []);
        expect(routing.decision, `${turn.label}: router skipped a search-required turn`).toBe("search");
        const result = await runtime.recall({
          query: turn.text,
          original: turn.text,
          userId: USER,
          limit: 5,
          terms: [turn.keyword],
          selectTerms: true,
        });
        const at = Date.now();
        const injected = result.hits.filter((hit) => shouldInjectRecallHit(hit, at));
        const requiredHit = injected.some((hit) => hit.memoryId === idByKeyword.get(turn.keyword));
        console.info(`[1877-offline] turn="${turn.text}" label=${turn.label} decision=search matched=${routing.matched} retrieved=${result.hits.length} injected=${injected.length} required=${requiredHit ? "yes" : "NO"}`);
        expect(requiredHit, `${turn.label}: required memory not injected on a searched turn`).toBe(true);
      }

      for (const turn of SKIP_TURNS) {
        const routing = shouldAutoRecall(turn.text, []);
        expect(routing.decision, `${turn.label}: router searched a self-contained turn`).toBe("skip");
        skips++;
        const result = await runtime.recall({ query: turn.text, original: turn.text, userId: USER, limit: 5 });
        const at = Date.now();
        const injected = result.hits.filter((hit) => shouldInjectRecallHit(hit, at));
        const falseSkip = injected.some((hit) => hit.memoryId !== undefined && requiredIds.has(hit.memoryId));
        console.info(`[1877-offline] turn="${turn.text}" label=${turn.label} decision=skip matched=${routing.matched} retrieved=${result.hits.length} injected=${injected.length} falseSkip=${falseSkip ? "YES" : "no"}`);
        expect(falseSkip, `${turn.label}: false skip — baseline would have injected a required memory`).toBe(false);
      }

      const total = SEARCH_TURNS.length + SKIP_TURNS.length;
      console.info(`[1877-offline] skip rate ${skips}/${total} (${Math.round((skips / total) * 100)}%), false skips 0 on this corpus/store`);
    } finally {
      h.cleanup();
    }
  });
});
