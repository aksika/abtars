import { describe, it, expect } from "vitest";
import { applyTemporalDecay } from "./memory-search-tool.js";
import type { MemorySearchResult } from "../types/memory.js";

const MS_PER_DAY = 86_400_000;

function makeResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    content: "test memory",
    source_timestamp: Date.now(),
    tier: "extracted",
    score: 1.0,
    ...overrides,
  };
}

describe("applyTemporalDecay", () => {
  it("returns multiplier 1.0 for a 0-day-old memory", () => {
    const now = Date.now();
    const results = [makeResult({ score: 1.0, source_timestamp: now })];
    const decayed = applyTemporalDecay(results, now, 30);
    expect(decayed[0].score).toBeCloseTo(1.0, 10);
  });

  it("returns multiplier 0.5 for a memory exactly half-life days old", () => {
    const now = Date.now();
    const halfLife = 30;
    const ts = now - halfLife * MS_PER_DAY;
    const results = [makeResult({ score: 1.0, source_timestamp: ts })];
    const decayed = applyTemporalDecay(results, now, halfLife);
    expect(decayed[0].score).toBeCloseTo(0.5, 10);
  });

  it("newer memory scores higher than older memory with same base score", () => {
    const now = Date.now();
    const newer = makeResult({ score: 1.0, source_timestamp: now - 5 * MS_PER_DAY });
    const older = makeResult({ score: 1.0, source_timestamp: now - 60 * MS_PER_DAY });
    const [dNewer, dOlder] = applyTemporalDecay([newer, older], now, 30);
    expect(dNewer.score).toBeGreaterThan(dOlder.score);
  });

  it("applies decay as multiplier on base score", () => {
    const now = Date.now();
    const halfLife = 30;
    const ageDays = 15;
    const baseScore = 0.8;
    const ts = now - ageDays * MS_PER_DAY;
    const results = [makeResult({ score: baseScore, source_timestamp: ts })];
    const decayed = applyTemporalDecay(results, now, halfLife);
    const expected = baseScore * Math.pow(2, -ageDays / halfLife);
    expect(decayed[0].score).toBeCloseTo(expected, 10);
  });

  it("does not mutate the original results array", () => {
    const now = Date.now();
    const original = [makeResult({ score: 1.0, source_timestamp: now - 10 * MS_PER_DAY })];
    const originalScore = original[0].score;
    applyTemporalDecay(original, now, 30);
    expect(original[0].score).toBe(originalScore);
  });

  it("handles empty results array", () => {
    const decayed = applyTemporalDecay([], Date.now(), 30);
    expect(decayed).toEqual([]);
  });

  it("returns base scores on computation error (graceful degradation)", () => {
    const now = Date.now();
    const results = [makeResult({ score: 0.9, source_timestamp: now })];
    // Force an error by passing NaN halfLife — Math.pow(2, -x/NaN) = NaN
    // but that won't throw. Instead, pass a proxy that throws on map.
    const badResults = Object.create(results);
    badResults.map = () => { throw new Error("boom"); };
    const decayed = applyTemporalDecay(badResults, now, 30);
    expect(decayed).toBe(badResults);
  });
});

import { applyMMR } from "./memory-search-tool.js";

describe("applyMMR", () => {
  it("returns empty array as-is", () => {
    expect(applyMMR([], 0.7)).toEqual([]);
  });

  it("returns single result as-is (fewer than 2)", () => {
    const results = [makeResult({ content: "hello world", score: 0.9 })];
    expect(applyMMR(results, 0.7)).toEqual(results);
  });

  it("first result is the highest-scored entry", () => {
    const results = [
      makeResult({ content: "alpha beta", score: 0.5 }),
      makeResult({ content: "gamma delta", score: 0.9 }),
      makeResult({ content: "epsilon zeta", score: 0.7 }),
    ];
    const reranked = applyMMR(results, 0.7);
    expect(reranked[0].score).toBe(0.9);
    expect(reranked[0].content).toBe("gamma delta");
  });

  it("penalizes candidates similar to already-selected results", () => {
    const results = [
      makeResult({ content: "the quick brown fox", score: 1.0 }),
      makeResult({ content: "the quick brown dog", score: 0.9 }),
      makeResult({ content: "completely different topic here", score: 0.85 }),
    ];
    const reranked = applyMMR(results, 0.5);
    // First pick: highest score
    expect(reranked[0].content).toBe("the quick brown fox");
    // Second pick: "completely different" should be preferred over "quick brown dog"
    // because it has lower similarity to the first pick despite lower score
    expect(reranked[1].content).toBe("completely different topic here");
  });

  it("with lambda=1.0 (pure relevance), preserves score order", () => {
    const results = [
      makeResult({ content: "the quick brown fox", score: 0.9 }),
      makeResult({ content: "the quick brown dog", score: 0.8 }),
      makeResult({ content: "something else entirely", score: 0.7 }),
    ];
    const reranked = applyMMR(results, 1.0);
    expect(reranked.map((r) => r.score)).toEqual([0.9, 0.8, 0.7]);
  });

  it("with lambda=0.0 (pure diversity), maximizes diversity", () => {
    const results = [
      makeResult({ content: "cat dog bird", score: 1.0 }),
      makeResult({ content: "cat dog fish", score: 0.95 }),
      makeResult({ content: "completely unrelated words here", score: 0.5 }),
    ];
    const reranked = applyMMR(results, 0.0);
    // First is still highest scored
    expect(reranked[0].content).toBe("cat dog bird");
    // Second should be the most different from first
    expect(reranked[1].content).toBe("completely unrelated words here");
  });

  it("preserves all results (no results lost)", () => {
    const results = [
      makeResult({ content: "alpha", score: 0.9 }),
      makeResult({ content: "beta", score: 0.8 }),
      makeResult({ content: "gamma", score: 0.7 }),
    ];
    const reranked = applyMMR(results, 0.7);
    expect(reranked).toHaveLength(3);
  });

  it("does not mutate the original array", () => {
    const results = [
      makeResult({ content: "first item", score: 0.9 }),
      makeResult({ content: "second item", score: 0.8 }),
    ];
    const copy = [...results];
    applyMMR(results, 0.7);
    expect(results).toEqual(copy);
  });

  it("returns pre-MMR order on computation error (graceful degradation)", () => {
    const results = [
      makeResult({ content: "a", score: 0.9 }),
      makeResult({ content: "b", score: 0.8 }),
    ];
    // Force an error by making .map throw on the results array
    const badResults = Object.create(results);
    Object.defineProperty(badResults, "length", { value: 2 });
    badResults.map = () => { throw new Error("boom"); };
    const reranked = applyMMR(badResults, 0.7);
    expect(reranked).toBe(badResults);
  });
});
