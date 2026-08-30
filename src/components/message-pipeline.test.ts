import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setUserRegistryOverride, type UserRegistry } from "./user-registry.js";
import { classifyContent } from "./clean-response.js";
import type { ManagedSession } from "./spin-types.js";
import { DurableContextUnavailableError } from "./transport/pi-core-context.js";
import { ProviderExecutionError } from "./transport/provider-failure.js";
import { SCHEDULED_ANNOUNCEMENT_TOKEN } from "../types/platform.js";

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
const MAIN_NOTICE_REGISTRY: UserRegistry = {
  users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }],
  byPlatformId: new Map([["master:telegram", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
  byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
};
import { handleInboundMessage, submitTrustedInternalMessage, type PipelineDeps } from "./message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";
import { Spin } from "./spin.js";
import { bufferAgentNotice, drainSystemEvents } from "./system-event-buffer.js";
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
        // #1651: the stub must mirror the production contract — the provider's
        // own string, verbatim (possibly empty), plus the classified outcome.
        // It previously returned `result ?? ""` while production spin returned
        // the literal "(no output)", so the empty-response and [NO_REPLY] cases
        // below asserted a policy production could never reach.
        const result = await transport.sendPrompt(
          spec.sessionId ?? "test_A_01",
          spec.prompt,
          spec.imageContent,
          spec.userId,
        );
        const raw = result ?? "";
        return { sessionId: spec.sessionId ?? "test_A_01", result: raw, outcome: classifyContent(raw) };
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
      console.log("ensureSessionTransport: setting transport id=", (transport as any)._id);
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
    drainSystemEvents();
    setUserRegistryOverride(null);
    vi.restoreAllMocks();
  });

  it("delivers agent notices to the master Main prompt", async () => {
    setUserRegistryOverride(MAIN_NOTICE_REGISTRY);
    bufferAgentNotice("dreamy", "sleep cycle degraded");
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("[SYSTEM] [DREAMY SAYS] sleep cycle degraded"),
      undefined,
      "master",
    );
    expect(drainSystemEvents()).toEqual([]);
  });

  it("does not drain agent notices for a non-Main session", async () => {
    setUserRegistryOverride(MAIN_NOTICE_REGISTRY);
    const spinMod = await import("./spin.js");
    const active = spinMod.spin.getActiveSession("master", "telegram");
    vi.mocked(spinMod.spin.getActiveSession).mockReturnValue({
      ...active,
      id: "test_C_01",
    });
    bufferAgentNotice("dreamy", "sleep cycle degraded");
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.not.stringContaining("[DREAMY SAYS] sleep cycle degraded"),
      undefined,
      "master",
    );
    expect(drainSystemEvents()).toEqual(["[DREAMY SAYS] sleep cycle degraded"]);
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

  it("#1651 v2: simple delivery delivers a reaction-only response as the emoji payload, never the raw marker", async () => {
    transport.sendPrompt = vi.fn().mockResolvedValue("[REACT:👍]") as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    const spinMod = await import("./spin.js");
    const active = spinMod.spin.getActiveSession("test", "telegram");
    const originalDelivery = active.delivery;
    active.delivery = "simple";
    try {
      await handleInboundMessage(makeMsg({ messageId: 9 }), adapter, deps);

      expect(adapter.sendMessage).toHaveBeenCalledWith("100", "👍", expect.any(Object));
      expect(adapter.sendMessage).not.toHaveBeenCalledWith("100", expect.stringContaining("[REACT:"), expect.any(Object));
    } finally {
      active.delivery = originalDelivery;
    }
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

  // #1529: a configured durable turn whose inbound write rejects must fail
  // closed at the Pi boundary — bounded response, no normal model response,
  // busy state released.
  it("fails closed with a bounded response when the inbound durable write rejects (#1529)", async () => {
    const adapter = mockAdapter();
    const recordMessage = vi.fn().mockRejectedValue(new Error("owner down"));
    const deps = mockDeps(transport, {
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      memoryRuntime: {
        state: "ready",
        capabilities: new Set(["durableContext"]),
        recordMessage,
        recall: vi.fn().mockResolvedValue({ hits: [] }),
        recordFeedback: vi.fn().mockResolvedValue({}),
        assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
        getRecentConversation: vi.fn().mockResolvedValue({ results: [] }),
        getStatus: vi.fn().mockResolvedValue({}),
        getCoreKnowledge: vi.fn().mockResolvedValue({ core: [] }),
        embed: vi.fn().mockResolvedValue({}),
        runMaintenance: vi.fn().mockResolvedValue({}),
        close: vi.fn().mockResolvedValue(undefined),
      } as any,
    } as any);
    // Stub spin() forwards the intent to the transport boundary so the Pi
    // preflight can fail closed before any provider work.
    (deps.sessionManager as any).spin = async (spec: any) => {
      const context = { userId: spec.userId, durableContextIntent: spec.durableContextIntent };
      if (context.durableContextIntent?.mode === "required_unavailable") {
        throw new DurableContextUnavailableError("cursor_unavailable");
      }
      const result = await transport.sendPrompt(spec.sessionId ?? "test_A_01", spec.prompt, spec.imageContent, context);
      return { sessionId: spec.sessionId ?? "test_A_01", result: result ?? "" };
    };

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "Memory context is temporarily unavailable. Please retry.", expect.any(Object));
    expect(transport.sendPrompt).not.toHaveBeenCalled();
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

  // ── Context-overflow recovery (#1745) ─────────────────────────────────────

  it("resets the session on ProviderExecutionError with code context_overflow", async () => {
    const failure = { code: "context_overflow", retryable: false, attemptedCandidates: 2, message: "The request exceeds the context window of every configured model" };
    transport.sendPrompt = vi.fn().mockRejectedValue(new ProviderExecutionError(failure)) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(transport.resetSession).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "Context window full — session reset. Send your message again.", expect.any(Object));
    expect((deps as any)._session.busy).toBe(false);
  });

  it("does NOT reset the session for a plain Error whose message mentions token limit", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("API error 429: token limit reached")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    // The four-substring sniff is gone — overflow must travel as the typed code.
    expect(transport.resetSession).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalled();
  });

  it("resets on overflow without notifying for synthetic-prefixed prompts", async () => {
    const failure = { code: "context_overflow", retryable: false, attemptedCandidates: 1, message: "The request exceeds the context window of every configured model" };
    transport.sendPrompt = vi.fn().mockRejectedValue(new ProviderExecutionError(failure)) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ text: "[SESSION START] You just came online. Greet the user." }), adapter, deps);

    expect(transport.resetSession).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
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
    // #1432: session-selection middleware resolves the effective session per
    // user/platform; buildPrompt uses that selected session (never recomputes).
    const spinMod = await import("./spin.js");
    const sessions = new Map<string, ManagedSession>();
    const selectSpy = vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((userId: string, platform: string): ManagedSession => {
      const id = `${userId}_A_01`;
      let s = sessions.get(id);
      if (!s) {
        s = {
          id, userId, platform, chatId: 100,
          delivery: "streaming", active: true, status: "ready",
          idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
          log: [], shortIndex: 1,
          busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
          compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
        };
        sessions.set(id, s);
      }
      return s;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => {
      const s = sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return s;
    });
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg({ userId: "aksika" }), adapter, deps);
    await handleInboundMessage(makeMsg({ userId: "adrika" }), adapter, deps);

    expect(selectSpy).toHaveBeenCalledWith("aksika", "telegram");
    expect(selectSpy).toHaveBeenCalledWith("adrika", "telegram");
  });

  it("userId flows to transport.sendPrompt for tool context", async () => {
    const deps = mockDeps(transport);
    const adapter = mockAdapter();

    await handleInboundMessage(makeMsg({ userId: "adrika" }), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith("test_A_01", expect.any(String), undefined, "adrika");
  });
});

