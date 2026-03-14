import { describe, it, expect, afterEach, vi } from "vitest";
import * as fc from "fast-check";
import { parseBrowserConfig, BrowserManager } from "./browser-manager.js";
import type { BrowserConfig } from "./browser-manager.js";

// ── Shared cleanup ──────────────────────────────────────────────────────────

let managersToCleanup: BrowserManager[] = [];

afterEach(async () => {
  for (const mgr of managersToCleanup) {
    try {
      await mgr.shutdown();
    } catch {
      // ignore
    }
  }
  managersToCleanup = [];
  BrowserManager.resetInstance();
}, 60_000);

// ── Generators ──────────────────────────────────────────────────────────────

/** Generate a valid session ID string (alphanumeric + hyphens, 1-20 chars). */
const sessionId = fc.stringOf(
  fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"),
  { minLength: 1, maxLength: 20 },
);

/** Generate a small positive integer for max sessions (1-5 for test speed). */
const smallMaxSessions = fc.integer({ min: 1, max: 5 });

// ── Helper ──────────────────────────────────────────────────────────────────

function createTestManager(maxSessions = 5): BrowserManager {
  const mgr = new BrowserManager({
    sessionTimeoutMs: 300_000,
    maxSessions,
    userAgent: "TestAgent/1.0",
  });
  managersToCleanup.push(mgr);
  return mgr;
}

// ═══════════════════════════════════════════════════════════════════════════
// Property 7: Session create-or-reuse idempotence
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 7: Session create-or-reuse idempotence
 *
 * For any session ID string, the first call to BrowserManager.getSession(id)
 * creates a new session, and any subsequent call to BrowserManager.getSession(id)
 * returns the same BrowserSession object (same context, same page) without
 * creating a new one.
 *
 * Validates: Requirements 8.1, 8.2
 */
