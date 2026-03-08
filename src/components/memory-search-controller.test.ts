import { describe, it, expect, vi } from "vitest";
import { MemorySearchController } from "./memory-search-controller.js";
import type { MemorySearchDeps } from "./memory-search-controller.js";
import type { MemorySearchResponse } from "./dashboard-config.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock MemoryIndex with all search methods stubbed. */
function mockMemoryIndex(overrides?: {
  search?: ReturnType<typeof vi.fn>;
  substringSearch?: ReturnType<typeof vi.fn>;
  searchExtracted?: ReturnType<typeof vi.fn>;
  searchOriginal?: ReturnType<typeof vi.fn>;
}) {
  return {
    search: overrides?.search ?? vi.fn(() => []),
    substringSearch: overrides?.substringSearch ?? vi.fn(() => []),
    searchExtracted: overrides?.searchExtracted ?? vi.fn(() => []),
    searchOriginal: overrides?.searchOriginal ?? vi.fn(() => []),
  };
}

/** Create a mock database with a prepare().all() chain. */
function mockDb(rows: unknown[] = []) {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => rows),
    })),
  };
}

/** Build MemorySearchDeps from mocks. */
function makeDeps(opts?: {
  memoryIndex?: ReturnType<typeof mockMemoryIndex>;
  db?: ReturnType<typeof mockDb>;
}): MemorySearchDeps {
  return {
    memoryIndex: (opts?.memoryIndex ?? mockMemoryIndex()) as unknown as MemorySearchDeps["memoryIndex"],
    db: (opts?.db ?? mockDb()) as unknown as MemorySearchDeps["db"],
  };
}

/** Build URLSearchParams from a plain object. */
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

  it("searches all chats when chatId is omitted", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test" }));
    expect(result.status).toBe(200);
  });

  it("returns 400 when chatId is not a number", async () => {
    const ctrl = new MemorySearchController(makeDeps());
    const result = await ctrl.handle(params({ keywords: "test", chatId: "abc" }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "chatId must be a number" });
  });
});

// ── Layer selection ─────────────────────────────────────────────────────────

describe("MemorySearchController.handle — layer selection", () => {
  it("executes all default layers (L1-L4) when layers param is omitted", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "hello", chatId: "1" }));

    expect(result.status).toBe(200);
    // L1 calls: search + substringSearch (+ possibly relaxed search)
    expect(mi.search).toHaveBeenCalled();
    expect(mi.substringSearch).toHaveBeenCalled();
    // L2 calls: searchExtracted
    expect(mi.searchExtracted).toHaveBeenCalled();
    // L4 without original param → skipped
    expect(mi.searchOriginal).not.toHaveBeenCalled();

    const body = result.body as MemorySearchResponse;
    expect(body.layers["L1"]?.status).toBe("ok");
    expect(body.layers["L2"]?.status).toBe("ok");
    expect(body.layers["L3"]?.status).toBe("ok");
    expect(body.layers["L4"]?.status).toBe("skipped");
    expect(body.layers["L5"]?.status).toBe("skipped");
  });

  it("only executes L2 when layers=L2", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "hello", chatId: "1", layers: "L2" }));

    expect(result.status).toBe(200);
    expect(mi.search).not.toHaveBeenCalled();
    expect(mi.substringSearch).not.toHaveBeenCalled();
    expect(mi.searchExtracted).toHaveBeenCalled();
    expect(mi.searchOriginal).not.toHaveBeenCalled();

    const body = result.body as MemorySearchResponse;
    expect(body.layers["L1"]?.status).toBe("skipped");
    expect(body.layers["L2"]?.status).toBe("ok");
  });

  it("executes L4 only when both layers includes L4 and original param is provided", async () => {
    const mi = mockMemoryIndex();
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(
      params({ keywords: "hello", chatId: "1", layers: "L4", original: "szia" }),
    );

    expect(result.status).toBe(200);
    expect(mi.searchOriginal).toHaveBeenCalled();

    const body = result.body as MemorySearchResponse;
    expect(body.layers["L4"]?.status).toBe("ok");
  });

  it("returns not_implemented for L5", async () => {
    const ctrl = new MemorySearchController(makeDeps());

    const result = await ctrl.handle(
      params({ keywords: "hello", chatId: "1", layers: "L5" }),
    );

    expect(result.status).toBe(200);
    const body = result.body as MemorySearchResponse;
    expect(body.layers["L5"]?.status).toBe("not_implemented");
    expect(body.results).toEqual([]);
  });
});

// ── Deduplication and ordering ──────────────────────────────────────────────

