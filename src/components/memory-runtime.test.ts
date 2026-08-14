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
      projectConversationContext: vi.fn().mockResolvedValue({
        version: 1,
        messages: [{ role: "user", content: "prior" }],
        estimatedTokens: 10,
        prunedToolResults: 0,
        sourceMessageCount: 1,
      }),
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
  "private.projectConversationContext",
];

describe("capability projection", () => {
  it.each<{ methods: string[]; features: Record<string, string>; expected: MemoryRuntimeCapability[] }>([
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" },
      expected: ["recall", "recordMessage", "instantStore", "editMemory", "rebuildFts", "feedback", "coreKnowledge", "status", "durableContext"],
    },
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "false" },
      expected: ["recall", "recordMessage", "feedback", "coreKnowledge", "status", "durableContext"],
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
      features: { private_write: "true", private_mutation_contract: "revision-v1" },
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
    const allCaps: MemoryRuntimeCapability[] = ["recall", "recordMessage", "instantStore", "editMemory", "rebuildFts", "feedback", "coreKnowledge", "status", "durableContext"];
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

  it.each([
    { version: 2, methods: ALL_METHODS, features: { private_write: "true" } },
    { version: 1, methods: "private.instantStore", features: { private_write: "true" } },
    { version: 1, methods: ALL_METHODS, features: "private_write=true" },
    { version: 1, methods: [...ALL_METHODS, 42], features: { private_write: "true" } },
  ])("malformed or unsupported snapshot fails closed: $version $methods", malformed => {
    const client = mockClient(caps([]));
    (client as any).capabilities = malformed;
    const rt = createClientRuntime(client);
    expect([...rt.capabilities]).toEqual([]);
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
    const client = mockClient(caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" }));
    const rt = createClientRuntime(client);
    const result = await rt.instantStore({ userId: "u1", contentEn: "test", contentOriginal: "test", memoryType: "fact", emotionScore: 0, confidence: 3, classification: 1 });
    expect(result.stored).toBe(true);
    expect(client.privateMemory.instantStore).toHaveBeenCalled();
  });

  it("editMemory dispatches when supported", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" }));
    const rt = createClientRuntime(client);
    const result = await rt.editMemory({ memoryId: 1, expectedRevision: 1, userId: "u1" });
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

  it("does not dispatch an unadvertised FTS rebuild", async () => {
    const client = mockClient(caps(["private.rebuildFts"], { private_write: "false" }));
    const rt = createClientRuntime(client);
    await expect(rt.rebuildFtsIndexes()).rejects.toThrow(/capability unavailable/);
    await expect(rt.runMaintenance({ operation: "fts_rebuild" })).resolves.toEqual({
      ok: false,
      summary: "Memory capability unavailable: rebuildFts",
    });
    expect(client.privateMemory.rebuildFtsIndexes).not.toHaveBeenCalled();
  });

  it("tracks route loss: memory becomes unavailable immediately and clears stale capabilities (#1382)", async () => {    const readySnapshot = { version: 1 as const, state: "ready" as const, generation: 3, retryEligible: 0, terminalUnknown: 0 };
    const lostSnapshot = { version: 1 as const, state: "reconnecting" as const, generation: 4, retryEligible: 1, terminalUnknown: 0 };
    const restoredSnapshot = { version: 1 as const, state: "ready" as const, generation: 5, retryEligible: 0, terminalUnknown: 0 };
    let currentCaps: AbmindCapabilitiesV1 | null = caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" });
    let listener: ((snapshot: typeof readySnapshot) => void) | null = null;
    const client = mockClient(currentCaps, {
      routeSnapshot: readySnapshot,
      onRouteChange: (fn: typeof listener) => {
        listener = fn as typeof listener;
        return () => { listener = null; };
      },
    } as never);
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;

    const rt = createClientRuntime(client);
    expect(rt.state).toBe("ready");
    expect(rt.supports("recall")).toBe(true);

    // Route loss: capabilities clear, runtime goes unavailable immediately.
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = null;
    listener?.(lostSnapshot);
    expect(rt.state).toBe("unavailable");
    expect(rt.supports("recall")).toBe(false);

    // Recovery: capabilities re-project only after the route is ready again.
    currentCaps = caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" });
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;
    listener?.(restoredSnapshot);
    expect(rt.state).toBe("ready");
    expect(rt.supports("recall")).toBe(true);
  });

  it("projects durable context when advertised and normalizes the result (#1527)", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true" }));
    const rt = createClientRuntime(client);
    expect(rt.supports("durableContext")).toBe(true);

    const result = await rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 });
    expect(result).toEqual({
      messages: [{ role: "user", content: "prior" }],
      estimatedTokens: 10,
      sourceMessageCount: 1,
    });
    expect(client.privateMemory.projectConversationContext).toHaveBeenCalledWith({
      userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000,
    });
  });

  it("fails closed when durable context is not advertised — provider is never invoked", async () => {
    const client = mockClient(caps(["private.recall", "private.recordMessage"], { private_read: "true" }));
    const rt = createClientRuntime(client);
    expect(rt.supports("durableContext")).toBe(false);
    await expect(rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 }))
      .rejects.toThrow(/capability unavailable: durableContext/);
    expect(client.privateMemory.projectConversationContext).not.toHaveBeenCalled();
  });

  it("rejects malformed projection responses instead of returning empty context (#1527)", async () => {
    const client = mockClient(caps(ALL_METHODS, { private_read: "true" }));
    (client.privateMemory.projectConversationContext as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ version: 1, messages: [{ role: "robot", content: "x" }] });
    const rt = createClientRuntime(client);
    await expect(rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 }))
      .rejects.toThrow(/malformed message/);

    (client.privateMemory.projectConversationContext as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ messages: "nope" });
    await expect(rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 }))
      .rejects.toThrow(/no messages array/);
  });

  it("route loss makes durable projection reject until renegotiation recovers (#1527)", async () => {
    const readySnapshot = { version: 1 as const, state: "ready" as const, generation: 3, retryEligible: 0, terminalUnknown: 0 };
    const lostSnapshot = { version: 1 as const, state: "reconnecting" as const, generation: 4, retryEligible: 1, terminalUnknown: 0 };
    let currentCaps: AbmindCapabilitiesV1 | null = caps(ALL_METHODS, { private_read: "true" });
    let listener: ((snapshot: typeof readySnapshot) => void) | null = null;
    const client = mockClient(currentCaps, {
      routeSnapshot: readySnapshot,
      onRouteChange: (fn: typeof listener) => {
        listener = fn as typeof listener;
        return () => { listener = null; };
      },
    } as never);
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;

    const rt = createClientRuntime(client);
    expect(rt.supports("durableContext")).toBe(true);

    // Route loss clears capabilities → projection must reject without a call.
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = null;
    listener?.(lostSnapshot);
    await expect(rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 }))
      .rejects.toThrow(/capability unavailable/);

    // Recovery re-projects capabilities → a new execution may project again.
    currentCaps = caps(ALL_METHODS, { private_read: "true" });
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;
    listener?.({ version: 1 as const, state: "ready" as const, generation: 5, retryEligible: 0, terminalUnknown: 0 });
    const result = await rt.projectDurableContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 });
    expect(result.messages.length).toBe(1);
  });
});

