import { logAndSwallow } from "../../components/log-and-swallow.js";
import { getEnv } from "../../components/env-schema.js";
import { chromium } from "patchright";
import type { Browser, BrowserContext, Page } from "patchright";
import { execFileSync } from "node:child_process";
import type { BrowserSession } from "../../types/browser.js";
import { parsePositiveIntEnv, parseStringEnv } from "../../components/env-utils.js";

// ---------------------------------------------------------------------------
// Environment variable parsing
// ---------------------------------------------------------------------------

const LOG_PREFIX = "[browser-manager]";

const DEFAULTS = {
  BROWSER_SESSION_TIMEOUT_MS: 300_000,
  BROWSER_MAX_SESSIONS: 3,
  WEB_SCRAPE_USER_AGENT: "Mozilla/5.0 (compatible; AgentBridge/1.0)",
} as const;

export type BrowserEngine = "patchright";

export interface BrowserConfig {
  sessionTimeoutMs: number;
  maxSessions: number;
  userAgent: string;
  engine: BrowserEngine;
}

/**
 * Read and validate browser-related env vars, returning resolved config.
 * Invalid values trigger a console.warn and fall back to defaults.
 * Exported for testability (Property 16).
 */
export function parseBrowserConfig(): BrowserConfig {
  const sessionTimeoutMs = parsePositiveIntEnv(
    "BROWSER_SESSION_TIMEOUT_MS",
    DEFAULTS.BROWSER_SESSION_TIMEOUT_MS,
  );
  const maxSessions = parsePositiveIntEnv(
    "BROWSER_MAX_SESSIONS",
    DEFAULTS.BROWSER_MAX_SESSIONS,
  );
  const userAgent = parseStringEnv(
    "WEB_SCRAPE_USER_AGENT",
    DEFAULTS.WEB_SCRAPE_USER_AGENT,
  );

  const engine = "patchright" as BrowserEngine;

  return { sessionTimeoutMs, maxSessions, userAgent, engine };
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
  private _lastActivityAt = 0;
  private readonly _containerIdleStopMs: number;

  constructor(config?: BrowserConfig) {
    this._config = config ?? parseBrowserConfig();
    this._containerIdleStopMs = getEnv().browserIdleStopMin * 60_000;
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

  /** Lazily launch or return the existing browser instance. */
  private async _ensureBrowser(): Promise<Browser> {
    if (this._browser?.isConnected()) return this._browser;

    // Avoid duplicate launches if multiple callers race.
    if (this._launching) return this._launching;

    this._launching = this._launchPatchright().then((browser) => {
      this._browser = browser;
      this._launching = null;
      browser.on("disconnected", () => {
        this._browser = null;
        this._sessions.clear();
      });
      return browser;
    }).catch((err) => {
      this._launching = null;
      throw err;
    });

    return this._launching;
  }

  private async _launchPatchright(): Promise<Browser> {
    const headed = getEnv().browserHeaded;
    const args = headed ? [] : ["--headless=new"];
    if (getEnv().browserNoSandbox) args.push("--no-sandbox");
    return chromium.launch({
      headless: !headed,
      channel: getEnv().browserChannel,
      args,
    });
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
    this._lastActivityAt = now;
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

    // Stop container if no sessions and idle long enough
    if (this._sessions.size === 0 && this._browser && this._lastActivityAt > 0 && now - this._lastActivityAt > this._containerIdleStopMs) {
      console.log(`${LOG_PREFIX} No sessions for ${Math.round((now - this._lastActivityAt) / 60_000)}min — stopping container.`);
      await this.shutdown();
      this._stopContainer();
    }
  }

  private _stopContainer(): void {
    try {
      execFileSync("docker", ["stop", "agentbridge-browser"], { stdio: "pipe", timeout: 10_000 });
    } catch (err) { logAndSwallow("browser_manager", "op", err); }
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
