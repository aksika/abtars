import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fc from "fast-check";

vi.mock("../../components/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logTrace: vi.fn(),
}));

import { BrowserTool } from "./browser-tool.js";
import type { BrowserAction, BrowserToolResult, BrowserActionType } from "../../types/browser.js";
import type { BrowserManager } from "./browser-manager.js";
import type { DomainAllowlist } from "./domain-allowlist.js";

// ── Mock helpers (same patterns as browser-tool.test.ts) ────────────────────

function makeMockPage(overrides: Record<string, unknown> = {}) {
  return {
    goto: vi.fn().mockResolvedValue({ status: () => 200 }),
    title: vi.fn().mockResolvedValue("Test Page"),
    url: vi.fn().mockReturnValue("https://example.com"),
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(""),
    screenshot: vi.fn().mockResolvedValue(undefined),
    waitForNavigation: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeMockSession(pageOverrides: Record<string, unknown> = {}) {
  const page = makeMockPage(pageOverrides);
  return {
    sessionId: "default",
    context: {},
    page,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  };
}

function makeMockBrowserManager(session = makeMockSession()): BrowserManager {
  return {
    getSession: vi.fn().mockResolvedValue(session),
    closeSession: vi.fn().mockResolvedValue(undefined),
  } as unknown as BrowserManager;
}

function makeMockAllowlist(allowed = true): DomainAllowlist {
  return {
    isAllowed: vi.fn().mockReturnValue(allowed),
    patterns: ["*.example.com"],
    isOpenMode: allowed,
  } as unknown as DomainAllowlist;
}

// ── Generators ──────────────────────────────────────────────────────────────

/** All valid browser action types. */
const VALID_ACTIONS: BrowserActionType[] = [
  "navigate", "click", "fill", "extract_text",
  "screenshot", "get_page_info", "close_session",
];

/** Generate a random session ID. */
const sessionId = fc.string({
  unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-"),
  minLength: 1,
  maxLength: 20,
});

/** Generate a random valid BrowserAction that will succeed with mocks. */
const validBrowserAction: fc.Arbitrary<BrowserAction> = fc.oneof(
  // navigate
  fc.record({
    action: fc.constant("navigate" as const),
    sessionId,
    url: fc.constant("https://example.com/page"),
  }),
  // click
  fc.record({
    action: fc.constant("click" as const),
    sessionId,
    selector: fc.constant("#btn"),
  }),
  // fill (non-password)
  fc.record({
    action: fc.constant("fill" as const),
    sessionId,
    selector: fc.constant("#email"),
    value: fc.constant("test@example.com"),
  }),
  // extract_text
  fc.record({
    action: fc.constant("extract_text" as const),
    sessionId,
  }),
  // screenshot
  fc.record({
    action: fc.constant("screenshot" as const),
    sessionId,
  }),
  // get_page_info
  fc.record({
    action: fc.constant("get_page_info" as const),
    sessionId,
  }),
  // close_session
  fc.record({
    action: fc.constant("close_session" as const),
    sessionId,
  }),
);

/** Generate a BrowserAction that will fail (missing required params, etc.). */
const failingBrowserAction: fc.Arbitrary<BrowserAction> = fc.oneof(
  // navigate without url
  fc.record({
    action: fc.constant("navigate" as const),
    sessionId,
  }),
  // click without selector
  fc.record({
    action: fc.constant("click" as const),
    sessionId,
  }),
  // fill without selector
  fc.record({
    action: fc.constant("fill" as const),
    sessionId,
    value: fc.constant("test"),
  }),
  // fill without value
  fc.record({
    action: fc.constant("fill" as const),
    sessionId,
    selector: fc.constant("#input"),
  }),
);

// ── Shared setup ────────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.env["SSRF_CHECK"] = "0"; // Skip DNS resolution in tests
});

