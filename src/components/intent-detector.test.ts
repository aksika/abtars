import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { IntentDetector, DEFAULT_CUE_PHRASES_EN, DEFAULT_CUE_PHRASES_HU } from "./intent-detector.js";

// Feature: memory-recall-fallback, Property 5: Cue Phrase Detection Across Languages
describe("IntentDetector — Property 5: Cue Phrase Detection Across Languages", () => {
  const detector = new IntentDetector({
    cuePhrasesEn: [...DEFAULT_CUE_PHRASES_EN],
    cuePhrasesHu: [...DEFAULT_CUE_PHRASES_HU],
  });

  const allCuePhrases = [...DEFAULT_CUE_PHRASES_EN, ...DEFAULT_CUE_PHRASES_HU];

  /**
   * Word-boundary-safe arbitrary: generates alphanumeric strings with spaces
   * that won't break regex word boundaries around the cue phrase.
   */
  const safeStringArb = fc.stringOf(
    fc.char().filter((c) => /[a-zA-Z0-9 ]/.test(c)),
  );

  it("returns hasRecallIntent: true for any message containing a cue phrase", () => {
    /**
     * Validates: Requirements 2.2
     *
     * For any message string that contains at least one of the configured
     * recall-intent cue phrases (English or Hungarian), IntentDetector.analyze
     * should return hasRecallIntent: true.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...allCuePhrases),
        safeStringArb,
        safeStringArb,
        (cuePhrase, prefix, suffix) => {
          // Use spaces as separators to ensure word boundaries around the cue phrase
          const message = `${prefix} ${cuePhrase} ${suffix}`;
          const result = detector.analyze(message);
          expect(result.hasRecallIntent).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: memory-recall-fallback, Property 7: Temporal Parsing Invariant
describe("IntentDetector — Property 7: Temporal Parsing Invariant", () => {
  const detector = new IntentDetector({
    cuePhrasesEn: [...DEFAULT_CUE_PHRASES_EN],
    cuePhrasesHu: [...DEFAULT_CUE_PHRASES_HU],
  });

  /** Fixed temporal expressions (English + Hungarian). */
  const fixedTemporalExpressions = [
    "yesterday",
    "today",
    "last week",
    "this week",
    "last month",
    "tegnap",
    "ma",
    "múlt héten",
    "ezen a héten",
    "múlt hónapban",
  ];

  const nowArb = fc.date({
    min: new Date(2020, 0, 1),
    max: new Date(2030, 0, 1),
  });

  it("returns non-null with startTime <= endTime for fixed temporal expressions", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any recognized fixed temporal expression (English or Hungarian)
     * and any reasonable "now" date, parseTemporalReference should return
     * a non-null result where startTime <= endTime and both are positive integers.
     */
    fc.assert(
      fc.property(
        fc.constantFrom(...fixedTemporalExpressions),
        nowArb,
        (temporalExpr, now) => {
          const result = detector.parseTemporalReference(temporalExpr, now);
          expect(result).not.toBeNull();
          expect(result!.startTime).toBeLessThanOrEqual(result!.endTime);
          expect(Number.isInteger(result!.startTime)).toBe(true);
          expect(Number.isInteger(result!.endTime)).toBe(true);
          expect(result!.startTime).toBeGreaterThan(0);
          expect(result!.endTime).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns non-null with startTime <= endTime for 'N days ago' / 'N napja' expressions", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any "N days ago" or "N napja" expression with N in [1, 100],
     * parseTemporalReference should return a non-null result where
     * startTime <= endTime and both are positive integers.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom("days ago", "napja"),
        nowArb,
        (n, suffix, now) => {
          const message = `${n} ${suffix}`;
          const result = detector.parseTemporalReference(message, now);
          expect(result).not.toBeNull();
          expect(result!.startTime).toBeLessThanOrEqual(result!.endTime);
          expect(Number.isInteger(result!.startTime)).toBe(true);
          expect(Number.isInteger(result!.endTime)).toBe(true);
          expect(result!.startTime).toBeGreaterThan(0);
          expect(result!.endTime).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns non-null with startTime <= endTime for 'N weeks ago' / 'N hete' expressions", () => {
    /**
     * Validates: Requirements 3.1, 3.2
     *
     * For any "N weeks ago" or "N hete" expression with N in [1, 100],
     * parseTemporalReference should return a non-null result where
     * startTime <= endTime and both are positive integers.
     */
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom("weeks ago", "hete"),
        nowArb,
        (n, suffix, now) => {
          const message = `${n} ${suffix}`;
          const result = detector.parseTemporalReference(message, now);
          expect(result).not.toBeNull();
          expect(result!.startTime).toBeLessThanOrEqual(result!.endTime);
          expect(Number.isInteger(result!.startTime)).toBe(true);
          expect(Number.isInteger(result!.endTime)).toBe(true);
          expect(result!.startTime).toBeGreaterThan(0);
          expect(result!.endTime).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Unit Tests for IntentDetector ───────────────────────────────────────────
describe("IntentDetector — Unit Tests", () => {
  const detector = new IntentDetector({
    cuePhrasesEn: [...DEFAULT_CUE_PHRASES_EN],
    cuePhrasesHu: [...DEFAULT_CUE_PHRASES_HU],
  });

  // Fixed reference date: June 15, 2025 at noon
  const now = new Date(2025, 5, 15, 12, 0, 0);

  // ── Recall-intent cue detection ──────────────────────────────────────────

  it("detects English recall-intent cue phrase", () => {
    const result = detector.analyze("do you remember what I said?");
    expect(result.hasRecallIntent).toBe(true);
  });

  it("detects Hungarian recall-intent cue phrase", () => {
    const result = detector.analyze("emlékszel mit mondtam?");
    expect(result.hasRecallIntent).toBe(true);
  });

  it("returns no intent for a message without cue phrases", () => {
    const result = detector.analyze("what is the weather?");
    expect(result.hasRecallIntent).toBe(false);
  });

  // ── Temporal reference parsing ───────────────────────────────────────────

  it('parses "yesterday" into correct day boundaries', () => {
    const result = detector.parseTemporalReference("yesterday", now);
    expect(result).not.toBeNull();
    // June 14, 2025 00:00:00.000
    const expectedStart = new Date(2025, 5, 14, 0, 0, 0, 0).getTime();
    // June 14, 2025 23:59:59.999
    const expectedEnd = new Date(2025, 5, 14, 23, 59, 59, 999).getTime();
    expect(result!.startTime).toBe(expectedStart);
    expect(result!.endTime).toBe(expectedEnd);
  });

  it('parses "3 days ago" into correct range', () => {
    const result = detector.parseTemporalReference("3 days ago", now);
    expect(result).not.toBeNull();
    // June 12, 2025 00:00:00.000
    const expectedStart = new Date(2025, 5, 12, 0, 0, 0, 0).getTime();
    // June 12, 2025 23:59:59.999
    const expectedEnd = new Date(2025, 5, 12, 23, 59, 59, 999).getTime();
    expect(result!.startTime).toBe(expectedStart);
    expect(result!.endTime).toBe(expectedEnd);
  });

  it('parses "múlt héten" into correct week range', () => {
    const result = detector.parseTemporalReference("múlt héten", now);
    expect(result).not.toBeNull();
    // 7 days ago from June 15 = June 8, 00:00:00.000
    const expectedStart = new Date(2025, 5, 8, 0, 0, 0, 0).getTime();
    // yesterday = June 14, 23:59:59.999
    const expectedEnd = new Date(2025, 5, 14, 23, 59, 59, 999).getTime();
    expect(result!.startTime).toBe(expectedStart);
    expect(result!.endTime).toBe(expectedEnd);
  });

  // ── Combined intent + temporal ───────────────────────────────────────────

  it("detects both recall intent and temporal reference in a combined message", () => {
    const result = detector.analyze("remember what we discussed last week", now);
    expect(result.hasRecallIntent).toBe(true);
    expect(result.temporalRange).not.toBeNull();
    expect(result.temporalRange!.startTime).toBeLessThanOrEqual(result.temporalRange!.endTime);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("returns no-intent and no-temporal for an empty string", () => {
    const result = detector.analyze("", now);
    expect(result.hasRecallIntent).toBe(false);
    expect(result.temporalRange).toBeNull();
    expect(result.hasTopicKeywords).toBe(false);
  });

  it("returns hasTopicKeywords: false when only a cue phrase is present", () => {
    const result = detector.analyze("remember", now);
    expect(result.hasRecallIntent).toBe(true);
    expect(result.hasTopicKeywords).toBe(false);
  });

  it('returns temporalRange: null for malformed temporal "last blorp"', () => {
    const result = detector.parseTemporalReference("last blorp", now);
    expect(result).toBeNull();
  });
});
