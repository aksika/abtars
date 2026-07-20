import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setUserRegistryOverride, type UserRegistry } from "./user-registry.js";
import type { ManagedSession } from "./spin-types.js";

const detectCitationsSpy = vi.fn().mockReturnValue([1]);
let abmindReturn: any = { detectCitations: detectCitationsSpy };

vi.mock("../utils/abmind-lazy.js", () => ({
  abmind: () => abmindReturn,
  loadAbmind: vi.fn(),
  resetAbmindCache: vi.fn(),
  ABMIND_MIN: [0, 2, 7],
  isSupportedVersion: vi.fn().mockReturnValue(true),
  parseSemver: vi.fn(),
}));

const MASTER_REGISTRY: UserRegistry = {
  users: [{ userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }],
  byPlatformId: new Map([["master:telegram", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
  byUserId: new Map([["test", { userId: "test", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
};
import { handleInboundMessage, type PipelineDeps } from "./message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { Spin } from "./spin.js";
const SessionManager = Spin;

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello from Kiro!"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    transportCommands: [],
    get isReady() { return true; },
  };
}

function mockAdapter(overrides: Partial<PlatformAdapter> = {}): PlatformAdapter {
  return {
    name: "telegram",
    capabilities: { voice: true, reactions: true, typing: true, threads: true },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    authorize: vi.fn().mockReturnValue(true),
    sendMessage: vi.fn().mockResolvedValue(1),
    chunkResponse: (t) => [t],
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setReaction: vi.fn().mockResolvedValue(undefined),
    downloadVoice: vi.fn().mockResolvedValue(Buffer.from("audio")),
    sendVoice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockDeps(transport: IKiroTransport, overrides: Partial<PipelineDeps> = {}): PipelineDeps & { _session: ManagedSession } {
  const session: ManagedSession = {
    id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
    delivery: "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
  };
  return {
    transport,
    codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as any,
    memory: null,
    memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
    nlmConfig: { enabled: false },
    idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    config: { agentTransport: "tmux", workingDir: "/tmp" },
    startedAt: Date.now(),
    sttConfig: null,
    ttsConfig: null,
    sessionManager: {
      getActiveSessionId: () => "test_A_01",
      getActiveSession: () => session,
      getSessionById: (id: string) => id === "test_A_01" ? session : undefined,
      spin: async (spec: any) => {
        // #1271: pipeline tests stub spin() to call the transport directly
        // (mirrors pre-refactor sendPrompt behavior). Streaming/tool callbacks
        // are set on the transport by the pipeline itself.
        const result = await transport.sendPrompt(
          spec.sessionId ?? "test_A_01",
          spec.prompt,
          spec.imageContent,
          spec.userId,
        );
        return { sessionId: spec.sessionId ?? "test_A_01", result: result ?? "" };
      },
    } as any,
    updateCtxStart: vi.fn(),
    _session: session,
    ...overrides,
  } as any;
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram",
    channelId: "100",
    userId: "master",
    senderId: "42",
    senderName: "Test",
    text: "hello",
    timestamp: Date.now(),
    isGroup: false,
    isVoice: false,
    ...overrides,
  };
}

describe("handleInboundMessage", () => {
  let transport: IKiroTransport;

  beforeEach(async () => {
    transport = mockTransport();
    setUserRegistryOverride(MASTER_REGISTRY);
    // Mock spin methods so pipeline can resolve sessions for any session ID
    const spinMod = await import("./spin.js");
    const mockSession: ManagedSession = {
      id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    };
    // #1348: Pipeline calls ensureSessionTransport if session.transport is missing.
    // Mock it to wire the describe-block's transport (recreated fresh per test) so
    // ctx.transport and deps.transport resolve to the same object.
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (session) => {
      session.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => ({
      ...mockSession, id,
    }));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((): ManagedSession => ({ ...mockSession }));
    // resolveSession mock returns a routable session with streaming delivery.
    vi.spyOn(spinMod.spin, "resolveSession").mockImplementation(
      async (_userId: string, _platform: string, _chatId: number): Promise<ManagedSession> => ({
        ...mockSession, delivery: "streaming",
      }),
    );
  });

  afterEach(() => {
    setUserRegistryOverride(null);
    vi.restoreAllMocks();
  });

  it("sends prompt to transport and delivers response via adapter", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("hello"), undefined, "master");
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "Hello from Kiro!", expect.any(Object));
  });

  it("sets and clears reaction around response", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    await handleInboundMessage(makeMsg({ messageId: 5 }), adapter, deps);

    const calls = (adapter.setReaction as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["100", 5, "👀"]); // set thinking
    expect(calls[calls.length - 1]).toEqual(["100", 5, ""]); // clear
  });

  it("sends typing indicator", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendTyping).toHaveBeenCalled();
  });

  it("handles empty response", async () => {
    transport.sendPrompt = vi.fn().mockResolvedValue("") as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ messageId: 3 }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("empty response"), expect.any(Object));
  });

  it("suppresses empty-response fallback when tool calls succeeded", async () => {
    transport.sendPrompt = vi.fn().mockResolvedValue("") as any;
    Object.defineProperty(transport, "toolCallsSucceeded", { get: () => 1 });
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ messageId: 4 }), adapter, deps);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.setReaction).toHaveBeenCalledWith("100", 4, "");
  });

  it("handles [NO_REPLY]", async () => {
    transport.sendPrompt = vi.fn().mockResolvedValue("[NO_REPLY]") as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    // Should not send any message to user
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("handles [REACT:emoji] response", async () => {
    transport.sendPrompt = vi.fn().mockResolvedValue("[REACT:👍]") as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ messageId: 7 }), adapter, deps);

    // Reaction sent via setReaction
    expect(adapter.setReaction).toHaveBeenCalledWith(expect.any(String), 7, "👍");
  });

  it("cleans up busyChats and resets idle timer in finally block", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect((deps as any)._session.busy).toBe(false);
    expect(deps.idleSave.reset).toHaveBeenCalledWith("test_A_01", 100);
  });

  it("handles transport error gracefully", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("boom")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("Error: boom"), expect.any(Object));
    expect((deps as any)._session.busy).toBe(false);
  });

  // #1294: a synthetic boot greeting that fails must NOT send a user-facing error reply.
  it("suppresses user-facing error for synthetic [SESSION START] greeting failures", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted:\nno candidates")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "[SESSION START] You just came online. Greet the user." }), adapter, deps);

    // No error message should reach the user — greeting failures are silent
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect((deps as any)._session.busy).toBe(false);
  });

  // #1298: [SYSTEM] and [TASK COMPLETE] synthetic prompts must also suppress errors
  it("suppresses user-facing error for [SYSTEM] scheduled messages", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "[SYSTEM] Daily briefing failed" }), adapter, deps);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses user-facing error for [TASK COMPLETE] announce delivery", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "[TASK COMPLETE] \"my task\" done.\nResult:\nsome output\n\nDeliver this to the user naturally." }), adapter, deps);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("does NOT suppress errors for real user messages", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "hello there" }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalled();
  });

  it("handles command and returns early", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    // /help is a known command
    await handleInboundMessage(makeMsg({ text: "/help" }), adapter, deps);

    // Command handler sends reply via adapter, transport should not be called
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });

  it("strips // prefix before sending to transport", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "//status" }), adapter, deps);

    // // stripped to / — no commands registered in test → falls through to transport
    expect(transport.sendPrompt).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("/status"), undefined, "master");
  });

  it("returns early for voice without STT config", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport, { sttConfig: null });

    await handleInboundMessage(makeMsg({ isVoice: true, voiceFileId: "f1" }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("STT"), expect.any(Object));
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });

  it("different users get different session keys from SessionManager", async () => {
    const sm = {
      getActiveSessionId: vi.fn((userId: string) => `${userId}_A_01`),
      getActiveSession: () => ({ id: "x", type: "A", shortIndex: 1, ended: false }),
    };
    const deps = mockDeps(transport, { sessionManager: sm } as any);
    const adapter = mockAdapter();

    await handleInboundMessage(makeMsg({ userId: "aksika" }), adapter, deps);
    await handleInboundMessage(makeMsg({ userId: "adrika" }), adapter, deps);

    expect(sm.getActiveSessionId).toHaveBeenCalledWith("aksika", "telegram");
    expect(sm.getActiveSessionId).toHaveBeenCalledWith("adrika", "telegram");
  });

  it("userId flows to transport.sendPrompt for tool context", async () => {
    const deps = mockDeps(transport);
    const adapter = mockAdapter();

    await handleInboundMessage(makeMsg({ userId: "adrika" }), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith("test_A_01", expect.any(String), undefined, "adrika");
  });
});

