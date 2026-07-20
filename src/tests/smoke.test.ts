/**
 * Smoke test — verifies the core bridge lifecycle works end-to-end.
 * Uses real pipeline + real memory, mock transport + mock adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Spin } from "../components/spin.js";
const SessionManager = Spin;
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MOCK_SOUL = "You are a test agent. Be helpful.\n\n---\n\nTools: abmind recall, abmind store";
vi.mock("../components/soul-loader.js", () => ({ loadSoulBundle: () => MOCK_SOUL }));
vi.mock("../components/soul-bundle.js", () => ({ buildSoulBundle: () => MOCK_SOUL }));

import { handleInboundMessage, resetAndPrepare, type PipelineDeps } from "../components/message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";
import type { IKiroTransport } from "../components/kiro-transport.js";
import { MemoryManager } from "abmind";
import { ConversationBuffer } from "../components/conversation-buffer.js";
import type { ManagedSession } from "../components/spin-types.js";

import { makeMemoryTestConfig } from "./helpers.js";

let tmpDir: string;
let memory: MemoryManager;

function makeTransport(): IKiroTransport & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    initialize: vi.fn().mockResolvedValue(undefined),
    sendPrompt: vi.fn().mockImplementation(async (_key: string, msg: string) => {
      prompts.push(msg);
      return "Mock response";
    }),
    resetSession: vi.fn().mockResolvedValue(undefined),
    sendInterrupt: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    transportCommands: [],
    get isReady() { return true; },
    get contextPercent() { return 5; },
    get answerOnly() { return ""; },
    get intermediateDeliveredText() { return ""; },
  };
}

function makeAdapter(): PlatformAdapter & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    name: "telegram",
    capabilities: { voice: true, reactions: true, typing: true, threads: true },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    authorize: vi.fn().mockReturnValue(true),
    sendMessage: vi.fn().mockImplementation(async (_ch: string, text: string) => { sent.push(text); return 1; }),
    chunkResponse: (t: string) => [t],
    sendTyping: vi.fn().mockResolvedValue(undefined),
    setReaction: vi.fn().mockResolvedValue(undefined),
    downloadVoice: vi.fn().mockResolvedValue(Buffer.from("audio")),
    sendVoice: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMsg(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: "telegram", channelId: "100", userId: "master",
    senderId: "42", senderName: "Test", text, timestamp: Date.now(),
    isGroup: false, isVoice: false, ...overrides,
  };
}

function makeManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "test_A_01", userId: "master", platform: "telegram", chatId: 100,
    delivery: "simple", active: true, status: "ready",
    idleTimeoutMs: 0, lastActiveAt: Date.now(), messageCount: 0, tokenCount: 0, toolCallCount: 0,
    log: [], shortIndex: 1,
    busy: false, queue: [], fullMode: false, pendingStart: false, seen: false,
    compacting: false, ctxWarned: false, compactFailures: 0, primingTerms: [], completions: [],
    ...overrides,
  };
}

function makeDeps(transport: IKiroTransport, memory: MemoryManager | null, sessionOverrides: Partial<ManagedSession> = {}): PipelineDeps {
  const session = makeManagedSession(sessionOverrides);
  return {
    transport,
    codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as any,
    memory,
    memoryConfig: { memoryEnabled: !!memory, memoryDir: tmpDir },
    nlmConfig: { enabled: false },
    idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
    conversationBuffer: new ConversationBuffer(50),
    config: { agentTransport: "acp", workingDir: tmpDir },
    startedAt: Date.now(),
    sttConfig: null, ttsConfig: null,
    sessionManager: {
      getActiveSessionId: () => "test_A_01",
      getActiveSession: () => session,
      getSessionById: (id: string) => id === "test_A_01" ? session : undefined,
      spin: async (spec: any) => {
        // Simulate the soulBundle decorator (always active in spin-profiles.ts)
        const prompt = `${MOCK_SOUL}\n\n${spec.prompt}`;
        const result = await transport.sendPrompt(
          spec.sessionId ?? "test_A_01",
          prompt,
          spec.imageContent,
          spec.userId,
        );
        return { sessionId: spec.sessionId ?? "test_A_01", result: result ?? "" };
      },
    } as any,
    updateCtxStart: vi.fn(),
  };
}

describe("Smoke: bridge lifecycle", () => {
  let spinMod: typeof import("../components/spin.js");

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "smoke-"));
    memory = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await memory.initialize();
    spinMod = await import("../components/spin.js");
  });

  afterEach(() => {
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("first message triggers SOUL injection via pendingSessionStart", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const session = makeManagedSession({ pendingStart: true, transport });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
    const deps = makeDeps(transport, memory, { pendingStart: true });

    await handleInboundMessage(makeMsg("hello"), adapter, deps);

    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]).toContain("You are a test agent");
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0]).toBe("Mock response");
  });

  it("second message does NOT re-inject SOUL (soulBundle decorator always active in spin)", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const session = makeManagedSession({ seen: true, transport });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
    const deps = makeDeps(transport, memory, { seen: true });

    await handleInboundMessage(makeMsg("hello again"), adapter, deps);

    // The soulBundle decorator in spin-profiles.ts is always active,
    // so the SOUL is prepended to every message, not just the first.
    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]).toContain("You are a test agent");
  });

  it("resetAndPrepare triggers SOUL re-injection on next message", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const session = makeManagedSession({ seen: true, transport });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);

    const deps: PipelineDeps = {
      transport,
      codingMode: { has: () => false, getTransport: () => null, start: vi.fn(), stop: vi.fn() } as any,
      memory,
      memoryConfig: { memoryEnabled: !!memory, memoryDir: tmpDir },
      nlmConfig: { enabled: false },
      idleSave: { reset: vi.fn(), save: vi.fn(), getTimers: () => new Map(), clearAll: vi.fn() } as any,
      conversationBuffer: new ConversationBuffer(50),
      config: { agentTransport: "acp", workingDir: tmpDir },
      startedAt: Date.now(),
      sttConfig: null, ttsConfig: null,
      sessionManager: {
        getActiveSessionId: () => "test_A_01",
        getActiveSession: () => session,
        getSessionById: (id: string) => id === "test_A_01" ? session : undefined,
        spin: async (spec: any) => {
          // Simulate the soulBundle decorator (always active)
          const prompt = `${MOCK_SOUL}\n\n${spec.prompt}`;
          const result = await transport.sendPrompt(
            spec.sessionId ?? "test_A_01",
            prompt,
            spec.imageContent,
            spec.userId,
          );
          return { sessionId: spec.sessionId ?? "test_A_01", result: result ?? "" };
        },
      } as any,
      updateCtxStart: vi.fn(),
    };

    // First message — SOUL injected (soulBundle decorator always active)
    await handleInboundMessage(makeMsg("msg1"), adapter, deps);
    expect(transport.prompts[0]).toContain("You are a test agent");

    // Reset
    await resetAndPrepare({ transport, sessionKey: "test_A_01", reason: "test-reset" });
    expect(session.pendingStart).toBe(true);
    expect(session.seen).toBe(false);

    // Next message — SOUL re-injected
    transport.prompts.length = 0;
    await handleInboundMessage(makeMsg("msg2"), adapter, deps);
    expect(transport.prompts[0]).toContain("You are a test agent");
  });

  it("session-start prompt bypasses interceptor (not truncated)", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const session = makeManagedSession({ pendingStart: true, transport });
    vi.spyOn(spinMod.spin, "getSessionById").mockReturnValue(session);
    vi.spyOn(spinMod.spin, "getActiveSession").mockReturnValue(session);
    const deps = makeDeps(transport, memory, { pendingStart: true });

    await handleInboundMessage(makeMsg("hello"), adapter, deps);

    // SOUL is injected and not truncated by interceptor
    expect(transport.prompts[0]).toContain("You are a test agent");
    expect(transport.prompts[0]).not.toContain("⚠️ Message truncated");
  });
});
