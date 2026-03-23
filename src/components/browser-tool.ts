import * as os from "node:os";
import * as path from "node:path";
import type { BrowserAction, BrowserToolResult, PageElement } from "../types/browser.js";
import type { BrowserManager } from "./browser-manager.js";
import type { DomainAllowlist } from "./domain-allowlist.js";
import { extractTextFromPage } from "./content-extractor.js";

const LOG_PREFIX = "[browser-tool]";

/** Max characters returned by extract_text before truncation. */
const TEXT_TRUNCATION_LIMIT = 4000;

/** Max interactive elements returned by get_page_info. */
const MAX_PAGE_ELEMENTS = 50;

/** Read navigation timeout from env, default 30 000 ms. */
function getNavigationTimeout(): number {
  const raw = process.env["WEB_SCRAPE_PLAYWRIGHT_TIMEOUT_MS"];
  if (raw === undefined || raw === "") return 30_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return n;
}

/**
 * Implements the seven browser actions (navigate, click, fill, extract_text,
 * screenshot, get_page_info, close_session). Pure action dispatch — receives
 * parsed args, calls BrowserManager + Playwright APIs, returns structured JSON.
 */
export class BrowserTool {
  private readonly _browserManager: BrowserManager;
  private readonly _domainAllowlist: DomainAllowlist;

  constructor(browserManager: BrowserManager, domainAllowlist: DomainAllowlist) {
    this._browserManager = browserManager;
    this._domainAllowlist = domainAllowlist;
  }

