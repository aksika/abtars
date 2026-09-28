/**
 * #1867 — two-path harness + #671 E2E probe (seeded, deterministic).
 *
 * Real bridge-to-abmind composition on a seeded store: the required memory
 * (R, #671-shaped: old "midnight architect tester paradox" fact with a
 * Hungarian original), a lexical false-friend distractor (D, #887-shaped:
 * porter-stem collision on architect/architecture plus filler), and 500+
 * newer fillers. Three improved-path turns — exact, paraphrase, and
 * Hungarian-via-fixture-translation — assert the FINAL injected set after
 * the bridge floor/age rules (prompt-builder.ts), not just abmind rank.
 *
 * Fidelity notes (recorded, not hidden):
 * - Stages are pinned to Sf/Ss/S6 by the harness (no embedding provider in
 *   CI); Se coverage behind 500+ newer rows is #1861's proven territory
 *   (recall-history-coverage.test.ts with a scripted provider). Se/Ss budget
 *   env and vec-index completeness are printed with every run.
 * - Ss sees NULL-signature seeds here, so it completes with 0 hits; the
 *   asserted mechanism is this ticket's (discrete terms → coverage ordering →
 *   df selection → bridge filters).
 * - Hungarian translation arrives as a deterministic fixture (no provider in
 *   tests), per design.md failure semantics; timeout/503 cases keep
 *   deterministic evidence through the same seam.
 */
import { describe, it, expect } from "vitest";
import { extractEnglishTokens } from "abmind";
import { createHarness, memoryDb, type IntegrationHarness } from "./harness.js";
import { prepareRecallQuery, mergeQueryTerms } from "../../components/pipeline/recall-query-preparation.js";
import { selectInjectedHits } from "../../components/memory-runtime.js";

const USER = "u1";
const DAY = 86400000;
const TRIVIAL_TTL_MS = 36 * 60 * 60_000;

// Fictional fixture text — independent of any private live memory.
const R_EN = "The midnight perfectionist architect resolved the tester paradox";
const R_ORIG = "Az éjféli maximalista építész feloldotta a tesztelő paradoxont";
// Lexical false friend: shares retrievable tokens (test, paradox, looks)
// with every arm's terms, but on a different topic.
const D_EN = "The test architecture paradox looks complete";

function seedRow(h: IntegrationHarness, opts: {
  contentEn: string; contentOriginal?: string; createdAt?: number; importanceFlags?: string | null;
}): number {
  const db = memoryDb(h.memory);
  const now = opts.createdAt ?? Date.now();
  const row = db.prepare(`INSERT INTO extracted_memories
    (user_id, content_en, content_original, memory_type, source_timestamp, created_at,
     classification, emotion_score, confidence, recall_count, relevance_score, importance_flags)
    VALUES (?, ?, ?, 'fact', ?, ?, 1, 0, 3, 0, 0, ?)`)
    .run(USER, opts.contentEn, opts.contentOriginal ?? opts.contentEn, now, now, opts.importanceFlags ?? null);
  return Number(row.lastInsertRowid);
}

async function seedStore(h: IntegrationHarness): Promise<{ r: number; d: number }> {
  const now = Date.now();
  // R is OLD (behind 500+ newer fillers) and flagged important, so the
  // bridge 36 h trivial-fact age rule spares it while still exercising it.
  const r = seedRow(h, {
    contentEn: R_EN, contentOriginal: R_ORIG,
    createdAt: now - 30 * DAY, importanceFlags: "standing-constraint",
  });
  const d = seedRow(h, { contentEn: D_EN, createdAt: now - 1 * DAY });
  for (let i = 0; i < 520; i++) {
    const filler = i % 2 === 0
      ? `archive note ${i}: this looks like routine noise ${i}`
      : `archive note ${i}: routine filler content ${i}`;
    seedRow(h, { contentEn: filler, createdAt: now - i * 60000 });
  }
  return { r, d };
}

/** Bridge floor + trivial-fact age rule, mirroring prompt-builder.ts. */
function bridgeFilter(hits: Array<{ score: number; memoryType?: string; createdAt?: number; emotionTags?: unknown; importanceFlags?: unknown }>): typeof hits {
  const nowMs = Date.now();
  return hits.filter((h) => {
    if (h.score <= 0.70) return false;
    if (h.memoryType === "fact" && h.score < 1.0 && h.createdAt && nowMs - h.createdAt > TRIVIAL_TTL_MS) {
      if (!h.emotionTags && !h.importanceFlags) return false;
    }
    return true;
  });
}

function envSnapshot(h: IntegrationHarness): string {
  const db = memoryDb(h.memory);
  let vec = "n/a";
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number }).c;
    let vecCount = 0;
    try {
      vecCount = (db.prepare("SELECT COUNT(*) AS c FROM vec_memories").get() as { c: number }).c;
    } catch { vecCount = -1; }
    vec = `vec_memories=${vecCount}/${total}`;
  } catch { /* read-only diagnostics, never fail the probe */ }
  return `seWaitMs=${process.env["RECALL_SE_WAIT_MS"] ?? "default(250)"} ssScanRows=${process.env["RECALL_SS_SCAN_ROWS"] ?? "default(5000)"} ${vec}`;
}

