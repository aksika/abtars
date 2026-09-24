import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createDisabledRuntime } from "../../components/memory-runtime.js";
import { TelegramAdapter, type TelegramAdapterConfig, type TelegramAdapterDeps } from "./telegram-adapter.js";
import type { PipelineDeps } from "../../components/message-pipeline.js";
import type { IKiroTransport } from "../../components/transport/kiro-transport.js";
import type { InboundMessage } from "../../types/platform.js";
import { BOOT_GREETING_TOKEN, type InternalBootMetadata } from "../../types/platform.js";
import type { ManagedSession } from "../../components/spin-types.js";

// Mock TelegramApi
let capturedApi: Record<string, ReturnType<typeof vi.fn>> | null = null;

vi.mock("./telegram-api.js", () => ({
  TelegramApi: vi.fn(function () {
    const api = {
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
    capturedApi = api;
    return api;
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
    (TelegramPollerMock as any).injectUpdate = vi.fn((update: unknown) => handler(update));
    return {
      start: vi.fn(),
      stop: vi.fn(),
      injectUpdate: (TelegramPollerMock as any).injectUpdate,
    };
  }),
}));

// #1800: partial mock so the real model picker resolves deterministically.
// Everything not listed is the real module, so other adapter flows are
// unaffected. Journey tests set explicit return values per case.
const tcMocks = vi.hoisted(() => ({
  loadTransport: vi.fn(),
  writeTransportConfig: vi.fn(),
  getModelsForProvider: vi.fn(),
  validateProviderReady: vi.fn(),
  formatValidationError: vi.fn(),
  resolveAgent: vi.fn(),
  cleanDemotedModels: vi.fn(),
}));

vi.mock("../../components/transport-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/transport-config.js")>();
  return { ...actual, ...tcMocks };
});

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
    // Documented "unavailable" values: -1 unknown percent, zero/empty rest.
    get contextPercent() { return -1; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get intermediateDeliveredText() { return ""; },
  };
}

function makeDeps(transport: IKiroTransport): TelegramAdapterDeps {
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
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    transport,
    memoryRuntime: createDisabledRuntime(),
    sessionManager: {
      getActiveSessionId: () => "1_A_01",
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
  };
}

