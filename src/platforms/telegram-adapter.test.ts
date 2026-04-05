import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter, type TelegramAdapterConfig, type TelegramAdapterDeps } from "./telegram-adapter.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { IKiroTransport } from "../components/transport/kiro-transport.js";
import type { InboundMessage } from "../types/platform.js";

// Mock TelegramApi
vi.mock("../components/telegram-api.js", () => ({
  TelegramApi: vi.fn().mockImplementation(() => ({
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
  })),
}));

vi.mock("../components/telegram-poller.js", () => ({
  TelegramPoller: vi.fn().mockImplementation((_api: unknown, _timeout: number, handler: Function) => {
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
      busyChats: new Set(),
      fullModeChats: new Set(),
      pendingSessionStart: new Set(),
      seenSessions: new Set(),
      updateCtxStart: vi.fn(),
    } as PipelineDeps,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    transport,
    memory: null,
  };
}

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;
  let transport: IKiroTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = mockTransport();
    adapter = new TelegramAdapter(makeConfig(), makeDeps(transport));
  });

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
    // Should not throw
    adapter.injectMessage({
      platform: "telegram", channelId: "100", sessionKey: "telegram:100",
      senderId: "42", senderName: "Test", text: "queued msg",
      timestamp: Date.now(), isGroup: false, isVoice: false,
    });
  });
});
