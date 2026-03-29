import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";
import type { MemorySearchDeps } from "./memory-search-controller.js";
import type { MemorySearchResponse } from "./dashboard-config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockMemoryIndex(overrides?: {
  search?: ReturnType<typeof vi.fn>;
  substringSearch?: ReturnType<typeof vi.fn>;
  searchExtracted?: ReturnType<typeof vi.fn>;
  searchOriginal?: ReturnType<typeof vi.fn>;
  bumpRecallCount?: ReturnType<typeof vi.fn>;
}) {
  return {
    search: overrides?.search ?? vi.fn(() => []),
    substringSearch: overrides?.substringSearch ?? vi.fn(() => []),
    searchExtracted: overrides?.searchExtracted ?? vi.fn(() => []),
    searchOriginal: overrides?.searchOriginal ?? vi.fn(() => []),
    bumpRecallCount: overrides?.bumpRecallCount ?? vi.fn(),
  };
}

function mockDb(rows: unknown[] = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => rows),
    })),
  };
}

function makeDeps(opts?: {
  memoryIndex?: ReturnType<typeof mockMemoryIndex>;
  db?: ReturnType<typeof mockDb>;
}): MemorySearchDeps {
  return {
    memoryIndex: (opts?.memoryIndex ?? mockMemoryIndex()) as unknown as MemorySearchDeps["memoryIndex"],
    db: (opts?.db ?? mockDb()) as unknown as MemorySearchDeps["db"],
  };
}

function params(obj: Record<string, string>): URLSearchParams {
  return new URLSearchParams(obj);
}

// ── Validation ──────────────────────────────────────────────────────────────

describe("MemorySearchController.handle — validation", () => {
  it("returns 400 when keywords are missing", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ chatId: "1" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "keywords required" });
  });

  it("returns 400 when keywords are empty string", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "", chatId: "1" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "keywords required" });
  });

  it("returns 400 when keywords are only whitespace", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "  ", chatId: "1" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "keywords required" });
  });

  it("returns 400 when chatId is not a number", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test", chatId: "abc" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "chatId must be a number" });
  });

  it("returns 200 when chatId is omitted", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test" }));
    expect(result.status).toBe(200);
  });
});

// ── Stage selection ─────────────────────────────────────────────────────────

describe("MemorySearchController.handle — stage selection", () => {
  it("calls searchExtracted (S1) by default", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    await ctrl.handle(params({ keywords: "hello", chatId: "1" }));
    expect(mi.searchExtracted).toHaveBeenCalled();
  });

  it("calls searchOriginal (S2) when original param is provided", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    await ctrl.handle(params({ keywords: "hello", chatId: "1", original: "szia" }));
    expect(mi.searchOriginal).toHaveBeenCalled();
  });

  it("does not call searchOriginal (S2) without original param", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    await ctrl.handle(params({ keywords: "hello", chatId: "1" }));
    expect(mi.searchOriginal).not.toHaveBeenCalled();
  });

  it("passes stages filter to recall engine", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    await ctrl.handle(params({ keywords: "hello", chatId: "1", stages: "S1" }));
    // S1 runs searchExtracted
    expect(mi.searchExtracted).toHaveBeenCalled();
    // S4 (messages FTS) should not run since only S1 requested
    expect(mi.search).not.toHaveBeenCalled();
  });

  it("returns per-stage hit counts and timing", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    const result = await ctrl.handle(params({ keywords: "hello", chatId: "1", stages: "S1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.layers["S1"]).toBeDefined();
    expect(body.layers["S1"]!.hits).toBe(0);
    expect(typeof body.layers["S1"]!.ms).toBe("number");
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe("MemorySearchController.handle — results", () => {
  it("returns extracted memory results with rich attributes", async () => {
    const mi = mockMemoryIndex({
      searchExtracted: vi.fn(() => [{
        id: 1, content: "puppy info", content_original: "kiskutya info",
        memory_type: "fact", created_at: 1000, score: 5.0,
        trust: 5, integrity: 5, credibility: 5, classification: 0,
        tier: "extracted" as const,
      }]),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    const result = await ctrl.handle(params({ keywords: "puppy", chatId: "1", stages: "S1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.content).toBe("puppy info");
    expect(body.results[0]!.contentOriginal).toBe("kiskutya info");
    expect(body.results[0]!.trust).toBe(5);
  });

  it("limits results to 10", async () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      id: i, content: `memory ${i}`, created_at: i * 1000,
      memory_type: "fact", score: 25 - i, tier: "extracted" as const,
    }));
    const mi = mockMemoryIndex({ searchExtracted: vi.fn(() => results) });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    const result = await ctrl.handle(params({ keywords: "test", chatId: "1", stages: "S1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.results.length).toBeLessThanOrEqual(10);
  });

  it("bumps recall count for returned extracted memories", async () => {
    const mi = mockMemoryIndex({
      searchExtracted: vi.fn(() => [{
        id: 42, content: "test", created_at: 1000, score: 5.0, tier: "extracted" as const,
      }]),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    await ctrl.handle(params({ keywords: "test", chatId: "1", stages: "S1" }));
    expect(mi.bumpRecallCount).toHaveBeenCalledWith([42]);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("MemorySearchController.handle — error handling", () => {
  it("returns 500 when recall engine throws", async () => {
    const mi = mockMemoryIndex({
      searchExtracted: vi.fn(() => { throw new Error("DB corrupt"); }),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    const result = await ctrl.handle(params({ keywords: "test", chatId: "1" }));
    expect(result.status).toBe(500);
  });
});
