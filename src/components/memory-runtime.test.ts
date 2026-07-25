import { describe, expect, it, vi } from "vitest";
import {
  createClientRuntime,
  createDisabledRuntime,
  createUnavailableRuntime,
  attemptMemoryMutation,
} from "./memory-runtime.js";

// Define minimal mock client
function mockClient(overrides?: Partial<import("abmind").AbmindClient>): import("abmind").AbmindClient {
  return {
    privateMemory: {
      recordMessage: vi.fn().mockResolvedValue({ id: 42 }),
      recall: vi.fn().mockResolvedValue({ results: [] }),
      assembleSessionContext: vi.fn().mockResolvedValue({ wakeUp: "", recall: "", coreKnowledge: "", soulBundle: { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" } }),
      getRecentConversation: vi.fn().mockResolvedValue([]),
      getRuntimeStatus: vi.fn().mockResolvedValue(null),
      getCoreKnowledge: vi.fn().mockResolvedValue(""),
      recordFeedback: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ vectors: [], model: "" }),
      rebuildFtsIndexes: vi.fn().mockResolvedValue({ rebuilt: [] }),
    },
    ...overrides,
  } as unknown as import("abmind").AbmindClient;
}

describe("createClientRuntime", () => {
  it("recordMessage returns { id: 42 } from client", async () => {
    const rt = createClientRuntime(mockClient());
    const result = await rt.recordMessage(
      { userId: "u1", sessionId: "s1", role: "user", content: "hi", timestamp: Date.now() },
      "test-key",
    );
    expect(result).toEqual({ id: 42 });
  });

  it("recordMessage passes operationKey to client", async () => {
    const client = mockClient();
    const rt = createClientRuntime(client);
    await rt.recordMessage(
      { userId: "u1", sessionId: "s1", role: "user", content: "hi", timestamp: Date.now() },
      "test-op-key",
    );
    expect(client.privateMemory.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1" }),
      "test-op-key",
    );
  });
});

describe("attemptMemoryMutation", () => {
  it("returns ok: true with value on success", async () => {
    const result = await attemptMemoryMutation({
      phase: "before_model",
      family: "inbound",
      operationKey: "test-key",
      run: async () => "success",
    });
    expect(result).toEqual({ ok: true, value: "success" });
  });

  it("returns ok: false without crashing on abmind error", async () => {
    const result = await attemptMemoryMutation({
      phase: "before_model",
      family: "inbound",
      operationKey: "test-key",
      run: async () => { throw Object.assign(new Error("idempotency conflict"), { code: "idempotency_conflict" }); },
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok: false on generic error without code", async () => {
    const result = await attemptMemoryMutation({
      phase: "after_delivery",
      family: "assistant",
      operationKey: "test-key-2",
      run: async () => { throw new Error("Connection refused"); },
    });
    expect(result.ok).toBe(false);
  });

  it("never retries — run is called at most once", async () => {
    const run = vi.fn().mockRejectedValue(new Error("fail"));
    await attemptMemoryMutation({
      phase: "feedback",
      family: "feedback",
      operationKey: "test-key-3",
      run,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not prevent subsequent successful mutations after a failure", async () => {
    await attemptMemoryMutation({
      phase: "before_model",
      family: "inbound",
      operationKey: "fail-key",
      run: async () => { throw new Error("fail"); },
    });
    const second = await attemptMemoryMutation({
      phase: "before_model",
      family: "inbound",
      operationKey: "success-key",
      run: async () => "ok",
    });
    expect(second).toEqual({ ok: true, value: "ok" });
  });

  it("does not disable memory runtime globally after failure", async () => {
    // Simulating a memory runtime that fails once then succeeds
    let callCount = 0;
    const run = async () => {
      callCount++;
      if (callCount === 1) throw new Error("first call fails");
      return "second call ok";
    };
    await attemptMemoryMutation({ phase: "before_model", family: "inbound", operationKey: "k1", run: async () => { callCount++; throw new Error("first call fails"); } });
    const result = await attemptMemoryMutation({ phase: "before_model", family: "inbound", operationKey: "k2", run: async () => { callCount++; return "ok"; } });
    expect(result.ok).toBe(true);
  });
});

describe("Disabled and Unavailable runtimes", () => {
  it("disabled runtime throws on recordMessage", async () => {
    const rt = createDisabledRuntime();
    await expect(rt.recordMessage({ userId: "u", sessionId: "s", role: "user", content: "hi", timestamp: 1 }, "k"))
      .rejects.toThrow("Memory is disabled");
  });

  it("unavailable runtime throws on recordMessage", async () => {
    const rt = createUnavailableRuntime();
    await expect(rt.recordMessage({ userId: "u", sessionId: "s", role: "user", content: "hi", timestamp: 1 }, "k"))
      .rejects.toThrow("Memory unavailable");
  });
});
