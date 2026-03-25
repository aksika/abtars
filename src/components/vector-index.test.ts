import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cosineSimilarity, VectorIndex } from "./vector-index.js";
import { EmbeddingProvider } from "./embedding-provider.js";
import { MemoryIndex } from "./memory-index.js";
import { initializeDatabase } from "./memory-db.js";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "../tests/helpers.js";
import type Database from "better-sqlite3";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for empty vectors", () => {
    const a = new Float32Array([]);
    const b = new Float32Array([]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("handles scaled vectors (same direction)", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});

describe("reciprocal rank fusion ordering", () => {
  /**
   * Pure RRF computation extracted for testability.
   * Given two ranked lists of IDs, compute fused scores and return sorted.
   */
  function computeRRF(
    ftsIds: number[],
    vectorIds: number[],
    k = 60,
  ): Array<{ id: number; score: number }> {
    const ftsRank = new Map<number, number>();
    for (let i = 0; i < ftsIds.length; i++) {
      ftsRank.set(ftsIds[i]!, i + 1);
    }
    const vecRank = new Map<number, number>();
    for (let i = 0; i < vectorIds.length; i++) {
      vecRank.set(vectorIds[i]!, i + 1);
    }

    const allIds = new Set([...ftsIds, ...vectorIds]);
    const scored: Array<{ id: number; score: number }> = [];
    for (const id of allIds) {
      let score = 0;
      const fr = ftsRank.get(id);
      const vr = vecRank.get(id);
      if (fr !== undefined) score += 1 / (k + fr);
      if (vr !== undefined) score += 1 / (k + vr);
      scored.push({ id, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
  }

  it("items in both lists rank higher than items in one list", () => {
    const fts = [1, 2, 3];
    const vec = [2, 4, 1];
    const result = computeRRF(fts, vec);

    // IDs 1 and 2 appear in both lists, so they should rank highest
    const topIds = result.slice(0, 2).map((r) => r.id);
    expect(topIds).toContain(1);
    expect(topIds).toContain(2);
  });

  it("results are sorted by descending fused score", () => {
    const fts = [10, 20, 30, 40];
    const vec = [30, 10, 50];
    const result = computeRRF(fts, vec);

    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.score).toBeGreaterThanOrEqual(result[i + 1]!.score);
    }
  });

  it("score formula matches 1/(k+rank_fts) + 1/(k+rank_vector)", () => {
    const k = 60;
    const fts = [1, 2];
    const vec = [2, 3];
    const result = computeRRF(fts, vec, k);

    const scoreMap = new Map(result.map((r) => [r.id, r.score]));

    // ID 1: only in FTS at rank 1
    expect(scoreMap.get(1)).toBeCloseTo(1 / (k + 1), 10);
    // ID 2: FTS rank 2, vector rank 1
    expect(scoreMap.get(2)).toBeCloseTo(1 / (k + 2) + 1 / (k + 1), 10);
    // ID 3: only in vector at rank 2
    expect(scoreMap.get(3)).toBeCloseTo(1 / (k + 2), 10);
  });

  it("empty lists produce empty results", () => {
    const result = computeRRF([], []);
    expect(result).toEqual([]);
  });

  it("single list produces correct scores", () => {
    const k = 60;
    const result = computeRRF([5, 10], [], k);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe(5);
    expect(result[0]!.score).toBeCloseTo(1 / (k + 1), 10);
    expect(result[1]!.id).toBe(10);
    expect(result[1]!.score).toBeCloseTo(1 / (k + 2), 10);
  });
});

describe("MemoryManager.hybridSearch — FTS-only mode", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hybrid-test-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir, { vectorEnabled: false }));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("search returns FTS results when vector is disabled", async () => {
    // We need to access the memoryIndex to index a message directly
    // Use the manager's internal DB via a workaround: create a separate MemoryIndex
    const db = initializeDatabase(join(tmpDir, "memory.db"));
    const memoryIndex = new MemoryIndex(db);
    memoryIndex.index({
      role: "user",
      content: "The quick brown fox jumps over the lazy dog",
      timestamp: Date.now(),
      chatId: 1,
      sessionId: "s1",
    });
    db.close();

    // Re-initialize manager to pick up the indexed data
    manager.close();
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir, { vectorEnabled: false }));
    await manager.initialize();

    const results = await manager.search("fox");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.record.content).toContain("fox");
  });

  it("search returns empty array for no matches", async () => {
    const results = await manager.search("nonexistentword");
    expect(results).toEqual([]);
  });

  it("search returns empty when memory is disabled", async () => {
    const disabledManager = new MemoryManager(makeMemoryTestConfig(tmpDir, { memoryEnabled: false }));
    await disabledManager.initialize();
    const results = await disabledManager.search("anything");
    expect(results).toEqual([]);
    disabledManager.close();
  });
});