  /** Execute a browser action and return a JSON-serializable result. */
  async execute(action: BrowserAction): Promise<BrowserToolResult> {
    try {
      switch (action.action) {
        case "navigate":
          return await this._handleNavigate(action);
        case "click":
          return await this._handleClick(action);
        case "fill":
          return await this._handleFill(action);
        case "extract_text":
          return await this._handleExtractText(action);
        case "screenshot":
          return await this._handleScreenshot(action);
        case "get_page_info":
          return await this._handleGetPageInfo(action);
        case "close_session":
          return await this._handleCloseSession(action);
        case "set_cookie":
          return await this._handleSetCookie(action);
        default:
          return { success: false, error: `Unknown action: ${String((action as BrowserAction).action)}` };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  // -------------------------------------------------------------------------
  // navigate
  // -------------------------------------------------------------------------

  private async _handleNavigate(action: BrowserAction): Promise<BrowserToolResult> {
    const url = action.url;
    if (!url) {
      return { success: false, error: "navigate action requires a url" };
    }

    // Domain allowlist check
    if (!this._domainAllowlist.isAllowed(url)) {
      let hostname: string;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = url;
      }
      return {
        success: false,
        error: `Domain "${hostname}" is not in the allowed list. Allowed patterns: ${this._domainAllowlist.patterns.join(", ")}`,
      };
    }

    const session = await this._browserManager.getSession(action.sessionId);
    const timeout = getNavigationTimeout();

    console.log(`${LOG_PREFIX} navigate session="${action.sessionId}" url="${url}"`);

    try {
      const response = await session.page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout,
      });

      const title = await session.page.title();
      const finalUrl = session.page.url();
      const status = response?.status();

      return { success: true, title, url: finalUrl, status };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Navigation failed for ${url}: ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // click
  // -------------------------------------------------------------------------

  private async _handleClick(action: BrowserAction): Promise<BrowserToolResult> {
    const selector = action.selector;
    if (!selector) {
      return { success: false, error: "click action requires a selector" };
    }

    const session = await this._browserManager.getSession(action.sessionId);

    console.log(`${LOG_PREFIX} click session="${action.sessionId}" selector="${selector}"`);

    try {
      // Use Promise.race to detect if click triggers navigation
      const navigationPromise = session.page
        .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 5000 })
        .catch(() => null);

      await session.page.click(selector);

      const navResult = await navigationPromise;

      if (navResult) {
        const title = await session.page.title();
        const url = session.page.url();
        return { success: true, navigated: true, title, url };
      }

      return { success: true, navigated: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("waiting for selector") || message.includes("No element")) {
        return { success: false, error: `Selector not found: "${selector}"` };
      }
      return { success: false, error: `Click failed for selector "${selector}": ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // fill
  // -------------------------------------------------------------------------

  private async _handleFill(action: BrowserAction): Promise<BrowserToolResult> {
    const selector = action.selector;
    const value = action.value;
    if (!selector) {
      return { success: false, error: "fill action requires a selector" };
    }
    if (value === undefined) {
      return { success: false, error: "fill action requires a value" };
    }

    const session = await this._browserManager.getSession(action.sessionId);

    // Check if the target is a password field to mask in logs
    let isPassword = false;
    try {
      isPassword = await session.page.evaluate(
        `(sel) => { const el = document.querySelector(sel); return el instanceof HTMLInputElement && el.type === "password"; }`,
        selector,
      ) as boolean;
    } catch {
      // If evaluate fails (e.g. text= selector), assume not password
    }

    const logValue = isPassword ? "***" : value;
    console.log(
      `${LOG_PREFIX} fill session="${action.sessionId}" selector="${selector}" value="${logValue}"`,
    );

    try {
      await session.page.fill(selector, value);
      return { success: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("waiting for selector") || message.includes("No element")) {
        return { success: false, error: `Selector not found: "${selector}"` };
      }
      return { success: false, error: `Fill failed for selector "${selector}": ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // extract_text
  // -------------------------------------------------------------------------

  private async _handleExtractText(action: BrowserAction): Promise<BrowserToolResult> {
    const session = await this._browserManager.getSession(action.sessionId);

    console.log(
      `${LOG_PREFIX} extract_text session="${action.sessionId}" selector="${action.selector ?? "(full page)"}"`,
    );

    try {
      const text = await extractTextFromPage(session.page, action.selector ?? undefined);

      if (!text || text.trim().length === 0) {
        return { success: false, error: "No text content found on the page" };
      }

      const truncated = text.length > TEXT_TRUNCATION_LIMIT;
      const resultText = truncated ? text.slice(0, TEXT_TRUNCATION_LIMIT) : text;

      return { success: true, text: resultText, truncated };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("waiting for selector") || message.includes("No element")) {
        return { success: false, error: `Selector not found: "${action.selector}"` };
      }
      return { success: false, error: `Text extraction failed: ${message}` };
    }
  }

  // -------------------------------------------------------------------------
  // screenshot
  // -------------------------------------------------------------------------

  private async _handleScreenshot(action: BrowserAction): Promise<BrowserToolResult> {
    const session = await this._browserManager.getSession(action.sessionId);

    const tmpFile = path.join(
      os.tmpdir(),
      `agentbridge-screenshot-${Date.now()}.png`,
    );

    console.log(
      `${LOG_PREFIX} screenshot session="${action.sessionId}" fullPage=${action.fullPage ?? false} path="${tmpFile}"`,
    );

    await session.page.screenshot({
      fullPage: action.fullPage ?? false,
      path: tmpFile,
    });

    return { success: true, filePath: tmpFile };
  }

  // -------------------------------------------------------------------------
  // get_page_info
  // -------------------------------------------------------------------------

  private async _handleGetPageInfo(action: BrowserAction): Promise<BrowserToolResult> {
    const session = await this._browserManager.getSession(action.sessionId);

    console.log(`${LOG_PREFIX} get_page_info session="${action.sessionId}"`);

    const title = await session.page.title();
    const url = session.page.url();

    const elements = await session.page.evaluate(`(maxElements) => {
      const selectors = "a, button, input, select, textarea, [role='button'], [role='link']";
      const nodes = document.querySelectorAll(selectors);
      const results = [];

      for (let i = 0; i < nodes.length && results.length < maxElements; i++) {
        const el = nodes[i];
        if (!el || !(el instanceof HTMLElement)) continue;

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;

        let selector = el.tagName.toLowerCase();
        if (el.id) {
          selector = "#" + el.id;
        } else if (el.className && typeof el.className === "string" && el.className.trim()) {
          const cls = el.className.trim().split(/\\s+/).slice(0, 2).join(".");
          selector = el.tagName.toLowerCase() + "." + cls;
        } else {
          const parent = el.parentElement;
          if (parent) {
            const siblings = parent.querySelectorAll(":scope > " + el.tagName.toLowerCase());
            if (siblings.length > 1) {
              const idx = Array.from(siblings).indexOf(el) + 1;
              selector = el.tagName.toLowerCase() + ":nth-of-type(" + idx + ")";
            }
          }
        }

        const entry = { tag: el.tagName.toLowerCase(), selector };
        const text = (el.textContent || "").trim().slice(0, 100);
        if (text) entry.text = text;

        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          if (el instanceof HTMLInputElement && el.type) entry.type = el.type;
          if (el.name) entry.name = el.name;
          if (el instanceof HTMLInputElement && el.placeholder) entry.placeholder = el.placeholder;
          if (el instanceof HTMLTextAreaElement && el.placeholder) entry.placeholder = el.placeholder;
        }

        if (el instanceof HTMLAnchorElement && el.href) {
          entry.href = el.href;
        }

        results.push(entry);
      }

      return results;
    }`, MAX_PAGE_ELEMENTS) as PageElement[];

    return {
      success: true,
      url,
      title,
      elements,
    };
  }

  // -------------------------------------------------------------------------
  // close_session
  // -------------------------------------------------------------------------

  private async _handleCloseSession(action: BrowserAction): Promise<BrowserToolResult> {
    console.log(`${LOG_PREFIX} close_session session="${action.sessionId}"`);
    await this._browserManager.closeSession(action.sessionId);
    return { success: true };
  }

  // -------------------------------------------------------------------------
  // set_cookie
  // -------------------------------------------------------------------------

  private async _handleSetCookie(action: BrowserAction): Promise<BrowserToolResult> {
    const file = action.cookieFile;
    if (!file) return { success: false, error: "set_cookie requires --cookie-file" };

    // Only allow files under /run/browser/cookies (mounted read-only)
    const COOKIES_DIR = "/run/browser/cookies";
    const resolved = require("node:path").resolve(file) as string;
    if (!resolved.startsWith(COOKIES_DIR)) {
      return { success: false, error: `cookie file must be under ${COOKIES_DIR}` };
    }

    const raw = require("node:fs").readFileSync(resolved, "utf-8") as string;
    const json = JSON.parse(raw) as Record<string, string>;

    const session = await this._browserManager.getSession(action.sessionId);
    const url = action.url ?? session.page.url();
    let domain: string;
    try { domain = new URL(url).hostname; } catch { domain = ""; }

    const cookies = Object.entries(json).map(([name, value]) => ({
      name, value: String(value), domain, path: "/",
    }));

    await session.context.addCookies(cookies);
    console.log(`${LOG_PREFIX} set_cookie session="${action.sessionId}" loaded ${cookies.length} cookies for ${domain}`);
    return { success: true, text: `Loaded ${cookies.length} cookies for ${domain}` };
  }}
