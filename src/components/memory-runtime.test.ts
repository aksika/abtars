import { describe, expect, it, vi, type Mock } from "vitest";
import {
  createClientRuntime,
  createDisabledRuntime,
  createUnavailableRuntime,
  attemptMemoryMutation,
  asSessionSoulBundle,
  asExplicitKeywords,
  type MemoryRuntimeCapability,
} from "./memory-runtime.js";

function ownedPacket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: "owned-v1",
    profile: "recall_fast",
    packetId: "test-packet",
    status: "evidence",
    items: [
      {
        ref: { kind: "db", layer: "durable", recordId: 9, owner: "u1", version: "1" },
        excerpt: "The dog chased the fox.",
        rationale: "projection porter",
        excerptProvenance: "projection porter",
      },
    ],
    text: "[1] (db:durable:9:u1:1) The dog chased the fox.",
    effective: { maxItems: 5, maxOutputBytes: 2000, deadlineMs: 500, policyVersion: "owned-v1" },
    stageOutcomes: {},
    omissionReasons: [],
    ...overrides,
  };
}
import type { AbmindRouteSnapshotV1Like } from "./abmind-route-contract.js";

type AbmindCapabilitiesV1 = { version: number; methods: string[]; domains: string[]; features: Record<string, string> };

function mockClient(caps: AbmindCapabilitiesV1, overrides?: Partial<import("abmind").AbmindClient>): import("abmind").AbmindClient {
  return {
    capabilities: caps,
    privateMemory: {
      recordMessage: vi.fn().mockResolvedValue({ id: 42 }),
      recall: vi.fn().mockResolvedValue(ownedPacket({ items: [], text: "" })),
      assembleSessionContext: vi.fn().mockResolvedValue({ wakeUp: "", recall: "", coreKnowledge: "", soulBundle: { soul: "", profile: "", notes: "", memoryTools: "", coreFacts: "" } }),
      getRecentConversation: vi.fn().mockResolvedValue([]),
      getRuntimeStatus: vi.fn().mockResolvedValue(null),
      getCoreKnowledge: vi.fn().mockResolvedValue(""),
      recordFeedback: vi.fn().mockResolvedValue(undefined),
      embed: vi.fn().mockResolvedValue({ vectors: [], model: "" }),
      rebuildFtsIndexes: vi.fn().mockResolvedValue({ rebuilt: [] }),
      instantStore: vi.fn().mockResolvedValue({ stored: true, memoriesCount: 1 }),
      adjustRelevance: vi.fn().mockResolvedValue({ ok: true }),
      mergeMemories: vi.fn().mockResolvedValue({ merged: true }),
      cascadeDelete: vi.fn().mockResolvedValue({ ok: true }),
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
  "private.rebuildFts", "private.getCoreKnowledge", "private.getRuntimeStatus",
];

describe("capability projection", () => {
  it.each<{ methods: string[]; features: Record<string, string>; expected: MemoryRuntimeCapability[] }>([
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" },
      expected: ["recall", "recordMessage", "instantStore", "rebuildFts", "coreKnowledge", "status"],
    },
    {
      methods: ALL_METHODS,
      features: { private_read: "true", private_write: "false" },
      expected: ["recall", "recordMessage", "coreKnowledge", "status"],
    },
    {
      methods: ALL_METHODS,
      features: {},
      expected: ["recordMessage", "coreKnowledge", "status"],
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
      expected: ["instantStore", "rebuildFts"],
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
    const allCaps: MemoryRuntimeCapability[] = ["recall", "recordMessage", "instantStore", "rebuildFts", "coreKnowledge", "status"];
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
    // No-op initial: assignments inside the onRouteChange closure are
    // invisible to control-flow analysis, which would otherwise fold the
    // null initializer and reject every call below as `never`.
    let listener: (snapshot: AbmindRouteSnapshotV1Like) => void = () => {};
    const client = mockClient(currentCaps, {
      routeSnapshot: readySnapshot,
      onRouteChange: (fn: typeof listener) => {
        listener = fn as typeof listener;
        return () => {};
      },
    } as never);
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;

    const rt = createClientRuntime(client);
    expect(rt.state).toBe("ready");
    expect(rt.supports("recall")).toBe(true);

    // Route loss: capabilities clear, runtime goes unavailable immediately.
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = null;
    listener(lostSnapshot);
    expect(rt.state).toBe("unavailable");
    expect(rt.supports("recall")).toBe(false);

    // Recovery: capabilities re-project only after the route is ready again.
    currentCaps = caps(ALL_METHODS, { private_read: "true", private_write: "true", private_mutation_contract: "revision-v1" });
    (client as unknown as { capabilities: AbmindCapabilitiesV1 | null }).capabilities = currentCaps;
    listener(restoredSnapshot);
    expect(rt.state).toBe("ready");
    expect(rt.supports("recall")).toBe(true);
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

  it("preserves a plain structural error object's message while bounding it", async () => {
    const client = mockClient(WRITE_CAPS);
    (client.privateMemory.instantStore as ReturnType<typeof vi.fn>)
      .mockRejectedValue({
        code: "outcome_unknown",
        message: `secret sk-${"a".repeat(30)} ${"x".repeat(700)}`,
        requestId: "req-object",
        retryable: false,
        action: "reconcile",
        stage: "response",
      });
    const rt = createClientRuntime(client);
    const result = await rt.instantStore({ userId: "u1", contentEn: "x", contentOriginal: "x", memoryType: "fact", emotionScore: 0, confidence: 3, classification: 1 });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.code).toBe("memory_outcome_unknown");
      expect(result.message).toContain("***REDACTED***");
      expect(result.message.length).toBeLessThanOrEqual(512);
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
      phase: "after_delivery",
      family: "assistant",
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

describe("#1928 M4 — owned recall through createClientRuntime", () => {
  function recallClient(packet: Record<string, unknown>) {
    const client = mockClient(caps(["private.recall"], { private_read: "true" }));
    (client.privateMemory.recall as unknown as Mock).mockResolvedValue(packet);
    return client;
  }

  it("fast sends the verbatim raw turn under the owned contract", async () => {
    const client = recallClient(ownedPacket());
    const rt = createClientRuntime(client);
    const res = await rt.recall({ query: "deploy now", userId: "u1", profile: "recall_fast", rawTurn: "deploy now" });
    expect(vi.mocked(client.privateMemory.recall)).toHaveBeenCalledWith(expect.objectContaining({
      contract: "owned-v1",
      profile: "recall_fast",
      identity: { principal: "u1" },
      rawTurn: "deploy now",
    }));
    expect(res.status).toBe("evidence");
    expect(res.context).toBe("[1] (db:durable:9:u1:1) The dog chased the fox.");
    expect(res.hits).toEqual([expect.objectContaining({ ref: "db:durable:9:u1:1", kind: "db", content: "The dog chased the fox." })]);
  });

  it("clamps host capacity to the profile ceiling, never expands it", async () => {
    const client = recallClient(ownedPacket());
    const rt = createClientRuntime(client);
    await rt.recall({ query: "x", userId: "u1", profile: "recall_fast", rawTurn: "x", limit: 50, maxOutputBytes: 100000 });
    expect(vi.mocked(client.privateMemory.recall)).toHaveBeenCalledWith(
      expect.objectContaining({ capacity: expect.objectContaining({ maxItems: 5, maxOutputBytes: 2000 }) }),
    );
  });

  it("explicit anchor crosses verbatim with filters", async () => {
    const client = recallClient(ownedPacket());
    const rt = createClientRuntime(client);
    const keywords = ["Migration", "AND", "rollback", "rollback"];
    await rt.recall({ query: keywords.join(" "), userId: "u1", profile: "recall_normal", text: keywords.join(" "), keywords, timeStart: 10, timeEnd: 20 });
    expect(vi.mocked(client.privateMemory.recall)).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { text: keywords.join(" "), keywords },
        filters: expect.objectContaining({ timeStart: 10, timeEnd: 20 }),
      }),
    );
  });

  it("rejects empty keywords before any retrieval runs", async () => {
    const client = recallClient(ownedPacket());
    const rt = createClientRuntime(client);
    await expect(rt.recall({ query: "q", userId: "u1", profile: "recall_normal", text: "q", keywords: [] })).rejects.toThrow(/non-empty array/);
    expect(client.privateMemory.recall).not.toHaveBeenCalled();
  });

  it("rejects malformed packets instead of injecting a lie", async () => {
    for (const bad of [
      { contract: "legacy", profile: "recall_fast" },
      ownedPacket({ items: [{ noRef: true, excerpt: "x" }] }),
      ownedPacket({ items: [{ ref: { kind: "db", layer: "durable" }, excerpt: "x" }] }),
      ownedPacket({ text: 42 }),
      null,
    ]) {
      const rt = createClientRuntime(recallClient(bad as Record<string, unknown>));
      await expect(rt.recall({ query: "x", userId: "u1", profile: "recall_fast", rawTurn: "x" })).rejects.toThrow(/recall returned a/);
    }
  });

  it("surfaces packet status, refs, and continuation", async () => {
    const rt = createClientRuntime(recallClient(ownedPacket({
      status: "partial",
      omissionReasons: ["stage-degraded: Se (failed)"],
      continuation: "h1",
      items: [
        { ref: { kind: "artifact", owner: "u1", artifact: "daily/d.md", contentVersion: "v1" }, excerpt: "Weekly note." },
        { ref: { kind: "graph", edge: "e", sources: ["a", "b"] }, excerpt: "Linked pair." },
      ],
      text: "Weekly note.\nLinked pair.",
    })));
    const res = await rt.recall({ query: "x", userId: "u1", profile: "recall_full", text: "x" });
    expect(res.status).toBe("partial");
    expect(res.omissionReasons).toEqual(["stage-degraded: Se (failed)"]);
    expect(res.continuation).toBe("h1");
    expect(res.hits.map((h) => h.ref)).toEqual(["artifact:u1:daily/d.md:v1", "graph:e:a+b"]);
    expect(res.context).toBe("Weekly note.\nLinked pair.");
  });

  it("asExplicitKeywords accepts verbatim arrays and rejects anything else", async () => {
    expect(asExplicitKeywords(["a", "B", "a"])).toEqual(["a", "B", "a"]);
    for (const bad of [undefined, null, [], ["ok", ""], ["ok", "  "], "x", [42]]) {
      expect(() => asExplicitKeywords(bad)).toThrow(/non-empty array of non-blank strings/);
    }
  });
});

describe("#1869 session parts and test-mode status", () => {
  const FULL = { soul: "s", profile: "p", notes: "n", memoryTools: "t", coreFacts: "f" };

  it("asSessionSoulBundle accepts the five-string shape, rejects the rest", () => {
    expect(asSessionSoulBundle(FULL)).toEqual(FULL);
    for (const bad of [undefined, null, 42, "x", [], { ...FULL, soul: 1 }, { ...FULL, coreFacts: null }, { soul: "s" }]) {
      expect(asSessionSoulBundle(bad)).toBeUndefined();
    }
  });

  it("passes parts through from new daemons; absent on old ones", async () => {
    const withParts = mockClient(caps(ALL_METHODS));
    (withParts.privateMemory.assembleSessionContext as Mock).mockResolvedValue({
      wakeUp: "", recall: "", coreKnowledge: "", soulBundle: FULL, parts: FULL,
    });
    const rt = createClientRuntime(withParts);
    const res = await rt.assembleSessionContext({ identity: { principalId: "u", executionId: "s" } });
    expect(res.parts).toEqual(FULL);

    const legacy = createClientRuntime(mockClient(caps(ALL_METHODS)));
    const old = await legacy.assembleSessionContext({ identity: { principalId: "u", executionId: "s" } });
    expect(old.parts).toBeUndefined();
    expect(old.coreKnowledge).toBe("");
  });

  it("maps the daemon memoryTest mode, defaulting absent to false", async () => {
    for (const [raw, expected] of [
      [{ memoryTest: true }, true],
      [{ memoryTest: false }, false],
      [{}, false],
      [null, false],
    ] as const) {
      const client = mockClient(caps(ALL_METHODS));
      (client.privateMemory.getRuntimeStatus as Mock).mockResolvedValue(raw);
      const rt = createClientRuntime(client);
      expect((await rt.getStatus()).memoryTest).toBe(expected);
    }
    // Disabled/unavailable runtimes throw before returning a status.
    await expect(createDisabledRuntime().getStatus()).rejects.toThrow();
    await expect(createUnavailableRuntime().getStatus()).rejects.toThrow();
  });
});
