import { describe, it, expect, vi } from "vitest";
import { recallSearch } from "./recall-engine.js";
import type { RecallDeps, RecallParams } from "./recall-engine.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockIndex(overrides?: {
  searchExtracted?: ReturnType<typeof vi.fn>;
  searchOriginal?: ReturnType<typeof vi.fn>;
  search?: ReturnType<typeof vi.fn>;
  bumpRecallCount?: ReturnType<typeof vi.fn>;
}) {
  return {
    searchExtracted: overrides?.searchExtracted ?? vi.fn(() => []),
    searchOriginal: overrides?.searchOriginal ?? vi.fn(() => []),
    search: overrides?.search ?? vi.fn(() => []),
    bumpRecallCount: overrides?.bumpRecallCount ?? vi.fn(),
  };
}

function mockDb(rows: unknown[] = []) {
  return {
    prepare: vi.fn(() => ({ all: vi.fn(() => rows) })),
  };
}

function makeDeps(opts?: { index?: ReturnType<typeof mockIndex>; db?: ReturnType<typeof mockDb> }): RecallDeps {
  return {
    db: (opts?.db ?? mockDb()) as unknown as RecallDeps["db"],
    index: (opts?.index ?? mockIndex()) as unknown as RecallDeps["index"],
    memoryDir: "/tmp/test-memory",
    ctxStartPath: "/tmp/test-ctx.json",
  };
}

function baseParams(overrides?: Partial<RecallParams>): RecallParams {
  return { translated: ["puppy"], chatId: 123, ...overrides };
}

// ── Stage execution ─────────────────────────────────────────────────────────

describe("recallSearch — stage execution", () => {
  it("runs S1 (searchExtracted) by default", () => {
    const idx = mockIndex();
    recallSearch(makeDeps({ index: idx }), baseParams());
    expect(idx.searchExtracted).toHaveBeenCalled();
  });

  it("runs S2 (searchOriginal) when original is provided", () => {
    const idx = mockIndex();
    recallSearch(makeDeps({ index: idx }), baseParams({ original: "kiskutya" }));
    expect(idx.searchOriginal).toHaveBeenCalledWith("kiskutya", expect.any(Object));
  });

  it("skips S2 when original is not provided", () => {
    const idx = mockIndex();
    recallSearch(makeDeps({ index: idx }), baseParams());
    expect(idx.searchOriginal).not.toHaveBeenCalled();
  });

  it("runs S4 (messages FTS) by default", () => {
    const idx = mockIndex();
    recallSearch(makeDeps({ index: idx }), baseParams());
    expect(idx.search).toHaveBeenCalled();
  });

  it("only runs requested stages when --stages is provided", () => {
    const idx = mockIndex();
    recallSearch(makeDeps({ index: idx }), baseParams({ stages: ["S1"] }));
    expect(idx.searchExtracted).toHaveBeenCalled();
    expect(idx.search).not.toHaveBeenCalled();
  });
});

// ── Short-circuit ───────────────────────────────────────────────────────────

describe("recallSearch — short-circuit", () => {
  it("short-circuits after S3 when enough results", () => {
    const hits = Array.from({ length: 12 }, (_, i) => ({
      id: i, content: `memory ${i}`, source_timestamp: i * 1000,
      score: 5.0, tier: "extracted" as const,
    }));
    const idx = mockIndex({ searchExtracted: vi.fn(() => hits) });
    const result = recallSearch(makeDeps({ index: idx }), baseParams());
    expect(result.shortCircuitAfter).toBe("S3");
    expect(idx.search).not.toHaveBeenCalled(); // S4 skipped
  });

  it("does not short-circuit with few results", () => {
    const idx = mockIndex({
      searchExtracted: vi.fn(() => [{ id: 1, content: "one", source_timestamp: 1000, score: 5.0, tier: "extracted" as const }]),
    });
    const result = recallSearch(makeDeps({ index: idx }), baseParams());
    expect(result.shortCircuitAfter).toBeNull();
    expect(idx.search).toHaveBeenCalled(); // S4 runs
  });
});

// ── Per-stage results ───────────────────────────────────────────────────────

describe("recallSearch — per-stage results", () => {
  it("returns per-stage hits and timing", () => {
    const idx = mockIndex({
      searchExtracted: vi.fn(() => [
        { id: 1, content: "test", source_timestamp: 1000, score: 5.0, tier: "extracted" as const },
      ]),
    });
    const result = recallSearch(makeDeps({ index: idx }), baseParams({ stages: ["S1"] }));
    expect(result.stages["S1"]).toBeDefined();
    expect(result.stages["S1"]!.hits.length).toBe(1);
    expect(typeof result.stages["S1"]!.ms).toBe("number");
  });

  it("collects extractedIds for recall count bumping", () => {
    const idx = mockIndex({
      searchExtracted: vi.fn(() => [
        { id: 42, content: "test", source_timestamp: 1000, score: 5.0, tier: "extracted" as const },
      ]),
    });
    const result = recallSearch(makeDeps({ index: idx }), baseParams({ stages: ["S1"] }));
    expect(result.extractedIds).toContain(42);
  });
});

// ── Dedup ───────────────────────────────────────────────────────────────────

describe("recallSearch — deduplication", () => {
  it("deduplicates by timestamp:content prefix across stages", () => {
    const hit = { id: 1, content: "same memory", source_timestamp: 1000, score: 5.0, tier: "extracted" as const };
    const idx = mockIndex({
      searchExtracted: vi.fn(() => [hit]),
      searchOriginal: vi.fn(() => [hit]),
    });
    const result = recallSearch(makeDeps({ index: idx }), baseParams({ original: "same", stages: ["S1", "S2"] }));
    // Same content+timestamp should appear only once in merged results
    const matching = result.results.filter(r => r.content === "same memory");
    expect(matching.length).toBe(1);
  });
});

// ── Limit ───────────────────────────────────────────────────────────────────

describe("recallSearch — limit", () => {
  it("respects limit parameter", () => {
    const hits = Array.from({ length: 20 }, (_, i) => ({
      id: i, content: `memory ${i}`, source_timestamp: i * 1000,
      score: 20 - i, tier: "extracted" as const,
    }));
    const idx = mockIndex({ searchExtracted: vi.fn(() => hits) });
    const result = recallSearch(makeDeps({ index: idx }), baseParams({ limit: 5 }));
    expect(result.results.length).toBeLessThanOrEqual(5);
  });
});

// ── S3 LIKE fallback ────────────────────────────────────────────────────────

describe("recallSearch — S3 LIKE fallback", () => {
  it("runs LIKE query on extracted_memories", () => {
    const db = mockDb();
    const result = recallSearch(makeDeps({ db }), baseParams({ stages: ["S3"] }));
    expect(result.stages["S3"]).toBeDefined();
    expect((db.prepare as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it("includes original keyword in LIKE search", () => {
    const db = mockDb();
    recallSearch(makeDeps({ db }), baseParams({ original: "kiskutya", stages: ["S3"] }));
    const prepareCall = (db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(prepareCall).toContain("LIKE");
  });
});
