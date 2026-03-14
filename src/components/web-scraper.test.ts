import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WebScraper, parseWebScraperConfig } from "./web-scraper.js";

// ---------------------------------------------------------------------------
// Helpers — minimal mock types
// ---------------------------------------------------------------------------

/** Build a mock BrowserManager that returns controllable page/context. */
function mockBrowserManager(opts?: {
  pageText?: string;
  navigateError?: Error;
}) {
  const routeHandler = vi.fn((_pattern: string, _handler: unknown) =>
    Promise.resolve(),
  );
  const gotoHandler = vi.fn(() => {
    if (opts?.navigateError) throw opts.navigateError;
    return Promise.resolve();
  });
  const evaluateHandler = vi.fn(() =>
    Promise.resolve(opts?.pageText ?? ""),
  );
  const closeFn = vi.fn(() => Promise.resolve());

  const mockPage = {
    route: routeHandler,
    goto: gotoHandler,
    evaluate: evaluateHandler,
  };
  const mockContext = { close: closeFn };

  return {
    createOneOffContext: vi.fn(() =>
      Promise.resolve({ context: mockContext, page: mockPage }),
    ),
    _mocks: { routeHandler, gotoHandler, evaluateHandler, closeFn, mockPage, mockContext },
  };
}

/** Generate a string of given length. */
function textOfLength(n: number): string {
  return "a".repeat(n);
}

// ---------------------------------------------------------------------------
// parseWebScraperConfig
// ---------------------------------------------------------------------------

describe("parseWebScraperConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env["WEB_SCRAPE_FETCH_TIMEOUT_MS"];
    delete process.env["WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS"];
    delete process.env["WEB_SCRAPE_USER_AGENT"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when env vars are unset", () => {
    const cfg = parseWebScraperConfig();
    expect(cfg.fetchTimeoutMs).toBe(15_000);
    expect(cfg.playwrightTimeoutMs).toBe(30_000);
    expect(cfg.userAgent).toBe("Mozilla/5.0 (compatible; AgentBridge/1.0)");
  });

  it("parses valid numeric env vars", () => {
    process.env["WEB_SCRAPE_FETCH_TIMEOUT_MS"] = "5000";
    process.env["WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS"] = "60000";
    const cfg = parseWebScraperConfig();
    expect(cfg.fetchTimeoutMs).toBe(5_000);
    expect(cfg.playwrightTimeoutMs).toBe(60_000);
  });

  it("falls back to default and warns for invalid values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["WEB_SCRAPE_FETCH_TIMEOUT_MS"] = "not-a-number";
    const cfg = parseWebScraperConfig();
    expect(cfg.fetchTimeoutMs).toBe(15_000);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[web-scraper]"),
    );
    warnSpy.mockRestore();
  });

  it("falls back to default for zero", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS"] = "0";
    const cfg = parseWebScraperConfig();
    expect(cfg.playwrightTimeoutMs).toBe(30_000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses custom user agent when set", () => {
    process.env["WEB_SCRAPE_USER_AGENT"] = "CustomBot/3.0";
    const cfg = parseWebScraperConfig();
    expect(cfg.userAgent).toBe("CustomBot/3.0");
  });
});


// ---------------------------------------------------------------------------
// WebScraper.extractText — unit tests
// ---------------------------------------------------------------------------

describe("WebScraper.extractText", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (fetchSpy) fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("returns fetch text when ≥ 200 chars (no Playwright fallback)", async () => {
    const longText = textOfLength(250);
    const html = `<html><body><p>${longText}</p></body></html>`;

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(html, { status: 200 })),
    ) as unknown as typeof fetch;

    const bm = mockBrowserManager();
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    const result = await scraper.extractText("https://example.com");
    expect(result.trim().length).toBeGreaterThanOrEqual(200);
    // Playwright should NOT have been called
    expect(bm.createOneOffContext).not.toHaveBeenCalled();
  });

  it("falls back to Playwright when fetch returns short text", async () => {
    const shortHtml = "<html><body><p>short</p></body></html>";
    const longPlaywrightText = textOfLength(300);

    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response(shortHtml, { status: 200 })),
    ) as unknown as typeof fetch;

    const bm = mockBrowserManager({ pageText: longPlaywrightText });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    const result = await scraper.extractText("https://example.com");
    expect(result).toBe(longPlaywrightText);
    expect(bm.createOneOffContext).toHaveBeenCalled();
  });

  it("falls back to Playwright when fetch fails (network error)", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network error")),
    ) as unknown as typeof fetch;

    const playwrightText = textOfLength(300);
    const bm = mockBrowserManager({ pageText: playwrightText });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    const result = await scraper.extractText("https://example.com");
    expect(result).toBe(playwrightText);
    expect(bm.createOneOffContext).toHaveBeenCalled();
  });

  it("falls back to Playwright when fetch returns non-2xx", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    ) as unknown as typeof fetch;

    const playwrightText = textOfLength(300);
    const bm = mockBrowserManager({ pageText: playwrightText });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    const result = await scraper.extractText("https://example.com");
    expect(result).toBe(playwrightText);
    expect(bm.createOneOffContext).toHaveBeenCalled();
  });

  it("throws when both fetch and Playwright fail", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("network error")),
    ) as unknown as typeof fetch;

    const bm = mockBrowserManager({ navigateError: new Error("browser crash") });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    await expect(
      scraper.extractText("https://example.com"),
    ).rejects.toThrow("https://example.com");
  });

  it("throws when extracted text is empty after cleaning", async () => {
    // Fetch returns empty content
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("<html><body></body></html>", { status: 200 })),
    ) as unknown as typeof fetch;

    // Playwright also returns empty
    const bm = mockBrowserManager({ pageText: "" });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    await expect(
      scraper.extractText("https://example.com"),
    ).rejects.toThrow("https://example.com");
  });

  it("blocks resources via page.route in Playwright fallback", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("fail")),
    ) as unknown as typeof fetch;

    const bm = mockBrowserManager({ pageText: textOfLength(300) });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    await scraper.extractText("https://example.com");

    // Verify page.route was called with the resource blocking pattern
    expect(bm._mocks.routeHandler).toHaveBeenCalledWith(
      "**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,webm,avi,css}",
      expect.any(Function),
    );
  });

  it("closes one-off context after Playwright extraction", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new Error("fail")),
    ) as unknown as typeof fetch;

    const bm = mockBrowserManager({ pageText: textOfLength(300) });
    const scraper = new WebScraper(bm as any, {
      fetchTimeoutMs: 5000,
      playwrightTimeoutMs: 5000,
      userAgent: "test",
    });

    await scraper.extractText("https://example.com");
    expect(bm._mocks.closeFn).toHaveBeenCalled();
  });
});
