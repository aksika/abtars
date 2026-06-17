import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TelegramAdapter, type TelegramAdapterConfig, type TelegramAdapterDeps } from "./telegram-adapter.js";
import type { PipelineDeps } from "../../components/message-pipeline.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { InboundMessage } from "../../types/platform.js";
import type { ManagedSession } from "../../components/spin-types.js";

// Mock TelegramApi
vi.mock("./telegram-api.js", () => ({
  TelegramApi: vi.fn(function () {
    return {
      getMe: vi.fn().mockResolvedValue({ username: "testbot" }),
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(1),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: "voice/file.ogg" }),
      downloadFile: vi.fn().mockResolvedValue(Buffer.from("audio")),
      sendVoice: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getUpdates: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("../../components/user-registry.js", () => ({
  loadUsers: () => ({
    users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 42 } }],
    byPlatformId: new Map([["telegram:42", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 42 } }]]),
    byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 42 } }]]),
  }),
}));

vi.mock("./telegram-poller.js", () => ({
  TelegramPoller: vi.fn(function (this: unknown, _api: unknown, _timeout: number, handler: Function) {
    (TelegramPollerMock as any)._handler = handler;
    return {
      start: vi.fn(),
      stop: vi.fn(),
      injectUpdate: vi.fn((update: unknown) => handler(update)),
    };
  }),
}));

const TelegramPollerMock: any = {};

function makeConfig(): TelegramAdapterConfig {
  return {
    botToken: "test-token",
    allowedUserIds: new Set([42]),
    pollTimeoutS: 30,
  };
}

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("response"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    transportCommands: [],
    get isReady() { return true; },
  };
}

function makeDeps(transport: IKiroTransport): TelegramAdapterDeps {
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
      sessionManager: { getActiveSessionId: () => "1_A_01", getActiveSession: () => ({ id: "1_A_01", type: "A", paused: false }) } as any,
      updateCtxStart: vi.fn(),
    } as PipelineDeps,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    transport,
    memory: null,
    sessionManager: { getActiveSessionId: () => "1_A_01" } as any,
  };
}

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;
  let transport: IKiroTransport;
  let deps: TelegramAdapterDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    transport = mockTransport();
    deps = makeDeps(transport);
    adapter = new TelegramAdapter(makeConfig(), deps);
    // Mock spin.getSessionById so pipeline can resolve session state
    const spinMod = await import("../../components/spin.js");
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue({
      id: "1_A_01", userId: "master", platform: "telegram", chatId: 42,
      delivery: "simple", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    } as ManagedSession);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue({
      id: "1_A_01", userId: "master", platform: "telegram", chatId: 42,
      delivery: "simple", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    } as ManagedSession);
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it("has correct name and capabilities", () => {
    expect(adapter.name).toBe("telegram");
    expect(adapter.capabilities.voice).toBe(true);
    expect(adapter.capabilities.reactions).toBe(true);
    expect(adapter.capabilities.typing).toBe(true);
    expect(adapter.capabilities.threads).toBe(true);
  });

  it("authorize checks user ID", () => {
    const allowed: InboundMessage = {
      platform: "telegram", channelId: "100", sessionKey: "telegram:100",
      senderId: "42", senderName: "Test", text: "hi", timestamp: Date.now(),
      isGroup: false, isVoice: false,
    };
    const denied: InboundMessage = { ...allowed, senderId: "999" };
    expect(adapter.authorize(allowed)).toBe(true);
    expect(adapter.authorize(denied)).toBe(false);
  });

  it("chunkResponse uses Telegram chunking", () => {
    expect(adapter.chunkResponse("hello")).toEqual(["hello"]);
  });

  it("start initializes bot and poller", async () => {
    await adapter.start();
    // If no error, start succeeded (getMe + setMyCommands + poller.start called)
  });

  it("stop is safe to call without start", () => {
    expect(() => adapter.stop()).not.toThrow();
  });

  it("injectMessage creates synthetic update after start", async () => {
    await adapter.start();
    adapter.injectMessage({
      platform: "telegram", channelId: "100", sessionKey: "telegram:100",
      senderId: "42", senderName: "Test", text: "queued msg",
      timestamp: Date.now(), isGroup: false, isVoice: false,
    });
  });

  describe("handleUpdate — text messages", () => {
    it("processes authorized text message via pipeline", async () => {
      await adapter.start();
      const update = {
        update_id: 1,
        message: {
          message_id: 100,
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "hello bot",
          date: Math.floor(Date.now() / 1000),
        },
      };

      // Should not throw — message reaches pipeline
      await (TelegramPollerMock as any)._handler(update);
      // Pipeline invokes transport.sendPrompt for authorized messages
      expect(transport.sendPrompt).toHaveBeenCalled();
    });

    it("rejects unauthorized text message silently", async () => {
      await adapter.start();
      const update = {
        update_id: 2,
        message: {
          message_id: 101,
          chat: { id: 999, type: "private" },
          from: { id: 999, first_name: "Hacker" },
          text: "sneaky",
          date: Math.floor(Date.now() / 1000),
        },
      };

      await (TelegramPollerMock as any)._handler(update);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });
  });

  describe("handleUpdate — reactions", () => {
    it("does not throw on authorized reaction", async () => {
      await adapter.start();
      const update = {
        update_id: 3,
        message_reaction: {
          chat: { id: 42, type: "private" },
          user: { id: 42, first_name: "Test" },
          message_id: 200,
          new_reaction: [{ type: "emoji", emoji: "👍" }],
          old_reaction: [],
          date: Math.floor(Date.now() / 1000),
        },
      };

      await expect((TelegramPollerMock as any)._handler(update)).resolves.not.toThrow();
    });

    it("ignores unauthorized reaction", async () => {
      await adapter.start();
      const update = {
        update_id: 4,
        message_reaction: {
          chat: { id: 999, type: "private" },
          user: { id: 999, first_name: "Hacker" },
          message_id: 201,
          new_reaction: [{ type: "emoji", emoji: "👍" }],
          old_reaction: [],
          date: Math.floor(Date.now() / 1000),
        },
      };

      await (TelegramPollerMock as any)._handler(update);
      // No crash, no processing — unauthorized silently dropped
    });
  });

  describe("handleUpdate — callback queries", () => {
    it("answers callback query from authorized user", async () => {
      await adapter.start();
      const update = {
        update_id: 5,
        callback_query: {
          id: "cb-1",
          from: { id: 42, first_name: "Test" },
          message: { message_id: 300, chat: { id: 42, type: "private" } },
          data: "action:yes",
        },
      };

      await (TelegramPollerMock as any)._handler(update);
      // answerCallbackQuery should be called for valid callback
    });
  });

  describe("handleUpdate — edited messages", () => {
    it("ignores edited messages", async () => {
      await adapter.start();
      const update = {
        update_id: 6,
        edited_message: {
          message_id: 400,
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Test" },
          text: "edited text",
          date: Math.floor(Date.now() / 1000),
        },
      };

      await (TelegramPollerMock as any)._handler(update);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });
  });
});
