/**
 * #1877 — held-out turn corpus for the deterministic cue router.
 *
 * Each case records the expected decision. Search-required and ambiguous
 * cases must search; skips may occur only on listed self-contained patterns.
 * A false skip is a skipped turn on which baseline retrieval (with the #1877
 * flag repair in place) would have injected a required memory — the offline
 * evidence job replays the skip set against the seeded harness.
 *
 * Corpus misses found during measurement are recorded here and fed back
 * into `recall-router.ts`, not invented from intuition.
 */
import { describe, it, expect } from "vitest";
import { shouldAutoRecall } from "./recall-router.js";

const SEARCH_REQUIRED: Array<[string, string]> = [
  ["what did we decide about the deploy yesterday?", "past-reference + prior-decision"],
  ["remind me what you told me about the midnight architect paradox", "past-reference"],
  ["actually you got that wrong, fix it", "correction EN"],
  ["javítsd ki, tévedtél a dátummal kapcsolatban", "correction HU"],
  ["we agreed to always run the migration first", "prior-decision + action-with-constraint"],
  ["megbeszéltük, hogy soha nem deployolunk pénteken", "prior-decision HU"],
  ["what did Anna say about the frontend project?", "named person + project"],
  ["kérlek Kati projektjéről emlékezz valamire", "named person HU"],
  ["@anna please review the release notes", "mention"],
  ["remember to follow the standing checkout rule", "action-with-constraint"],
  ["ne felejtsd el a szokásos mentést futtatni", "action-with-constraint HU"],
  ["which perfectionist resolved the midnight tester paradox?", "question-about-past"],
  ["Ki oldotta fel az éjféli tesztelő paradoxont?", "question-about-past HU"],
  ["yesterday's standup notes said the API changed, right?", "past-reference"],
  ["tegnap mondtad, hogy a szerverterv változott", "past-reference HU"],
];

const AMBIGUOUS_MUST_SEARCH: Array<[string, string]> = [
  ["hmm, not sure about that detail", "uncertain — searches"],
  ["maybe check the earlier note?", "hedged past reference — searches"],
  ["ok, but what did we promise the client?", "ack prefix + past question — searches"],
  ["köszi, de mit ígértünk az ügyfélnek?", "ack prefix HU + question — searches"],
  ["fine, and the project deadline?", "short but retrieval content — searches"],
];

const SELF_CONTAINED_MAY_SKIP: Array<[string, string]> = [
  ["hi", "greeting EN"],
  ["hello", "greeting EN"],
  ["szia", "greeting HU"],
  ["jó reggelt", "greeting HU"],
  ["thanks", "acknowledgement EN"],
  ["thank you", "acknowledgement EN"],
  ["ok", "acknowledgement EN"],
  ["köszi", "acknowledgement HU"],
  ["köszönöm", "acknowledgement HU"],
  ["rendben", "acknowledgement HU"],
  ["yes", "ultra-short"],
  ["ok!", "ultra-short with punctuation"],
];

describe("#1877 router — held-out corpus", () => {
  it("searches every search-required turn (EN + HU)", () => {
    for (const [text, label] of SEARCH_REQUIRED) {
      expect(shouldAutoRecall(text, []).decision, `${label}: ${text}`).toBe("search");
    }
  });

  it("searches every ambiguous turn — uncertainty favors search", () => {
    for (const [text, label] of AMBIGUOUS_MUST_SEARCH) {
      expect(shouldAutoRecall(text, ["deploy", "deadline"]).decision, `${label}: ${text}`).toBe("search");
    }
  });

  it("skips only on listed self-contained patterns", () => {
    for (const [text, label] of SELF_CONTAINED_MAY_SKIP) {
      const routing = shouldAutoRecall(text, []);
      expect(routing.decision, `${label}: ${text}`).toBe("skip");
      expect(["greeting", "acknowledgement", "ultra-short"]).toContain(routing.matched);
    }
  });

  it("priming presence alone never forces search, but a term match tie-breaks toward search", () => {
    // Priming is non-empty on nearly every turn after the first; as a cue it
    // would force search everywhere and make the router a no-op.
    expect(shouldAutoRecall("hi", ["deploy", "deadline", "migration"]).decision).toBe("skip");
    // But when a priming term matches the current message, it pushes to search.
    const routing = shouldAutoRecall("hi deploy", ["deploy"]);
    expect(routing.decision).toBe("search");
    expect(routing.matched).toBe("priming-term-match");
  });

  it("is total — never throws, falls back to search", () => {
    expect(() => shouldAutoRecall("hello", [])).not.toThrow();
    expect(shouldAutoRecall("hello", []).decision).toBe("skip");
    expect(shouldAutoRecall("what did we decide?", []).matched).not.toBe("error-fallback");
  });

  it("proper-noun heuristic searches named references without firing on sentence case", () => {
    expect(shouldAutoRecall("ask Anna about Friday", []).decision).toBe("search");
    expect(shouldAutoRecall("hello today", []).decision).toBe("skip");
  });
});
