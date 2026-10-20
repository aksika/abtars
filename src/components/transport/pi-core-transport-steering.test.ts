/**
 * pi-core-transport-steering.test.ts — #1531 execution slot and per-lease
 * steering handoff.
 *
 * Uses a mocked SDK conversation store (and mocked Pi core loading) so the
 * transport's slot lifecycle can be driven deterministically: pre-open
 * waiting, readiness, generation isolation, lease acknowledgement, and
 * post-settlement rejection. These tests protect against dead-execution
 * delivery and cross-execution handoff, not private field shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstructionLease } from "../spin-types.js";
import {
  FakeSdkAgent,
  FakeSdkConversationStore,
} from "../../test-support/fake-sdk-conversation.js";

vi.mock("./pi-sdk-conversation.js", () => ({ PiSdkConversationStore: FakeSdkConversationStore }));
vi.mock("./pi-core-types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pi-core-types.js")>();
  return {
    ...actual,
    loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
      module: { Agent: FakeSdkAgent },
      installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.85.1", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
    }),
  };
});
vi.mock("./pi-stream-fn.js", () => ({
  createPiStreamFn: vi.fn(),
}));

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// steering tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";

function makeCandidates(): ModelCandidate[] {
  return [{
    model: "test-model",
    provider: "test-provider",
    endpoint: "https://api.test/v1",
    maxContext: 128000,
    apiKey: "test-key",
    source: "primary",
  }];
}

function makeTransport(): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
  });
}

function makeLease(overrides?: Partial<InstructionLease>): InstructionLease {
  return {
    leaseId: "lease_1",
    sessionId: "session_1",
    executionId: "exec_1",
    kind: "steer",
    instructions: [{ id: "inst_1", sessionId: "session_1", executionId: "exec_1", kind: "steer", source: "tui", text: "steer me", bytes: 8, createdAt: Date.now(), state: "leased" }],
    ...overrides,
  };
}

function fakeStore(): FakeSdkConversationStore {
  const store = FakeSdkConversationStore.latest();
  if (!store) throw new Error("expected a FakeSdkConversationStore instance");
  return store;
}

/** Ack the outstanding lease through the turn's event tap. */
function ackLease(sessionKey: string, lease: InstructionLease): void {
  const store = fakeStore();
  const call = store.promptCalls.find((c) => c.sessionKey === sessionKey);
  if (!call?.tap) throw new Error("expected a tap on the active turn");
  call.tap({
    type: "message_end",
    message: {
      role: "abtars_instruction",
      leaseId: lease.leaseId,
      executionId: "exec-1",
      kind: lease.kind,
      instructionIds: lease.instructions.map((i) => i.id),
    },
  });
}

describe("PiCoreTransport — #1531 execution slot steering", () => {
  beforeEach(() => {
    FakeSdkConversationStore.resetAll();
  });

  it("steer without an active execution slot throws an explicit error", async () => {
    const t = makeTransport();
    await expect(t.steer("steer me", makeLease())).rejects.toThrow(/No active Pi execution to steer/);
  });

  it("steer waits for the opening execution and resolves on instruction ack", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { hold: true });
    // Fixed execution ID so the test can craft the matching ack.
    const sendP = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });
    // Same tick: the conversation is still opening — steer must wait, not fail.
    const lease = makeLease({ sessionId: "session_1" });
    const steerP = t.steer("steer me", lease);
    await vi.waitFor(() => expect(fakeStore().steerCalls).toHaveLength(1));
    expect(fakeStore().steerCalls[0]).toMatchObject({ sessionKey: "session_1" });
    // The instruction message carries the lease identity for ack matching.
    const sent = fakeStore().steerCalls[0]?.message as { leaseId?: string; kind?: string };
    expect(sent.leaseId).toBe("lease_1");

    // Ack through the session tap resolves the per-lease promise.
    ackLease("session_1", lease);
    await steerP;

    fakeStore().releaseHold("session_1");
    await expect(sendP).resolves.toBe("");
  });

  it("steer rejects when the execution fails before readiness", async () => {
    const t = makeTransport();
    await t.initialize();
    // Fail conversation opening: the slot rejects instead of hanging.
    FakeSdkConversationStore.failNextEnsureError = new Error("provider exploded");
    const sendP = t.sendPrompt("session_1", "hello").catch((e: unknown) => e);
    await expect(t.steer("steer me", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/failed before steer readiness/);
    const store = fakeStore();
    expect(store.steerCalls).toHaveLength(0);
    await sendP;
  });

  it("steer never delivers to a replaced execution (generation isolation)", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { hold: true });
    const sendP1 = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });

    // #1691: a second send while the first slot is active is rejected instead
    // of replacing it — generation isolation is now guaranteed by admission,
    // so a steer can never be routed to a successor conversation.
    await expect(t.sendPrompt("session_1", "again")).rejects.toThrow(/already active/);

    // The first execution keeps its slot; its steer still delivers.
    const lease = makeLease({ sessionId: "session_1" });
    const steerP = t.steer("steer me", lease);
    await vi.waitFor(() => expect(fakeStore().steerCalls).toHaveLength(1));
    ackLease("session_1", lease);
    await steerP;

    fakeStore().releaseHold("session_1");
    await sendP1;
  });

  it("steer after execution settlement is rejected, not silently dropped", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { text: "done" });
    await t.sendPrompt("session_1", "hello");

    await expect(t.steer("dead", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/No active Pi execution to steer/);
  });

  it("followUp uses the same slot machinery", async () => {
    const t = makeTransport();
    await t.initialize();
    FakeSdkConversationStore.queueTurn("session_1", { hold: true });
    const sendP = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });

    const lease = makeLease({ leaseId: "lease_f", sessionId: "session_1", kind: "followUp" });
    const followP = t.followUp("continue", lease);
    await vi.waitFor(() => expect(fakeStore().followUpCalls).toHaveLength(1));
    ackLease("session_1", lease);
    await followP;

    fakeStore().releaseHold("session_1");
    await sendP;
  });
});
