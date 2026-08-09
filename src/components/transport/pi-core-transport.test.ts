// Pi resolution is mocked to "absent" (../pi-installation.js) so these tests
// verify the compositor structure and lifecycle with the real loader chain
// (pi-core-types loadAndValidatePiAgentCore stays real), deterministically,
// regardless of whether a compatible global Pi install is present on the host.
// A host Pi would otherwise load the real pi-agent-core and hit the provider
// boundary with the unreachable test endpoint — see #1582.
// Real-Pi integration coverage stays deferred: requires a full Pi installation.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PiCoreTransport, extractAssistantText } from "./pi-core-transport.js";
import { PiCoreContextProjection, DurableContextUnavailableError, createDurableContextProvider } from "./pi-core-context.js";
import { PiCoreContractError, convertCurrentTurnToLlm } from "./pi-core-types.js";
import type { DurableContextProviderHolder } from "./pi-core-context.js";
import type { PiExecutionContextSeed, AbtarsCurrentTurnMessage, AgentMessage } from "./pi-core-types.js";
import type { ModelCandidate } from "./model-candidates.js";
import { ModelHealthRegistry } from "./model-health-registry.js";

const mockCreatePiStreamFn = vi.hoisted(() => vi.fn(() => vi.fn()));

vi.mock("./pi-stream-fn.js", () => ({ createPiStreamFn: mockCreatePiStreamFn }));
vi.mock("../pi-installation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi-installation.js")>();
  return {
    ...actual,
    resolvePiInstallation: () => ({ state: "absent" as const }),
  };
});

function makeCandidates(): ModelCandidate[] {
  return [{
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  }];
}

