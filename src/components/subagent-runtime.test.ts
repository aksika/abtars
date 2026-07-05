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
  // #1290: mirrors DirectApiTransport.agentLabel default (direct-api-transport.ts:59)
  agentLabel: "professor",
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
    // #1290: reset to the DirectApiTransport default between tests
    mockTransport.agentLabel = "professor";
  });

  it("complete() returns response from transport", async () => {
    const result = await runtime.complete("dreamy", "test prompt");
    expect(result).toBe("response text");
    expect(mockSendPrompt).toHaveBeenCalledWith("system:dreamy", "test prompt");
  });

  it("caches transport — second call reuses", async () => {
    await runtime.complete("dreamy", "first");
    await runtime.complete("dreamy", "second");
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

  // --- #1290: budget attribution ---

  it("createAgent sets transport.agentLabel to the resolved agent (#1290)", async () => {
    await runtime.complete("dreamy", "test");
    expect(mockTransport.agentLabel).toBe("dreamy");
  });

  it("agentLabel follows the agent type, not the default (#1290)", async () => {
    await runtime.complete("coding", "test");
    expect(mockTransport.agentLabel).toBe("coding");
    expect(mockTransport.agentLabel).not.toBe("professor");
  });

  it("shutdown destroys all cached transports", async () => {
    await runtime.complete("dreamy", "a");
    await runtime.complete("coding", "b");
    await runtime.shutdown();
    expect(mockDestroy).toHaveBeenCalledTimes(2);
  });

  it("fresh session resets before sending", async () => {
    await runtime.complete("dreamy", "first");
    await runtime.complete("dreamy", "second", { session: "fresh" });
    expect(mockResetSession).toHaveBeenCalledWith("system:dreamy");
  });

  // --- session() tests ---

  it("session() returns AgentSession with sendPrompt and destroy", async () => {
    const session = await runtime.session("coding");
    expect(typeof session.sendPrompt).toBe("function");
    expect(typeof session.destroy).toBe("function");
    expect(session.isReady).toBe(true);
  });

  it("session().sendPrompt delegates to transport", async () => {
    const session = await runtime.session("coding");
    await session.sendPrompt("key1", "hello");
    expect(mockSendPrompt).toHaveBeenCalledWith("key1", "hello");
  });

  it("session().destroy evicts from cache", async () => {
    const session = await runtime.session("coding");
    await session.destroy();
    expect(mockDestroy).toHaveBeenCalledTimes(1);
    // Next session() should create fresh
    await runtime.session("coding");
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
  });

  // --- spawn() tests ---

  it("spawn() returns taskId immediately", async () => {
    const result = await runtime.spawn("browsie", "long task");
    expect(result.taskId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("spawn() calls onComplete with result", async () => {
    const onComplete = vi.fn();
    await runtime.spawn("browsie", "task", { onComplete });
    // Wait for the background promise to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(onComplete).toHaveBeenCalledWith(expect.any(String), "response text");
  });

  it("spawn() calls onError on failure", async () => {
    mockSendPrompt.mockRejectedValueOnce(new Error("boom"));
    const onError = vi.fn();
    await runtime.spawn("browsie", "fail", { onError });
    await new Promise(r => setTimeout(r, 10));
    expect(onError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: "boom" }));
  });

  it("shutdown aborts active spawns", async () => {
    mockSendPrompt.mockImplementation(() => new Promise(r => setTimeout(r, 5000)));
    const onComplete = vi.fn();
    await runtime.spawn("browsie", "slow", { onComplete });
    await runtime.shutdown();
    // onComplete should NOT be called (aborted)
    await new Promise(r => setTimeout(r, 10));
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe("SubagentRuntime shared registry", () => {
  it("passes registry to createSubagentTransport when set", async () => {
    const { ModelHealthRegistry } = await import("./transport/model-health-registry.js");
    const registry = new ModelHealthRegistry();
    const runtime = new SubagentRuntime();
    runtime.setRegistry(registry);

    mockSendPrompt.mockResolvedValueOnce("ok");
    await runtime.complete("dreamy", "test");

    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledWith("sleep", registry, undefined);
  });
});