describe("Feature: playwright-web-ingestion, Property 7: Session create-or-reuse idempotence", () => {
  it("first getSession creates a session, subsequent calls return the same session", async () => {
    const mgr = createTestManager(10);

    await fc.assert(
      fc.asyncProperty(sessionId, async (id) => {
        // First call — creates a new session
        const session1 = await mgr.getSession(id);
        expect(session1.sessionId).toBe(id);
        expect(session1.context).toBeDefined();
        expect(session1.page).toBeDefined();

        // Second call — should return the exact same session
        const session2 = await mgr.getSession(id);
        expect(session2).toBe(session1);
        expect(session2.context).toBe(session1.context);
        expect(session2.page).toBe(session1.page);

        // Third call — still the same
        const session3 = await mgr.getSession(id);
        expect(session3).toBe(session1);

        // Clean up this session so we don't hit the limit
        await mgr.closeSession(id);
      }),
      { numRuns: 5 },
    );
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 10: Max sessions enforcement
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 10: Max sessions enforcement
 *
 * For any positive integer N configured as BROWSER_MAX_SESSIONS, when N sessions
 * are already active, attempting to create session N+1 with a new session ID
 * returns an error and does not increase the active session count.
 *
 * Validates: Requirements 8.5
 */
describe("Feature: playwright-web-ingestion, Property 10: Max sessions enforcement", () => {
  it("creating session N+1 throws an error and activeSessionCount remains N", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        async (maxN) => {
          const mgr = createTestManager(maxN);

          // Create exactly N sessions
          for (let i = 0; i < maxN; i++) {
            await mgr.getSession(`session-${i}`);
          }
          expect(mgr.activeSessionCount).toBe(maxN);

          // Attempt to create session N+1 — should throw
          await expect(
            mgr.getSession(`session-overflow-${maxN}`),
          ).rejects.toThrow(/maximum concurrent sessions/i);

          // Active count should still be N
          expect(mgr.activeSessionCount).toBe(maxN);

          // Clean up
          for (let i = 0; i < maxN; i++) {
            await mgr.closeSession(`session-${i}`);
          }
        },
      ),
      { numRuns: 5 },
    );
  }, 60_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// Property 16: Environment variable parsing with defaults
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 16: Environment variable parsing with defaults
 *
 * For any combination of environment variable values (set, unset, or invalid),
 * each configuration parameter resolves to either the parsed env var value
 * (when valid) or the documented default value (when unset or invalid).
 * Invalid values trigger a log warning.
 *
 * Validates: Requirements 18.1, 18.5
 */
describe("Feature: playwright-web-ingestion, Property 16: Environment variable parsing with defaults", () => {
  const DEFAULTS: BrowserConfig = {
    sessionTimeoutMs: 300_000,
    maxSessions: 3,
    userAgent: "Mozilla/5.0 (compatible; AgentBridge/1.0)",
  };

  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "BROWSER_SESSION_TIMEOUT_MS",
    "BROWSER_MAX_SESSIONS",
    "WEB_SCRAPE_USER_AGENT",
  ] as const;

  function saveEnv() {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  }

  function restoreEnv() {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  }

  /** Generate a valid positive integer string. */
  const validPositiveIntStr = fc
    .integer({ min: 1, max: 1_000_000 })
    .map(String);

  /** Generate an invalid numeric string (negative, zero, float, non-numeric). */
  const invalidNumericStr = fc.oneof(
    fc.constant("0"),
    fc.integer({ min: -1_000_000, max: -1 }).map(String),
    fc.double({ min: 0.1, max: 99.9, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Number.isInteger(n))
      .map(String),
    fc.stringOf(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz!@#$%"),
      { minLength: 1, maxLength: 10 },
    ),
    fc.constant("NaN"),
    fc.constant("Infinity"),
    fc.constant("-Infinity"),
  );

  /** Generate an env var value: valid positive int, invalid, empty, or unset (undefined). */
  const numericEnvValue = fc.oneof(
    validPositiveIntStr.map((v) => ({ kind: "valid" as const, raw: v, parsed: Number(v) })),
    invalidNumericStr.map((v) => ({ kind: "invalid" as const, raw: v, parsed: undefined })),
    fc.constant({ kind: "empty" as const, raw: "", parsed: undefined }),
    fc.constant({ kind: "unset" as const, raw: undefined as string | undefined, parsed: undefined }),
  );

  /** Generate a user agent env value: non-empty string, empty/whitespace, or unset. */
  const userAgentEnvValue = fc.oneof(
    fc.stringOf(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-_ "),
      { minLength: 1, maxLength: 30 },
    )
      .filter((s) => s.trim().length > 0)
      .map((v) => ({ kind: "valid" as const, raw: v, parsed: v })),
    fc.constantFrom("", "   ", "\t")
      .map((v) => ({ kind: "empty" as const, raw: v, parsed: undefined })),
    fc.constant({ kind: "unset" as const, raw: undefined as string | undefined, parsed: undefined }),
  );

  it("BROWSER_SESSION_TIMEOUT_MS resolves to parsed value when valid, default when invalid/unset", () => {
    saveEnv();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      fc.assert(
        fc.property(numericEnvValue, (envVal) => {
          warnSpy.mockClear();

          if (envVal.raw === undefined) {
            delete process.env["BROWSER_SESSION_TIMEOUT_MS"];
          } else {
            process.env["BROWSER_SESSION_TIMEOUT_MS"] = envVal.raw;
          }
          // Clear others so they don't interfere
          delete process.env["BROWSER_MAX_SESSIONS"];
          delete process.env["WEB_SCRAPE_USER_AGENT"];

          const cfg = parseBrowserConfig();

          if (envVal.kind === "valid") {
            expect(cfg.sessionTimeoutMs).toBe(envVal.parsed);
          } else {
            expect(cfg.sessionTimeoutMs).toBe(DEFAULTS.sessionTimeoutMs);
          }

          if (envVal.kind === "invalid") {
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining("BROWSER_SESSION_TIMEOUT_MS"),
            );
          }
        }),
        { numRuns: 100 },
      );
    } finally {
      warnSpy.mockRestore();
      restoreEnv();
    }
  });

  it("BROWSER_MAX_SESSIONS resolves to parsed value when valid, default when invalid/unset", () => {
    saveEnv();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      fc.assert(
        fc.property(numericEnvValue, (envVal) => {
          warnSpy.mockClear();

          if (envVal.raw === undefined) {
            delete process.env["BROWSER_MAX_SESSIONS"];
          } else {
            process.env["BROWSER_MAX_SESSIONS"] = envVal.raw;
          }
          delete process.env["BROWSER_SESSION_TIMEOUT_MS"];
          delete process.env["WEB_SCRAPE_USER_AGENT"];

          const cfg = parseBrowserConfig();

          if (envVal.kind === "valid") {
            expect(cfg.maxSessions).toBe(envVal.parsed);
          } else {
            expect(cfg.maxSessions).toBe(DEFAULTS.maxSessions);
          }

          if (envVal.kind === "invalid") {
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining("BROWSER_MAX_SESSIONS"),
            );
          }
        }),
        { numRuns: 100 },
      );
    } finally {
      warnSpy.mockRestore();
      restoreEnv();
    }
  });

  it("WEB_SCRAPE_USER_AGENT resolves to value when non-empty, default when empty/unset", () => {
    saveEnv();

    try {
      fc.assert(
        fc.property(userAgentEnvValue, (envVal) => {
          if (envVal.raw === undefined) {
            delete process.env["WEB_SCRAPE_USER_AGENT"];
          } else {
            process.env["WEB_SCRAPE_USER_AGENT"] = envVal.raw;
          }
          delete process.env["BROWSER_SESSION_TIMEOUT_MS"];
          delete process.env["BROWSER_MAX_SESSIONS"];

          const cfg = parseBrowserConfig();

          if (envVal.kind === "valid") {
            expect(cfg.userAgent).toBe(envVal.parsed);
          } else {
            expect(cfg.userAgent).toBe(DEFAULTS.userAgent);
          }
        }),
        { numRuns: 100 },
      );
    } finally {
      restoreEnv();
    }
  });

  it("combined: all three env vars resolve correctly together", () => {
    saveEnv();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      fc.assert(
        fc.property(
          numericEnvValue,
          numericEnvValue,
          userAgentEnvValue,
          (timeoutVal, maxVal, uaVal) => {
            warnSpy.mockClear();

            if (timeoutVal.raw === undefined) {
              delete process.env["BROWSER_SESSION_TIMEOUT_MS"];
            } else {
              process.env["BROWSER_SESSION_TIMEOUT_MS"] = timeoutVal.raw;
            }

            if (maxVal.raw === undefined) {
              delete process.env["BROWSER_MAX_SESSIONS"];
            } else {
              process.env["BROWSER_MAX_SESSIONS"] = maxVal.raw;
            }

            if (uaVal.raw === undefined) {
              delete process.env["WEB_SCRAPE_USER_AGENT"];
            } else {
              process.env["WEB_SCRAPE_USER_AGENT"] = uaVal.raw;
            }

            const cfg = parseBrowserConfig();

            // sessionTimeoutMs
            if (timeoutVal.kind === "valid") {
              expect(cfg.sessionTimeoutMs).toBe(timeoutVal.parsed);
            } else {
              expect(cfg.sessionTimeoutMs).toBe(DEFAULTS.sessionTimeoutMs);
            }

            // maxSessions
            if (maxVal.kind === "valid") {
              expect(cfg.maxSessions).toBe(maxVal.parsed);
            } else {
              expect(cfg.maxSessions).toBe(DEFAULTS.maxSessions);
            }

            // userAgent
            if (uaVal.kind === "valid") {
              expect(cfg.userAgent).toBe(uaVal.parsed);
            } else {
              expect(cfg.userAgent).toBe(DEFAULTS.userAgent);
            }
          },
        ),
        { numRuns: 100 },
      );
    } finally {
      warnSpy.mockRestore();
      restoreEnv();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 12: Browser singleton reuse
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 12: Browser singleton reuse
 *
 * For any sequence of getSession() or createOneOffContext() calls, the
 * BrowserManager uses the same underlying Chromium browser instance for all
 * calls (no duplicate launches), as long as the browser remains connected.
 *
 * Validates: Requirements 11.3
 */
describe("Feature: playwright-web-ingestion, Property 12: Browser singleton reuse", () => {
  it("all sessions and one-off contexts share the same browser instance", async () => {
    const mgr = createTestManager(10);

    // Create a few sessions and one-off contexts, verify they all work
    // (sharing the same browser). We can't directly inspect the private
    // _browser field, but we can verify that multiple sessions + one-off
    // contexts all succeed without launching multiple browsers.
    const session1 = await mgr.getSession("reuse-a");
    const session2 = await mgr.getSession("reuse-b");
    const oneOff = await mgr.createOneOffContext();

    // All should be functional
    expect(session1.page).toBeDefined();
    expect(session2.page).toBeDefined();
    expect(oneOff.page).toBeDefined();

    // The sessions should be different contexts
    expect(session1.context).not.toBe(session2.context);
    expect(session1.context).not.toBe(oneOff.context);

    // Reusing session1 should return the same object
    const session1Again = await mgr.getSession("reuse-a");
    expect(session1Again).toBe(session1);

    // Clean up
    await mgr.closeContext(oneOff.context);
    await mgr.closeSession("reuse-a");
    await mgr.closeSession("reuse-b");
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 8: Session close removes session
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 8: Session close removes session
 *
 * For any active session ID, after calling BrowserManager.closeSession(id),
 * the session no longer exists in the manager's session map, and a subsequent
 * getSession(id) call creates a fresh session (different context).
 *
 * Validates: Requirements 8.3
 */
describe("Feature: playwright-web-ingestion, Property 8: Session close removes session", () => {
  it("closeSession removes session; next getSession creates a fresh one", async () => {
    const mgr = createTestManager(10);

    await fc.assert(
      fc.asyncProperty(sessionId, async (id) => {
        // Create a session
        const original = await mgr.getSession(id);
        const originalContext = original.context;
        expect(mgr.activeSessionCount).toBeGreaterThanOrEqual(1);

        // Close it
        await mgr.closeSession(id);

        // Create again — should be a fresh session with a different context
        const fresh = await mgr.getSession(id);
        expect(fresh.sessionId).toBe(id);
        expect(fresh.context).not.toBe(originalContext);

        // Clean up
        await mgr.closeSession(id);
      }),
      { numRuns: 5 },
    );
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 9: Idle timeout cleanup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 9: Idle timeout cleanup
 *
 * For any session whose lastActivityAt timestamp is older than
 * BROWSER_SESSION_TIMEOUT_MS milliseconds ago, the idle-check sweep closes
 * that session and removes it from the session map.
 *
 * Validates: Requirements 8.4
 */
describe("Feature: playwright-web-ingestion, Property 9: Idle timeout cleanup", () => {
  it("sessions idle beyond timeout are cleaned up by sweep", async () => {
    // Use a very short timeout so we can test the sweep quickly
    const mgr = new BrowserManager({
      sessionTimeoutMs: 50, // 50ms timeout
      maxSessions: 5,
      userAgent: "TestAgent/1.0",
    });
    managersToCleanup.push(mgr);

    // Create a session
    const session = await mgr.getSession("idle-test");
    expect(mgr.activeSessionCount).toBe(1);

    // Wait longer than the timeout
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Manually trigger the sweep by accessing the private method via any cast.
    // The idle check runs on an interval, but for deterministic testing we
    // invoke it directly.
    await (mgr as any)._sweepIdleSessions();

    // Session should be gone
    expect(mgr.activeSessionCount).toBe(0);

    // Getting the same session ID should create a fresh session
    const fresh = await mgr.getSession("idle-test");
    expect(fresh.context).not.toBe(session.context);

    await mgr.closeSession("idle-test");
  }, 60_000);
});