describe("#1724 submitTrustedInternalMessage — receipt-bearing internal submissions", () => {
  let transport: IKiroTransport;
  let mockSession: ManagedSession;

  const SCHEDULED_TEXT = "[SCHEDULED TASK COMPLETED]\nTask: Morning greeting\nCard ID: 12\n\nThe task agent produced the following user-facing result:\nGood morning!\n\nAnnounce this result.";

  function announceMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
    return makeMsg({
      text: SCHEDULED_TEXT,
      senderId: "scheduler",
      senderName: "scheduler",
      internal: { [SCHEDULED_ANNOUNCEMENT_TOKEN]: true, kind: "scheduled_announcement", eventId: "scheduled-card:12", cardId: 12 },
      ...overrides,
    });
  }

  beforeEach(async () => {
    transport = mockTransport();
    setUserRegistryOverride(MAIN_NOTICE_REGISTRY);
    const spinMod = await import("./spin.js");
    // One stable session object per test — mutations (busy flag) are visible
    // to every middleware resolution.
    mockSession = {
      id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    };
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (session) => {
      session.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => (id === "test_A_01" ? mockSession : { ...mockSession, id }));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((): ManagedSession => mockSession);
  });

  afterEach(() => {
    drainSystemEvents();
    setUserRegistryOverride(null);
    vi.restoreAllMocks();
  });

  it("resolves sent only after the response was externally delivered, and records both turns", async () => {
    const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {
      memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
      memoryRuntime: {
        state: "ready", capabilities: new Set<string>(), recordMessage,
        recall: vi.fn().mockResolvedValue({ hits: [] }),
        recordFeedback: vi.fn().mockResolvedValue({}),
        assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
      } as any,
    });

    const outcome = await submitTrustedInternalMessage(announceMsg(), adapter, deps);

    expect(outcome).toBe("sent");
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "Hello from Kiro!", expect.any(Object));
    // Both the internal event (inbound, before the model turn) and Main's
    // assistant response are recorded into the same target A session by the
    // normal pipeline — no task-specific memory writer.
    const roles = recordMessage.mock.calls.map((c: unknown[]) => (c[0] as { role?: string })?.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    const inbound = recordMessage.mock.calls.find((c: unknown[]) => (c[0] as { role?: string })?.role === "user")![0] as { sessionId: string; content: string };
    const assistant = recordMessage.mock.calls.find((c: unknown[]) => (c[0] as { role?: string })?.role === "assistant")![0] as { sessionId: string };
    expect(inbound.sessionId).toBe("test_A_01");
    expect(inbound.content).toContain("[SCHEDULED TASK COMPLETED]");
    expect(assistant.sessionId).toBe("test_A_01");
  });

  it("resolves not_sent on a busy session without queueing and without a model turn (#1724 no-queue policy)", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    mockSession.busy = true;

    const outcome = await submitTrustedInternalMessage(announceMsg(), adapter, deps);

    expect(outcome).toBe("not_sent");
    expect(mockSession.queue).toHaveLength(0);
    expect(transport.sendPrompt).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects a scheduler-shaped event without the runtime trust token", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    const outcome = await submitTrustedInternalMessage(
      announceMsg({ internal: { kind: "scheduled_announcement", eventId: "scheduled-card:12", cardId: 12 } as any }),
      adapter,
      deps,
    );

    expect(outcome).toBe("not_sent");
    expect(transport.sendPrompt).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("resolves not_sent for an empty, [NO_REPLY], or reaction-only Main outcome", async () => {
    for (const raw of ["", "[NO_REPLY]", "[REACT:👍]"]) {
      transport.sendPrompt = vi.fn().mockResolvedValue(raw) as any;
      const adapter = mockAdapter();
      const deps = mockDeps(transport);
      const outcome = await submitTrustedInternalMessage(announceMsg(), adapter, deps);
      expect(outcome).toBe("not_sent");
    }
  }, 20_000);

  it("resolves unknown after a partial send and not_sent when the first chunk fails", async () => {
    // Two chunks — first delivered, second permanently failing → ambiguous.
    transport.sendPrompt = vi.fn().mockResolvedValue("part one\n\npart two") as any;
    const partialAdapter = mockAdapter({
      chunkResponse: (t: string) => t.split("\n\n"),
      sendMessage: vi.fn()
        .mockResolvedValueOnce(11)
        .mockRejectedValue(new Error("network gone")),
    });
    const deps1 = mockDeps(transport);
    const unknownOutcome = await submitTrustedInternalMessage(announceMsg(), partialAdapter, deps1);
    expect(unknownOutcome).toBe("unknown");

    // First chunk never lands → definitely not sent.
    transport.sendPrompt = vi.fn().mockResolvedValue("part one\n\npart two") as any;
    const failingAdapter = mockAdapter({
      chunkResponse: (t: string) => t.split("\n\n"),
      sendMessage: vi.fn().mockRejectedValue(new Error("network gone")),
    });
    const deps2 = mockDeps(transport);
    const notSentOutcome = await submitTrustedInternalMessage(announceMsg(), failingAdapter, deps2);
    expect(notSentOutcome).toBe("not_sent");
  }, 30_000);

  it("resolves unknown when a semantic pre-tool segment was already delivered", async () => {
    mockSession.showThinking = true;
    transport.sendPrompt = vi.fn(async () => {
      await transport.onSegmentBreak?.("The first part is ready.");
      return "[NO_REPLY]";
    }) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    const outcome = await submitTrustedInternalMessage(announceMsg(), adapter, deps);

    expect(outcome).toBe("unknown");
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "The first part is ready.", expect.any(Object));
  });

  it("suppresses the user-facing error reply for a failed announcement turn (synthetic convention)", async () => {
    transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted")) as any;
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    const outcome = await submitTrustedInternalMessage(announceMsg(), adapter, deps);

    expect(outcome).toBe("not_sent");
    expect(adapter.sendMessage).not.toHaveBeenCalled();
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
      console.log("ensureSessionTransport: setting transport id=", (transport as any)._id);
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

  describe("recordMessage canonical content (#1473)", () => {
    function mockMemoryRuntime(overrides: Record<string, unknown> = {}) {
      return {
        state: "ready",
        capabilities: new Set<string>(),
        recall: vi.fn().mockResolvedValue({ hits: [] }),
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
      abmindReturn = null;
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

    it("records cleaned text for [NO_REPLY] + text response", async () => {
      transport.sendPrompt = vi.fn().mockResolvedValue("[NO_REPLY]\n\n[REACT:🤷]\n\nSleep finished — 5 things done.") as any;
      const recordMessage = vi.fn().mockResolvedValue({ id: 1 });
      const adapter = mockAdapter();
      const deps = mockDeps(transport, {
        memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
        memoryRuntime: mockMemoryRuntime({ recordMessage }),
      } as any);

      await handleInboundMessage(makeMsg({ messageId: 10 }), adapter, deps);

      // recordMessage should be called with cleaned text (no [NO_REPLY] marker)
      expect(recordMessage).toHaveBeenCalledWith(
        expect.objectContaining({ role: "assistant", content: "Sleep finished — 5 things done." }),
        expect.any(String),
      );
    });

    it("does not record assistant response for exact [NO_REPLY] (no text)", async () => {
      transport.sendPrompt = vi.fn().mockResolvedValue("[NO_REPLY]") as any;
      const recordMessage = vi.fn().mockResolvedValue({ id: null });
      const adapter = mockAdapter();
      const deps = mockDeps(transport, {
        memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
        memoryRuntime: mockMemoryRuntime({ recordMessage }),
      } as any);

      await handleInboundMessage(makeMsg({ messageId: 11 }), adapter, deps);

      // Should not send anything
      expect(adapter.sendMessage).not.toHaveBeenCalled();
      // User message IS recorded (by buildPrompt), but assistant response should NOT be
      const assistantCalls = (recordMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => (c[0] as { role?: string })?.role === "assistant",
      );
      expect(assistantCalls).toHaveLength(0);
    });
  });
});

describe("#1619 incremental block delivery wiring", () => {
  let transport: IKiroTransport;

  const MASTER_REG: UserRegistry = {
    users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }],
    byPlatformId: new Map([["master:telegram", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
    byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
  };

  beforeEach(async () => {
    transport = mockTransport();
    setUserRegistryOverride(MASTER_REG);
    const spinMod = await import("./spin.js");
    const mockSession: ManagedSession = {
      id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      showThinking: true, // #1654: wiring evidence tests need the feed enabled
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    };
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (session) => {
      console.log("ensureSessionTransport: setting transport id=", (transport as any)._id);
      session.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => ({
      ...mockSession, id,
    }));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((): ManagedSession => ({ ...mockSession }));
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

  it("installs callbacks before spin() — a fast first thinking delta becomes a marked progress block", async () => {
    const fake = transport as any;
    fake.sendPrompt = vi.fn(async () => {
      // Fast first delta: the model begins reasoning before the pipeline
      // would have had time to wire callbacks after spin().
      fake.onOutputDelta?.({ kind: "thinking", text: "pondering the question" });
      await fake.onSegmentBreak?.("Pre-tool text.");
      return "Pre-tool text.\n\nFinal answer.";
    });
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {});
    await handleInboundMessage(makeMsg(), adapter, deps);
    await new Promise((r) => setTimeout(r, 20));

    const sent = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[1]));
    // Thinking was coalesced into exactly one marked progress block.
    expect(sent.filter((t) => t.startsWith("💭 "))).toEqual(["💭 pondering the question"]);
    // The pre-tool segment arrived once...
    expect(sent.filter((t) => t.includes("Pre-tool text."))).toHaveLength(1);
    // ...and the terminal answer excludes the already-delivered prefix.
    expect(sent).toContain("Final answer.");
  });

  it("guest/group/TUI turns never receive master-chat progress blocks", async () => {
    const fake = transport as any;
    fake.sendPrompt = vi.fn(async () => {
      fake.onOutputDelta?.({ kind: "thinking", text: "secret reasoning" });
      return "answer";
    });
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {});
    await handleInboundMessage(makeMsg({ isGroup: true }), adapter, deps);
    await new Promise((r) => setTimeout(r, 20));
    const sent = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[1]));
    expect(sent.some((t) => t.startsWith("💭 "))).toBe(false);
    expect(sent).toContain("answer");
  });

  it("#1654: default session (showThinking false) never delivers 💭 blocks but still answers", async () => {
    const spinMod = await import("./spin.js");
    const hiddenSession = (id: string): ManagedSession => ({
      id, userId: "master", platform: "telegram", chatId: 100,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      showThinking: false, // #1654: default-hidden
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => hiddenSession(id));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((): ManagedSession => hiddenSession("test_A_01"));
    vi.spyOn(spinMod.spin, "resolveSession").mockImplementation(
      async (_userId: string, _platform: string, _chatId: number): Promise<ManagedSession> => hiddenSession("test_A_01"),
    );

    const fake = transport as any;
    fake.sendPrompt = vi.fn(async () => {
      fake.onOutputDelta?.({ kind: "thinking", text: "pondering quietly" });
      return "Final answer.";
    });
    const adapter = mockAdapter();
    const deps = mockDeps(transport, {});
    await handleInboundMessage(makeMsg(), adapter, deps);
    await new Promise((r) => setTimeout(r, 20));
    const sent = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[1]));
    // Gating the feed must not swallow the terminal answer.
    expect(sent).toContain("Final answer.");
    expect(sent.some((t) => t.startsWith("💭 "))).toBe(false);
  });

  it("an interim segment send failure keeps the complete final response (never lost)", async () => {
    const fake = transport as any;
    fake.sendPrompt = vi.fn(async () => {
      await fake.onSegmentBreak?.("Lost segment text.");
      return "Lost segment text.\n\nFinal answer.";
    });
    const adapter = mockAdapter({
      sendMessage: vi.fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValue(1),
    });
    const deps = mockDeps(transport, {});
    await handleInboundMessage(makeMsg(), adapter, deps);
    await new Promise((r) => setTimeout(r, 20));
    const sent = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: unknown[]) => String(c[1]));
    // The interim attempt failed (recorded), and the terminal delivery merged
    // the failed segment into the complete final answer — nothing lost,
    // nothing delivered twice.
    const terminal = sent.filter((t) => t.includes("Final answer."));
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toContain("Lost segment text.");
    expect(terminal[0]).toContain("Final answer.");
  });
});
