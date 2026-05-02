import { describe, it, expect, vi, beforeEach } from "vitest";
import { BrowserTool } from "./browser-tool.js";
import type { BrowserAction, BrowserToolResult } from "../../types/browser.js";
import type { BrowserManager } from "./browser-manager.js";
import type { DomainAllowlist } from "./domain-allowlist.js";

// ---------------------------------------------------------------------------
// Helpers — lightweight mocks
// ---------------------------------------------------------------------------

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
    isOpenMode: !allowed,
  } as unknown as DomainAllowlist;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrowserTool", () => {
  let tool: BrowserTool;
  let mgr: BrowserManager;
  let allowlist: DomainAllowlist;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env["SSRF_CHECK"] = "0";
  });

  // -----------------------------------------------------------------------
  // navigate
  // -----------------------------------------------------------------------

  describe("navigate", () => {
    it("returns success with title, url, status on successful navigation", async () => {
      const session = makeMockSession();
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "navigate",
        sessionId: "default",
        url: "https://example.com",
      });

      expect(result.success).toBe(true);
      expect(result.title).toBe("Test Page");
      expect(result.url).toBe("https://example.com");
      expect(result.status).toBe(200);
    });

    it("rejects navigation when domain is not allowed", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(false);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "navigate",
        sessionId: "default",
        url: "https://evil.com/hack",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("evil.com");
      expect(result.error).toContain("allowed");
    });

    it("returns error when url is missing", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "navigate",
        sessionId: "default",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("url");
    });

    it("returns error with URL on navigation timeout", async () => {
      const session = makeMockSession({
        goto: vi.fn().mockRejectedValue(new Error("Timeout 30000ms exceeded")),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "navigate",
        sessionId: "default",
        url: "https://slow.example.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("https://slow.example.com");
    });
  });

  // -----------------------------------------------------------------------
  // click
  // -----------------------------------------------------------------------

  describe("click", () => {
    it("returns success with navigated=false when click does not trigger navigation", async () => {
      const session = makeMockSession({
        waitForNavigation: vi.fn().mockResolvedValue(null),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "click",
        sessionId: "default",
        selector: "#btn",
      });

      expect(result.success).toBe(true);
      expect(result.navigated).toBe(false);
    });

    it("returns navigated=true with title/url when click triggers navigation", async () => {
      const mockResponse = { url: () => "https://example.com/next" };
      const session = makeMockSession({
        waitForNavigation: vi.fn().mockResolvedValue(mockResponse),
        title: vi.fn().mockResolvedValue("Next Page"),
        url: vi.fn().mockReturnValue("https://example.com/next"),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "click",
        sessionId: "default",
        selector: "text=Sign In",
      });

      expect(result.success).toBe(true);
      expect(result.navigated).toBe(true);
      expect(result.title).toBe("Next Page");
      expect(result.url).toBe("https://example.com/next");
    });

    it("returns error when selector is missing", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "click",
        sessionId: "default",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("selector");
    });

    it("returns error when selector not found", async () => {
      const session = makeMockSession({
        click: vi.fn().mockRejectedValue(new Error("waiting for selector '#missing'")),
        waitForNavigation: vi.fn().mockResolvedValue(null),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "click",
        sessionId: "default",
        selector: "#missing",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Selector not found");
    });
  });

  // -----------------------------------------------------------------------
  // fill
  // -----------------------------------------------------------------------

  describe("fill", () => {
    it("returns success on valid fill", async () => {
      const session = makeMockSession({
        evaluate: vi.fn().mockResolvedValue(false),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "fill",
        sessionId: "default",
        selector: "#email",
        value: "test@example.com",
      });

      expect(result.success).toBe(true);
    });

    it("masks password values in logs", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const session = makeMockSession({
        evaluate: vi.fn().mockResolvedValue(true), // isPassword = true
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      await tool.execute({
        action: "fill",
        sessionId: "default",
        selector: "#password",
        value: "s3cret!",
      });

      // Check that the actual password never appears in log calls
      const allLogCalls = logSpy.mock.calls.flat().join(" ");
      expect(allLogCalls).not.toContain("s3cret!");
      expect(allLogCalls).toContain("***");
    });

    it("returns error when selector is missing", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "fill",
        sessionId: "default",
        value: "test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("selector");
    });

    it("returns error when value is missing", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "fill",
        sessionId: "default",
        selector: "#email",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("value");
    });

    it("returns error when selector not found", async () => {
      const session = makeMockSession({
        evaluate: vi.fn().mockResolvedValue(false),
        fill: vi.fn().mockRejectedValue(new Error("waiting for selector '#nope'")),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "fill",
        sessionId: "default",
        selector: "#nope",
        value: "test",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Selector not found");
    });
  });

  // -----------------------------------------------------------------------
  // extract_text
  // -----------------------------------------------------------------------

  describe("extract_text", () => {
    it("returns extracted text with truncated=false when under limit", async () => {
      const session = makeMockSession();
      // Mock extractTextFromPage via page.evaluate
      session.page.evaluate = vi.fn().mockResolvedValue("Hello world content");
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      // We need to mock the module-level function. Since extractTextFromPage
      // calls page.evaluate internally, we mock at the page level.
      // But the real function is imported — let's test via the actual flow.
      // The extractTextFromPage function calls page.evaluate, so mocking
      // page.evaluate is sufficient.
      const result = await tool.execute({
        action: "extract_text",
        sessionId: "default",
      });

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(false);
    });

    it("truncates text exceeding 4000 chars and sets truncated=true", async () => {
      const longText = "x".repeat(5000);
      const session = makeMockSession();
      session.page.evaluate = vi.fn().mockResolvedValue(longText);
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "extract_text",
        sessionId: "default",
      });

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
      expect(result.text!.length).toBeLessThanOrEqual(4000);
    });

    it("returns error when page has no text content", async () => {
      const session = makeMockSession();
      session.page.evaluate = vi.fn().mockResolvedValue("");
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "extract_text",
        sessionId: "default",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No text content");
    });
  });

  // -----------------------------------------------------------------------
  // screenshot
  // -----------------------------------------------------------------------

  describe("screenshot", () => {
    it("returns success with filePath", async () => {
      const session = makeMockSession();
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "screenshot",
        sessionId: "default",
      });

      expect(result.success).toBe(true);
      expect(result.filePath).toContain("abtars-screenshot-");
      expect(result.filePath).toContain(".png");
    });

    it("passes fullPage option to page.screenshot", async () => {
      const session = makeMockSession();
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      await tool.execute({
        action: "screenshot",
        sessionId: "default",
        fullPage: true,
      });

      expect(session.page.screenshot).toHaveBeenCalledWith(
        expect.objectContaining({ fullPage: true }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // get_page_info
  // -----------------------------------------------------------------------

  describe("get_page_info", () => {
    it("returns url, title, and elements array", async () => {
      const mockElements = [
        { tag: "a", selector: "#link1", text: "Home", href: "https://example.com" },
        { tag: "button", selector: "#btn1", text: "Submit" },
      ];
      const session = makeMockSession({
        evaluate: vi.fn().mockResolvedValue(mockElements),
        title: vi.fn().mockResolvedValue("Info Page"),
        url: vi.fn().mockReturnValue("https://example.com/info"),
      });
      mgr = makeMockBrowserManager(session);
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "get_page_info",
        sessionId: "default",
      });

      expect(result.success).toBe(true);
      expect(result.url).toBe("https://example.com/info");
      expect(result.title).toBe("Info Page");
      expect(result.elements).toHaveLength(2);
    });
  });

  // -----------------------------------------------------------------------
  // close_session
  // -----------------------------------------------------------------------

  describe("close_session", () => {
    it("calls browserManager.closeSession and returns success", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "close_session",
        sessionId: "my-session",
      });

      expect(result.success).toBe(true);
      expect(mgr.closeSession).toHaveBeenCalledWith("my-session");
    });
  });

  // -----------------------------------------------------------------------
  // General error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("catches unexpected errors and returns error result", async () => {
      mgr = {
        getSession: vi.fn().mockRejectedValue(new Error("Browser crashed")),
        closeSession: vi.fn(),
      } as unknown as BrowserManager;
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      const result = await tool.execute({
        action: "click",
        sessionId: "default",
        selector: "#btn",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Browser crashed");
    });

    it("all results have success boolean", async () => {
      mgr = makeMockBrowserManager();
      allowlist = makeMockAllowlist(true);
      tool = new BrowserTool(mgr, allowlist);

      // Test a few actions — all should have success field
      const actions: BrowserAction[] = [
        { action: "navigate", sessionId: "default", url: "https://example.com" },
        { action: "close_session", sessionId: "default" },
      ];

      for (const action of actions) {
        const result = await tool.execute(action);
        expect(typeof result.success).toBe("boolean");
      }
    });
  });
});
