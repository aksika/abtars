import type { BrowserManager } from "./browser-manager.js";
import { extractTextFromHtml, extractTextFromPage } from "./content-extractor.js";
import { parseNumberEnv, parseStringEnv } from "./env-utils.js";

// ---------------------------------------------------------------------------
// Constants & env-var parsing
// ---------------------------------------------------------------------------

/** Minimum trimmed text length to accept the fetch strategy result. */
const MIN_STATIC_TEXT_LENGTH = 200;

/** Glob pattern for resources to block during Playwright ingestion scrapes. */
const BLOCKED_RESOURCE_PATTERN =
  "**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,webm,avi,css}";

interface WebScraperConfig {
  fetchTimeoutMs: number;
  playwrightTimeoutMs: number;
  userAgent: string;
}

/**
 * Parse WebScraper-specific env vars with defaults.
 * Exported for testability.
 */
export function parseWebScraperConfig(): WebScraperConfig {
  return {
    fetchTimeoutMs: parseNumberEnv("WEB_SCRAPE_FETCH_TIMEOUT_MS", 15_000),
    playwrightTimeoutMs: parseNumberEnv("WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS", 30_000),
    userAgent: parseStringEnv(
      "WEB_SCRAPE_USER_AGENT",
      "Mozilla/5.0 (compatible; AgentBridge/1.0)",
    ),
  };
}

// ---------------------------------------------------------------------------
// WebScraper
// ---------------------------------------------------------------------------

export class WebScraper {
  private readonly _browserManager: BrowserManager;
  private readonly _config: WebScraperConfig;

  constructor(browserManager: BrowserManager, config?: WebScraperConfig) {
    this._browserManager = browserManager;
    this._config = config ?? parseWebScraperConfig();
  }

  /** Exposed for testing. */
  get config(): WebScraperConfig {
    return this._config;
  }

  /**
   * Extract text content from a URL.
   * Tries lightweight fetch first, falls back to Playwright for JS-rendered pages.
   */
  async extractText(url: string): Promise<string> {
    let fetchText: string | null = null;

    // ── 1. Fetch strategy ─────────────────────────────────────────────
    try {
      fetchText = await this._fetchStrategy(url);
    } catch {
      // Fetch failed — will fall back to Playwright below.
    }

    // If fetch produced enough text, return it.
    if (fetchText !== null && fetchText.trim().length >= MIN_STATIC_TEXT_LENGTH) {
      return fetchText;
    }

    // ── 2. Playwright fallback ────────────────────────────────────────
    let playwrightText: string | null = null;
    try {
      playwrightText = await this._playwrightStrategy(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to extract text from ${url}: both fetch and Playwright strategies failed. Playwright error: ${msg}`,
      );
    }

    if (!playwrightText || playwrightText.trim().length === 0) {
      throw new Error(
        `Failed to extract text from ${url}: page returned no readable content.`,
      );
    }

    return playwrightText;
  }

  // ── Private strategies ──────────────────────────────────────────────

  /**
   * Lightweight fetch + HTML parse.
   * Throws on network error, non-2xx, or timeout.
   */
  private async _fetchStrategy(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this._config.fetchTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": this._config.userAgent },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      return extractTextFromHtml(html);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Full Playwright render + DOM extraction.
   * Creates a one-off context, blocks heavy resources, navigates, extracts text.
   */
  private async _playwrightStrategy(url: string): Promise<string> {
    const { context, page } = await this._browserManager.createOneOffContext();

    try {
      // Block heavy resources to speed up ingestion.
      await page.route(BLOCKED_RESOURCE_PATTERN, (route) => route.abort());

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this._config.playwrightTimeoutMs,
      });

      return await extractTextFromPage(page);
    } finally {
      try {
        await context.close();
      } catch {
        // Context may already be closed — safe to ignore.
      }
    }
  }
}
