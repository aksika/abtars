/**
 * pi-core-transport-steering.test.ts — #1531 execution slot and per-lease
 * steering handoff (#1940: handoff to Pi resolves the lease).
 *
 * Uses an injected fake AgentSession factory so the transport's slot
 * lifecycle can be driven deterministically: pre-open waiting, readiness,
 * generation isolation, lease handoff, and post-settlement rejection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstructionLease } from "../spin-types.js";
import type { PiAgentSessionFactoryLoader } from "./pi-agent-session-store.js";

vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import type { ModelCandidate } from "./model-candidates.js";

interface FakeSession {
  calls: string[];
  steered: string[];
  followedUp: string[];
  prompted: string[];
  streaming: boolean;
  listeners: Set<(event: { type: string } & Record<string, unknown>) => void>;
}

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

interface SteeringHarness {
  loader: PiAgentSessionFactoryLoader;
  sessions: FakeSession[];
  releaseCreate: () => void;
  created: Array<Record<string, unknown>>;
}

function makeHarness(): SteeringHarness {
  const sessions: FakeSession[] = [];
  const created: Array<Record<string, unknown>> = [];
  let releaseCreate!: () => void;
  let createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  const loader = (async () => ({
    createAgentSession: async (options: Record<string, unknown>) => {
      // Gate session creation so tests can steer mid-opening.
      await createGate;
      created.push(options);
      const session: FakeSession = {
        calls: [],
        steered: [],
        followedUp: [],
        prompted: [],
        streaming: false,
        listeners: new Set(),
      };
      const record = session as FakeSession & {
        subscribe: (l: (e: { type: string } & Record<string, unknown>) => void) => () => void;
        prompt: (text: string) => Promise<void>;
        abort: () => Promise<void>;
        clearQueue: () => unknown;
        waitForIdle: () => Promise<void>;
        dispose: () => void;
        steer: (text: string) => void;
        followUp: (text: string) => void;
        setModel: () => Promise<void>;
        setThinkingLevel: () => void;
        compact: () => Promise<unknown>;
        getContextUsage: () => undefined;
        getActiveToolNames: () => string[];
        readonly isStreaming: boolean;
      };
      Object.assign(record, {
        subscribe: (l: (e: { type: string } & Record<string, unknown>) => void) => {
          session.listeners.add(l);
          return () => { session.listeners.delete(l); };
        },
        prompt: async (text: string) => {
          session.calls.push("prompt");
          session.prompted.push(text);
          session.streaming = true;
        },
        abort: async () => { session.calls.push("abort"); session.streaming = false; },
        clearQueue: () => { session.calls.push("clearQueue"); return {}; },
        waitForIdle: async () => { session.calls.push("waitForIdle"); },
        dispose: () => { session.calls.push("dispose"); session.streaming = false; },
        steer: (text: string) => { session.calls.push("steer"); session.steered.push(text); },
        followUp: (text: string) => { session.calls.push("followUp"); session.followedUp.push(text); },
        setModel: async () => { session.calls.push("setModel"); },
        setThinkingLevel: () => { session.calls.push("setThinkingLevel"); },
        compact: async () => { session.calls.push("compact"); return {}; },
        getContextUsage: () => undefined,
        getActiveToolNames: () => [],
      });
      Object.defineProperty(record, "isStreaming", { get: () => session.streaming });
      sessions.push(session);
      return { session: record };
    },
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    ModelRuntime: {
      create: async () => ({
        getModel: () => ({ id: "m" }),
        registerProvider: () => {},
      }),
    },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
  })) as PiAgentSessionFactoryLoader;
  return {
    loader, sessions, created,
    releaseCreate: () => releaseCreate(),
  };
}

function makeTransport(harness: SteeringHarness): PiCoreTransport {
  return new PiCoreTransport({
    role: "main",
    systemPrompt: "You are a helpful assistant.",
    candidate: makeCandidates()[0]!,
    sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
    sessionFactoryLoader: harness.loader,
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

function latestSession(harness: SteeringHarness): FakeSession {
  const session = harness.sessions[harness.sessions.length - 1];
  if (!session) throw new Error("expected a created session");
  return session;
}

function settle(session: FakeSession, text: string): void {
  for (const listener of [...session.listeners]) {
    listener({ type: "message_end", message: { role: "assistant", content: text } });
  }
  for (const listener of [...session.listeners]) {
    listener({ type: "agent_settled", aborted: false });
  }
  session.streaming = false;
}

describe("PiCoreTransport — #1531 execution slot steering (#1940 handoff)", () => {
  let harness: SteeringHarness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("steer without an active execution slot throws an explicit error", async () => {
    const t = makeTransport(harness);
    await expect(t.steer("steer me", makeLease())).rejects.toThrow(/No active Pi execution to steer/);
  });

  it("steer waits for the opening execution and resolves on Pi handoff", async () => {
    const t = makeTransport(harness);
    await t.initialize();
    // Session creation is gated: the conversation is still opening — steer
    // must wait, not fail.
    const sendP = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });
    const lease = makeLease({ sessionId: "session_1" });
    const steerP = t.steer("steer me", lease);
    await vi.waitFor(() => expect(harness.sessions).toHaveLength(0));
    harness.releaseCreate();
    await steerP;
    // #1940: the handoff to Pi's queue resolves the lease — plain steer
    // text reaches Pi (no instruction wrapper).
    const session = latestSession(harness);
    expect(session.steered).toEqual(["steer me"]);
    expect(session.prompted).toEqual(["hello"]);

    settle(session, "done");
    await expect(sendP).resolves.toBe("done");
  });

  it("steer rejects when the execution fails before readiness", async () => {
    const failing = new PiCoreTransport({
      role: "main",
      systemPrompt: "sys",
      candidate: makeCandidates()[0]!,
      sandboxPolicy: { allowedTools: ["*"], allowedRead: ["*"], allowedWrite: ["*"], canExecuteBash: true },
      sessionFactoryLoader: async () => null,
    });
    await failing.initialize();
    const sendP = failing.sendPrompt("session_1", "hello").catch((e: unknown) => e);
    await expect(failing.steer("steer me", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/failed before steer readiness/);
    await sendP;
  });

  it("steer never delivers to a replaced execution (generation isolation)", async () => {
    const t = makeTransport(harness);
    await t.initialize();
    harness.releaseCreate();
    const sendP1 = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });

    // #1691: a second send while the first slot is active is rejected instead
    // of replacing it — generation isolation is guaranteed by admission, so
    // a steer can never be routed to a successor conversation.
    await expect(t.sendPrompt("session_1", "again")).rejects.toThrow(/already active/);

    // The first execution keeps its slot; its steer still delivers.
    const lease = makeLease({ sessionId: "session_1" });
    await vi.waitFor(() => expect(latestSession(harness).prompted).toEqual(["hello"]));
    await t.steer("steer me", lease);
    expect(latestSession(harness).steered).toEqual(["steer me"]);

    settle(latestSession(harness), "");
    await sendP1;
  });

  it("steer after execution settlement is rejected, not silently dropped", async () => {
    const t = makeTransport(harness);
    await t.initialize();
    harness.releaseCreate();
    const sendP = t.sendPrompt("session_1", "hello");
    await vi.waitFor(() => expect(latestSession(harness).prompted).toEqual(["hello"]));
    settle(latestSession(harness), "done");
    await sendP;

    await expect(t.steer("dead", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/No active Pi execution to steer/);
  });

  it("followUp uses the same slot machinery", async () => {
    const t = makeTransport(harness);
    await t.initialize();
    harness.releaseCreate();
    const sendP = t.sendPrompt("session_1", "hello", undefined, { executionId: "exec-1" });
    await vi.waitFor(() => expect(latestSession(harness).prompted).toEqual(["hello"]));

    const lease = makeLease({ leaseId: "lease_f", sessionId: "session_1", kind: "followUp" });
    await t.followUp("continue", lease);
    expect(latestSession(harness).followedUp).toEqual(["continue"]);

    settle(latestSession(harness), "");
    await sendP;
  });
});
