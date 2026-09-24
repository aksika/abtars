import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDisabledRuntime } from "../../components/memory-runtime.js";
import { DiscordAdapter, type DiscordAdapterConfig, type DiscordAdapterDeps } from "./discord-adapter.js";
import type { PipelineDeps } from "../../components/message-pipeline.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { InboundMessage } from "../../types/platform.js";

// Mock discord.js client
let capturedReactionHandler: Function | null = null;
// Structural mock of DiscordApi: all Mock methods plus the botUserId data
// field (null until connect, mirroring the real class — not a Mock).
interface MockDiscordApi {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  onMessage: ReturnType<typeof vi.fn>;
  onReaction: ReturnType<typeof vi.fn>;
  onInteraction: ReturnType<typeof vi.fn>;
  onSelectMenu: ReturnType<typeof vi.fn>;
  registerCommands: ReturnType<typeof vi.fn>;
  sendTyping: ReturnType<typeof vi.fn>;
  botUserId: string | null;
}
let capturedDiscordApi: MockDiscordApi | null = null;

vi.mock("./discord-api.js", () => ({
  DiscordApi: vi.fn(function () {
    const api = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
      onReaction: vi.fn((handler: Function) => { capturedReactionHandler = handler; }),
      onInteraction: vi.fn(),
      onSelectMenu: vi.fn(),
      registerCommands: vi.fn().mockResolvedValue(undefined),
      sendTyping: vi.fn().mockResolvedValue(undefined),
      botUserId: null,
    };
    capturedDiscordApi = api;
    return api;
  }),
}));

vi.mock("../../components/user-registry.js", () => ({
  loadUsers: () => ({
    users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { discord: "42" } }],
    byPlatformId: new Map([["discord:42", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { discord: "42" } }]]),
    byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { discord: "42" } }]]),
  }),
}));

vi.mock("./discord-poller.js", () => ({
  DiscordPoller: vi.fn(function (this: unknown, _api: unknown, _appId: string, handler: Function) {
    (DiscordPollerMock as any)._handler = handler;
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn(),
    };
  }),
}));

vi.mock("../../components/media-utils.js", () => ({
  saveInboundMedia: vi.fn().mockResolvedValue({
    path: "/tmp/inbound/photo.jpg",
    mime: "image/jpeg",
    ext: ".jpg",
    size: 4,
    isImage: true,
  }),
}));

vi.mock("../../components/message-pipeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/message-pipeline.js")>();
  return { ...actual, handleInboundMessage: vi.fn().mockResolvedValue(undefined) };
});

// Partial transport-config mock for the model-picker dispatch test: only the
// two lookups the picker performs are stubbed, everything else stays real.
vi.mock("../../components/transport-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/transport-config.js")>();
  return {
    ...actual,
    loadTransport: vi.fn(() => ({ providers: { p1: { name: "P1" } } })),
    getModelsForProvider: vi.fn(() => [{ id: "m1", entry: { status: "alive" } }]),
  };
});

const DiscordPollerMock: any = {};

function makeConfig(): DiscordAdapterConfig {
  return {
    botToken: "test-token",
    appId: "123456789",
    allowedUserIds: new Set(["42"]),
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
    // Documented "unavailable" values: -1 unknown percent, zero/empty rest.
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
  };
}