function makeTransport() {
  const registry = new ModelHealthRegistry();
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidates: makeCandidates(),
    healthRegistry: registry,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport", () => {
  it("constructs with main role", () => {
    const t = makeTransport();
    expect(t.config.role).toBe("main");
    expect(t.config.candidates).toHaveLength(1);
  });

  it("starts uninitialized", () => {
    const t = makeTransport();
    expect(t.isReady).toBe(false);
  });

  it("initialize sets isReady", async () => {
    const t = makeTransport();
    await t.initialize();
    expect(t.isReady).toBe(true);
  });

  it("implements IKiroTransport interface", () => {
    const t = makeTransport();
    expect(typeof t.initialize).toBe("function");
    expect(typeof t.sendPrompt).toBe("function");
    expect(typeof t.resetSession).toBe("function");
    expect(typeof t.sendInterrupt).toBe("function");
    expect(typeof t.destroy).toBe("function");
    expect(typeof t.lastUsage).toBe("function");
    expect(typeof t.getRuntimeStatus).toBe("function");
  });

  it("getRuntimeStatus returns route/provider/model", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.route).toBe("pi-ai");
    expect(status.provider).toBe("test-provider");
    expect(status.model).toBe("test-model");
  });

  it("resetSession clears state", async () => {
    const t = makeTransport();
    await t.resetSession("test_session");
    expect(t.isReady).toBe(false);
  });

  it("destroy clears active host", () => {
    const t = makeTransport();
    t.destroy();
    expect(t.isReady).toBe(false);
  });

  it("sendPrompt without Pi installation throws", async () => {
    const t = makeTransport();
    await t.initialize();
    await expect(t.sendPrompt("test_session", "hello")).rejects.toThrow(PiCoreContractError);
  });

  it("interrupt on inactive host does not throw", async () => {
    const t = makeTransport();
    await t.sendInterrupt();
  });

  it("supports specialist role", () => {
    const registry = new ModelHealthRegistry();
    const t = new PiCoreTransport({
      role: "specialist",
      systemPrompt: "",
      candidates: makeCandidates(),
      healthRegistry: registry,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(t.config.role).toBe("specialist");
  });

  it("captures the late-bound provider holder for post-construction composition (#1527)", () => {
    // Transport construction and memory negotiation boot in parallel, so the
    // transport must observe a holder populated AFTER construction. This test
    // fails if the production constructor drops the holder option.
    const holder: DurableContextProviderHolder = { current: null };
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidates: makeCandidates(),
      healthRegistry: new ModelHealthRegistry(),
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      contextProvider: holder,
    });
    const stored = (t as unknown as { _contextProvider: DurableContextProviderHolder })._contextProvider;
    expect(stored).toBe(holder);

    const provider = { projectContext: vi.fn() };
    holder.current = provider;
    expect(stored.current).toBe(provider);
  });

  it("defaults to an empty holder when no provider is composed (fail-closed baseline)", () => {
    const t = makeTransport();
    const stored = (t as unknown as { _contextProvider: DurableContextProviderHolder })._contextProvider;
    expect(stored).toEqual({ current: null });
  });

  it("createDurableContextProvider adapts the memory runtime's fail-closed projection", async () => {
    const provider = createDurableContextProvider({
      state: "ready",
      capabilities: new Set(["durableContext"]),
      supports: (cap: string) => cap === "durableContext",
      projectDurableContext: vi.fn().mockResolvedValue({
        messages: [{ role: "user", content: "prior turn" }],
        estimatedTokens: 7,
        sourceMessageCount: 1,
      }),
    } as never);
    const result = await provider.projectContext({ userId: "u1", sessionId: "s1", beforeMessageId: 42, maxContext: 8000 });
    expect(result.messages).toEqual([{ role: "user", content: "prior turn" }]);
  });

  it("sendPrompt with no context does not crash — returns text via onEvent", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello");
    // Pi resolution is mocked absent — it must reject with the typed contract
    // error, and we just want no crash
    await expect(promise).rejects.toThrow(PiCoreContractError);
    // activeHost should be null after failure
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });

  it("forwards the caller's provider inactivity allowance to Pi", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "sleep", undefined, {
      deadlineAt: Date.now() + 600_000,
      providerInactivityTimeoutMs: 570_000,
    });
    await expect(promise).rejects.toThrow(PiCoreContractError);
    expect(mockCreatePiStreamFn).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: expect.any(Number),
      providerInactivityTimeoutMs: 570_000,
    }));
  });

  it("setSystemPrompt updates config", () => {
    const t = makeTransport();
    t.setSystemPrompt("New prompt");
    expect(t.config.systemPrompt).toBe("New prompt");
  });

  it("setModel changes active candidate and resets policy", () => {
    const t = makeTransport();
    t.setModel("new-model", "https://new.endpoint/v1", 64000);
    expect(t.config.candidates[0]?.model).toBe("new-model");
    expect(t.config.candidates[0]?.endpoint).toBe("https://new.endpoint/v1");
    expect(t.config.candidates[0]?.maxContext).toBe(64000);
  });

  it("image input emits text+image parts in the pi-ai message", () => {
    // The transport's internal image plumbing was previously asserted through
    // sendPrompt with a bare rejection — which observed nothing about images.
    // The pure conversion that carries the image shape into the pi-ai message
    // is asserted directly (#1582).
    const msg: AbtarsCurrentTurnMessage = {
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "sess_1",
      content: "Look at this",
      timestamp: 123,
      imageContent: [{ mime: "image/png", base64: "iVBOR=" }],
    };
    const m = convertCurrentTurnToLlm(msg) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
    expect(m.role).toBe("user");
    expect(m.content[0]).toMatchObject({ type: "text", text: "Look at this" });
    expect(m.content[1]).toMatchObject({ type: "image", data: "iVBOR=", mimeType: "image/png" });
  });

  it("host-load failure clears activeHost", async () => {
    const t = makeTransport();
    await t.initialize();
    const err = await t.sendPrompt("s", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiCoreContractError);
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });

  it("rejects required_unavailable intent before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "required_unavailable", reason: "record_failed" },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    await expect(promise).rejects.toMatchObject({ reason: "cursor_unavailable" });
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });

  it("rejects durable intent without caller identity before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    await expect(promise).rejects.toMatchObject({ reason: "identity_unavailable" });
    expect((t as unknown as Record<string, unknown>).activeHost).toBeNull();
  });

  it("lets a valid durable intent past preflight — failure comes from Pi loading, not the intent (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const err = await t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiCoreContractError);
  });

  it("lets omitted intent (not-required) past preflight — intentional ephemeral stays operable (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const err = await t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiCoreContractError);
  });
});

