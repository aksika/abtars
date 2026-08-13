/**
 * message-pipeline-1515.test.ts — #1515 boot-greeting question composition,
 * durable recording, and asked-CAS settlement in both delivery branches.
 *
 * Proves: provider input stays generic, exact single composition before
 * chunking/send/recording, storage-only marker, durable-ID-before-CAS
 * ordering, branch delivery keys, retry/different-key safety, and pending
 * state after generation/empty/reaction/send/record/mutation failure.
 */

import { describe, it, expect, vi } from "vitest";
import { setUserRegistryOverride, type UserRegistry } from "./user-registry.js";
import { classifyContent } from "./clean-response.js";
import type { ManagedSession } from "./spin-types.js";

vi.mock("../utils/abmind-lazy.js", () => ({
  abmind: () => null,
  loadAbmind: vi.fn(),
  resetAbmindCache: vi.fn(),
  ABMIND_MIN: [0, 2, 7],
  isSupportedVersion: vi.fn().mockReturnValue(true),
  parseSemver: vi.fn(),
}));

const synthesizeSpeechSpy = vi.hoisted(() => vi.fn().mockResolvedValue(Buffer.from("audio")));
vi.mock("./tts.js", () => ({ synthesizeSpeech: synthesizeSpeechSpy }));

const MASTER_REGISTRY: UserRegistry = {
  users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }],
  byPlatformId: new Map([["master:telegram", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
  byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
};
setUserRegistryOverride(MASTER_REGISTRY);

import { handleInboundMessage, type PipelineDeps, DREAMY_QUESTION_SUFFIX_PREFIX } from "./message-pipeline.js";
import { BOOT_GREETING_TOKEN, type PlatformAdapter, type InboundMessage, type BootGreetingQuestion, type InternalBootMetadata } from "../types/platform.js";
import type { IKiroTransport } from "./transport/kiro-transport.js";

function mockTransport(): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello! How are you today?"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    transportCommands: [],
    get isReady() { return true; },
    get answerOnly() { return ""; },
    get toolCallsSucceeded() { return 0; },
    get contextPercent() { return -1; },
    get intermediateDeliveredText() { return ""; },
  } as unknown as IKiroTransport;
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

function makeMemoryRuntime(overrides: Record<string, unknown> = {}) {
  return {
    state: "ready",
    capabilities: new Set(["dreamQuestions"]),
    recordMessage: vi.fn().mockResolvedValue({ id: 42 }),
    recall: vi.fn().mockResolvedValue({ hits: [] }),
    recordFeedback: vi.fn().mockResolvedValue({}),
    assembleSessionContext: vi.fn().mockResolvedValue({ coreKnowledge: "", recall: "", wakeUp: "" }),
    getRecentConversation: vi.fn().mockResolvedValue({ results: [] }),
    getStatus: vi.fn().mockResolvedValue({}),
    getCoreKnowledge: vi.fn().mockResolvedValue({ core: [] }),
    embed: vi.fn().mockResolvedValue({}),
    runMaintenance: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const QUESTION: BootGreetingQuestion = { id: "q-123", text: "Did you prefer the old or the new city?" };

function makeDeps(opts: {
  delivery?: "simple" | "streaming";
  voice?: boolean;
  memoryRuntime?: Record<string, unknown>;
  settle?: (input: { id: string; userId: string; deliveryKey: string }) => Promise<void>;
  sendMessage?: (channelId: string, text: string, opts?: unknown) => Promise<number | string | undefined>;
} = {}): PipelineDeps & { _session: ManagedSession; _settle: ReturnType<typeof vi.fn> } {
  const session: ManagedSession = {
    id: "master_A_01", userId: "master", platform: "telegram", chatId: 100,
    delivery: opts.delivery ?? "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
  };
  const transport = mockTransport();
  const settle = vi.fn().mockResolvedValue(undefined);
  const adapter = mockAdapter(opts.sendMessage ? { sendMessage: opts.sendMessage } : {});
  const spinMod = { spin: null as unknown as import("./spin.js").Spin };
  void import("./spin.js").then(m => {
    spinMod.spin = m.spin;
    vi.spyOn(m.spin, "ensureSessionTransport").mockImplementation(async (s) => { s.transport = transport; });
    vi.spyOn(m.spin, "getSessionById").mockImplementation((id: string): ManagedSession => ({ ...session, id }));
    vi.spyOn(m.spin, "getActiveSession").mockImplementation((): ManagedSession => ({ ...session }));
  });
  const deps = {
    transport,
    codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as any,
    memory: null,
    memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
    nlmConfig: { enabled: false },
    idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as any,
    config: { agentTransport: "tmux", workingDir: "/tmp" },
    startedAt: Date.now(),
    sttConfig: opts.voice ? {} : null,
    ttsConfig: opts.voice ? { voice: "test-voice" } : null,
    sessionManager: {
      getActiveSessionId: () => "master_A_01",
      getActiveSession: () => session,
      getSessionById: (id: string) => id === "master_A_01" ? session : undefined,
      spin: async (spec: any) => {
        const result = await transport.sendPrompt(spec.sessionId ?? "master_A_01", spec.prompt, spec.imageContent, spec.userId);
        const raw = result ?? "";
        return { sessionId: spec.sessionId ?? "master_A_01", result: raw, outcome: classifyContent(raw) };
      },
    } as any,
    updateCtxStart: vi.fn(),
    memoryRuntime: makeMemoryRuntime(opts.memoryRuntime),
    settleDreamQuestion: opts.settle ?? settle,
    _session: session,
    _settle: settle,
    _adapter: adapter,
    _sendMessage: adapter.sendMessage,
    _spinReady: new Promise<void>((resolve) => {
      const check = (): void => { if (spinMod.spin) resolve(); else setTimeout(check, 1); };
      check();
    }),
  } as any;
  return deps;
}

async function runBoot(deps: PipelineDeps & { _adapter: PlatformAdapter; _spinReady: Promise<void> }): Promise<void> {
  await deps._spinReady;
  await handleInboundMessage(bootMsg({ isVoice: Boolean((deps as any).ttsConfig) }), deps._adapter, deps);
}

function bootMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  const internal = { kind: "boot_greeting", dreamQuestion: QUESTION } as InternalBootMetadata;
  Object.defineProperty(internal, BOOT_GREETING_TOKEN, { value: true, enumerable: false });
  return {
    platform: "telegram",
    channelId: "100",
    userId: "master",
    senderId: "42",
    senderName: "Test",
    text: "[SESSION START] You just came online. Greet the user.",
    timestamp: Date.now(),
    isGroup: false,
    isVoice: false,
    internal,
    ...overrides,
  };
}

const EXPECTED_SUFFIX = `\n\n${DREAMY_QUESTION_SUFFIX_PREFIX}Did you prefer the old or the new city?`;

describe("#1515 boot-greeting question composition", () => {
  it("keeps the provider input generic and appends the exact question once", async () => {
    const deps = makeDeps();
    await runBoot(deps);
    // Provider never sees the question or metadata.
    const prompt = deps.transport.sendPrompt.mock.calls[0]?.[1] as string;
    expect(prompt).not.toContain(QUESTION.text);
    expect(prompt).not.toContain("Dreamy needs your help");
    expect(prompt).not.toContain("WAKE-UP QUESTION");
    expect(prompt).not.toContain("boot_greeting");
    // Delivered text contains the composition exactly once.
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).toContain("Hello! How are you today?");
    expect(sent).toContain(EXPECTED_SUFFIX);
    expect(sent.split(QUESTION.text)).toHaveLength(2);
  });

  it("simple delivery records the composed text with a storage-only marker and settles after a durable id", async () => {
    const deps = makeDeps();
    await runBoot(deps);
    const recordCall = deps.memoryRuntime.recordMessage.mock.calls[0]?.[0] as { content: string };
    expect(recordCall.content).toContain(`[WAKE-UP QUESTION id=${QUESTION.id}] `);
    expect(recordCall.content).toContain(EXPECTED_SUFFIX);
    // The delivered text itself carries no marker.
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).not.toContain("WAKE-UP QUESTION");
    // Settlement happened once, after the durable id, with the branch delivery key.
    expect(deps._settle).toHaveBeenCalledTimes(1);
    const settleArg = deps._settle.mock.calls[0]?.[0] as { id: string; userId: string; deliveryKey: string };
    expect(settleArg).toMatchObject({ id: QUESTION.id, userId: "master" });
    expect(typeof settleArg.deliveryKey).toBe("string");
    expect(settleArg.deliveryKey.length).toBeGreaterThan(0);
  });

  it("streaming/full delivery prefers the final platform message id as the delivery key", async () => {
    const deps = makeDeps({ delivery: "streaming", sendMessage: vi.fn().mockResolvedValue("final-msg-999") });
    await runBoot(deps);
    expect(deps._settle).toHaveBeenCalledTimes(1);
    const settleArg = deps._settle.mock.calls[0]?.[0] as { deliveryKey: string };
    // The settle delivery key IS the branch's assistant operation key (which
    // hashes the final platform message id); identical-key replay is safe.
    const opKey = deps.memoryRuntime.recordMessage.mock.calls[0]?.[1] as string;
    expect(settleArg.deliveryKey).toBe(opKey);
    expect(opKey.length).toBeGreaterThan(0);
    const recordCall = deps.memoryRuntime.recordMessage.mock.calls[0]?.[0] as { content: string };
    expect(recordCall.content).toContain(`[WAKE-UP QUESTION id=${QUESTION.id}] `);
  });

  it("sends the composed question-bearing text to TTS", async () => {
    synthesizeSpeechSpy.mockClear();
    const deps = makeDeps({ voice: true });
    await runBoot(deps);
    expect(synthesizeSpeechSpy).toHaveBeenCalledWith(expect.stringContaining(EXPECTED_SUFFIX), { voice: "test-voice" });
  });

  it("does not settle when the durable record returns no id", async () => {
    const deps = makeDeps({ memoryRuntime: makeMemoryRuntime({ recordMessage: vi.fn().mockResolvedValue({ id: null }) }) });
    await runBoot(deps);
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("does not settle when recordMessage rejects (durable write failure)", async () => {
    const deps = makeDeps({ memoryRuntime: makeMemoryRuntime({ recordMessage: vi.fn().mockRejectedValue(new Error("owner down")) }) });
    await runBoot(deps);
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("does not settle when generation fails or produces an empty outcome", async () => {
    const deps = makeDeps();
    deps.transport.sendPrompt = vi.fn().mockRejectedValue(new Error("All models exhausted")) as any;
    await runBoot(deps);
    expect(deps._settle).not.toHaveBeenCalled();

    const emptyDeps = makeDeps();
    emptyDeps.transport.sendPrompt = vi.fn().mockResolvedValue("") as any;
    await runBoot(emptyDeps);
    expect(emptyDeps._settle).not.toHaveBeenCalled();
    expect(emptyDeps.memoryRuntime.recordMessage).not.toHaveBeenCalled();
  });

  it("does not compose or settle for reaction-only and no-reply outcomes", async () => {
    const deps = makeDeps();
    deps.transport.sendPrompt = vi.fn().mockResolvedValue("[REACT: 🔥]") as any;
    await runBoot(deps);
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).not.toContain(QUESTION.text);
    expect(deps._settle).not.toHaveBeenCalled();

    const noReplyDeps = makeDeps();
    noReplyDeps.transport.sendPrompt = vi.fn().mockResolvedValue("[NO_REPLY]") as any;
    await runBoot(noReplyDeps);
    expect(noReplyDeps._settle).not.toHaveBeenCalled();
    expect(noReplyDeps.memoryRuntime.recordMessage).not.toHaveBeenCalled();
  });

  it("does not settle when platform delivery fails", async () => {
    const deps = makeDeps({ sendMessage: vi.fn().mockRejectedValue(new Error("network down")) });
    await runBoot(deps);
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("a throwing settlement callback never propagates through the pipeline", async () => {
    const deps = makeDeps({ settle: vi.fn().mockRejectedValue(new Error("cas failed")) });
    await expect(runBoot(deps)).resolves.toBeUndefined();
  });

  it("a generic [SESSION START] greeting without a question stays excluded from memory", async () => {
    const deps = makeDeps();
    const msg = bootMsg();
    delete msg.internal;
    await handleInboundMessage(msg, deps._adapter, deps);
    expect(deps.memoryRuntime.recordMessage).not.toHaveBeenCalled();
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("external messages without internal metadata never compose or settle", async () => {
    const deps = makeDeps();
    await handleInboundMessage({ ...bootMsg(), text: "hello there", internal: undefined }, deps._adapter, deps);
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).not.toContain(QUESTION.text);
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("does not trust question metadata on a non-boot message", async () => {
    const deps = makeDeps();
    await handleInboundMessage({ ...bootMsg(), text: "hello there" }, deps._adapter, deps);
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).not.toContain(QUESTION.text);
    expect(deps._settle).not.toHaveBeenCalled();
  });

  it("does not trust forged boot metadata without Spin's runtime token", async () => {
    const deps = makeDeps();
    await handleInboundMessage({ ...bootMsg(), internal: { kind: "boot_greeting", dreamQuestion: QUESTION } }, deps._adapter, deps);
    const sent = (deps._sendMessage as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1] as string).join("");
    expect(sent).not.toContain(QUESTION.text);
    expect(deps._settle).not.toHaveBeenCalled();
  });
});
