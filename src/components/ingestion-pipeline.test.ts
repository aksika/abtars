import { describe, it, expect, vi, afterEach } from "vitest";
import { IngestionPipeline } from "./ingestion-pipeline.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMockDb() {
  const runFn = vi.fn((..._args: unknown[]) => ({
    lastInsertRowid: BigInt(1),
    changes: 1,
  }));
  return { prepare: vi.fn(() => ({ run: runFn })), _runFn: runFn };
}

function makeMockEmbeddingProvider() {
  return { embed: vi.fn(() => Promise.resolve([0.1, 0.2])) };
}

function makeMockVectorIndex() {
  return { index: vi.fn(() => Promise.resolve()) };
}

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

const defaultConfig = { ingestChunkMaxTokens: 512 } as any;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Unit tests ──────────────────────────────────────────────────────────────

describe("IngestionPipeline — webpage source type", () => {
  it("calls WebScraper.extractText for webpage source type", async () => {
    const longText = "a".repeat(300);
    const html = `<html><body><p>${longText}</p></body></html>`;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(html, { status: 200 })),
    ) as unknown as typeof fetch;

    const db = makeMockDb();
    const bm = makeMockBrowserManager(longText);
    const pipeline = new IngestionPipeline(
      db as any,
      makeMockEmbeddingProvider() as any,
      makeMockVectorIndex() as any,
      defaultConfig,
      bm as any,
    );

    const result = await pipeline.ingest(
      { type: "webpage", identifier: "https://example.com/page" },
      1,
    );

    expect(result.sourceType).toBe("webpage");
    expect(result.chunkCount).toBeGreaterThan(0);
    // fetch was called (WebScraper's fetch strategy)
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("stores correct source_type and identifier in ingested_documents", async () => {
    const longText = "b".repeat(300);
    const html = `<html><body><p>${longText}</p></body></html>`;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(html, { status: 200 })),
    ) as unknown as typeof fetch;

    const db = makeMockDb();
    const pipeline = new IngestionPipeline(
      db as any,
      makeMockEmbeddingProvider() as any,
      makeMockVectorIndex() as any,
      defaultConfig,
      makeMockBrowserManager(longText) as any,
    );

    const url = "https://docs.example.com/guide";
    await pipeline.ingest({ type: "webpage", identifier: url }, 42);

    // The last db.prepare().run() call is the ingested_documents INSERT
    const calls = db._runFn.mock.calls;
    const lastCall = calls[calls.length - 1]!;
    // Args: (chatId, source.type, source.identifier, chunks.length, timestamp)
    expect(lastCall[0]).toBe(42);
    expect(lastCall[1]).toBe("webpage");
    expect(lastCall[2]).toBe(url);
  });

  it("propagates WebScraper error with URL when extraction fails", async () => {
    // Make fetch fail and Playwright return empty text
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network error")),
    ) as unknown as typeof fetch;

    const bm = makeMockBrowserManager(""); // empty text from Playwright
    // Override createOneOffContext to make Playwright strategy throw
    bm.createOneOffContext = vi.fn(() =>
      Promise.resolve({
        context: { close: vi.fn(() => Promise.resolve()) },
        page: {
          route: vi.fn(() => Promise.resolve()),
          goto: vi.fn(() => Promise.reject(new Error("Navigation timeout"))),
          evaluate: vi.fn(() => Promise.resolve("")),
        },
      }),
    );

    const pipeline = new IngestionPipeline(
      makeMockDb() as any,
      makeMockEmbeddingProvider() as any,
      makeMockVectorIndex() as any,
      defaultConfig,
      bm as any,
    );

    const url = "https://broken.example.com/page";
    await expect(
      pipeline.ingest({ type: "webpage", identifier: url }, 1),
    ).rejects.toThrow(url);
  });

  it("throws when no browserManager is provided for webpage source", async () => {
    const pipeline = new IngestionPipeline(
      makeMockDb() as any,
      makeMockEmbeddingProvider() as any,
      makeMockVectorIndex() as any,
      defaultConfig,
      // No browserManager
    );

    await expect(
      pipeline.ingest(
        { type: "webpage", identifier: "https://example.com" },
        1,
      ),
    ).rejects.toThrow("no BrowserManager");
  });

  it("existing source types still work without browserManager", async () => {
    const pipeline = new IngestionPipeline(
      makeMockDb() as any,
      makeMockEmbeddingProvider() as any,
      makeMockVectorIndex() as any,
      defaultConfig,
      // No browserManager — existing types should still work
    );

    // Verify text type attempts to read from filesystem (will fail with
    // a file-not-found error, but the important thing is it doesn't throw
    // about missing browserManager).
    await expect(
      pipeline.ingest({ type: "text", identifier: "/tmp/nonexistent-test-file.txt" }, 1),
    ).rejects.toThrow("Failed to read text file");

    // Also verify unsupported types still throw the correct error
    await expect(
      pipeline.ingest({ type: "unknown" as any, identifier: "foo" }, 1),
    ).rejects.toThrow("Unsupported source type");
  });
});