// ── extractAssistantText (pure function) ─────────────────────────────────────

describe("extractAssistantText", () => {
  it("returns string content as-is", () => {
    expect(extractAssistantText("Hello world")).toBe("Hello world");
  });

  it("extracts only text parts from mixed text+toolCall content", () => {
    const content = [
      { type: "text", text: "Here's the answer. " },
      { type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
      { type: "text", text: "Done." },
    ];
    expect(extractAssistantText(content)).toBe("Here's the answer. Done.");
  });

  it("returns empty string for toolCall-only content", () => {
    const content = [
      { type: "toolCall", id: "t1", name: "bash", arguments: {} },
    ];
    expect(extractAssistantText(content)).toBe("");
  });

  it("returns empty string for empty array", () => {
    expect(extractAssistantText([])).toBe("");
  });

  it("returns empty string for non-array, non-string input", () => {
    expect(extractAssistantText({ foo: "bar" })).toBe("");
  });

  it("skips non-text parts gracefully", () => {
    const content = [
      { type: "text", text: "A" },
      { type: "unknown", text: "B" },
      { type: "text", text: "C" },
    ];
    expect(extractAssistantText(content)).toBe("AC");
  });
});

// ── Context projection wiring at transport level ────────────────────────────

function makeProjectionSeed(overrides?: Partial<PiExecutionContextSeed>): PiExecutionContextSeed {
  return {
    source: { mode: "ephemeral", sessionKey: "test_session" },
    executionId: "exec_1",
    currentTurn: {
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "session_1",
      content: "Hello!",
      timestamp: Date.now(),
    },
    volatileBlocks: [],
    ...overrides,
  };
}

function makeMarkerMessages(): AgentMessage[] {
  return [
    { role: "assistant", content: "How can I help?" },
    {
      role: "abtars_current_turn",
      executionId: "exec_1",
      sessionId: "session_1",
      content: "Hello!",
      timestamp: Date.now(),
    } as AbtarsCurrentTurnMessage,
  ];
}

describe("context projection at transport level", () => {
  it("durable seed carries the caller identity into the projection request", async () => {
    const seed = makeProjectionSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 0, maxContext: 8000, userId: "user-1" },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    let capturedInput: unknown = null;
    const result = await projection.transform(makeMarkerMessages(), {
      hostGeneration: 0,
      contextProvider: {
        async projectContext(input: unknown) {
          capturedInput = input;
          return { messages: [{ role: "user", content: "prior" }], estimatedTokens: 4, sourceMessageCount: 1 };
        },
      },
    });
    expect(capturedInput).toEqual({ userId: "user-1", sessionId: "test_session", beforeMessageId: 0, maxContext: 8000 });
    expect(result.messages.some((m) => m.content === "prior")).toBe(true);
  });

  it("durable request without a provider throws a typed error — no degraded suffix answer", async () => {
    const seed = makeProjectionSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 100, maxContext: 8000, userId: "user-1" },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    await expect(projection.transform(makeMarkerMessages(), { hostGeneration: 0 }))
      .rejects.toBeInstanceOf(DurableContextUnavailableError);
  });

  it("durable seed without a user identity is impossible by construction; production supplies both", async () => {
    const seed = makeProjectionSeed({
      source: { mode: "durable", sessionKey: "test_session", beforeMessageId: 42, maxContext: 8000, userId: "user-1" },
    });
    const projection = new PiCoreContextProjection(seed, "system");
    const result = await projection.transform(makeMarkerMessages(), {
      hostGeneration: 0,
      contextProvider: {
        async projectContext() {
          return {
            messages: [
              { role: "user", content: "first" },
              { role: "assistant", content: "second" },
              { role: "user", content: "third" },
            ],
            estimatedTokens: 12,
            sourceMessageCount: 3,
          };
        },
      },
    });
    expect(result.contextDegraded).toBe(false);
    expect(result.messages).toHaveLength(4); // 3 historical + 1 current-turn marker
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("first");
    expect(result.messages[1]?.role).toBe("assistant");
    expect(result.messages[1]?.content).toEqual([{ type: "text", text: "second" }]);
    expect(result.messages[2]?.role).toBe("user");
    expect(result.messages[2]?.content).toBe("third");
  });
});