describe("TelegramAdapter", () => {
  let adapter: TelegramAdapter;
  let transport: IKiroTransport;
  let deps: TelegramAdapterDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    TelegramPollerMock.injectUpdate = undefined;
    transport = mockTransport();
    deps = makeDeps(transport);
    adapter = new TelegramAdapter(makeConfig(), deps);
    // Mock spin.getSessionById so pipeline can resolve session state
    const spinMod = await import("../../components/spin.js");
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (session) => {
      session.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue({
      id: "1_A_01", userId: "master", platform: "telegram", chatId: 42,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1, showThinking: false,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
      instructionQueue: [], steeringAccepting: false,
    } as ManagedSession);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue({
      id: "1_A_01", userId: "master", platform: "telegram", chatId: 42,
      delivery: "streaming", active: true, status: "ready",
      idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
      log: [], shortIndex: 1, showThinking: false,
      busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
      compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
      instructionQueue: [], steeringAccepting: false,
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
      platform: "telegram", channelId: "100", userId: "master",
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

  it("setMyCommands payload equals the registry Telegram projection", async () => {
    const { getPlatformCommands } = await import("../../components/command-registry.js");
    await adapter.start();
    const expected = getPlatformCommands("telegram").map(c => ({ command: c.name, description: c.description }));
    const setMyCommands = capturedApi?.setMyCommands;
    expect(setMyCommands).toHaveBeenCalledWith(expected);
    if (!setMyCommands) throw new Error("expected setMyCommands mock");
    const payload = (setMyCommands.mock.calls[0]![0] as Array<{ command: string }>);
    const names = payload.map(c => c.command);
    expect(new Set(names).size).toBe(names.length);
    expect(payload).toContainEqual({ command: "full", description: "Raw output, TTS disabled" });
    expect(payload).toContainEqual({ command: "healing", description: "Self-healing status (read-only)" });
    expect(payload.find(c => c.command === "pi")).toBeUndefined();
  });

  it("stop is safe to call without start", () => {
    expect(() => adapter.stop()).not.toThrow();
  });

  it("injectMessage creates synthetic update after start", async () => {
    await adapter.start();
    adapter.injectMessage({
      platform: "telegram", channelId: "100", userId: "master",
      senderId: "42", senderName: "Test", text: "queued msg",
      timestamp: Date.now(), isGroup: false, isVoice: false,
    });
  });

  it("routes boot metadata directly so Telegram does not discard the question", async () => {
    await adapter.start();
    const internal = { kind: "boot_greeting", dreamQuestion: { id: "q-1", text: "Which city do you prefer?" } } as InternalBootMetadata;
    Object.defineProperty(internal, BOOT_GREETING_TOKEN, { value: true, enumerable: false });
    adapter.injectMessage({
      platform: "telegram", channelId: "42", senderId: "42", senderName: "Test",
      userId: "master", text: "[SESSION START] You just came online. Greet the user.",
      timestamp: Date.now(), isGroup: false, isVoice: false, internal,
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((TelegramPollerMock as any).injectUpdate).not.toHaveBeenCalled();
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

  describe("transport freshness after rebuild (#1800)", () => {
    const MODEL = "tencent/hy3-preview";

    function mockSwitchableTransport() {
      return {
        initialize: vi.fn().mockResolvedValue(undefined),
        sendPrompt: vi.fn().mockResolvedValue("response"),
        resetSession: vi.fn().mockResolvedValue(undefined),
        sendInterrupt: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn(),
        setModel: vi.fn().mockResolvedValue(undefined),
        switchProvider: vi.fn(),
        transportCommands: [],
        get isReady() { return true; },
      };
    }

    function routeConfig(mainProvider: string, mainModel: string, providers: Record<string, unknown>) {
      return {
        activeRoute: "pi-ai",
        routes: { "pi-ai": { agents: { main: { model: mainModel, provider: mainProvider } }, fallbacks: [] } },
        providers,
      };
    }

    function resolvedAgent(transport: string) {
      return {
        model: MODEL,
        provider: { transport, endpoint: "https://api.test/v1", apiKeyEnv: "TEST_API_KEY" },
        providerName: "test-provider",
        contextWindow: 128000,
      };
    }

    const apiProviders = {
      openrouter: { transport: "api", endpoint: "https://api.test/v1" },
      codex: { transport: "api", endpoint: "https://api.test/v1" },
      localacp: { transport: "acp", cli: "kiro-cli" },
    };

    let pipelineDeps: any;
    let oldTransport: ReturnType<typeof mockSwitchableTransport>;
    let newTransport: ReturnType<typeof mockSwitchableTransport>;

    async function wireWithLiveGetter() {
      const { createBootCtx } = await import("../../boot/context.js");
      const { wireTelegram } = await import("../../boot/wire-platform.js");
      pipelineDeps = (deps.pipeline as unknown) as any;
      pipelineDeps.transport = oldTransport;
      pipelineDeps.rebuildTransport = vi.fn(async () => {
        pipelineDeps.transport = newTransport;
      });
      const bootCtx = createBootCtx() as any;
      bootCtx.pipelineDeps = pipelineDeps;
      bootCtx.transport = oldTransport;
      bootCtx.telegramAdapter = adapter;
      bootCtx.config = { mainChatId: null };
      bootCtx.conversationBuffer = deps.conversationBuffer;
      bootCtx.memoryRuntime = deps.memoryRuntime;
      bootCtx.sessionManager = deps.sessionManager;
      await wireTelegram(bootCtx);
      await adapter.start();
    }

    function injectModelCallback(data: string) {
      return (TelegramPollerMock as any)._handler({
        update_id: 100,
        callback_query: {
          id: "cb-1800",
          from: { id: 42, first_name: "Test" },
          message: { message_id: 301, chat: { id: 42, type: "private" } },
          data,
        },
      });
    }

    function sentTexts(): string[] {
      const api = capturedApi as unknown as { sendMessage: ReturnType<typeof vi.fn> };
      return api.sendMessage.mock.calls.map((c) => String(c[1]));
    }

    beforeEach(() => {
      oldTransport = mockSwitchableTransport();
      newTransport = mockSwitchableTransport();
      tcMocks.loadTransport.mockReset();
      tcMocks.resolveAgent.mockReset();
      tcMocks.writeTransportConfig.mockReset();
      tcMocks.getModelsForProvider.mockReset();
      tcMocks.validateProviderReady.mockReset();
      tcMocks.formatValidationError.mockReset();
      tcMocks.cleanDemotedModels.mockReset();
      tcMocks.writeTransportConfig.mockReturnValue({ ok: true });
      tcMocks.getModelsForProvider.mockReturnValue([{ id: MODEL }]);
      tcMocks.validateProviderReady.mockReturnValue({ ok: true });
      tcMocks.formatValidationError.mockReturnValue("");
      tcMocks.cleanDemotedModels.mockReturnValue(undefined);
    });

    it("calls setModel on the live transport after a completed rebuild", async () => {
      await wireWithLiveGetter();
      tcMocks.loadTransport.mockReturnValue(
        routeConfig("openrouter", "codex-old-model", { openrouter: apiProviders.openrouter }),
      );
      // Model a previously completed rebuild on the same holder; the adapter
      // stays wired. A value capture would keep using oldTransport here.
      pipelineDeps.transport = newTransport;

      await injectModelCallback(`mset:openrouter:${MODEL}`);

      expect(newTransport.setModel).toHaveBeenCalledTimes(1);
      expect(newTransport.setModel).toHaveBeenCalledWith(MODEL);
      expect(oldTransport.setModel).not.toHaveBeenCalled();
      expect(pipelineDeps.rebuildTransport).not.toHaveBeenCalled();
      expect(sentTexts().some((t) => t.includes(`✓ Switched to ${MODEL}`))).toBe(true);
    });

    it("calls switchProvider on the live transport for a same-type provider change", async () => {
      await wireWithLiveGetter();
      tcMocks.loadTransport.mockReturnValue(
        routeConfig("codex", "codex-model", { openrouter: apiProviders.openrouter, codex: apiProviders.codex }),
      );
      tcMocks.resolveAgent.mockImplementation((slot: string) =>
        slot === "_old" ? resolvedAgent("api") : resolvedAgent("api"),
      );
      pipelineDeps.transport = newTransport;

      const envMod = await import("../../components/env-schema.js");
      const realEnv = envMod.getEnv();
      vi.spyOn(envMod, "getEnv").mockReturnValue({ ...realEnv, getApiKey: () => "test-key" } as never);

      await injectModelCallback(`mset:openrouter:${MODEL}`);

      expect(newTransport.switchProvider).toHaveBeenCalledTimes(1);
      expect(newTransport.switchProvider).toHaveBeenCalledWith(
        expect.objectContaining({ provider: "openrouter", model: MODEL, apiKey: "test-key" }),
      );
      expect(oldTransport.switchProvider).not.toHaveBeenCalled();
      expect(pipelineDeps.rebuildTransport).not.toHaveBeenCalled();
      expect(sentTexts().some((t) => t.includes(`✓ Switched to ${MODEL} (openrouter)`))).toBe(true);
    });

    it("rebuilds and resets the live transport for a cross-transport change", async () => {
      await wireWithLiveGetter();
      tcMocks.loadTransport.mockReturnValue(
        routeConfig("localacp", "local-model", { openrouter: apiProviders.openrouter, localacp: apiProviders.localacp }),
      );
      tcMocks.resolveAgent.mockImplementation((slot: string) =>
        slot === "_old" ? resolvedAgent("acp") : resolvedAgent("api"),
      );

      await injectModelCallback(`mset:openrouter:${MODEL}`);

      expect(pipelineDeps.rebuildTransport).toHaveBeenCalledTimes(1);
      expect(newTransport.resetSession).toHaveBeenCalledTimes(1);
      expect(newTransport.resetSession).toHaveBeenCalledWith("telegram:42");
      expect(oldTransport.resetSession).not.toHaveBeenCalled();
      expect(newTransport.switchProvider).not.toHaveBeenCalled();
      expect(oldTransport.switchProvider).not.toHaveBeenCalled();
      expect(sentTexts().some((t) => t.includes("Transport rebuilt"))).toBe(true);
    });
  });

  describe("unwired pipeline degraded route (#1831)", () => {
    let recovery: {
      handle: (msg: InboundMessage, adapter: any) => Promise<void>;
      messageQueue: Array<{ msg: InboundMessage; adapter: any }>;
      noticedChannels: Set<string>;
    };
    let unwired: TelegramAdapter;

    function dmUpdate(text: string, messageId: number) {
      return {
        update_id: messageId,
        message: {
          message_id: messageId,
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Test" },
          text,
          date: Math.floor(Date.now() / 1000),
        },
      };
    }

    function unwiredSentTexts(): string[] {
      const api = capturedApi as unknown as { sendMessage: ReturnType<typeof vi.fn> };
      return api.sendMessage.mock.calls.map((c) => String(c[1]));
    }

    beforeEach(async () => {
      const { createBootCtx } = await import("../../boot/context.js");
      const { createRecoveryHandler } = await import("../../boot/phase-platforms-connect.js");
      const ctx = createBootCtx();
      ctx.phaseHealth.set("transport", { status: "failed", error: "test fixture" });
      ctx.phaseHealth.set("pipelineDeps", { status: "skipped", error: "no transport" });
      recovery = createRecoveryHandler(ctx);
      unwired = new TelegramAdapter(makeConfig(), {
        ...deps,
        pipeline: {} as PipelineDeps,
        degraded: { handle: (msg, adapter) => recovery.handle(msg, adapter) },
      });
      await unwired.start();
    });

    it("routes a normal DM to the degraded route with notice + queue, never the pipeline", async () => {
      await (TelegramPollerMock as any)._handler(dmUpdate("hello bot", 901));

      expect(unwiredSentTexts().some((t) => t.includes("/status"))).toBe(true);
      expect(recovery.messageQueue).toHaveLength(1);
      expect(recovery.messageQueue[0]!.msg.text).toBe("hello bot");
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("throttles the notice to one per chat per episode", async () => {
      await (TelegramPollerMock as any)._handler(dmUpdate("first", 902));
      await (TelegramPollerMock as any)._handler(dmUpdate("second", 903));

      expect(recovery.messageQueue).toHaveLength(2);
      expect(unwiredSentTexts().filter((t) => t.includes("/status"))).toHaveLength(1);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("answers /status on the command fast path", async () => {
      await (TelegramPollerMock as any)._handler(dmUpdate("/status", 904));

      expect(unwiredSentTexts().some((t) => t.includes("Boot status"))).toBe(true);
      expect(recovery.messageQueue).toHaveLength(0);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("treats an addressed group message like a DM non-command", async () => {
      await (TelegramPollerMock as any)._handler({
        update_id: 907,
        message: {
          message_id: 907,
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, first_name: "Test" },
          text: "@testbot hello group",
          date: Math.floor(Date.now() / 1000),
        },
      });

      expect(recovery.messageQueue).toHaveLength(1);
      expect(unwiredSentTexts().filter((t) => t.includes("/status"))).toHaveLength(1);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("routes an internal synthetic message to the degraded route while unwired", async () => {
      const internal = { kind: "boot_greeting" } as InternalBootMetadata;
      Object.defineProperty(internal, BOOT_GREETING_TOKEN, { value: true, enumerable: false });
      unwired.injectMessage({
        platform: "telegram", channelId: "42", senderId: "42", senderName: "Test",
        userId: "master", text: "[SESSION START] hello",
        timestamp: Date.now(), isGroup: false, isVoice: false, internal,
      });

      expect(recovery.messageQueue).toHaveLength(1);
      expect(transport.sendPrompt).not.toHaveBeenCalled();
    });

    it("emits one content-free error log per unwired inbound", async () => {
      const logMod = await import("../../components/logger.js");
      const errorSpy = vi.spyOn(logMod, "logError").mockImplementation(() => {});

      await (TelegramPollerMock as any)._handler(dmUpdate("hello bot", 905));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls.map((c) => String(c[1])).join("\n");
      expect(logged).toContain("telegram");
      expect(logged).not.toContain("hello bot");
      errorSpy.mockRestore();
    });

    it("wiring drops the degraded route and restores the pipeline", async () => {
      unwired.setMessageHandler(deps);

      await (TelegramPollerMock as any)._handler(dmUpdate("hello again", 906));

      expect(transport.sendPrompt).toHaveBeenCalled();
      expect(recovery.messageQueue).toHaveLength(0);
    });
  });
});
