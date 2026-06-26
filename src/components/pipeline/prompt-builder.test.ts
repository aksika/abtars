import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildSessionStartPrompt } from "./prompt-builder.js";

// Mock dependencies
vi.mock("../logger.js", () => ({
  logInfo: vi.fn(), logDebug: vi.fn(), logTrace: vi.fn(), logWarn: vi.fn(),
}));
vi.mock("../log-and-swallow.js", () => ({ logAndSwallow: vi.fn() }));
vi.mock("../soul-loader.js", () => ({ loadSoulBundle: vi.fn(() => "# SOUL\nYou are an AI.") }));
vi.mock("../user-registry.js", () => ({
  loadUsers: vi.fn(() => ({
    users: [{ userId: "aksika", role: "master", maxClass: 3 }],
    byUserId: new Map([["aksika", { userId: "aksika", role: "master", maxClass: 3 }]]),
    byPlatformId: new Map(),
  })),
}));
vi.mock("abmind", () => ({
  renderMemory: vi.fn((m) => `[memory] ${m.content_en}`),
  buildSessionStartContext: vi.fn(() => ({ text: "Session context: last active 2h ago", stats: { messages: 5, dailies: 1, weeklies: 0, quarterlies: 0, usedBytes: 500, budget: 4000 } })),
}));
vi.mock("../../utils/abmind-lazy.js", () => ({
  abmind: () => ({
    buildSessionStartContext: () => ({ text: "Session context: last active 2h ago", stats: { messages: 5, dailies: 1, weeklies: 0, quarterlies: 0, usedBytes: 500, budget: 4000 } }),
    renderMemory: (m: any) => `[memory] ${m.content_en}`,
  }),
  loadAbmind: async () => ({}),
}));
vi.mock("../transport/bridge-lock-transport.js", () => ({
  readAndClearRestartReason: vi.fn(() => null),
}));

function mockMemory() {
  return {
    buildWakeUp: vi.fn(() => "Wake-up: 3 memories, last sleep 8h ago"),
    recallSearch: vi.fn(async () => ({ results: [] })),
    recordMessage: vi.fn(),
  } as any;
}

describe("buildSessionStartPrompt", () => {
  it("wraps prompt in CONTEXT block with soul + user + context", () => {
    const result = buildSessionStartPrompt("hello", mockMemory(), "aksika", "aksika:telegram");
    expect(result).toContain("[CONTEXT — do not respond to this section]");
    expect(result).toContain("[/CONTEXT]");
    expect(result).toContain("# SOUL");
    expect(result).toContain("[CURRENT USER]");
    expect(result).toContain("aksika");
    expect(result).toContain("hello");
  });

  it("places user message AFTER context block", () => {
    const result = buildSessionStartPrompt("user msg here", mockMemory(), "aksika", "aksika:telegram");
    const ctxEnd = result.indexOf("[/CONTEXT]");
    const msgPos = result.indexOf("user msg here");
    expect(msgPos).toBeGreaterThan(ctxEnd);
  });

  it("includes wake-up for master users", () => {
    const result = buildSessionStartPrompt("hi", mockMemory(), "aksika", "aksika:telegram");
    expect(result).toContain("Wake-up:");
  });

  it("includes session-start context from abmind", () => {
    const result = buildSessionStartPrompt("hi", mockMemory(), "aksika", "aksika:telegram");
    expect(result).toContain("Session context: last active 2h ago");
  });

  it("includes restart reason when present", async () => {
    const { readAndClearRestartReason } = await import("../transport/bridge-lock-transport.js");
    (readAndClearRestartReason as any).mockReturnValueOnce("deploy: updated to 0.1.0-abc123");
    const result = buildSessionStartPrompt("hi", mockMemory(), "aksika", "aksika:telegram");
    expect(result).toContain("[SESSION START REASON] deploy: updated to 0.1.0-abc123");
  });

  it("works without sessionKey (no user injection)", () => {
    const result = buildSessionStartPrompt("hi", mockMemory(), "aksika");
    expect(result).not.toContain("[CURRENT USER]");
    expect(result).toContain("# SOUL");
    expect(result).toContain("hi");
  });

  it("handles missing soul gracefully", async () => {
    const { loadSoulBundle } = await import("../soul-loader.js");
    (loadSoulBundle as any).mockReturnValueOnce(null);
    const result = buildSessionStartPrompt("hi", mockMemory(), "aksika", "aksika:telegram");
    expect(result).toContain("hi");
    // No crash, still has context block
    expect(result).toContain("[CONTEXT");
  });
});
