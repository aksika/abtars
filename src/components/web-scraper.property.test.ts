import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";
import { WebScraper } from "./web-scraper.js";

/**
 * Feature: playwright-web-ingestion, Property 15: Fetch-first fallback threshold
 *
 * For any URL processed by the WebScraper, the Playwright fallback is invoked
 * if and only if the fetch strategy either failed (network error, non-2xx status,
 * timeout) or produced extracted text with a trimmed length of fewer than 200
 * characters.
 *
 * Validates: Requirements 14.3, 14.4
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

const MIN_STATIC_TEXT_LENGTH = 200;

/** Build a mock BrowserManager whose createOneOffContext we can spy on. */
function makeMockBrowserManager(playwrightText: string) {
  const closeFn = vi.fn(() => Promise.resolve());
  const createOneOffContext = vi.fn(() =>
    Promise.resolve({
      context: { close: closeFn },
      page: {
        route: vi.fn(() => Promise.resolve()),
        goto: vi.fn(() => Promise.resolve()),
        evaluate: vi.fn(() => Promise.resolve(playwrightText)),
      },
    }),
  );
  return { createOneOffContext, _closeFn: closeFn };
}

/** Generate a plain-text string of exactly `n` characters (no HTML). */
function plainText(n: number): string {
  return "x".repeat(n);
}

/** Wrap plain text in minimal HTML so extractTextFromHtml returns it. */
function wrapHtml(text: string): string {
  return `<html><body><p>${text}</p></body></html>`;
}

const defaultConfig = {
  fetchTimeoutMs: 5_000,
  playwrightTimeoutMs: 5_000,
  userAgent: "test",
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Property tests ──────────────────────────────────────────────────────────

describe("Feature: playwright-web-ingestion, Property 15: Fetch-first fallback threshold", () => {
  it("Playwright is NOT invoked when fetch succeeds with ≥ 200 chars of text", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate text lengths from 200 to 600
        fc.integer({ min: MIN_STATIC_TEXT_LENGTH, max: 600 }),
        async (len) => {
          const text = plainText(len);
          const html = wrapHtml(text);

          globalThis.fetch = vi.fn(() =>
            Promise.resolve(new Response(html, { status: 200 })),
          ) as unknown as typeof fetch;

          const playwrightFallbackText = plainText(500);
          const bm = makeMockBrowserManager(playwrightFallbackText);
          const scraper = new WebScraper(bm as any, defaultConfig);

          const result = await scraper.extractText("https://example.com");

          // Playwright should NOT have been called
          expect(bm.createOneOffContext).not.toHaveBeenCalled();
          // Result should contain the fetched text
          expect(result.trim().length).toBeGreaterThanOrEqual(MIN_STATIC_TEXT_LENGTH);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Playwright IS invoked when fetch succeeds with < 200 chars of text", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate text lengths from 0 to 199
        fc.integer({ min: 0, max: MIN_STATIC_TEXT_LENGTH - 1 }),
        async (len) => {
          const text = plainText(len);
          const html = wrapHtml(text);

          globalThis.fetch = vi.fn(() =>
            Promise.resolve(new Response(html, { status: 200 })),
          ) as unknown as typeof fetch;

          const playwrightFallbackText = plainText(500);
          const bm = makeMockBrowserManager(playwrightFallbackText);
          const scraper = new WebScraper(bm as any, defaultConfig);

          const result = await scraper.extractText("https://example.com");

          // Playwright SHOULD have been called
          expect(bm.createOneOffContext).toHaveBeenCalled();
          expect(result).toBe(playwrightFallbackText);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Playwright IS invoked when fetch fails (network error / non-2xx)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(
          "network-error",
          "non-2xx",
        ),
        async (failureMode) => {
          if (failureMode === "network-error") {
            globalThis.fetch = vi.fn(() =>
              Promise.reject(new Error("network failure")),
            ) as unknown as typeof fetch;
          } else {
            globalThis.fetch = vi.fn(() =>
              Promise.resolve(new Response("error", { status: 500 })),
            ) as unknown as typeof fetch;
          }

          const playwrightFallbackText = plainText(500);
          const bm = makeMockBrowserManager(playwrightFallbackText);
          const scraper = new WebScraper(bm as any, defaultConfig);

          const result = await scraper.extractText("https://example.com");

          // Playwright SHOULD have been called
          expect(bm.createOneOffContext).toHaveBeenCalled();
          expect(result).toBe(playwrightFallbackText);
        },
      ),
      { numRuns: 100 },
    );
  });
});
