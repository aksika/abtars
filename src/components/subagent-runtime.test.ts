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
  // #1290: mirrors PiCoreTransport.agentLabel default (direct-api-transport.ts:59)
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
    // #1290: reset to the PiCoreTransport default between tests
    mockTransport.agentLabel = "professor";
  });

  it("complete() returns response from transport", async () => {
    const result = await runtime.complete("dreamy", "test prompt");
    expect(result).toBe("response text");
    expect(mockSendPrompt).toHaveBeenCalledWith("system:dreamy", "test prompt", undefined, expect.objectContaining({ executionId: expect.any(String), outputObserver: undefined }));
  });

  it("reuses transport for reuse-strategy agents", async () => {
    await runtime.complete("professor", "first");
    await runtime.complete("professor", "second");
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).toHaveBeenCalledTimes(2);
  });

  it("creates fresh transport per call for fresh-strategy agents (#1502)", async () => {
    await runtime.complete("dreamy", "first");
    await runtime.complete("dreamy", "second");
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
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

  it("fresh session creates new transport (#1502)", async () => {
    await runtime.complete("dreamy", "first");
    await runtime.complete("dreamy", "second", { session: "fresh" });
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
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

  it("keeps the default spawn alive past 10 minutes", async () => {
    vi.useFakeTimers();
    let release!: (result: string) => void;
    mockSendPrompt.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const onComplete = vi.fn();

    try {
      await runtime.spawn("browsie", "slow", { onComplete });
      for (let i = 0; i < 10 && !mockSendPrompt.mock.calls.length; i++) await Promise.resolve();
      expect(mockSendPrompt).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
      release("response text");
      await vi.advanceTimersByTimeAsync(0);

      expect(onComplete).toHaveBeenCalledWith(expect.any(String), "response text");
    } finally {
      await runtime.shutdown();
      vi.useRealTimers();
    }
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
    // #1527: the late-bound durable context provider holder is the 4th arg;
    // #1552: the memory-tool deps holder is the 5th.
    // --- the transport factory's trailing workingDir override (#1807) is
    // undefined here; the assertion pins forwarding of the first six args.
    expect(createSubagentTransport).toHaveBeenCalledWith("sleep", registry, null, { current: null }, { current: null }, undefined, undefined);
  });

  it("forwards the composed durable context provider holder to lazy transports (#1527)", async () => {
    const { ModelHealthRegistry } = await import("./transport/model-health-registry.js");
    const registry = new ModelHealthRegistry();
    const runtime = new SubagentRuntime();
    runtime.setRegistry(registry);

    const holder = { current: { projectContext: () => Promise.resolve({ messages: [], estimatedTokens: 0, sourceMessageCount: 0 }) } };
    runtime.setContextProvider(holder);
    const memoryDepsHolder = { current: null };
    runtime.setMemoryToolDependencies(memoryDepsHolder);

    mockSendPrompt.mockResolvedValueOnce("ok");
    await runtime.complete("dreamy", "test");

    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledWith("sleep", registry, null, holder, memoryDepsHolder, undefined, undefined);
  });

  it("#1611: a persistent session rejects conflicting candidate-policy reuse — never broadens configured-only", async () => {
    vi.clearAllMocks();
    mockSendPrompt.mockResolvedValue("response text");
    const runtime = new SubagentRuntime();
    const s1 = await runtime.session("dreamy", undefined, { candidatePolicy: "configured-only" });
    expect(s1.isReady).toBe(true);
    // Same policy reuses the cached transport.
    const s2 = await runtime.session("dreamy", undefined, { candidatePolicy: "configured-only" });
    expect(s2.isReady).toBe(true);
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(1);

    await expect(
      runtime.session("dreamy", undefined, { candidatePolicy: "fallback-chain" }),
    ).rejects.toThrow(/conflicting reuse/);
    expect(createSubagentTransport, "the cached transport must not be recreated").toHaveBeenCalledTimes(1);
  });
});

describe("SubagentRuntime sleep cwd binding (#1807)", () => {
  let tmpA: string;
  let tmpB: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSendPrompt.mockResolvedValue("response text");
    mockTransport.agentLabel = "professor";
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    tmpA = mkdtempSync(join(tmpdir(), "sleep-scope-a-"));
    tmpB = mkdtempSync(join(tmpdir(), "sleep-scope-b-"));
  });

  function scope(cwd: string) {
    return { cwd, env: Object.freeze({ WORKSPACE: cwd }) };
  }

  it("records the binding on scoped creation and reuses it for the same cycle", async () => {
    const { realpathSync } = await import("node:fs");
    const runtime = new SubagentRuntime();
    const s1 = await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    const s2 = await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    expect(s1.isReady).toBe(true);
    expect(s2.isReady).toBe(true);
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(1);
    expect(runtime.verifyTransportBinding("dreamy", "cycle-1")).toBe(realpathSync(tmpA));
  });

  it("allocates separately per cycle identity", async () => {
    const runtime = new SubagentRuntime();
    await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    await runtime.session("dreamy", "cycle-2", { executionScope: scope(tmpA) });
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched scope reuse before any provider work", async () => {
    const runtime = new SubagentRuntime();
    await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    mockSendPrompt.mockClear();
    await expect(
      runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpB) }),
    ).rejects.toThrow(/refusing reuse/);
    const { createSubagentTransport } = await import("./agent-registry.js");
    expect(createSubagentTransport, "mismatched reuse must not recreate").toHaveBeenCalledTimes(1);
    expect(mockSendPrompt).not.toHaveBeenCalled();
  });

  it("rejects scoped reuse of an unverified (scopeless) transport", async () => {
    const runtime = new SubagentRuntime();
    await runtime.session("dreamy", "legacy");
    await expect(
      runtime.session("dreamy", "legacy", { executionScope: scope(tmpA) }),
    ).rejects.toThrow(/unverified/);
  });

  it("fails an unavailable cwd before creating anything", async () => {
    const runtime = new SubagentRuntime();
    const { createSubagentTransport } = await import("./agent-registry.js");
    const callsBefore = (createSubagentTransport as any).mock.calls.length;
    await expect(
      runtime.session("dreamy", "cycle-9", { executionScope: scope("/nonexistent-1807-scope") }),
    ).rejects.toThrow(/unavailable/);
    expect((createSubagentTransport as any).mock.calls.length).toBe(callsBefore);
  });

  it("a stale destroy callback cannot evict a newer entry under the same key", async () => {
    const runtime = new SubagentRuntime();
    const s1 = await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    await s1.destroy();
    const s2 = await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    const { createSubagentTransport } = await import("./agent-registry.js");
    const creations = (createSubagentTransport as any).mock.calls.length;
    // Stale callback from the first generation runs late: the live entry survives.
    await s1.destroy();
    const s3 = await runtime.session("dreamy", "cycle-1", { executionScope: scope(tmpA) });
    expect((createSubagentTransport as any).mock.calls.length).toBe(creations);
    expect(s3.isReady).toBe(true);
    expect(s2.isReady).toBe(true);
  });
});