afterEach(() => {
  logSpy.mockRestore();
  delete process.env["SSRF_CHECK"];
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: JSON output structure invariant
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 2: JSON output structure invariant
 *
 * For any browser tool execution (whether success or failure), the output is
 * valid JSON containing at minimum a `success` boolean field. On failure, it
 * additionally contains an `error` string field.
 *
 * Validates: Requirements 1.4
 */
describe("Feature: playwright-web-ingestion, Property 2: JSON output structure invariant", () => {
  it("successful actions always return an object with success: true", async () => {
    // Mock page.evaluate to return non-empty text for extract_text and
    // an elements array for get_page_info
    const session = makeMockSession({
      evaluate: vi.fn().mockImplementation((fn: unknown, arg?: unknown) => {
        // get_page_info passes MAX_PAGE_ELEMENTS as arg (a number)
        if (typeof arg === "number") {
          return Promise.resolve([{ tag: "a", selector: "#link", text: "Link" }]);
        }
        // extract_text — return non-empty text
        return Promise.resolve("Some page content here");
      }),
    });
    const mgr = makeMockBrowserManager(session);
    const allowlist = makeMockAllowlist(true);
    const tool = new BrowserTool(mgr, allowlist);

    await fc.assert(
      fc.asyncProperty(validBrowserAction, async (action) => {
        const result = await tool.execute(action);

        // Result must be a plain object
        expect(result).toBeDefined();
        expect(typeof result).toBe("object");

        // Must have a boolean `success` field
        expect(typeof result.success).toBe("boolean");

        // Must be JSON-serializable (round-trip)
        const json = JSON.stringify(result);
        expect(json).toBeDefined();
        const parsed = JSON.parse(json) as BrowserToolResult;
        expect(parsed.success).toBe(result.success);
      }),
      { numRuns: 100 },
    );
  });

  it("failing actions return success: false with an error string", async () => {
    const mgr = makeMockBrowserManager();
    const allowlist = makeMockAllowlist(true);
    const tool = new BrowserTool(mgr, allowlist);

    await fc.assert(
      fc.asyncProperty(failingBrowserAction, async (action) => {
        const result = await tool.execute(action);

        expect(typeof result.success).toBe("boolean");
        expect(result.success).toBe(false);

        // On failure, error must be a non-empty string
        expect(typeof result.error).toBe("string");
        expect(result.error!.length).toBeGreaterThan(0);

        // Must be JSON-serializable
        const json = JSON.stringify(result);
        const parsed = JSON.parse(json) as BrowserToolResult;
        expect(parsed.success).toBe(false);
        expect(typeof parsed.error).toBe("string");
      }),
      { numRuns: 100 },
    );
  });

  it("actions that throw internally still return valid JSON with success: false", async () => {
    const crashingMgr = {
      getSession: vi.fn().mockRejectedValue(new Error("Browser crashed")),
      closeSession: vi.fn().mockRejectedValue(new Error("No session")),
    } as unknown as BrowserManager;
    const allowlist = makeMockAllowlist(true);
    const tool = new BrowserTool(crashingMgr, allowlist);

    await fc.assert(
      fc.asyncProperty(validBrowserAction, async (action) => {
        const result = await tool.execute(action);

        expect(typeof result.success).toBe("boolean");

        // JSON round-trip
        const json = JSON.stringify(result);
        const parsed = JSON.parse(json) as BrowserToolResult;
        expect(typeof parsed.success).toBe("boolean");

        if (!result.success) {
          expect(typeof result.error).toBe("string");
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Property 5: Text truncation at 4000 characters
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 5: Text truncation at 4000 characters
 *
 * For any extracted text string, if its length exceeds 4000 characters, the
 * browser tool response text is at most 4000 characters and the truncated flag
 * is true. If the length is 4000 or fewer, the full text is returned and
 * truncated is false.
 *
 * Validates: Requirements 5.4
 */
describe("Feature: playwright-web-ingestion, Property 5: Text truncation at 4000 characters", () => {
  /** Generate random strings of varying lengths around the 4000 boundary. */
  const textLength = fc.oneof(
    fc.integer({ min: 1, max: 3999 }),      // under limit
    fc.constant(4000),                       // exactly at limit
    fc.integer({ min: 4001, max: 10000 }),   // over limit
  );

  it("text > 4000 chars → truncated to ≤ 4000 with truncated: true; text ≤ 4000 → full text with truncated: false", async () => {
    await fc.assert(
      fc.asyncProperty(textLength, sessionId, async (len, sid) => {
        const generatedText = "a".repeat(len);

        // Mock page.evaluate to return the generated text (simulating extractTextFromPage)
        const session = makeMockSession({
          evaluate: vi.fn().mockResolvedValue(generatedText),
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "extract_text",
          sessionId: sid,
        });

        expect(result.success).toBe(true);

        if (len > 4000) {
          expect(result.truncated).toBe(true);
          expect(result.text!.length).toBeLessThanOrEqual(4000);
        } else {
          expect(result.truncated).toBe(false);
          expect(result.text).toBe(generatedText);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("truncated text is a prefix of the original", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 4001, max: 8000 }),
        async (len) => {
          // Use distinct characters so we can verify prefix
          const chars = "abcdefghijklmnopqrstuvwxyz";
          const generatedText = Array.from({ length: len }, (_, i) => chars[i % chars.length]).join("");

          const session = makeMockSession({
            evaluate: vi.fn().mockResolvedValue(generatedText),
          });
          const mgr = makeMockBrowserManager(session);
          const allowlist = makeMockAllowlist(true);
          const tool = new BrowserTool(mgr, allowlist);

          const result = await tool.execute({
            action: "extract_text",
            sessionId: "default",
          });

          expect(result.success).toBe(true);
          expect(result.truncated).toBe(true);
          // The returned text should be the first 4000 chars of the original
          expect(result.text).toBe(generatedText.slice(0, 4000));
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Property 6: Interactive element list capped at 50
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 6: Interactive element list capped at 50
 *
 * For any page with N interactive elements, the get_page_info response contains
 * at most 50 elements in the elements array.
 *
 * Validates: Requirements 7.2
 */
describe("Feature: playwright-web-ingestion, Property 6: Interactive element list capped at 50", () => {
  /** Generate element counts from 0 to 100. */
  const elementCount = fc.integer({ min: 0, max: 100 });

  it("get_page_info returns at most 50 elements regardless of page element count", async () => {
    await fc.assert(
      fc.asyncProperty(elementCount, sessionId, async (n, sid) => {
        // Generate N mock elements
        const mockElements = Array.from({ length: n }, (_, i) => ({
          tag: "a",
          selector: `#link-${i}`,
          text: `Link ${i}`,
          href: `https://example.com/${i}`,
        }));

        // The page.evaluate in get_page_info receives MAX_PAGE_ELEMENTS as arg
        // and the in-browser JS caps at that limit. We simulate this by
        // returning only up to the maxElements arg.
        const session = makeMockSession({
          evaluate: vi.fn().mockImplementation((_fn: unknown, maxElements: number) => {
            return Promise.resolve(mockElements.slice(0, maxElements));
          }),
          title: vi.fn().mockResolvedValue("Test Page"),
          url: vi.fn().mockReturnValue("https://example.com"),
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "get_page_info",
          sessionId: sid,
        });

        expect(result.success).toBe(true);
        expect(result.elements).toBeDefined();
        expect(result.elements!.length).toBeLessThanOrEqual(50);

        if (n <= 50) {
          expect(result.elements!.length).toBe(n);
        } else {
          expect(result.elements!.length).toBe(50);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("get_page_info passes 50 as the max elements argument to page.evaluate", async () => {
    const evaluateSpy = vi.fn().mockResolvedValue([]);
    const session = makeMockSession({
      evaluate: evaluateSpy,
      title: vi.fn().mockResolvedValue("Test"),
      url: vi.fn().mockReturnValue("https://example.com"),
    });
    const mgr = makeMockBrowserManager(session);
    const allowlist = makeMockAllowlist(true);
    const tool = new BrowserTool(mgr, allowlist);

    await tool.execute({
      action: "get_page_info",
      sessionId: "default",
    });

    // The second argument to page.evaluate should be 50 (MAX_PAGE_ELEMENTS)
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(String), 50);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Property 11: Credential masking
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 11: Credential masking
 *
 * For any fill action targeting a password-type input, the password value never
 * appears in log output or in the JSON response. Log entries contain the action
 * name, session ID, and URL but password values are replaced with "***".
 *
 * Validates: Requirements 10.1, 10.2, 10.3
 */
describe("Feature: playwright-web-ingestion, Property 11: Credential masking", () => {
  /**
   * Generate random password strings that are unique enough not to appear
   * as substrings in log boilerplate (session IDs, selectors, action names).
   * We prefix with "PWD_" and use a minimum length to avoid false positives.
   */
  const randomPassword = fc.string({
    unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    minLength: 4,
    maxLength: 40,
  }).map((s) => `PWD_${s}`);

  it("password value never appears in console.log output", async () => {
    const { logDebug } = await import("../../components/logger.js");
    const logSpy = vi.mocked(logDebug);

    await fc.assert(
      fc.asyncProperty(randomPassword, async (password) => {
        logSpy.mockClear();

        // Use a fixed session ID that won't collide with password prefix "PWD_"
        const fixedSid = "test-session-xyz";

        // Mock page.evaluate to return true for isPassword check
        const session = makeMockSession({
          evaluate: vi.fn().mockResolvedValue(true), // isPassword = true
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        await tool.execute({
          action: "fill",
          sessionId: fixedSid,
          selector: "#password",
          value: password,
        });

        // Collect all log output
        const allLogOutput = logSpy.mock.calls.flat().join(" ");

        // Password must NOT appear in logs
        expect(allLogOutput).not.toContain(password);

        // Masked placeholder must appear instead
        expect(allLogOutput).toContain("***");
      }),
      { numRuns: 100 },
    );
  });

  it("password value never appears in JSON response values", async () => {
    await fc.assert(
      fc.asyncProperty(randomPassword, async (password) => {
        const session = makeMockSession({
          evaluate: vi.fn().mockResolvedValue(true), // isPassword = true
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "fill",
          sessionId: "default",
          selector: "#password",
          value: password,
        });

        // Check that the password doesn't appear in any string value of the result
        const allValues = Object.values(result)
          .filter((v): v is string => typeof v === "string");
        for (const val of allValues) {
          expect(val).not.toContain(password);
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Property 17: Error responses include URL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Feature: playwright-web-ingestion, Property 17: Error responses include URL
 *
 * For any navigation failure involving a URL, the error message string contains
 * the URL that caused the failure.
 *
 * Validates: Requirements 2.4, 12.4, 15.5
 */
describe("Feature: playwright-web-ingestion, Property 17: Error responses include URL", () => {
  /** Generate random valid-looking URLs. */
  const randomUrl = fc.tuple(
    fc.constantFrom("https://", "http://"),
    fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"),
      minLength: 1,
      maxLength: 15,
    }),
    fc.constantFrom(".com", ".org", ".net", ".io", ".dev"),
    fc.string({
      unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789/-_"),
      minLength: 0,
      maxLength: 20,
    }),
  ).map(([scheme, host, tld, path]) => `${scheme}${host}${tld}/${path}`);

  it("navigation failure error message contains the URL", async () => {
    await fc.assert(
      fc.asyncProperty(randomUrl, sessionId, async (url, sid) => {
        // Mock page.goto to throw a navigation error
        const session = makeMockSession({
          goto: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")),
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "navigate",
          sessionId: sid,
          url,
        });

        expect(result.success).toBe(false);
        expect(typeof result.error).toBe("string");
        // The error message must contain the URL that failed
        expect(result.error).toContain(url);
      }),
      { numRuns: 100 },
    );
  });

  it("timeout failure error message contains the URL", async () => {
    await fc.assert(
      fc.asyncProperty(randomUrl, async (url) => {
        const session = makeMockSession({
          goto: vi.fn().mockRejectedValue(new Error("Timeout 30000ms exceeded")),
        });
        const mgr = makeMockBrowserManager(session);
        const allowlist = makeMockAllowlist(true);
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "navigate",
          sessionId: "default",
          url,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain(url);
      }),
      { numRuns: 100 },
    );
  });

  it("domain rejection error message contains the hostname from the URL", async () => {
    await fc.assert(
      fc.asyncProperty(randomUrl, async (url) => {
        const mgr = makeMockBrowserManager();
        const allowlist = makeMockAllowlist(false); // reject all
        const tool = new BrowserTool(mgr, allowlist);

        const result = await tool.execute({
          action: "navigate",
          sessionId: "default",
          url,
        });

        expect(result.success).toBe(false);
        expect(typeof result.error).toBe("string");

        // Error should contain the hostname extracted from the URL
        const hostname = new URL(url).hostname;
        expect(result.error).toContain(hostname);
      }),
      { numRuns: 100 },
    );
  });
});
