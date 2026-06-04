/**
 * Smoke test — verifies the core bridge lifecycle works end-to-end.
 * Uses real pipeline + real memory, mock transport + mock adapter.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionRegistry } from "../components/session-registry.js";
import { SessionManager } from "../components/session-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MOCK_SOUL = "You are a test agent. Be helpful.\n\n---\n\nTools: abmind recall, abmind store";
vi.mock("../components/soul-loader.js", () => ({ loadSoulBundle: () => MOCK_SOUL }));

import { handleInboundMessage, startSession, resetAndPrepare, type PipelineDeps } from "../components/message-pipeline.js";
import type { PlatformAdapter, InboundMessage } from "../types/platform.js";
import type { IKiroTransport } from "../components/kiro-transport.js";
import { MemoryManager } from "abmind";
import { ConversationBuffer } from "../components/conversation-buffer.js";

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

function makeDeps(transport: IKiroTransport, memory: MemoryManager | null, overrides: Partial<PipelineDeps> = {}): PipelineDeps {
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
    sessions: new SessionRegistry(),
    sessionManager: { getActiveSessionId: () => "test_A_01", getActiveSession: () => ({ id: "test_A_01", type: "A", shortIndex: 1, ended: false }) } as any,
    updateCtxStart: vi.fn(),
    ...overrides,
  };
}

describe("Smoke: bridge lifecycle", () => {
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "smoke-"));
    memory = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await memory.initialize();
  });

  afterEach(() => {
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startSession injects SOUL bundle into prompt", async () => {
    const transport = makeTransport();
    const memory = new MemoryManager({ memoryEnabled: true, memoryDir: join(tmpDir, "memory"), embeddingEnabled: false } as any);
    await memory.initialize();

    await startSession(transport, memory, 100, "telegram:100", "Say hello.", async () => {});

    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]).toContain("You are a test agent");
    expect(transport.prompts[0]).toContain("abmind recall");
    expect(transport.prompts[0]!.length).toBeGreaterThan(50);
    memory.close();
  });

  it("first message triggers SOUL injection via pendingSessionStart", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const sessions = new SessionRegistry();
    sessions.getOrCreate("test_A_01").pendingStart = true;
    const deps = makeDeps(transport, memory, { sessions });

    await handleInboundMessage(makeMsg("hello"), adapter, deps);

    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]).toContain("You are a test agent");
    expect(adapter.sent.length).toBe(1);
    expect(adapter.sent[0]).toBe("Mock response");
  });

  it("second message does NOT re-inject SOUL", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const sessions = new SessionRegistry();
    sessions.getOrCreate("test_A_01").seen = true;
    const deps = makeDeps(transport, memory, { sessions });

    await handleInboundMessage(makeMsg("hello again"), adapter, deps);

    expect(transport.prompts.length).toBe(1);
    expect(transport.prompts[0]).not.toContain("You are a test agent");
  });

  it("resetAndPrepare triggers SOUL re-injection on next message", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const sessions = new SessionRegistry();
    sessions.getOrCreate("test_A_01").seen = true;
    const deps = makeDeps(transport, memory, { sessions });

    // First message — no SOUL (already seen)
    await handleInboundMessage(makeMsg("msg1"), adapter, deps);
    expect(transport.prompts[0]).not.toContain("You are a test agent");

    // Reset
    await resetAndPrepare({
      transport, sessionKey: "test_A_01", reason: "test-reset",
      sessions,
    });

    // Next message — SOUL re-injected
    transport.prompts.length = 0;
    await handleInboundMessage(makeMsg("msg2"), adapter, deps);
    expect(transport.prompts[0]).toContain("You are a test agent");
  });

  it("session-start prompt bypasses interceptor (not truncated)", async () => {
    const transport = makeTransport();
    const adapter = makeAdapter();
    const sessions = new SessionRegistry();
    sessions.getOrCreate("test_A_01").pendingStart = true;
    const deps = makeDeps(transport, memory, { sessions });

    await handleInboundMessage(makeMsg("hello"), adapter, deps);

    // SOUL is injected and not truncated by interceptor
    expect(transport.prompts[0]).toContain("You are a test agent");
    expect(transport.prompts[0]).not.toContain("⚠️ Message truncated");
  });
});
