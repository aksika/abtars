/**
 * #1813 — fast-path lifecycle E2E (pipeline lane, not the default suite).
 *
 * Real composition: actual message-pipeline routing, prompt building, Main
 * delivery, memory recording, and settlement. Fixtured: transport/model I/O
 * (mock transport counts invocations, never calls a provider) and the abmind
 * verdict (stubbed memoryRuntime returns a caller-built decision envelope).
 * No live model, provider, or daemon anywhere in this file.
 *
 * Acceptance: an answer verdict sends one source-grounded answer with zero
 * transport calls and leaves the next turn usable; anything else takes the
 * normal path. The same shared lifecycle runs for ACP and Direct API routes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setUserRegistryOverride, type UserRegistry } from "../user-registry.js";
import type { ManagedSession } from "../spin-types.js";
import { handleInboundMessage, type PipelineDeps } from "../message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../../types/platform.js";
import type { IKiroTransport } from "../transport/kiro-transport.js";

const MASTER_REGISTRY: UserRegistry = {
  users: [{ userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }],
  byPlatformId: new Map([["master:telegram", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
  byUserId: new Map([["master", { userId: "master", role: "master", maxClass: 3, tools: ["all"], platforms: { telegram: 100 } }]]),
};

function mockTransport(route?: string): IKiroTransport {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockResolvedValue("Hello from Kiro!"),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    transportCommands: [],
    get isReady() { return true; },
    contextPercent: 0,
    answerOnly: "",
    toolCallsSucceeded: 0,
    intermediateDeliveredText: "",
    ...(route !== undefined ? { getRuntimeStatus: () => ({ route }) } : {}),
  } as unknown as IKiroTransport;
}

function mockAdapter(): PlatformAdapter {
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
  };
}

function makeSession(id: string): ManagedSession {
  return {
    id, userId: "master", platform: "telegram", chatId: 100,
    delivery: "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
  };
}

const ANSWER_DECISION = {
  version: 1,
  outcome: "answer",
  answerText: "Production deploys run via /deploy prod.",
  answerLanguage: "en",
  sourceIds: [3],
  sourceRevisions: { 3: 0 },
  selectedRefs: [3],
  profile: "fixture lookup-v1",
  questionSet: "lookup-v1",
};

function mockMemoryRuntime(...decisions: unknown[]) {
  // One decision per recall call, then ordinary results: proves a verdict is
  // one-shot and the next turn flows normally.
  const queue = [...decisions];
  const recall = vi.fn(async () => ({
    hits: [{ memoryId: 3, content: "Production deploys run via /deploy prod.", score: 0.95, date: "2026-09-01" }],
    context: "- (score: 0.950) Production deploys run via /deploy prod.",
    ...(queue.length > 0 ? { decision: queue.shift() } : {}),
  }));
  return {
    state: "ready",
    capabilities: new Set<string>(["recall", "recordMessage"]),
    recall,
    recordMessage: vi.fn().mockResolvedValue({ id: 7 }),
    recordFeedback: vi.fn().mockResolvedValue({}),
    attribution: vi.fn().mockResolvedValue(null),
  };
}

function mockDeps(transport: IKiroTransport, session: ManagedSession, memoryRuntime: unknown): PipelineDeps {
  return {
    transport,
    codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as never,
    memory: null,
    memoryConfig: { memoryEnabled: true, memoryDir: "/tmp" },
    nlmConfig: { enabled: false },
    idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as never,
    conversationBuffer: { push: vi.fn(), drain: vi.fn().mockReturnValue(null), clear: vi.fn() } as never,
    config: { agentTransport: "tmux", workingDir: "/tmp" },
    startedAt: Date.now(),
    sttConfig: null,
    ttsConfig: null,
    memoryRuntime: memoryRuntime as never,
    sessionManager: {
      getActiveSessionId: () => session.id,
      getActiveSession: () => session,
      getSessionById: () => session,
      spin: async (spec: { sessionId?: string; prompt?: string }) => {
        const result = await transport.sendPrompt(spec.sessionId ?? session.id, spec.prompt ?? "");
        return { sessionId: spec.sessionId ?? session.id, result: result ?? "", outcome: "text" as const };
      },
    } as never,
    updateCtxStart: vi.fn(),
  } as unknown as PipelineDeps;
}

function makeMsg(text: string): InboundMessage {
  return {
    platform: "telegram", channelId: "100", userId: "master", senderId: "42",
    senderName: "Test", text, timestamp: Date.now(), isGroup: false, isVoice: false,
  };
}

describe("#1813 — fast-path lifecycle", () => {
  async function setupSpin(session: ManagedSession, transport: IKiroTransport) {
    // Mirror message-pipeline.test.ts: drive the real spin singleton with
    // stubbed session/transport methods so the shared lifecycle runs for real
    // while model I/O stays fixtured at the transport boundary.
    const spinMod = await import("../spin.js");
    vi.spyOn(spinMod.spin, "ensureSessionTransport").mockImplementation(async (s) => {
      s.transport = transport;
    });
    vi.spyOn(spinMod.spin, "getSessionById").mockImplementation(() => session);
    vi.spyOn(spinMod.spin, "getActiveSession").mockImplementation(() => session);
    vi.spyOn(spinMod.spin, "resolveSession").mockImplementation(async () => session);
  }

  beforeEach(() => {
    setUserRegistryOverride(MASTER_REGISTRY);
  });

  afterEach(() => {
    setUserRegistryOverride(null);
    vi.restoreAllMocks();
  });

  it.each(["acp", "direct"])("answer verdict delivers grounded text with zero transport calls (%s route)", async (route) => {
    const transport = mockTransport(route);
    const adapter = mockAdapter();
    const session = makeSession("test_A_01");
    await setupSpin(session, transport);
    const runtime = mockMemoryRuntime(ANSWER_DECISION);
    const deps = mockDeps(transport, session, runtime);

    await handleInboundMessage(makeMsg("How do I deploy?"), adapter, deps);

    expect(transport.sendPrompt).not.toHaveBeenCalled();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      "100", "Production deploys run via /deploy prod.\n\n— memory #3", expect.anything(),
    );
    expect(runtime.recordMessage).toHaveBeenCalledTimes(2);
    expect(runtime.recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: "assistant" }),
      expect.any(String),
    );
    expect(session.busy).toBe(false);

    // The next turn stays usable through the ordinary path: the verdict was
    // one-shot, so the second recall carries no decision.
    await handleInboundMessage(makeMsg("tell me more"), adapter, deps);
    expect(transport.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("falls back to the agent path without a decision", async () => {
    const transport = mockTransport();
    const adapter = mockAdapter();
    const session = makeSession("test_A_01");
    await setupSpin(session, transport);
    const deps = mockDeps(transport, session, mockMemoryRuntime(undefined));

    await handleInboundMessage(makeMsg("How do I deploy?"), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.sendMessage).toHaveBeenCalledWith("100", "Hello from Kiro!", expect.anything());
  });

  it("keeps skill-isolated sessions on the ordinary path despite a verdict", async () => {
    const transport = mockTransport();
    const adapter = mockAdapter();
    const session = makeSession("test_K_01");
    await setupSpin(session, transport);
    const deps = mockDeps(transport, session, mockMemoryRuntime(ANSWER_DECISION));

    await handleInboundMessage(makeMsg("How do I deploy?"), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledTimes(1);
  });
});
