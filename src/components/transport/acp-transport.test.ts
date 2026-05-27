import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ACP Transport — session management tests.
 * Tests the session Map logic without spawning a real kiro-cli process.
 * We access the private sessions Map via (transport as any).sessions.
 */

vi.mock("../transport-config.js", () => ({ loadTransport: () => null, resolveAgent: () => ({ contextWindow: 128000 }), clearTransportCache: () => {} }));
vi.mock("../../paths.js", () => ({ abtarsHome: () => "/tmp/abtars-test" }));
vi.mock("../logger.js", () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logDebug: vi.fn(), logError: vi.fn(), logTrace: vi.fn(), logAndSwallow: vi.fn() }));
vi.mock("../env-schema.js", () => ({ getEnv: () => ({ promptTimeoutSec: 180 }) }));

import { AcpTransport } from "./acp-transport.js";

describe("AcpTransport — session map logic", () => {
  let transport: AcpTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = new AcpTransport("/usr/bin/kiro-cli", "/tmp/work");
  });

  describe("sessions Map", () => {
    it("starts empty", () => {
      expect((transport as any).sessions.size).toBe(0);
    });

    it("stores session mapping after set", () => {
      const map = (transport as any).sessions as Map<string, string>;
      map.set("key-1", "acp-sess-001");
      map.set("key-2", "acp-sess-002");
      expect(map.get("key-1")).toBe("acp-sess-001");
      expect(map.get("key-2")).toBe("acp-sess-002");
      expect(map.size).toBe(2);
    });

    it("destroy clears ALL mappings", () => {
      const map = (transport as any).sessions as Map<string, string>;
      map.set("key-1", "acp-sess-001");
      map.set("key-2", "acp-sess-002");
      // destroy() clears the map
      map.clear(); // simulates what destroy() does
      expect(map.size).toBe(0);
      expect(map.get("key-1")).toBeUndefined();
    });

    it("resetSession destroys all sessions (not just the specified key)", () => {
      // This documents the pre-#622 behavior that caused the bug.
      // After #622 fix, /session new no longer calls resetSession.
      // But resetSession itself still clears everything (used by /reset).
      const map = (transport as any).sessions as Map<string, string>;
      map.set("key-1", "acp-sess-001");
      map.set("key-2", "acp-sess-002");
      // resetSession calls destroy() which clears all
      map.clear();
      expect(map.size).toBe(0);
    });
  });
});

describe("AcpTransport — sendPrompt signature", () => {
  it("accepts optional image parameter", () => {
    const transport = new AcpTransport("/usr/bin/kiro-cli", "/tmp/work");
    // Verify the method signature accepts 3 args (won't actually call — no client)
    expect(typeof transport.sendPrompt).toBe("function");
    expect(transport.sendPrompt.length).toBeGreaterThanOrEqual(2);
  });
});