describe("MemorySearchController.handle — deduplication and ordering", () => {
  it("deduplicates results by timestamp+content prefix and keeps highest score", async () => {
    const ts = Date.now();
    const content = "This is a test message with enough content to deduplicate";
    const mi = mockMemoryIndex({
      search: vi.fn(() => [
        { record: { content, timestamp: ts, chatId: 1, sessionId: "s1", role: "user" }, score: 5.0 },
      ]),
      substringSearch: vi.fn(() => [
        { record: { content, timestamp: ts, chatId: 1, sessionId: "s1", role: "user" }, score: 0.3 },
      ]),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "test", chatId: "1", layers: "L1" }));

    const body = result.body as MemorySearchResponse;
    // Same content+timestamp should be deduplicated — only the highest score kept
    const matching = body.results.filter((r) => r.content === content);
    expect(matching.length).toBe(1);
    expect(matching[0]!.score).toBe(5.0);
  });

  it("sorts results by score descending", async () => {
    const mi = mockMemoryIndex({
      search: vi.fn(() => [
        { record: { content: "low score", timestamp: 1000, chatId: 1, sessionId: "s1", role: "user" }, score: 1.0 },
        { record: { content: "high score", timestamp: 2000, chatId: 1, sessionId: "s1", role: "user" }, score: 10.0 },
        { record: { content: "mid score", timestamp: 3000, chatId: 1, sessionId: "s1", role: "user" }, score: 5.0 },
      ]),
      substringSearch: vi.fn(() => []),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "test", chatId: "1", layers: "L1" }));

    const body = result.body as MemorySearchResponse;
    const scores = body.results.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
    }
  });

  it("limits results to 10", async () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      record: { content: `message ${i}`, timestamp: i * 1000, chatId: 1, sessionId: "s1", role: "user" as const },
      score: 25 - i,
    }));
    const mi = mockMemoryIndex({
      search: vi.fn(() => results),
      substringSearch: vi.fn(() => []),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "test", chatId: "1", layers: "L1" }));

    const body = result.body as MemorySearchResponse;
    expect(body.results.length).toBeLessThanOrEqual(10);
  });
});

// ── L3 compaction search ────────────────────────────────────────────────────

describe("MemorySearchController.handle — L3 compaction search", () => {
  it("queries compactions table with LIKE for each keyword", async () => {
    const db = mockDb([
      { id: 1, tier: "weekly", timestamp: 1700000000000, summary: "Weekly summary about testing" },
    ]);
    const ctrl = new MemorySearchController(makeDeps({ db }));

    const result = await ctrl.handle(
      params({ keywords: "testing", chatId: "1", layers: "L3" }),
    );

    expect(result.status).toBe(200);
    expect(db.prepare).toHaveBeenCalled();
    const body = result.body as MemorySearchResponse;
    expect(body.layers["L3"]?.status).toBe("ok");
    expect(body.results.length).toBe(1);
    expect(body.results[0]!.source).toBe("L3:compaction:weekly");
  });
});

// ── Error handling ──────────────────────────────────────────────────────────

describe("MemorySearchController.handle — error handling", () => {
  it("continues with partial results when a layer throws", async () => {
    const mi = mockMemoryIndex({
      search: vi.fn(() => { throw new Error("FTS5 error"); }),
      substringSearch: vi.fn(() => { throw new Error("substring error"); }),
      searchExtracted: vi.fn(() => [
        { content: "extracted result", source_timestamp: 1000, memory_type: "fact", tier: "extracted", score: 3.0 },
      ]),
    });
    const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

    const result = await ctrl.handle(params({ keywords: "test", chatId: "1", layers: "L1,L2" }));

    expect(result.status).toBe(200);
    const body = result.body as MemorySearchResponse;
    // L2 should still have results even though L1 threw
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results.some((r) => r.source === "L2:extracted")).toBe(true);
  });
});

// Feature: kiro-professor-webui, Property 6: Memory search layer selection
import fc from "fast-check";

