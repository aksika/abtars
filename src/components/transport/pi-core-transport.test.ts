// Pi resolution is mocked to "absent" (../pi-installation.js) so these tests
// verify the compositor structure and lifecycle with the real loader chain
// (pi-core-types loadAndValidatePiAgentCore stays real), deterministically,
// regardless of whether a compatible global Pi install is present on the host.
// A host Pi would otherwise load the real pi-agent-core and hit the provider
// boundary with the unreachable test endpoint — see #1582.
// Real-Pi integration coverage stays deferred: requires a full Pi installation.

import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { PiCoreTransport, extractAssistantText } from "./pi-core-transport.js";
import { isProviderUnavailable } from "./provider-failure.js";
import { saveAvailabilityMemo } from "../pi-session/provider-availability-memo.js";
import type { AbtarsPiStreamFnOptions } from "./pi-stream-fn.js";
import type { StreamFn } from "./pi-core-types.js";
import { ensurePiThinkingClamp } from "./pi-ai-adapter.js";
import { DurableContextUnavailableError, createDurableContextProvider } from "./pi-core-context.js";
import { convertCurrentTurnToLlm } from "./pi-core-types.js";
import type { DurableContextProviderHolder } from "./pi-core-context.js";
import type { AbtarsCurrentTurnMessage } from "./pi-core-types.js";
import type { ModelCandidate } from "./model-candidates.js";
import {
  FakeSdkAgent,
  FakeSdkConversationStore,
} from "../../test-support/fake-sdk-conversation.js";

const mockCreatePiStreamFn = vi.hoisted(() =>
  vi.fn((..._args: [AbtarsPiStreamFnOptions]): StreamFn => vi.fn() as unknown as StreamFn),
);

// Assert-narrowed accessor for the recorded factory calls: the tests assert
// call counts first, and a missing call must fail loudly — never silently
// produce undefined options through a cast.
function streamFnCallOptions(index: number): AbtarsPiStreamFnOptions {
  const call = mockCreatePiStreamFn.mock.calls[index];
  assert(call, `expected createPiStreamFn call ${index}`);
  return call[0];
}

vi.mock("./pi-stream-fn.js", () => ({ createPiStreamFn: mockCreatePiStreamFn }));
vi.mock("../pi-installation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi-installation.js")>();
  return {
    ...actual,
    resolvePiInstallation: () => ({ state: "absent" as const }),
  };
});
vi.mock("./pi-sdk-conversation.js", async () => {
  const helper = await import("../../test-support/fake-sdk-conversation.js");
  return { PiSdkConversationStore: helper.FakeSdkConversationStore };
});
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  const helper = await import("../../test-support/fake-sdk-conversation.js");
  return {
    ...actual,
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: { Agent: helper.FakeSdkAgent },
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.85.1", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});
// #1573: the readiness probe is the external boundary of initialize(). Unrelated
// tests receive a successful probe; readiness tests override it per case.
vi.mock("./pi-runtime-contract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-runtime-contract.js")>();
  return {
    ...actual,
    validatePiRuntimeContract: vi.fn(async () => {}),
  };
});

import { validatePiRuntimeContract, PiRuntimeContractError } from "./pi-runtime-contract.js";