describe("#1867 #671 probe — improved path injects R at or above D", () => {
  it("exact, paraphrase, and Hungarian-via-translation turns", async () => {
    const h = await createHarness();
    try {
      const { r, d } = await seedStore(h);
      console.info(`[1867-probe] env: ${envSnapshot(h)}`);

      // Deterministic fixture translation (no provider in tests): genuine
      // English terms for the Hungarian turn, mirroring a bounded
      // dispatchBackground translation call.
      const fixtureTranslate = async (): Promise<string[]> =>
        ["midnight", "tester", "paradox", "perfectionist", "architect", "resolved"];

      const arms: Array<{ name: string; text: string; translate: boolean }> = [
        { name: "exact", text: "midnight perfectionist architect tester paradox", translate: false },
        { name: "paraphrase", text: "which perfectionist resolved the midnight tester paradox", translate: false },
        { name: "hungarian", text: "Ki oldotta fel az éjféli tesztelő paradoxont, a maximalista építész?", translate: true },
      ];

      for (const arm of arms) {
        const prepared = prepareRecallQuery(arm.text, [], { extractTokens: extractEnglishTokens });
        let terms = prepared.terms ?? [];
        if (arm.translate) {
          const translated = await fixtureTranslate();
          terms = mergeQueryTerms([translated, terms]);
        }
        expect(terms.length).toBeGreaterThan(1);
        const t0 = performance.now();
        // Params shaped exactly as memory-runtime.recall sends them.
        // trackRecalls:false keeps sequential arms deterministic: recall-count
        // bumps would otherwise shift darwinism scores between arms.
        const result = await h.recallSearch({
          translated: terms, original: arm.text, userId: USER, limit: 5, selectTerms: true, trackRecalls: false,
        });
        const ms = Math.round(performance.now() - t0);
        const rawIds = result.results.map((hit) => hit.id);
        // The distractor must actually contest, or the probe is vacuous.
        expect(rawIds, `${arm.name}: distractor D absent from raw results`).toContain(d);
        const filtered = bridgeFilter(result.results.map((hit) => ({
          score: hit.score, memoryType: hit.memoryType, createdAt: hit.createdAt,
          emotionTags: hit.emotionTags, importanceFlags: hit.importanceFlags,
        })).map((f, i) => ({ ...f, memoryId: result.results[i]!.id, content: result.results[i]!.content })));
        const injected = selectInjectedHits(filtered, result.selection);
        const injectedIds = injected.map((hit) => hit.memoryId);
        console.info(`[1867-probe] ${arm.name}: ${ms}ms raw=[${rawIds.slice(0, 6).join(",")}] injected=[${injectedIds.join(",")}] weakEvidence=${result.weakEvidence}`);
        expect(injectedIds, `${arm.name}: required memory R not injected`).toContain(r);
        expect(injectedIds.indexOf(r), `${arm.name}: R ranks below distractor D`).toBeLessThanOrEqual(injectedIds.indexOf(d));
        if (arm.name !== "hungarian") {
          // Every English-arm term genuinely matches R, so the lexical arm of
          // weakEvidence must clear. The Hungarian arm carries untranslatable
          // source-language residue alongside the fixture translation, so its
          // flag is logged, not asserted.
          expect(result.weakEvidence, `${arm.name}: weak evidence on an exact topical match`).toBe(false);
        }
      }
    } finally {
      h.cleanup();
    }
  });

  it("filler-laden query: df selection drops filler, R still injected", async () => {
    const h = await createHarness();
    try {
      const { r, d } = await seedStore(h);
      // "looks like" has high df from the seeded fillers; the topical terms
      // are rare. Selection must drop the filler before retrieval, leaving a
      // term set R matches exactly (weak evidence clears).
      const result = await h.recallSearch({
        translated: ["midnight", "tester", "paradox", "looks", "like"],
        original: "looks like the midnight tester paradox",
        userId: USER, limit: 5, selectTerms: true, trackRecalls: false,
      });
      const rawIds = result.results.map((hit) => hit.id);
      expect(rawIds, "distractor D absent from raw results").toContain(d);
      const injected = selectInjectedHits(
        bridgeFilter(result.results.map((hit) => ({
          score: hit.score, memoryType: hit.memoryType, createdAt: hit.createdAt,
          emotionTags: hit.emotionTags, importanceFlags: hit.importanceFlags,
        })).map((f, i) => ({ ...f, memoryId: result.results[i]!.id, content: result.results[i]!.content }))),
        result.selection,
      ).map((hit) => hit.memoryId);
      expect(injected, "required memory R not injected").toContain(r);
      expect(injected.indexOf(r), "R ranks below distractor D").toBeLessThanOrEqual(injected.indexOf(d));
      expect(result.weakEvidence, "weak evidence after filler selection").toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
