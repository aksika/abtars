import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSendPrompt = vi.fn().mockResolvedValue("ok");
const mockDestroy = vi.fn().mockResolvedValue(undefined);

vi.mock("./agent-registry.js", () => ({
  createSubagentTransport: vi.fn(async () => ({
    transport: {
      sendPrompt: mockSendPrompt,
      destroy: mockDestroy,
      resetSession: vi.fn(),
      isReady: true,
      contextPercent: -1,
      initialize: vi.fn(),
    },
    model: "test-model",
  })),
}));

const { SubagentRuntime } = await import("./subagent-runtime.js");
const { CodingMode } = await import("./coding-mode.js");

describe("CodingMode", () => {
  let cm: InstanceType<typeof CodingMode>;

  beforeEach(() => {
    vi.clearAllMocks();
    const runtime = new SubagentRuntime();
    cm = new CodingMode(runtime);
  });

  it("has() returns false for unknown session", () => {
    expect(cm.has("s1")).toBe(false);
  });

  it("getSession() returns null before start", () => {
    expect(cm.getSession()).toBeNull();
  });

  it("start() creates session and adds session key", async () => {
    await cm.start("s1");
    expect(cm.has("s1")).toBe(true);
    expect(cm.getSession()).not.toBeNull();
  });

  it("start() reuses session for second key", async () => {
    await cm.start("s1");
    const s1 = cm.getSession();
    await cm.start("s2");
    expect(cm.getSession()).toBe(s1);
    expect(cm.has("s1")).toBe(true);
    expect(cm.has("s2")).toBe(true);
  });

  it("stop() removes key, destroys session when last key removed", async () => {
    await cm.start("s1");
    await cm.stop("s1");
    expect(cm.has("s1")).toBe(false);
    expect(cm.getSession()).toBeNull();
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("stop() keeps session alive if other keys remain", async () => {
    await cm.start("s1");
    await cm.start("s2");
    await cm.stop("s1");
    expect(cm.has("s1")).toBe(false);
    expect(cm.getSession()).not.toBeNull();
  });
});
