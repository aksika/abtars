import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { IngestionPipeline } from "./ingestion-pipeline.js";

/**
 * Feature: playwright-web-ingestion, Property 13: Webpage ingestion metadata
 *
 * For any successful webpage ingestion, the record stored in the
 * `ingested_documents` table has `source_type` equal to `"webpage"` and
 * `identifier` equal to the original URL string.
 *
 * Validates: Requirements 12.3
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Arbitrary that produces HTTP/HTTPS URLs. */
const urlArb = fc
  .record({
    protocol: fc.constantFrom("http", "https"),
    host: fc.stringOf(fc.constantFrom("a", "b", "c", "d", "e", "1", "2", "3"), {
      minLength: 1,
      maxLength: 10,
    }),
    tld: fc.constantFrom("com", "org", "net", "io"),
    path: fc.stringOf(fc.constantFrom("a", "b", "/", "-"), {
      minLength: 0,
      maxLength: 15,
    }),
  })
  .map(({ protocol, host, tld, path }) => `${protocol}://${host}.${tld}/${path}`);

/** Build a mock database that captures INSERT calls. */
function makeMockDb() {
  const insertedRows: Record<string, unknown>[] = [];
  const runFn = vi.fn((...args: unknown[]) => {
    insertedRows.push({ args });
    return { lastInsertRowid: BigInt(insertedRows.length), changes: 1 };
  });
  const prepareFn = vi.fn(() => ({ run: runFn }));
  return { prepare: prepareFn, _insertedRows: insertedRows, _runFn: runFn };
}

/** Build a mock embedding provider. */
function makeMockEmbeddingProvider() {
  return { embed: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])) };
}

/** Build a mock vector index. */
function makeMockVectorIndex() {
  return { index: vi.fn(() => Promise.resolve()) };
}

/** Build a mock BrowserManager for WebScraper. */
function makeMockBrowserManager(text: string) {
  const closeFn = vi.fn(() => Promise.resolve());
  return {
    createOneOffContext: vi.fn(() =>
      Promise.resolve({
        context: { close: closeFn },
        page: {
          route: vi.fn(() => Promise.resolve()),
          goto: vi.fn(() => Promise.resolve()),
          evaluate: vi.fn(() => Promise.resolve(text)),
        },
      }),
    ),
  };
}

const defaultConfig = {
  ingestChunkMaxTokens: 512,
} as any;

// ── Property test ───────────────────────────────────────────────────────────

describe("Feature: playwright-web-ingestion, Property 13: Webpage ingestion metadata", () => {
  it("ingested_documents record has source_type='webpage' and identifier=original URL", async () => {
    // We need to mock global fetch so WebScraper's fetch strategy returns
    // enough text (≥200 chars) to avoid Playwright fallback.
    const longText = "x".repeat(300);
    const html = `<html><body><p>${longText}</p></body></html>`;
    const originalFetch = globalThis.fetch;

    try {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve(new Response(html, { status: 200 })),
      ) as unknown as typeof fetch;

      await fc.assert(
        fc.asyncProperty(urlArb, async (url) => {
          const db = makeMockDb();
          const embeddingProvider = makeMockEmbeddingProvider();
          const vectorIndex = makeMockVectorIndex();
          const browserManager = makeMockBrowserManager(longText);

          const pipeline = new IngestionPipeline(
            db as any,
            embeddingProvider as any,
            vectorIndex as any,
            defaultConfig,
            browserManager as any,
          );

          const result = await pipeline.ingest(
            { type: "webpage", identifier: url },
            1,
          );

          // Verify the IngestionResult metadata
          expect(result.sourceType).toBe("webpage");
          expect(result.identifier).toBe(url);

          // Verify the ingested_documents INSERT was called with correct values.
          // The last call to db.prepare().run() is the ingested_documents INSERT.
          const calls = db._runFn.mock.calls;
          const lastCall = calls[calls.length - 1]!;
          // Args: (chatId, source.type, source.identifier, chunks.length, timestamp)
          expect(lastCall[1]).toBe("webpage");
          expect(lastCall[2]).toBe(url);
        }),
        { numRuns: 100 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