describe("citation detection (#1270)", () => {
  let transport: IKiroTransport;

  /** Shared memoryRuntime mock that satisfies AbtarsMemoryRuntime. */
  function mockMemoryRuntime(overrides: Record<string, unknown> = {}) {
    return {
      state: "ready",
      capabilities: new Set<string>(),
      recall: vi.fn().mockResolvedValue({ hits: [{ memoryId: 1, content: "test memory", score: 0.95 }] }),
      recordMessage: vi.fn().mockResolvedValue({}),
      recordFeedback: vi.fn().mockResolvedValue({}),
      assembleSessionContext: vi.fn().mockResolvedValue({}),
      getRecentConversation: vi.fn().mockResolvedValue({ results: [] }),
      getStatus: vi.fn().mockResolvedValue({}),
      getCoreKnowledge: vi.fn().mockResolvedValue({ core: [] }),
      embed: vi.fn().mockResolvedValue({}),
      runMaintenance: vi.fn().mockResolvedValue({}),
      close: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(async () => {
    transport = mockTransport();
    transport.contextPercent = -1;
    setUserRegistryOverride(MASTER_REGISTRY);
    detectCitationsSpy.mockClear();
    detectCitationsSpy.mockReturnValue([1]);
    abmindReturn = { detectCitations: detectCitationsSpy, renderMemory: vi.fn().mockReturnValue("test memory") };
    const spinMod = await import("./spin.js");
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (session) => {
      session.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => ({
      id, userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    }));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((_userId, _platform): ManagedSession => ({
      id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    }));
    vi.spyOn(spinMod.spin, "resolveSession").mockImplementation(
      async (_userId: string, _platform: string, _chatId: number): Promise<ManagedSession> => ({
        id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
        delivery: "streaming", active: true, status: "ready",
        idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
        log: [], shortIndex: 1,
        busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
        compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
      }),
    );
  });

  afterEach(() => {
    setUserRegistryOverride(null);
    vi.restoreAllMocks();
  });

  it("skips citation detection when memoryConfig.memoryEnabled is false", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {
      memory: { bumpCitedCount: vi.fn(), recordMessage: vi.fn() } as any,
      memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
      memoryRuntime: mockMemoryRuntime(),
    } as any);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(detectCitationsSpy).not.toHaveBeenCalled();
  });

  it("calls detectCitations from lazy module when memoryConfig.memoryEnabled is true", async () => {
    const recordFeedback = vi.fn().mockResolvedValue({});
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {
      memory: { bumpCitedCount: vi.fn(), recordMessage: vi.fn() } as any,
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      memoryRuntime: mockMemoryRuntime({ recordFeedback }),
    } as any);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(detectCitationsSpy).toHaveBeenCalledWith("Hello from Kiro!", [{ id: 1, contentEn: "test memory" }]);
    expect(recordFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ memoryId: 1, feedbackType: "cite" }),
      expect.any(String),
    );
  });

  it("skips citation detection when abmind() returns null even if memoryEnabled is true", async () => {
    abmindReturn = null;
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {
      memory: { bumpCitedCount: vi.fn(), recordMessage: vi.fn() } as any,
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      memoryRuntime: mockMemoryRuntime(),
    } as any);

    await handleInboundMessage(makeMsg(), adapter, deps);
  });

  it("logs WARN (not DEBUG) when detectCitations throws", async () => {
    abmindReturn = { detectCitations: () => { throw new Error("boom"); }, renderMemory: vi.fn().mockReturnValue("test memory") };
    const logMod = await import("./logger.js");
    const warnSpy = vi.spyOn(logMod, "logWarn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(logMod, "logDebug").mockImplementation(() => {});

    const adapter = mockAdapter();
    const deps = mockDeps(transport, {
      memory: { bumpCitedCount: vi.fn(), recordMessage: vi.fn() } as any,
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      memoryRuntime: mockMemoryRuntime(),
    } as any);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(warnSpy).toHaveBeenCalledWith("pipeline", expect.stringContaining("Citation detection failed"));
    expect(debugSpy).not.toHaveBeenCalledWith("pipeline", expect.stringContaining("Citation detection failed"));
  });
});
