import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setUserRegistryOverride, type UserRegistry } from "./user-registry.js";
import type { ManagedSession } from "./spin-types.js";

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
    // Mock spin.getSessionById so pipeline can resolve sessions for any session ID
    const spinMod = await import("./spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation((id: string): ManagedSession => ({
      id, userId: "master", platform: "telegram", chatId: 100,
      delivery: "simple", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    }));
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation((_userId, _platform): ManagedSession => ({
      id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
      delivery: "simple", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    }));
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
    const emptyTransport = mockTransport();
    (emptyTransport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const adapter = mockAdapter();
    const deps = mockDeps(emptyTransport);

    await handleInboundMessage(makeMsg({ messageId: 3 }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("empty response"), expect.any(Object));
  });

  it("suppresses empty-response fallback when tool calls succeeded", async () => {
    const t = mockTransport();
    (t.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("");
    Object.defineProperty(t, "toolCallsSucceeded", { get: () => 1 });
    const adapter = mockAdapter();
    const deps = mockDeps(t);

    await handleInboundMessage(makeMsg({ messageId: 4 }), adapter, deps);

    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.setReaction).toHaveBeenCalledWith("100", 4, "");
  });

  it("handles [NO_REPLY]", async () => {
    const noReplyTransport = mockTransport();
    (noReplyTransport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("[NO_REPLY]");
    const adapter = mockAdapter();
    const deps = mockDeps(noReplyTransport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    // Should not send any message to user
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it("handles [REACT:emoji] response", async () => {
    const reactTransport = mockTransport();
    (reactTransport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("[REACT:👍]");
    const adapter = mockAdapter();
    const deps = mockDeps(reactTransport);

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
    const errorTransport = mockTransport();
    (errorTransport.sendPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const adapter = mockAdapter();
    const deps = mockDeps(errorTransport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("Something went wrong"), expect.any(Object));
    expect((deps as any)._session.busy).toBe(false);
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
