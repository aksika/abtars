import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock createSubagentTransport before importing SubagentRuntime
const mockSendPrompt = vi.fn();
const mockDestroy = vi.fn();
const mockResetSession = vi.fn();
const mockTransport = {
  sendPrompt: mockSendPrompt,
  destroy: mockDestroy,
  resetSession: mockResetSession,
  isReady: true,
  contextPercent: -1,
  initialize: vi.fn(),
};

vi.mock("./agent-registry.js", () => ({
  createSubagentTransport: vi.fn(async () => ({ transport: mockTransport, model: "test-model" })),
}));

const { SubagentRuntime } = await import("./subagent-runtime.js");

describe("SubagentRuntime", () => {
  let runtime: InstanceType<typeof SubagentRuntime>;

  beforeEach(() => {
    runtime = new SubagentRuntime();
    vi.clearAllMocks();
    mockSendPrompt.mockResolvedValue("response text");
  });

  it("complete() returns response from transport", async () => {
    const result = await runtime.complete("dreamy", "test prompt");
    expect(result).toBe("response text");
    expect(mockSendPrompt).toHaveBeenCalledWith("system:dreamy", "test prompt");
  });

  it("caches transport — second call reuses", async () => {
    await runtime.complete("dreamy", "first");
    await runtime.complete("dreamy", "second");
    // createSubagentTransport called once, sendPrompt called twice
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).toHaveBeenCalledTimes(2);
  });

  it("different agents get different transports", async () => {
    await runtime.complete("dreamy", "a");
    await runtime.complete("coding", "b");
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
  });

  it("evicts cache on failure — next call creates fresh", async () => {
    mockSendPrompt.mockRejectedValueOnce(new Error("model down"));
    await expect(runtime.complete("dreamy", "fail")).rejects.toThrow("model down");
    // Next call should create new transport
    mockSendPrompt.mockResolvedValueOnce("recovered");
    const result = await runtime.complete("dreamy", "retry");
    expect(result).toBe("recovered");
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
  });

  it("returns empty string for null response", async () => {
    mockSendPrompt.mockResolvedValue(null);
    const result = await runtime.complete("browsie", "test");
    expect(result).toBe("");
  });

  it("shutdown destroys all cached transports", async () => {
    await runtime.complete("dreamy", "a");
    await runtime.complete("coding", "b");
    await runtime.shutdown();
    expect(mockDestroy).toHaveBeenCalledTimes(2);
  });

  it("fresh session resets before sending", async () => {
    // First call creates + caches
    await runtime.complete("dreamy", "first");
    // Second call with fresh session should reset
    await runtime.complete("dreamy", "second", { session: "fresh" });
    expect(mockResetSession).toHaveBeenCalledWith("system:dreamy");
  });
});
