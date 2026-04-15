import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";
import type { MemorySearchDeps } from "./memory-search-controller.js";
import type { MemorySearchResponse } from "../components/dashboard/dashboard-config.js";

const defaultRecallResult = {
  results: [],
  stages: {},
  shortCircuitAfter: null,
  extractedIds: [],
};

function makeDeps(opts?: { recallResult?: typeof defaultRecallResult }): MemorySearchDeps {
  const mockMemory = {
    getDistinctChatIds: vi.fn(() => []),
    getAllExtractedMemories: vi.fn(() => []),
    getAllEntities: vi.fn(() => []),
    getAllEntityLinks: vi.fn(() => []),
    recallSearch: vi.fn(async () => opts?.recallResult ?? defaultRecallResult),
    bumpRecallCount: vi.fn(),
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
    const result = await ctrl.handle(params({ userId: "1" }));
    expect(result.status).toBe(400);
  });

  it("returns 400 when keywords are empty string", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "", userId: "1" }));
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
    const deps = makeDeps();
    const ctrl = new MemorySearchController(deps);
    (deps.memory.recallSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: [], stages: { Sf: { hits: [], ms: 1 } }, shortCircuitAfter: null, extractedIds: [] });
    await ctrl.handle(params({ keywords: "hello", userId: "1" }));
    expect(deps.memory.recallSearch).toHaveBeenCalledWith(expect.objectContaining({ translated: ["hello"] }));
  });

  it("passes original param to recallSearch", async () => {
    const deps = makeDeps();
    const ctrl = new MemorySearchController(deps);
    await ctrl.handle(params({ keywords: "hello", userId: "1", original: "szia" }));
    expect(deps.memory.recallSearch).toHaveBeenCalledWith(expect.objectContaining({ original: "szia" }));
  });

  it("passes stages filter to recall engine", async () => {
    const deps = makeDeps();
    const ctrl = new MemorySearchController(deps);
    (deps.memory.recallSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ results: [], stages: { Sf: { hits: [], ms: 1 } }, shortCircuitAfter: null, extractedIds: [] });
    await ctrl.handle(params({ keywords: "hello", userId: "1", stages: "Sf" }));
    expect(deps.memory.recallSearch).toHaveBeenCalledWith(expect.objectContaining({ stages: ["Sf"] }));
  });

  it("returns per-stage hit counts and timing", async () => {
    const deps = makeDeps({ recallResult: { results: [], stages: { Sf: { hits: [], ms: 2 } }, shortCircuitAfter: null, extractedIds: [] } as any });
    const ctrl = new MemorySearchController(deps);
    const result = await ctrl.handle(params({ keywords: "hello", userId: "1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.layers["Sf"]).toBeDefined();
    expect(body.layers["Sf"]!.hits).toBe(0);
    expect(typeof body.layers["Sf"]!.ms).toBe("number");
  });
});

describe("MemorySearchController.handle — results", () => {
  it("returns recall results with rich attributes", async () => {
    const deps = makeDeps();
    (deps.memory.recallSearch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      results: [{
        content: "puppy info", date: "2026-01-01T00:00:00", source: "Sf:porter", score: 0.95,
        contentOriginal: "kiskutya info", memoryType: "fact", trust: 5, integrity: 5, credibility: 5, classification: 0,
      }],
      stages: { Sf: { hits: [{ content: "puppy info", date: "2026-01-01T00:00:00", source: "Sf:porter", score: 0.95 }], ms: 1 } },
      shortCircuitAfter: null, extractedIds: [1],
    });
    const ctrl = new MemorySearchController(deps);
    const result = await ctrl.handle(params({ keywords: "puppy", userId: "1" }));
    const body = result.body as MemorySearchResponse;
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.content).toBe("puppy info");
    expect(deps.memory.bumpRecallCount).toHaveBeenCalledWith([1]);
  });
});

describe("MemorySearchController.handle — error handling", () => {
  it("returns 500 when recall engine throws", async () => {
    const deps = makeDeps();
    (deps.memory.recallSearch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("DB corrupt"));
    const ctrl = new MemorySearchController(deps);
    const result = await ctrl.handle(params({ keywords: "test", userId: "1" }));
    expect(result.status).toBe(500);
  });
});
