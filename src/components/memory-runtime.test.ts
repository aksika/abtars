import { describe, expect, it, vi } from "vitest";
import {
  createClientRuntime,
  createDisabledRuntime,
  createUnavailableRuntime,
  attemptMemoryMutation,
  type MemoryRuntimeCapability,
} from "./memory-runtime.js";

type AbmindCapabilitiesV1 = { version: number; methods: string[]; domains: string[]; features: Record<string, string> };

function mockClient(caps: AbmindCapabilitiesV1, overrides?: Partial<import("abmind").AbmindClient>): import("abmind").AbmindClient {
  return {
    capabilities: caps,
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
      instantStore: vi.fn().mockResolvedValue({ stored: true, memoriesCount: 1 }),
      editMemory: vi.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  } as unknown as import("abmind").AbmindClient;
}

function caps(methods: string[], features: Record<string, string> = {}): AbmindCapabilitiesV1 {
  return { version: 1, methods, domains: ["system", "private"], features };
}

const ALL_METHODS = [
  "private.recall", "private.recordMessage", "private.instantStore", "private.edit",
  "private.rebuildFts", "private.recordFeedback", "private.getCoreKnowledge", "private.getRuntimeStatus",
];

describe("capability projection", () => {
  it.each<{ methods: string[]; features: Record<string, string>; expected: MemoryRuntimeCapability[] }>([
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "true" },
      expected: ["recall", "recordMessage", "instantStore", "editMemory", "rebuildFts", "feedback", "coreKnowledge", "status"],
    },
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "false" },
      expected: ["recall", "recordMessage", "feedback", "coreKnowledge", "status"],
    },
    {
      methods: ALL_METHODS,
      features: {},
      expected: ["recordMessage", "feedback", "coreKnowledge", "status"],
    },
    {
      methods: ["private.recall", "private.recordMessage"],
      features: { private_read: "true", private_write: "true" },
      expected: ["recall", "recordMessage"],
    },
    {
      methods: [],
      features: {},
      expected: [],
    },
    {
      methods: ["private.instantStore", "private.edit", "private.rebuildFts"],
      features: { private_write: "true" },
      expected: ["instantStore", "editMemory", "rebuildFts"],
    },
    {
      methods: [],
      features: { private_read: "true", private_write: "true" },
      expected: [],
    },
  ])("$methods $features → $expected", ({ methods, features, expected }) => {
    const client = mockClient(caps(methods, features));
    const rt = createClientRuntime(client);
    for (const cap of expected) {
      expect(rt.supports(cap)).toBe(true);
    }
    const allCaps: MemoryRuntimeCapability[] = ["recall", "recordMessage", "instantStore", "editMemory", "rebuildFts", "feedback", "coreKnowledge", "status"];
    for (const cap of allCaps) {
      if (expected.includes(cap)) {
        expect(rt.supports(cap), `${cap} should be supported`).toBe(true);
      } else {
        expect(rt.supports(cap), `${cap} should NOT be supported`).toBe(false);
      }
    }
  });

  it("null capabilities → empty set (fail closed)", () => {
    const client = mockClient(caps([]));
    (client as any).capabilities = null;
    const rt = createClientRuntime(client);
    expect(rt.supports("recall")).toBe(false);
    expect(rt.supports("instantStore")).toBe(false);
    expect(rt.supports("recordMessage")).toBe(false);
  });
});

describe("createClientRuntime", () => {
  it("recordMessage returns { id: 42 } from client", async () => {
    const rt = createClientRuntime(mockClient(caps(ALL_METHODS)));
    const result = await rt.recordMessage(
      { userId: "u1", sessionId: "s1", role: "user", content: "hi", timestamp: Date.now() },
      "test-key",
    );
    expect(result).toEqual({ id: 42 });
  });

  it("recordMessage passes operationKey to client", async () => {
    const client = mockClient(caps(ALL_METHODS));
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

  it("instantStore dispatches when supported", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true", private_write: "true" }));
    const rt = createClientRuntime(client);
    const result = await rt.instantStore({ userId: "u1", contentEn: "test", contentOriginal: "test", memoryType: "fact", emotionScore: 0, confidence: 3, classification: 1 });
    expect(result.stored).toBe(true);
    expect(client.privateMemory.instantStore).toHaveBeenCalled();
  });

  it("editMemory dispatches when supported", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true", private_write: "true" }));
    const rt = createClientRuntime(client);
    const result = await rt.editMemory({ memoryId: 1, contentEn: "updated" });
    expect(result.ok).toBe(true);
    expect(client.privateMemory.editMemory).toHaveBeenCalled();
  });

  it("supports recall when private_read=true", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true" }));
    const rt = createClientRuntime(client);
    expect(rt.supports("recall")).toBe(true);
  });

  it("does NOT support recall when private_read is missing", async () => {
    const client = mockClient(caps(ALL_METHODS, {}));
    const rt = createClientRuntime(client);
    expect(rt.supports("recall")).toBe(false);
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