function makeDeps(transport: IKiroTransport): DiscordAdapterDeps {
  return {
    pipeline: {
      transport,
      codingMode: { has: () => false, getTransport: () => null } as any,
      memoryRuntime: createDisabledRuntime(),
      memoryConfig: { memoryEnabled: false, memoryDir: "/tmp" },
      nlmConfig: { enabled: false },
      idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
      conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
      config: { agentTransport: "tmux", workingDir: "/tmp" },
      startedAt: Date.now(),
      sttConfig: null,
      ttsConfig: null,
      sessionManager: {
        getActiveSessionId: () => "1_A_01",
        getActiveSession: () => ({ id: "1_A_01", type: "A", paused: false }),
        spin: async (spec: any) => {
          const result = await transport.sendPrompt(
            spec.sessionId ?? "1_A_01",
            spec.prompt,
            spec.imageContent,
            spec.userId,
          );
          return { sessionId: spec.sessionId ?? "1_A_01", result: result ?? "" };
        },
      } as any,
      updateCtxStart: vi.fn(),
    } as PipelineDeps,
    transport,
    memoryRuntime: createDisabledRuntime(),
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
      userId: "master",
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

    it("registerCommands payload equals the registry Discord projection", async () => {
      const { getPlatformCommands } = await import("../../components/command-registry.js");
      const expected = getPlatformCommands("discord");
      const registerCommands = capturedDiscordApi?.registerCommands;
      expect(registerCommands).toHaveBeenCalledWith(expected);
      if (!registerCommands) throw new Error("expected registerCommands mock");
      const payload = registerCommands.mock.calls[0]![0] as Array<{ name: string }>;
      const names = payload.map(c => c.name);
      expect(new Set(names).size).toBe(names.length);
      expect(payload.find(c => c.name === "pi")).toBeUndefined();
      for (const tgOnly of ["full", "short", "healing"]) {
        expect(payload.find(c => c.name === tgOnly)).toBeUndefined();
      }
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
      const mockMemory = { ...createDisabledRuntime(), state: "ready" as const, recordFeedback: vi.fn().mockResolvedValue({ ok: true }) };
      deps.memoryRuntime = mockMemory as any;
      adapter = new DiscordAdapter(makeConfig(), deps);
      capturedReactionHandler = null;
      await adapter.start();

      await capturedReactionHandler!(fakeReaction("❤️", "ch1", "555"), fakeUser("42"));
      expect(mockMemory.recordFeedback).not.toHaveBeenCalled();
    });
  });

  describe("unwired pipeline degraded route (#1831)", () => {
    let recovery: {
      handle: (msg: InboundMessage, adapter: any) => Promise<void>;
      messageQueue: Array<{ msg: InboundMessage; adapter: any }>;
      noticedChannels: Set<string>;
    };
    let unwired: DiscordAdapter;

    function dmMessage(text: string, id = "900") {
      return {
        id,
        channelId: "ch1",
        parentChannelId: null,
        channelName: "DM",
        isDM: true,
        authorId: "42",
        authorUsername: "Tester",
        authorIsBot: false,
        content: text,
        timestamp: Date.now(),
        mentionsBotId: false,
        mentionsBotRole: false,
        mentionsEveryone: false,
        hasUserMentions: false,
        replyReferenceMessageId: null,
        attachments: [],
      };
    }

    function unwiredSentTexts(): string[] {
      const api = capturedDiscordApi as unknown as { sendMessage: ReturnType<typeof vi.fn> };
      return api.sendMessage.mock.calls.map((c) => String(c[1]));
    }

    async function pipelineCalls(): Promise<number> {
      const mod = await import("../../components/message-pipeline.js");
      return (mod.handleInboundMessage as ReturnType<typeof vi.fn>).mock.calls.length;
    }

    beforeEach(async () => {
      const { createBootCtx } = await import("../../boot/context.js");
      const { createRecoveryHandler } = await import("../../boot/phase-platforms-connect.js");
      const ctx = createBootCtx();
      ctx.phaseHealth.set("transport", { status: "failed", error: "test fixture" });
      ctx.phaseHealth.set("pipelineDeps", { status: "skipped", error: "no transport" });
      recovery = createRecoveryHandler(ctx);
      unwired = new DiscordAdapter(makeConfig(), {
        ...makeDeps(transport),
        pipeline: {} as PipelineDeps,
        degraded: { handle: (msg, adapter) => recovery.handle(msg, adapter) },
      });
      await unwired.start();
    });

    it("routes a normal DM to the degraded route with notice + queue, never the pipeline", async () => {
      await DiscordPollerMock._handler(dmMessage("hello bot"));

      expect(unwiredSentTexts().some((t) => t.includes("/status"))).toBe(true);
      expect(recovery.messageQueue).toHaveLength(1);
      expect(await pipelineCalls()).toBe(0);
    });

    it("throttles the notice to one per chat per episode", async () => {
      await DiscordPollerMock._handler(dmMessage("first", "901"));
      await DiscordPollerMock._handler(dmMessage("second", "902"));

      expect(recovery.messageQueue).toHaveLength(2);
      expect(unwiredSentTexts().filter((t) => t.includes("/status"))).toHaveLength(1);
      expect(await pipelineCalls()).toBe(0);
    });

    it("answers /status on the command fast path", async () => {
      await DiscordPollerMock._handler(dmMessage("/status", "903"));

      expect(unwiredSentTexts().some((t) => t.includes("Boot status"))).toBe(true);
      expect(recovery.messageQueue).toHaveLength(0);
      expect(await pipelineCalls()).toBe(0);
    });

    it("treats an addressed guild message like a DM non-command", async () => {
      await DiscordPollerMock._handler({
        ...dmMessage("hello guild", "905"),
        isDM: false,
        channelName: "general",
        mentionsBotId: true,
      });

      expect(recovery.messageQueue).toHaveLength(1);
      expect(unwiredSentTexts().filter((t) => t.includes("/status"))).toHaveLength(1);
      expect(await pipelineCalls()).toBe(0);
    });

    it("emits one content-free error log per unwired inbound", async () => {
      const logMod = await import("../../components/logger.js");
      const errorSpy = vi.spyOn(logMod, "logError").mockImplementation(() => {});

      await DiscordPollerMock._handler(dmMessage("hello bot", "904"));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls.map((c) => String(c[1])).join("\n");
      expect(logged).toContain("discord");
      expect(logged).not.toContain("hello bot");
      errorSpy.mockRestore();
    });

    it("routes injectMessage to the degraded route while unwired", () => {
      unwired.injectMessage({
        platform: "discord", channelId: "ch1", userId: "master",
        senderId: "42", senderName: "Tester", text: "replay me",
        timestamp: Date.now(), isGroup: false, isVoice: false,
      });

      expect(recovery.messageQueue).toHaveLength(1);
    });

    it("answers a slash command through the interaction reply while unwired", async () => {
      const onInteraction = (capturedDiscordApi!.onInteraction as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Function;
      const editReply = vi.fn().mockResolvedValue({ id: "r1" });
      const interaction = {
        commandName: "status",
        deferReply: vi.fn().mockResolvedValue(undefined),
        editReply,
        followUp: vi.fn().mockResolvedValue({ id: "r2" }),
        user: { id: "42", username: "Tester" },
        channelId: "ch1",
        guildId: null,
      };

      await onInteraction(interaction);

      expect(interaction.deferReply).toHaveBeenCalledOnce();
      const replied = editReply.mock.calls.map((c) => String(c[0])).join("\n");
      expect(replied).toContain("Boot status");
      expect(await pipelineCalls()).toBe(0);
    });

    it("routes the model-picker dispatch to the degraded route while unwired", async () => {
      const onInteraction = (capturedDiscordApi!.onInteraction as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Function;
      const interaction = {
        commandName: "model",
        deferReply: vi.fn().mockResolvedValue(undefined),
        reply: vi.fn().mockResolvedValue(undefined),
        editReply: vi.fn().mockResolvedValue({ id: "r1" }),
        followUp: vi.fn().mockResolvedValue({ id: "r2" }),
        user: { id: "42", username: "Tester" },
        channelId: "ch1",
        guildId: null,
      };
      await onInteraction(interaction);

      const onSelectMenu = capturedDiscordApi!.onSelectMenu as unknown as ReturnType<typeof vi.fn>;
      const providerCb = onSelectMenu.mock.calls.find((c) => c[0] === "model_picker_provider")![1] as Function;
      await providerCb({ values: ["p1"], update: vi.fn().mockResolvedValue(undefined) });
      const modelCb = onSelectMenu.mock.calls.find((c) => c[0] === "model_picker_model")![1] as Function;
      const modelUpdate = vi.fn().mockResolvedValue(undefined);
      await modelCb({ values: ["m1"], channelId: "ch1", update: modelUpdate });

      expect(modelUpdate).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Switching") }));
      expect(recovery.messageQueue).toHaveLength(1);
      expect(recovery.messageQueue[0]!.msg.text).toBe("/model p1 m1");
      expect(await pipelineCalls()).toBe(0);
    });
  });

  describe("attachment download (#1667)", () => {
    let transport: IKiroTransport;
    let deps: DiscordAdapterDeps;
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
      vi.clearAllMocks();
      transport = mockTransport();
      deps = makeDeps(transport);
      adapter = new DiscordAdapter(makeConfig(), deps);
      await adapter.start();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("requests the first attachment with a live AbortSignal", async () => {
      globalThis.fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { status: 200 }),
      ) as unknown as typeof fetch;

      await DiscordPollerMock._handler({
        id: "111",
        channelId: "ch1",
        parentChannelId: null,
        channelName: "DM",
        isDM: true,
        authorId: "42",
        authorUsername: "Tester",
        authorIsBot: false,
        content: "",
        timestamp: Date.now(),
        mentionsBotId: false,
        mentionsBotRole: false,
        mentionsEveryone: false,
        hasUserMentions: false,
        replyReferenceMessageId: null,
        attachments: [{ url: "https://cdn.example/att.jpg", filename: "photo.jpg", contentType: "image/jpeg", size: 100 }],
      });

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe("https://cdn.example/att.jpg");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    });
  });
});
