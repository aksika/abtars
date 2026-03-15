import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "patchright";
import type { BrowserSession } from "../types/browser.js";

// ---------------------------------------------------------------------------
// Environment variable parsing
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[browser-manager]";

const DEFAULTS = {
  BROWSER_SESSION_TIMEOUT_MS: 300_000,
  BROWSER_MAX_SESSIONS: 3,
  WEB_SCRAPE_USER_AGENT: "Mozilla/5.0 (compatible; AgentBridge/1.0)",
} as const;

export interface BrowserConfig {
  sessionTimeoutMs: number;
  maxSessions: number;
  userAgent: string;
}

/**
 * Read and validate browser-related env vars, returning resolved config.
 * Invalid values trigger a console.warn and fall back to defaults.
 * Exported for testability (Property 16).
 */
export function parseBrowserConfig(): BrowserConfig {
  const sessionTimeoutMs = parsePositiveInt(
    "BROWSER_SESSION_TIMEOUT_MS",
    DEFAULTS.BROWSER_SESSION_TIMEOUT_MS,
  );
  const maxSessions = parsePositiveInt(
    "BROWSER_MAX_SESSIONS",
    DEFAULTS.BROWSER_MAX_SESSIONS,
  );
  const userAgent = parseStringEnv(
    "WEB_SCRAPE_USER_AGENT",
    DEFAULTS.WEB_SCRAPE_USER_AGENT,
  );

  return { sessionTimeoutMs, maxSessions, userAgent };
}

function parsePositiveInt(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.warn(
      `${LOG_PREFIX} Invalid value for ${envKey}: "${raw}". Using default ${fallback}.`,
    );
    return fallback;
  }
  return n;
}

function parseStringEnv(envKey: string, fallback: string): string {
  const raw = process.env[envKey];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw;
}

// ---------------------------------------------------------------------------
// BrowserManager singleton
// ---------------------------------------------------------------------------

export class BrowserManager {
  private static _instance: BrowserManager | null = null;

  private _browser: Browser | null = null;
  private _launching: Promise<Browser> | null = null;
  private readonly _sessions = new Map<string, BrowserSession>();
  private _idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _config: BrowserConfig;

  constructor(config?: BrowserConfig) {
    this._config = config ?? parseBrowserConfig();
    this._startIdleCheck();
  }

  /** Get (or create) the singleton instance. */
  static getInstance(): BrowserManager {
    if (!BrowserManager._instance) {
      BrowserManager._instance = new BrowserManager();
    }
    return BrowserManager._instance;
  }

  /** Reset singleton — primarily for testing. */
  static resetInstance(): void {
    BrowserManager._instance = null;
  }

  // -------------------------------------------------------------------------
  // Browser lifecycle
  // -------------------------------------------------------------------------

  /** Lazily launch or return the existing Chromium instance. */
  private async _ensureBrowser(): Promise<Browser> {
    if (this._browser?.isConnected()) return this._browser;

    // Avoid duplicate launches if multiple callers race.
    if (this._launching) return this._launching;

    const headed = process.env["BROWSER_HEADED"] === "1";
    const args = headed ? [] : ["--headless=new"];
    if (process.env["BROWSER_NO_SANDBOX"] === "1") args.push("--no-sandbox");

    this._launching = chromium
      .launch({
        headless: !headed,
        channel: process.env["BROWSER_CHANNEL"] || undefined,
        args,
      })
      .then((browser) => {
        this._browser = browser;
        this._launching = null;

        // Detect unexpected disconnection so we re-launch on next request.
        browser.on("disconnected", () => {
          this._browser = null;
          // Invalidate all sessions — their contexts are gone.
          this._sessions.clear();
        });

        return browser;
      })
      .catch((err) => {
        this._launching = null;
        throw err;
      });

    return this._launching;
  }

  // -------------------------------------------------------------------------
  // Named sessions
  // -------------------------------------------------------------------------

  /**
   * Get or create a named browser session.
   * Reusing an existing session updates `lastActivityAt`.
   */
  async getSession(sessionId: string): Promise<BrowserSession> {
    const existing = this._sessions.get(sessionId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }

    // Enforce max sessions.
    if (this._sessions.size >= this._config.maxSessions) {
      const activeIds = [...this._sessions.keys()].join(", ");
      throw new Error(
        `Maximum concurrent sessions (${this._config.maxSessions}) reached. ` +
          `Close an existing session first. Active sessions: ${activeIds}`,
      );
    }

    const browser = await this._ensureBrowser();
    const context = await browser.newContext({
      userAgent: this._config.userAgent,
    });
    const page = await context.newPage();
    const now = Date.now();

    const session: BrowserSession = {
      sessionId,
      context,
      page,
      createdAt: now,
      lastActivityAt: now,
    };

    this._sessions.set(sessionId, session);
    return session;
  }

  /** Close a named session and release its resources. */
  async closeSession(sessionId: string): Promise<void> {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    this._sessions.delete(sessionId);
    try {
      await session.context.close();
    } catch {
      // Context may already be closed if browser disconnected.
    }
  }

  // -------------------------------------------------------------------------
  // One-off contexts (ingestion scrapes)
  // -------------------------------------------------------------------------

  /** Create a disposable context + page for ingestion. No session tracking. */
  async createOneOffContext(): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await this._ensureBrowser();
    const context = await browser.newContext({
      userAgent: this._config.userAgent,
    });
    const page = await context.newPage();
    return { context, page };
  }

  /** Close a one-off context after use. */
  async closeContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch {
      // Already closed or browser disconnected — safe to ignore.
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown & cleanup
  // -------------------------------------------------------------------------

  /** Shut down everything: all sessions, the browser, cleanup timers. */
  async shutdown(): Promise<void> {
    this._stopIdleCheck();

    // Close all named sessions.
    const closePromises = [...this._sessions.keys()].map((id) =>
      this.closeSession(id),
    );
    await Promise.all(closePromises);

    // Close the browser itself.
    if (this._browser) {
      try {
        await this._browser.close();
      } catch {
        // Already closed.
      }
      this._browser = null;
    }
  }

  // -------------------------------------------------------------------------
  // Idle-check interval
  // -------------------------------------------------------------------------

  private _startIdleCheck(): void {
    // Check every 30 seconds for idle sessions.
    this._idleTimer = setInterval(() => {
      void this._sweepIdleSessions();
    }, 30_000);

    // Don't prevent Node from exiting.
    if (this._idleTimer && typeof this._idleTimer === "object" && "unref" in this._idleTimer) {
      this._idleTimer.unref();
    }
  }

  private _stopIdleCheck(): void {
    if (this._idleTimer) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
  }

  private async _sweepIdleSessions(): Promise<void> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this._sessions) {
      if (now - session.lastActivityAt > this._config.sessionTimeoutMs) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      console.warn(`${LOG_PREFIX} Closing idle session "${id}".`);
      await this.closeSession(id);
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  /** Number of active named sessions. */
  get activeSessionCount(): number {
    return this._sessions.size;
  }

  /** Exposed for testing — the resolved config. */
  get config(): BrowserConfig {
    return this._config;
  }
}
