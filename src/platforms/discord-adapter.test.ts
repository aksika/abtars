import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAdapter, type DiscordAdapterConfig, type DiscordAdapterDeps } from "./discord-adapter.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { IKiroTransport } from "../components/kiro-transport.js";

// Mock discord.js client
let capturedReactionHandler: Function | null = null;

vi.mock("../components/discord-api.js", () => ({
  DiscordApi: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onReaction: vi.fn((handler: Function) => { capturedReactionHandler = handler; }),
    botUserId: null,
  })),
}));

vi.mock("../components/discord-poller.js", () => ({
  DiscordPoller: vi.fn().mockImplementation((_api: unknown, _appId: string, handler: Function) => {
    (DiscordPollerMock as any)._handler = handler;
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
  }),
}));

const DiscordPollerMock: any = {};

function makeConfig(): DiscordAdapterConfig {
  return {
    botToken: "test-token",
    appId: "123456789",
    allowedUserIds: new Set(["42"]),
    allowedChannelIds: new Set(["*"]),
    a2aEnabled: false,
    a2aRateLimitMs: 5000,
  };
}

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("response"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    get isReady() { return true; },
  };
}

function makeDeps(transport: IKiroTransport): DiscordAdapterDeps {
  return {
    pipeline: {
      transport,
      codingMode: { has: () => false, getTransport: () => null } as any,
      memory: null,
      memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
      nlmConfig: { enabled: false },
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
    } as PipelineDeps,
    transport,
    memory: null,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
  };
}

describe("DiscordAdapter", () => {
  let adapter: DiscordAdapter;
  let transport: IKiroTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = mockTransport();
    adapter = new DiscordAdapter(makeConfig(), makeDeps(transport));
  });

  it("has correct name and capabilities", () => {
    expect(adapter.name).toBe("discord");
    expect(adapter.capabilities.voice).toBe(false);
    expect(adapter.capabilities.threads).toBe(true);
  });

  it("authorize delegates to security gate", () => {
    const result = adapter.authorize({
      platform: "discord",
      channelId: "ch1",
      sessionKey: "discord:ch1",
      senderId: "42",
      senderName: "Test",
      text: "hi",
      timestamp: Date.now(),
      isGroup: false,
      isVoice: false,
    });
    // DiscordSecurityGate checks user + channel; "42" is allowed, "*" allows all channels
    expect(result).toBe(true);
  });

  it("chunkResponse uses Discord chunking", () => {
    const short = adapter.chunkResponse("hello");
    expect(short).toEqual(["hello"]);
  });

  it("reactions capability is enabled", () => {
    expect(adapter.capabilities.reactions).toBe(true);
  });

  describe("reaction handling", () => {
    let deps: DiscordAdapterDeps;

    beforeEach(async () => {
      vi.clearAllMocks();
      capturedReactionHandler = null;
      transport = mockTransport();
      deps = makeDeps(transport);
      adapter = new DiscordAdapter(makeConfig(), deps);
      await adapter.start();
    });

    function fakeReaction(emoji: string, channelId = "ch1", messageId = "999") {
      return {
        message: { channelId, id: messageId },
        emoji: { name: emoji },
        partial: false,
        fetch: vi.fn(),
      };
    }

    function fakeUser(id: string, username = "tester", bot = false) {
      return { id, username, bot, partial: false, fetch: vi.fn() };
    }

    it("registers reaction handler on start", () => {
      expect(capturedReactionHandler).toBeTypeOf("function");
    });

    it("buffers reaction signal from authorized user", async () => {
      await capturedReactionHandler!(fakeReaction("👍"), fakeUser("42"));
      expect(deps.conversationBuffer.push).toHaveBeenCalledWith(
        "discord:ch1",
        "tester",
        expect.stringContaining("👍"),
      );
    });

    it("discards reaction from unauthorized user", async () => {
      await capturedReactionHandler!(fakeReaction("👍"), fakeUser("999"));
      expect(deps.conversationBuffer.push).not.toHaveBeenCalled();
    });

    it("scores emotion on authorized reaction when memory is available", async () => {
      const mockMemory = { updateEmotionByPlatformId: vi.fn().mockReturnValue(true) };
      deps.memory = mockMemory as any;
      adapter = new DiscordAdapter(makeConfig(), deps);
      capturedReactionHandler = null;
      await adapter.start();

      await capturedReactionHandler!(fakeReaction("❤️", "ch1", "555"), fakeUser("42"));
      expect(mockMemory.updateEmotionByPlatformId).toHaveBeenCalledWith(
        "ch1", 555, expect.any(Number),
      );
    });
  });
});
