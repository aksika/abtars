/**
 * #1813 — compact-injection lifecycle E2E (pipeline lane, not the default suite).
 *
 * Real composition: actual message-pipeline routing, prompt building, agent
 * delivery through the shared lifecycle on ACP and Direct API routes.
 * Fixtured at the boundary: transport/model I/O (mock transport counts
 * invocations) and the abmind recall payload (stubbed memoryRuntime returns
 * caller-built hits plus a deterministic selection, exactly the validated
 * wire shape).
 *
 * Acceptance: a compact turn injects the bounded selection instead of every
 * hit (smaller agent-bound payload, constraint retained); without a selection
 * the turn renders every hit. Removing selectInjectedHits from prompt-builder
 * fails the compact assertion, so this is not mock-mirroring.
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
    sendVoice: vi.fn().mockResolvedValue(Buffer.from("audio")),
  };
}

function makeSession(id: string): ManagedSession {
  return {
    id, userId: "master", platform: "telegram", chatId: 100,
    // Production master sessions use streaming delivery (spin.ts); the
    // compact turn must prove itself on that path, including post-response
    // attribution which the simple-delivery early return never reaches.
    delivery: "streaming", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1, showThinking: false,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: true,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    instructionQueue: [], steeringAccepting: false,
  };
}

const LONG_A = `Production deploys go through the pipeline. ${"a".repeat(1600)}`;
const LONG_B = `Rollbacks restore the previous release. ${"b".repeat(1600)}`;
const CONSTRAINT = "Ask the operator before deploying changes to the production database.";

function broadHits() {
  return [
    { memoryId: 1, content: LONG_A, score: 1.3, date: "2026-09-01" },
    { memoryId: 2, content: LONG_B, score: 1.2, date: "2026-09-02" },
    { memoryId: 3, content: CONSTRAINT, score: 1.1, date: "2026-09-03" },
  ];
}

const COMPACT_SELECTION = {
  version: 1,
  refs: [{ id: 3, revision: 1 }],
  budgetBytes: 2000,
  truncated: true,
};

function mockMemoryRuntime(selection: unknown) {
  const caps = new Set<string>(["recall", "recordMessage", "attribution"]);
  const recall = vi.fn(async () => ({
    hits: broadHits(),
    context: "",
    ...(selection !== undefined ? { selection } : {}),
  }));
  return {
    state: "ready",
    capabilities: caps,
    supports: (cap: string) => caps.has(cap),
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

describe("#1813 — compact injection lifecycle", () => {
  async function setupSpin(session: ManagedSession, transport: IKiroTransport) {
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

  it.each(["acp", "direct"])("compact turn injects the bounded selection (%s route)", async (route) => {
    const transport = mockTransport(route);
    const adapter = mockAdapter();
    const session = makeSession("test_A_01");
    await setupSpin(session, transport);
    const runtime = mockMemoryRuntime(COMPACT_SELECTION);
    const deps = mockDeps(transport, session, runtime);

    await handleInboundMessage(makeMsg("How do I deploy?"), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = String(vi.mocked(transport.sendPrompt).mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain(CONSTRAINT);
    expect(prompt).not.toContain("aaaa");
    // Attribution sees the injected row only.
    expect(runtime.attribution).toHaveBeenCalledWith(
      expect.objectContaining({ sourceIds: [3] }),
    );
  });

  it("renders every hit when the turn carries no selection", async () => {
    const transport = mockTransport();
    const adapter = mockAdapter();
    const session = makeSession("test_A_01");
    await setupSpin(session, transport);
    const deps = mockDeps(transport, session, mockMemoryRuntime(undefined));

    await handleInboundMessage(makeMsg("How do I deploy?"), adapter, deps);

    expect(transport.sendPrompt).toHaveBeenCalledTimes(1);
    const prompt = String(vi.mocked(transport.sendPrompt).mock.calls[0]?.[1] ?? "");
    expect(prompt).toContain(CONSTRAINT);
    expect(prompt).toContain("aaaa");
  });
});