beforeEach(() => {
  FakeSdkConversationStore.resetAll();
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
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

describe("PiCoreTransport", () => {
  it("constructs with main role", () => {
    const t = makeTransport();
    expect(t.config.role).toBe("main");
    expect(t.config.candidate.model).toBe("test-model");
  });

  it("starts uninitialized", () => {
    const t = makeTransport();
    expect(t.isReady).toBe(false);
  });

  describe("availability admission (#1932)", () => {
    it("suppresses dispatch while every allowed selection cools down", async () => {
      mockCreatePiStreamFn.mockClear();
      const memoStateDir = mkdtempSync(join(tmpdir(), "pi-memo-admit-"));
      saveAvailabilityMemo(memoStateDir, [{
        authNamespace: "abtars:test-provider",
        provider: "test-provider",
        endpoint: "https://api.test/v1",
        modelScope: "test-model",
        reason: "rate-limit",
        observedAt: Date.now(),
        unusableUntil: Date.now() + 5 * 60 * 1000,
      }]);
      const transport = new PiCoreTransport({
        role: "main",
        systemPrompt: "You are a helpful assistant.",
        candidate: makeCandidates()[0]!,
        sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
        memoStateDir,
      });

      await expect(transport.sendPrompt("test-session", "hello")).rejects.toSatisfy((err: unknown) => {
        if (!isProviderUnavailable(err)) return false;
        return (err as Error).message.includes("cooling down");
      });
      expect(mockCreatePiStreamFn).not.toHaveBeenCalled();
    });

    it("dispatches when the memo is empty", async () => {
      mockCreatePiStreamFn.mockClear();
      const memoStateDir = mkdtempSync(join(tmpdir(), "pi-memo-admit-"));
      const transport = new PiCoreTransport({
        role: "main",
        systemPrompt: "You are a helpful assistant.",
        candidate: makeCandidates()[0]!,
        sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
        memoStateDir,
      });
      mockCreatePiStreamFn.mockClear();
      // The preflight lets dispatch through to stream-fn construction and
      // the SDK conversation delivers. A live-provider dispatch is covered
      // by the Pi production lanes.
      FakeSdkConversationStore.queueTurn("test-session", { text: "admitted" });
      await expect(transport.sendPrompt("test-session", "hello")).resolves.toBe("admitted");
      expect(mockCreatePiStreamFn).toHaveBeenCalled();
    });
  });

  it("initialize sets isReady", async () => {
    const t = makeTransport();
    await t.initialize();
    expect(t.isReady).toBe(true);
  });

  describe("readiness contract (#1573)", () => {
    beforeEach(() => {
      vi.mocked(validatePiRuntimeContract).mockReset();
      vi.mocked(validatePiRuntimeContract).mockResolvedValue(undefined);
    });

    it("keeps the transport not-ready and suppresses onReady when the probe fails", async () => {
      const t = makeTransport();
      const onReady = vi.fn();
      t.onReady = onReady;
      vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
        new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; pi-ai; missing createProvider).", {
          component: "pi-ai",
          capability: "createProvider",
        }),
      );
      await expect(t.initialize()).rejects.toThrow(PiRuntimeContractError);
      expect(t.isReady).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
    });

    it("probes again after a rejected attempt and succeeds once repaired", async () => {
      const t = makeTransport();
      const onReady = vi.fn();
      t.onReady = onReady;
      vi.mocked(validatePiRuntimeContract).mockRejectedValueOnce(
        new PiRuntimeContractError("Pi runtime contract incompatible (0.84.0; openai-completions; missing streamSimple).", {
          component: "openai-completions",
          capability: "streamSimple",
        }),
      );
      await expect(t.initialize()).rejects.toThrow(PiRuntimeContractError);
      expect(t.isReady).toBe(false);

      await t.initialize();
      expect(t.isReady).toBe(true);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it("shares one in-flight probe among concurrent callers", async () => {
      const t = makeTransport();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(validatePiRuntimeContract).mockImplementationOnce(() => gate);
      const first = t.initialize();
      const second = t.initialize();
      for (let i = 0; i < 100 && vi.mocked(validatePiRuntimeContract).mock.calls.length === 0; i++) {
        await Promise.resolve();
      }
      expect(vi.mocked(validatePiRuntimeContract)).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
      expect(vi.mocked(validatePiRuntimeContract)).toHaveBeenCalledTimes(1);
      expect(t.isReady).toBe(true);
    });
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

  it("sendPrompt without an SDK surface fails closed (never silent fallback)", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.failNextEnsureError = new Error("Pi SDK conversation surface unavailable");
    await expect(t.sendPrompt("test_session", "hello")).rejects.toThrow(/surface unavailable/);
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("interrupt on inactive host does not throw", async () => {
    const t = makeTransport();
    await t.sendInterrupt();
  });

  it("supports specialist role", () => {
    const t = new PiCoreTransport({
      role: "specialist",
      systemPrompt: "",
      candidate: makeCandidates()[0]!,
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
      candidate: makeCandidates()[0]!,
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

  it("sendPrompt with no context does not crash — returns text via the session tap", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", { text: "hello back" });
    const text = await t.sendPrompt("sess_1", "hello");
    expect(text).toBe("hello back");
    expect((t as unknown as { activeSlot: unknown }).activeSlot).toBeNull();
  });

  it("#1619: threads the session's requested reasoning effort into the streamFn", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    t.setReasoningEffort("high");
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await t.sendPrompt("sess_1", "sleep");
    expect(mockCreatePiStreamFn).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: "high",
    }));
  });

  // ── Cache identity + retention (#1748) ─────────────────────────────────────

  it("#1748: derives a cache identity once per transport and sends it on two turns of one session", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await t.sendPrompt("sess_1", "first");
    await t.sendPrompt("sess_1", "second");

    expect(mockCreatePiStreamFn).toHaveBeenCalledTimes(2);
    const firstCall = streamFnCallOptions(0);
    const secondCall = streamFnCallOptions(1);
    expect(firstCall.cacheIdentity).toMatch(/^[0-9a-f]{40}$/);
    expect(secondCall.cacheIdentity).toBe(firstCall.cacheIdentity);
  });

  it("#1748: two transports on different sessions send different identities", async () => {
    mockCreatePiStreamFn.mockClear();
    const a = makeTransport();
    const b = makeTransport();
    await a.initialize();
    await b.initialize();
    FakeSdkConversationStore.queueTurn("sess_a", {});
    FakeSdkConversationStore.queueTurn("sess_b", {});
    await a.sendPrompt("sess_a", "x");
    await b.sendPrompt("sess_b", "x");
    const idA = streamFnCallOptions(0).cacheIdentity;
    const idB = streamFnCallOptions(1).cacheIdentity;
    expect(idA).not.toBe(idB);
  });

  it("#1748: Main and a subagent of the same bridge send different identities", async () => {
    mockCreatePiStreamFn.mockClear();
    const main = makeTransport();
    const sub = new PiCoreTransport({
      role: "specialist",
      systemPrompt: "You are an abtars cody agent.",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      cacheScope: "cody",
    });
    await main.initialize();
    await sub.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await main.sendPrompt("sess_1", "x");
    await sub.sendPrompt("sess_1", "x");
    const mainId = streamFnCallOptions(0).cacheIdentity;
    const subId = streamFnCallOptions(1).cacheIdentity;
    expect(mainId).not.toBe(subId);
  });

  it("#1748: two subagent transports of the same role send the same identity", async () => {
    mockCreatePiStreamFn.mockClear();
    const makeSub = () => new PiCoreTransport({
      role: "specialist",
      systemPrompt: "You are an abtars dreamy agent.",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      cacheScope: "dreamy",
    });
    const a = makeSub();
    const b = makeSub();
    await a.initialize();
    await b.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await a.sendPrompt("sess_1", "x");
    await b.sendPrompt("sess_1", "x");
    const idA = streamFnCallOptions(0).cacheIdentity;
    const idB = streamFnCallOptions(1).cacheIdentity;
    expect(idA).toBe(idB);
  });

  it("#1748: resetSession clears the identity so a new session derives a fresh one", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_old", {});
    FakeSdkConversationStore.queueTurn("sess_new", {});
    await t.sendPrompt("sess_old", "x");
    await t.resetSession("sess_old");
    await t.sendPrompt("sess_new", "x");
    const idOld = streamFnCallOptions(0).cacheIdentity;
    const idNew = streamFnCallOptions(1).cacheIdentity;
    expect(idOld).not.toBe(idNew);
  });

  it("#1748: pins cacheRetention short by default and forwards it to the streamFn", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await t.sendPrompt("sess_1", "x");
    expect(mockCreatePiStreamFn).toHaveBeenCalledWith(expect.objectContaining({
      cacheRetention: "short",
    }));
  });

  it("#1748: a provider opting into long retention forwards long to the streamFn", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "You are a helpful assistant.",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      cacheRetention: "long",
    });
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await t.sendPrompt("sess_1", "x");
    expect(mockCreatePiStreamFn).toHaveBeenCalledWith(expect.objectContaining({
      cacheRetention: "long",
    }));
  });

  it("forwards the caller's provider inactivity allowance to Pi", async () => {
    mockCreatePiStreamFn.mockClear();
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    await t.sendPrompt("sess_1", "sleep", undefined, {
      deadlineAt: Date.now() + 600_000,
      providerInactivityTimeoutMs: 570_000,
    });
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

  it("setModel changes the configured candidate", () => {
    const t = makeTransport();
    t.setModel("new-model", "https://new.endpoint/v1", 64000);
    expect(t.config.candidate.model).toBe("new-model");
    expect(t.config.candidate.endpoint).toBe("https://new.endpoint/v1");
    expect(t.config.candidate.maxContext).toBe(64000);
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
      images: [{ type: "image", mimeType: "image/png", data: "iVBOR=" }],
    };
    const m = convertCurrentTurnToLlm(msg);
    expect(m.role).toBe("user");
    if (typeof m.content === "string") throw new Error("expected content parts for an image turn");
    expect(m.content[0]).toMatchObject({ type: "text", text: "Look at this" });
    expect(m.content[1]).toMatchObject({ type: "image", data: "iVBOR=", mimeType: "image/png" });
  });

  it("host-load failure clears activeHost", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.failNextEnsureError = new Error("SDK conversation surface unavailable");
    const err = await t.sendPrompt("s", "hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/surface unavailable/);
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("rejects required_unavailable intent before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "required_unavailable", reason: "record_failed" },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    // #1932: the preflight propagates the intent's reason instead of
    // masking every pre-provider failure as cursor_unavailable.
    await expect(promise).rejects.toMatchObject({ reason: "record_failed" });
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("rejects durable intent without caller identity before any host/provider work (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    const promise = t.sendPrompt("sess_1", "hello", undefined, {
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    });
    await expect(promise).rejects.toBeInstanceOf(DurableContextUnavailableError);
    await expect(promise).rejects.toMatchObject({ reason: "identity_unavailable" });
    expect((t as unknown as Record<string, unknown>).activeSlot).toBeNull();
  });

  it("runs a valid durable intent through the transform probe — history stays Pi-owned (#1529)", async () => {
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "system",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      memoryToolDeps: { current: { runtime: { state: "ready" } } as never },
    });
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", { text: "durable ok" });
    const text = await t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
      contextProvider: {
        projectContext: async () => ({
          messages: [{ role: "user", content: "prior" }],
          estimatedTokens: 4,
          sourceMessageCount: 1,
        }),
      },
    });
    expect(text).toBe("durable ok");
  });

  it("denies a durable turn without a context provider at the transform (no_provider)", async () => {
    const t = new PiCoreTransport({
      role: "main",
      systemPrompt: "system",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      memoryToolDeps: { current: { runtime: { state: "ready" } } as never },
    });
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", {});
    const err = await t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
      durableContextIntent: { mode: "durable", beforeMessageId: 42 },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DurableContextUnavailableError);
    expect((err as DurableContextUnavailableError).reason).toBe("no_provider");
  });

  it("lets omitted intent (not-required) past preflight — intentional ephemeral stays operable (#1529)", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("sess_1", { text: "ephemeral ok" });
    const text = await t.sendPrompt("sess_1", "hello", undefined, {
      userId: "user-1",
    });
    expect(text).toBe("ephemeral ok");
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


describe("#1619 reasoning effort (session-scoped)", () => {
  // #1746: resolveCandidateModel reads pi's clamp from the runtime slot now.
  // Production populates it at boot and in the contract probe; these tests do
  // the same with pi's real function so the constructor-time clamp is
  // exercised as shipped (the pi-installation mock above is "absent", so the
  // slot is fed the already-loaded module directly).
  beforeAll(async () => {
    await ensurePiThinkingClamp({ clampThinkingLevel });
  });

  it("initializes requested effort from effort-style thinking config; off otherwise", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.reasoning).toBe("off");
    const withConfig = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidate: { ...makeCandidates()[0]!, thinking: { style: "effort", default: "medium" } },
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(withConfig.getRuntimeStatus().reasoning).toBe("medium");
  });

  it("clamps an effort-style configured default before the first turn", () => {
    const withConfig = new PiCoreTransport({
      role: "main",
      systemPrompt: "",
      candidate: { ...makeCandidates()[0]!, thinking: { style: "effort", default: "xhigh" } },
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    });
    expect(withConfig.getRuntimeStatus().reasoning).toBe("high");
    expect(withConfig.getRuntimeStatus().reasoningRequested).toBe("xhigh");
  });

  it("setReasoningEffort stores requested and reports the Pi-clamped effective value", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("high");
    expect(state).toEqual({ requested: "high", effective: "high" });
  });

  it("clamps xhigh to the custom model's supported maximum (Pi authoritative)", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("xhigh");
    expect(state.requested).toBe("xhigh");
    expect(state.effective).toBe("high");
  });

  it("off is a real level and disables reasoning", () => {
    const t = makeTransport();
    const state = t.setReasoningEffort("off");
    expect(state.effective).toBe("off");
  });

  it("runtime status publishes effective reasoning and requested when clamped", () => {
    const t = makeTransport();
    t.setReasoningEffort("xhigh");
    const status = t.getRuntimeStatus();
    expect(status.reasoning).toBe("high");
    expect(status.reasoningRequested).toBe("xhigh");
    t.setReasoningEffort("high");
    const aligned = t.getRuntimeStatus();
    expect(aligned.reasoningRequested).toBeUndefined();
  });

  it("resetSession retains requested effort but clears measured context", async () => {
    const t = makeTransport();
    t.setReasoningEffort("high");
    await t.resetSession("s1");
    expect(t.getRuntimeStatus().reasoning).toBe("high");
    expect(t.getRuntimeStatus().contextPercent).toBeUndefined();
  });
});

