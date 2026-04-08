import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";
import type { MemorySearchDeps } from "./memory-search-controller.js";
import type { MemorySearchResponse } from "../components/dashboard/dashboard-config.js";

vi.mock("../memory/recall-engine.js", () => ({
  recallSearch: vi.fn(async () => ({
    results: [],
    stages: {},
    shortCircuitAfter: null,
    extractedIds: [],
  })),
}));

import { recallSearch } from "../memory/recall-engine.js";
const mockRecall = vi.mocked(recallSearch);

function mockMemoryIndex() {
  return {
    search: vi.fn(() => []),
    substringSearch: vi.fn(() => []),
    searchExtracted: vi.fn(() => []),
    bumpRecallCount: vi.fn(),
  };
}

function mockDb() {
  return {
    prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
  };
}

function makeDeps(opts?: { memoryIndex?: ReturnType<typeof mockMemoryIndex>; db?: ReturnType<typeof mockDb> }): MemorySearchDeps {
  const db = (opts?.db ?? mockDb()) as any;
  const mi = (opts?.memoryIndex ?? mockMemoryIndex()) as any;
  const mockMemory = {
    store: {
      getDistinctChatIds: () => [],
      getAllExtractedMemories: () => [],
      getAllEntities: () => [],
      getAllEntityLinks: () => [],
    },
    getDatabase: () => db,
    getMemoryIndex: () => mi,
  } as unknown as MemorySearchDeps["memory"];
  return { memory: mockMemory };
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
  });

  it("returns 400 when keywords are empty string", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "", chatId: "1" }));
    expect(result.status).toBe(400);
  });

  it("returns 400 when chatId is not a number", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test", chatId: "abc" }));
    expect(result.status).toBe(400);
  });

  it("returns 200 when chatId is omitted", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test" }));
    expect(result.status).toBe(200);
  });
});

// ── Stage selection ─────────────────────────────────────────────────────────

describe("MemorySearchController.handle — stage selection", () => {
  it("calls recallSearch with translated keywords", async () => {
    mockRecall.mockResolvedValueOnce({ results: [], stages: { Sf: { hits: [], ms: 1 } }, shortCircuitAfter: null, extractedIds: [] });
    const ctrl = new MemorySearchController(makeDeps());
    await ctrl.handle(params({ keywords: "hello", chatId: "1" }));
    expect(mockRecall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ translated: ["hello"] }));
  });

  it("passes original param to recallSearch", async () => {
    mockRecall.mockResolvedValueOnce({ results: [], stages: {}, shortCircuitAfter: null, extractedIds: [] });
    const ctrl = new MemorySearchController(makeDeps());
    await ctrl.handle(params({ keywords: "hello", chatId: "1", original: "szia" }));
    expect(mockRecall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ original: "szia" }));
  });

  it("passes stages filter to recall engine", async () => {
    mockRecall.mockResolvedValueOnce({ results: [], stages: { Sf: { hits: [], ms: 1 } }, shortCircuitAfter: null, extractedIds: [] });
    const ctrl = new MemorySearchController(makeDeps());
    await ctrl.handle(params({ keywords: "hello", chatId: "1", stages: "Sf" }));
    expect(mockRecall).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ stages: ["Sf"] }));
  });

  it("returns per-stage hit counts and timing", async () => {
    mockRecall.mockResolvedValueOnce({
      results: [], stages: { Sf: { hits: [], ms: 2 } }, shortCircuitAfter: null, extractedIds: [],
    });
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "hello", chatId: "1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.layers["Sf"]).toBeDefined();
    expect(body.layers["Sf"]!.hits).toBe(0);
    expect(typeof body.layers["Sf"]!.ms).toBe("number");
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe("MemorySearchController.handle — results", () => {
  it("returns recall results with rich attributes", async () => {
    mockRecall.mockResolvedValueOnce({
      results: [{
        content: "puppy info", date: "2026-01-01T00:00:00", source: "Sf:porter", score: 0.95,
        contentOriginal: "kiskutya info", memoryType: "fact", trust: 5, integrity: 5, credibility: 5, classification: 0,
      }],
      stages: { Sf: { hits: [{ content: "puppy info", date: "2026-01-01T00:00:00", source: "Sf:porter", score: 0.95 }], ms: 1 } },
      shortCircuitAfter: null, extractedIds: [1],
    });
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));
    const result = await ctrl.handle(params({ keywords: "puppy", chatId: "1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.content).toBe("puppy info");
    expect(mi.bumpRecallCount).toHaveBeenCalledWith([1]);
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("MemorySearchController.handle — error handling", () => {
  it("returns 500 when recall engine throws", async () => {
    mockRecall.mockRejectedValueOnce(new Error("DB corrupt"));
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test", chatId: "1" }));
    expect(result.status).toBe(500);
  });
});
