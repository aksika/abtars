/**
 * #1894 — translation-free ambient recall over the real bridge→abmind boundary.
 *
 * Seeded bilingual store: twelve courtesy memories whose source token `köszi`
 * is dense in `content_original`, one topical memory retrievable only through
 * its stored original-language text, and one topical memory carrying an
 * English-only term. Corpus is 14 rows, so the df ceiling is
 * max(2, floor(14 * 0.25)) = 3 and the courtesy df is 12.
 *
 * No provider and no session manager exist anywhere in this file: every
 * verdict and retrieval below is produced without translation or any model
 * call, through `prepareRecallQuery` (pure) and the real client runtime.
 */
import { describe, it, expect } from "vitest";
import { extractEnglishTokens, type MemoryManager } from "abmind";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
import { prepareRecallQuery } from "../../components/pipeline/recall-query-preparation.js";
import { createClientRuntime, type AbtarsMemoryRuntime } from "../../components/memory-runtime.js";
import type { AbmindClientLike } from "../../components/abmind-client-contract.js";

const USER = "u1";

// Topical memory retrievable only via its stored original-language text.
// `terv` is the ASCII token the bridge extraction surfaces from the turn;
// it occurs in exactly one stored original.
const S_EN = "unrelated english filler rugged";
const S_ORIG = "adatmigrálás terv jóváhagyva";
// Topical memory carrying an English-only term: same-word lexical probes
// must retrieve it from `content_en` without translation.
const E_EN = "daylight lamp inventory ledger";
const E_ORIG = "napi rutin lámpa leltár";

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

function seedStore(h: IntegrationHarness): { s: number; e: number } {
  const s = seedRow(h, S_EN, S_ORIG);
  const e = seedRow(h, E_EN, E_ORIG);
  for (let i = 0; i < 12; i++) {
    seedRow(h, `daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
  }
  return { s, e };
}

/** Bridge runtime with the #1894 check wired to the real manager. */
function bridgeRuntime(h: IntegrationHarness): AbtarsMemoryRuntime {
  const client = {
    capabilities: {
      version: 1,
      methods: ["private.recall", "private.checkWorthRetrieving"],
      domains: ["system", "private"],
      features: { private_read: "true" },
    },
    routeSnapshot: {},
    privateMemory: {
      recall: (params: unknown) =>
        h.memory.recallSearch(params as Parameters<IntegrationHarness["recallSearch"]>[0]) as unknown as Promise<unknown>,
      checkWorthRetrieving: (params: unknown) =>
        h.memory.checkWorthRetrieving(params as Parameters<MemoryManager["checkWorthRetrieving"]>[0]) as unknown as Promise<unknown>,
    },
    sleep: {},
    negotiate: async () => ({}),
    close: async () => {},
  };
  return createClientRuntime(client as unknown as AbmindClientLike);
}

/** One ambient turn through real bridge preparation and the real runtime. */
async function ambientTurn(runtime: AbtarsMemoryRuntime, text: string) {
  // Explicit extractor, as the bridge sends it when abmind is loaded.
  const prepared = prepareRecallQuery(text, [], { extractTokens: extractEnglishTokens });
  const check = await runtime.worthRetrieving!({ original: text, userId: USER, limit: 5 });
  if (check !== null && check.verdict === "skip") return { check, recall: null };
  const recall = await runtime.recall({
    query: prepared.query, original: prepared.original, userId: USER, limit: 5,
    intent: "ambient",
    ...(prepared.terms !== undefined && prepared.terms.length > 0 ? { terms: prepared.terms, selectTerms: true } : {}),
  });
  return { check, recall };
}

describe("#1894 — translation-free ambient recall", () => {
  it("a courtesy turn skips before any retrieval stage", async () => {
    const h = await createHarness();
    try {
      seedStore(h);
      const runtime = bridgeRuntime(h);
      const { check, recall } = await ambientTurn(runtime, "köszi");
      expect(check?.verdict).toBe("skip");
      expect(recall).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("an informative turn retrieves from stored original-language text without translation", async () => {
    const h = await createHarness();
    try {
      const { s } = seedStore(h);
      const runtime = bridgeRuntime(h);
      const { check, recall } = await ambientTurn(runtime, "köszi adatmigrálás terv");
      expect(check?.verdict).toBe("search");
      expect(recall?.searchSkipped).toBeUndefined();
      expect((recall?.hits ?? []).map((hit) => hit.memoryId)).toContain(s);
    } finally {
      h.cleanup();
    }
  });

  it("an English-only term retrieves from content_en without translation", async () => {
    const h = await createHarness();
    try {
      const { e } = seedStore(h);
      const runtime = bridgeRuntime(h);
      const { check, recall } = await ambientTurn(runtime, "köszi daylight lamp");
      expect(check?.verdict).toBe("search");
      expect((recall?.hits ?? []).map((hit) => hit.memoryId)).toContain(e);
    } finally {
      h.cleanup();
    }
  });
});
