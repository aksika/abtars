import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleInboundMessage, type PipelineDeps } from "./message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";
import type { IKiroTransport } from "./kiro-transport.js";

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello from Kiro!"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
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

function mockDeps(transport: IKiroTransport, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    transport,
    codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as any,
    memory: null,
    memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
    nlmConfig: { enabled: false },
    sleepQueue: { isActive: false, enqueue: vi.fn(), activate: vi.fn(), deactivate: vi.fn(), replay: vi.fn() } as any,
    idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    config: { agentTransport: "tmux", workingDir: "/tmp" },
    startedAt: Date.now(),
    sttConfig: null,
    ttsConfig: null,
    busyChats: new Set(),
    fullModeChats: new Set(),
    pendingSessionStart: new Set(),
    seenSessions: new Set(),
    updateCtxStart: vi.fn(),
    ...overrides,
  };
}

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram",
    channelId: "100",
    sessionKey: "telegram:100",
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

  beforeEach(() => {
    transport = mockTransport();
  });

  it("sends prompt to transport and delivers response via adapter", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);
    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith("telegram:100", expect.stringContaining("hello"));
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

  it("queues message when sleep is active", async () => {
    const adapter = mockAdapter();
    const sleepQueue = { isActive: true, enqueue: vi.fn().mockReturnValue(true), activate: vi.fn(), deactivate: vi.fn(), replay: vi.fn() } as any;
    const deps = mockDeps(transport, { sleepQueue });

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(sleepQueue.enqueue).toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("waking up"), expect.any(Object));
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });

  it("rejects busy session", async () => {
    const adapter = mockAdapter();
    const busyChats = new Set(["telegram:100"]);
    const deps = mockDeps(transport, { busyChats });

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("in progress"), expect.any(Object));
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });

  it("handles empty response", async () => {
    const emptyTransport = mockTransport();
    (emptyTransport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("");
    const adapter = mockAdapter();
    const deps = mockDeps(emptyTransport);

    await handleInboundMessage(makeMsg({ messageId: 3 }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("empty response"), expect.any(Object));
  });

  it("handles <NO_REPLY>", async () => {
    const noReplyTransport = mockTransport();
    (noReplyTransport.sendPrompt as ReturnType<typeof vi.fn>).mockResolvedValue("<NO_REPLY>");
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

    expect(adapter.setReaction).toHaveBeenCalledWith("100", 7, "👍");
    // Should not send text message
    const sendCalls = (adapter.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls).toHaveLength(0);
  });

  it("cleans up busyChats and resets idle timer in finally block", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(deps.busyChats.has("telegram:100")).toBe(false);
    expect(deps.idleSave.reset).toHaveBeenCalledWith("telegram:100", 100);
  });

  it("handles transport error gracefully", async () => {
    const errorTransport = mockTransport();
    (errorTransport.sendPrompt as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const adapter = mockAdapter();
    const deps = mockDeps(errorTransport);

    await handleInboundMessage(makeMsg(), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("Something went wrong"), expect.any(Object));
    expect(deps.busyChats.has("telegram:100")).toBe(false);
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

    await handleInboundMessage(makeMsg({ text: "//agent list" }), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledWith("telegram:100", expect.stringContaining("/agent list"));
  });

  it("returns early for voice without STT config", async () => {
    const adapter = mockAdapter();
    const deps = mockDeps(transport, { sttConfig: null });

    await handleInboundMessage(makeMsg({ isVoice: true, voiceFileId: "f1" }), adapter, deps);

    expect(adapter.sendMessage).toHaveBeenCalledWith("100", expect.stringContaining("STT"), expect.any(Object));
    expect(transport.sendPrompt).not.toHaveBeenCalled();
  });
});