describe("#1659 runtime failure contract", () => {
  const WRITE_CAPS = caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" });

  function structuralError(code: string, message: string, stage: string, retryable: boolean, action: string): Error {
    return Object.assign(new Error(message), {
      name: "AbmindClientError", code, requestId: "req-123", retryable, action, stage,
    });
  }

  it.each<{ code: string; stage: string; retryable: boolean; action: string; bridgeCode: string }>([
    { code: "validation_error", stage: "pre_dispatch", retryable: false, action: "fix_input", bridgeCode: "memory_validation" },
    { code: "not_found", stage: "pre_dispatch", retryable: false, action: "stop", bridgeCode: "memory_not_found" },
    { code: "conflict", stage: "pre_dispatch", retryable: false, action: "re_recall", bridgeCode: "memory_conflict" },
    { code: "unauthorized", stage: "pre_dispatch", retryable: false, action: "stop", bridgeCode: "memory_unauthorized" },
    { code: "idempotency_conflict", stage: "pre_dispatch", retryable: false, action: "stop", bridgeCode: "memory_idempotency_conflict" },
    { code: "unavailable", stage: "pre_dispatch", retryable: true, action: "retry", bridgeCode: "memory_unavailable" },
    { code: "outcome_unknown", stage: "response", retryable: false, action: "reconcile", bridgeCode: "memory_outcome_unknown" },
  ])("instantStore preserves the structural failure contract for $code", async ({ code, stage, retryable, action, bridgeCode }) => {
    const client = mockClient(WRITE_CAPS);
    (client.privateMemory.instantStore as ReturnType<typeof vi.fn>)
      .mockRejectedValue(structuralError(code, `${code} happened`, stage, retryable, action));
    const rt = createClientRuntime(client);
    const result = await rt.instantStore({ userId: "u1", contentEn: "x", contentOriginal: "x", memoryType: "fact", emotionScore: 0, confidence: 3, classification: 1 });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result).toMatchObject({
        code: bridgeCode,
        message: `${code} happened`,
        requestId: "req-123",
        retryable,
        action,
        stage,
      });
    }
  });

  it("editMemory surfaces a conflict as memory_conflict/re_recall without flattening", async () => {
    const client = mockClient(WRITE_CAPS);
    (client.privateMemory.editMemory as ReturnType<typeof vi.fn>)
      .mockRejectedValue(structuralError("conflict", "Semantic revision conflict", "pre_dispatch", false, "re_recall"));
    const rt = createClientRuntime(client);
    const result = await rt.editMemory({ memoryId: 7, expectedRevision: 2, userId: "u1" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("memory_conflict");
      expect(result.action).toBe("re_recall");
      expect(result.retryable).toBe(false);
    }
  });

  it("an unstructured thrown error becomes an uncertain response-stage failure, never pre_dispatch", async () => {
    const client = mockClient(WRITE_CAPS);
    (client.privateMemory.instantStore as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("connection reset"));
    const rt = createClientRuntime(client);
    const result = await rt.instantStore({ userId: "u1", contentEn: "x", contentOriginal: "x", memoryType: "fact", emotionScore: 0, confidence: 3, classification: 1 });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.code).toBe("unknown");
      expect(result.stage).toBe("response");
      expect(result.action).toBe("reconcile");
      expect(result.message).toContain("connection reset");
    }
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

  it("disabled and unavailable runtimes reject durable projection rather than returning empty context (#1527)", async () => {
    const input = { userId: "u", sessionId: "s", beforeMessageId: 1, maxContext: 8000 };
    await expect(createDisabledRuntime().projectDurableContext(input)).rejects.toThrow("Memory is disabled");
    await expect(createUnavailableRuntime().projectDurableContext(input)).rejects.toThrow("Memory unavailable");
  });
});