describe("MemorySearchController — Property 6: Memory search layer selection", () => {
  // **Validates: Requirements 8.3, 8.4**

  it("only executes search stages for selected layers; unselected layers produce no results; L5 always returns not_implemented", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.subarray(["L1", "L2", "L3", "L4", "L5"] as const, { minLength: 1 }),
        async (selectedLayers) => {
          const mi = mockMemoryIndex();
          const db = mockDb();
          const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi, db }));

          const searchParams: Record<string, string> = {
            keywords: "test",
            chatId: "1",
            layers: selectedLayers.join(","),
          };
          // Always provide `original` so L4 can execute when selected
          searchParams["original"] = "teszt";

          const result = await ctrl.handle(params(searchParams));
          const body = result.body as MemorySearchResponse;

          expect(result.status).toBe(200);

          // L1: search + substringSearch should be called iff L1 is selected
          if (selectedLayers.includes("L1")) {
            expect(mi.search).toHaveBeenCalled();
            expect(mi.substringSearch).toHaveBeenCalled();
            expect(body.layers["L1"]?.status).toBe("ok");
          } else {
            expect(mi.search).not.toHaveBeenCalled();
            expect(mi.substringSearch).not.toHaveBeenCalled();
            expect(body.layers["L1"]?.status).toBe("skipped");
          }

          // L2: searchExtracted should be called iff L2 is selected
          if (selectedLayers.includes("L2")) {
            expect(mi.searchExtracted).toHaveBeenCalled();
            expect(body.layers["L2"]?.status).toBe("ok");
          } else {
            expect(mi.searchExtracted).not.toHaveBeenCalled();
            expect(body.layers["L2"]?.status).toBe("skipped");
          }

          // L3: db.prepare should be called iff L3 is selected
          if (selectedLayers.includes("L3")) {
            expect(db.prepare).toHaveBeenCalled();
            expect(body.layers["L3"]?.status).toBe("ok");
          } else {
            expect(db.prepare).not.toHaveBeenCalled();
            expect(body.layers["L3"]?.status).toBe("skipped");
          }

          // L4: searchOriginal should be called iff L4 is selected (original param provided)
          if (selectedLayers.includes("L4")) {
            expect(mi.searchOriginal).toHaveBeenCalled();
            expect(body.layers["L4"]?.status).toBe("ok");
          } else {
            expect(mi.searchOriginal).not.toHaveBeenCalled();
            expect(body.layers["L4"]?.status).toBe("skipped");
          }

          // L5: always returns not_implemented when selected, skipped otherwise
          if (selectedLayers.includes("L5")) {
            expect(body.layers["L5"]?.status).toBe("not_implemented");
          } else {
            expect(body.layers["L5"]?.status).toBe("skipped");
          }

          // L5 never contributes actual results
          const hasL5Results = body.results.some((r) => r.source.startsWith("L5"));
          expect(hasL5Results).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// Feature: kiro-professor-webui, Property 7: Search result deduplication and ordering
describe("MemorySearchController — Property 7: Search result deduplication and ordering", () => {
  // **Validates: Requirements 8.5, 8.7, 8.8**

  it("merged results have no duplicates by date+content prefix, are sorted by score descending, and contain at most 10 results", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            content: fc.string({ minLength: 0, maxLength: 200 }),
            date: fc.date({
              min: new Date("2020-01-01T00:00:00Z"),
              max: new Date("2030-01-01T00:00:00Z"),
            }),
            score: fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true }),
          }),
          { minLength: 0, maxLength: 30 },
        ),
        async (generated) => {
          // Map generated records into the shape returned by MemoryIndex.search
          const ftsResults = generated.map((g) => ({
            record: {
              content: g.content,
              timestamp: g.date.getTime(),
              chatId: 1,
              sessionId: "s1",
              role: "user" as const,
            },
            score: g.score,
          }));

          const mi = mockMemoryIndex({
            search: vi.fn(() => ftsResults),
            substringSearch: vi.fn(() => []),
          });
          const ctrl = new MemorySearchController(makeDeps({ memoryIndex: mi }));

          const result = await ctrl.handle(
            params({ keywords: "test", chatId: "1", layers: "L1" }),
          );

          expect(result.status).toBe(200);
          const body = result.body as MemorySearchResponse;
          const results = body.results;

          // 1. At most 10 results
          expect(results.length).toBeLessThanOrEqual(10);

          // 2. No duplicates by date + content prefix (first 50 chars)
          const keys = results.map((r) => `${r.date}|${r.content.slice(0, 50)}`);
          expect(new Set(keys).size).toBe(keys.length);

          // 3. Sorted by score descending
          for (let i = 1; i < results.length; i++) {
            expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
          }

          // 4. For each duplicate group in input, the kept result has the highest score
          const inputByKey = new Map<string, number>();
          for (const g of generated) {
            const key = `${g.date.toISOString()}|${g.content.slice(0, 50)}`;
            const existing = inputByKey.get(key);
            if (existing === undefined || g.score > existing) {
              inputByKey.set(key, g.score);
            }
          }
          for (const r of results) {
            // Only check results that came from our FTS source
            if (r.source === "L1:fts") {
              const key = `${r.date}|${r.content.slice(0, 50)}`;
              const expectedBest = inputByKey.get(key);
              if (expectedBest !== undefined) {
                expect(r.score).toBe(expectedBest);
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("returns 400 for empty keywords", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("", "  ", "\t", " \n "),
        async (emptyKeywords) => {
          const ctrl = new MemorySearchController(makeDeps());
          const result = await ctrl.handle(params({ keywords: emptyKeywords, chatId: "1" }));
          expect(result.status).toBe(400);
          expect(result.body).toEqual({ error: "keywords required" });
        },
      ),
      { numRuns: 20 },
    );
  });
});