describe("#1619 context accounting (truthful)", () => {
  it("reports unknown percentage with the configured window before valid usage", () => {
    const t = makeTransport();
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBeUndefined();
    expect(status.contextWindow).toBe(128000);
    expect(t.contextPercent).toBe(-1);
  });

  it("invalidateContextUsage clears measured tokens only", () => {
    const t = makeTransport();
    t.invalidateContextUsage();
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBeUndefined();
    expect(status.contextWindow).toBe(128000);
  });

  it("computes a display-clamped percentage from tokens and the committed window", () => {
    const t = makeTransport();
    (t as unknown as { currentContextTokens: number | null }).currentContextTokens = 64000;
    (t as unknown as { currentContextWindow: number | null }).currentContextWindow = 128000;
    const status = t.getRuntimeStatus();
    expect(status.contextPercent).toBe(50);
    expect(t.contextPercent).toBe(50);
  });
});

describe("#1619 typed output deltas and semantic segments", () => {
  it("hasToolCallContent detects toolCall blocks only", async () => {
    const { hasToolCallContent } = await import("./pi-core-transport.js");
    expect(hasToolCallContent([{ type: "text", text: "hi" }])).toBe(false);
    expect(hasToolCallContent([{ type: "toolCall", id: "t1", name: "search", arguments: {} }])).toBe(true);
    expect(hasToolCallContent("plain string")).toBe(false);
    expect(hasToolCallContent(null)).toBe(false);
  });
});
