import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseBrowserConfig, BrowserManager } from "./browser-manager.js";

// ---------------------------------------------------------------------------
// parseBrowserConfig unit tests
// ---------------------------------------------------------------------------

describe("parseBrowserConfig", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test.
    delete process.env["BROWSER_SESSION_TIMEOUT_MS"];
    delete process.env["BROWSER_MAX_SESSIONS"];
    delete process.env["WEB_SCRAPE_USER_AGENT"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns defaults when env vars are unset", () => {
    const cfg = parseBrowserConfig();
    expect(cfg.sessionTimeoutMs).toBe(300_000);
    expect(cfg.maxSessions).toBe(3);
    expect(cfg.userAgent).toBe("Mozilla/5.0 (compatible; AgentBridge/1.0)");
  });

  it("parses valid numeric env vars", () => {
    process.env["BROWSER_SESSION_TIMEOUT_MS"] = "60000";
    process.env["BROWSER_MAX_SESSIONS"] = "5";
    const cfg = parseBrowserConfig();
    expect(cfg.sessionTimeoutMs).toBe(60_000);
    expect(cfg.maxSessions).toBe(5);
  });

  it("falls back to default and warns for non-numeric values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["BROWSER_MAX_SESSIONS"] = "abc";
    const cfg = parseBrowserConfig();
    expect(cfg.maxSessions).toBe(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[env]"),
    );
    warnSpy.mockRestore();
  });

  it("falls back to default for negative numbers", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["BROWSER_SESSION_TIMEOUT_MS"] = "-100";
    const cfg = parseBrowserConfig();
    expect(cfg.sessionTimeoutMs).toBe(300_000);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to default for zero", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["BROWSER_MAX_SESSIONS"] = "0";
    const cfg = parseBrowserConfig();
    expect(cfg.maxSessions).toBe(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("falls back to default for float values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env["BROWSER_MAX_SESSIONS"] = "2.5";
    const cfg = parseBrowserConfig();
    expect(cfg.maxSessions).toBe(3);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses custom user agent when set", () => {
    process.env["WEB_SCRAPE_USER_AGENT"] = "CustomBot/2.0";
    const cfg = parseBrowserConfig();
    expect(cfg.userAgent).toBe("CustomBot/2.0");
  });

  it("falls back to default user agent for empty string", () => {
    process.env["WEB_SCRAPE_USER_AGENT"] = "   ";
    const cfg = parseBrowserConfig();
    expect(cfg.userAgent).toBe("Mozilla/5.0 (compatible; AgentBridge/1.0)");
  });
});

// ---------------------------------------------------------------------------
// BrowserManager unit tests (no real browser — tests structural behavior)
// ---------------------------------------------------------------------------

describe("BrowserManager", () => {
  afterEach(async () => {
    BrowserManager.resetInstance();
  });

  it("singleton getInstance returns the same instance", () => {
    const a = BrowserManager.getInstance();
    const b = BrowserManager.getInstance();
    expect(a).toBe(b);
    // Clean up idle timer
    void a.shutdown();
  });

  it("resetInstance clears the singleton", () => {
    const a = BrowserManager.getInstance();
    void a.shutdown();
    BrowserManager.resetInstance();
    const b = BrowserManager.getInstance();
    expect(a).not.toBe(b);
    void b.shutdown();
  });

  it("activeSessionCount starts at 0", () => {
    const mgr = new BrowserManager({
      sessionTimeoutMs: 300_000,
      maxSessions: 3,
      userAgent: "test",
    });
    expect(mgr.activeSessionCount).toBe(0);
    void mgr.shutdown();
  });

  it("config getter exposes resolved config", () => {
    const cfg = {
      sessionTimeoutMs: 60_000,
      maxSessions: 5,
      userAgent: "TestAgent/1.0",
    };
    const mgr = new BrowserManager(cfg);
    expect(mgr.config).toEqual(cfg);
    void mgr.shutdown();
  });

  it("shutdown is safe to call when no browser is running", async () => {
    const mgr = new BrowserManager({
      sessionTimeoutMs: 300_000,
      maxSessions: 3,
      userAgent: "test",
    });
    // Should not throw.
    await mgr.shutdown();
  });
});
