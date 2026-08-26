/**
 * pi-core-transport-steering.test.ts — #1531 execution slot and per-lease
 * steering delegation.
 *
 * Uses a mocked PiCoreExecutionHost (and mocked Pi core loading) so the
 * transport's slot lifecycle can be driven deterministically: pre-host
 * waiting, host readiness, generation isolation, and post-settlement
 * rejection. These tests protect against dead-host delivery and
 * cross-execution handoff, not private field shape.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InstructionLease } from "../spin-types.js";

const { hostInstances, FakeHost, makeDeferred } = vi.hoisted(() => {
  type Deferred<T = void> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
  function makeDeferred<T = void>(): Deferred<T> {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  const hostInstances: Array<{
    executionId: string;
    sessionId: string;
    state: string;
    isSettled: boolean;
    ready: Promise<void>;
    becomeSteerable: () => void;
    failReadiness: (e: unknown) => void;
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    waitForSettlement: ReturnType<typeof vi.fn>;
    startDeferred: Deferred<void>;
    settlementDeferred: Deferred<void>;
  }> = [];

  class FakeHost {
    executionId: string;
    sessionId: string;
    state = "created";
    isSettled = false;
    ready: Promise<void>;
    private resolveReady!: () => void;
    private rejectReady!: (e: unknown) => void;
    startDeferred = makeDeferred<void>();
    settlementDeferred = makeDeferred<void>();
    steer: ReturnType<typeof vi.fn>;
    followUp: ReturnType<typeof vi.fn>;
    cancel = vi.fn();
    start: ReturnType<typeof vi.fn>;
    waitForSettlement: ReturnType<typeof vi.fn>;

    constructor(opts: { executionId: string; sessionId: string }) {
      this.executionId = opts.executionId;
      this.sessionId = opts.sessionId;
      this.ready = new Promise<void>((res, rej) => { this.resolveReady = res; this.rejectReady = rej; });
      this.steer = vi.fn();
      this.followUp = vi.fn();
      this.start = vi.fn(async () => { this.state = "running"; await this.startDeferred.promise; });
      this.waitForSettlement = vi.fn(() => this.settlementDeferred.promise);
      hostInstances.push(this);
    }

    becomeSteerable(): void { this.resolveReady(); }
    failReadiness(e: unknown): void { this.rejectReady(e); }
  }

  return { hostInstances, FakeHost, makeDeferred };
});

vi.mock("./pi-core-host.js", () => ({
  PiCoreExecutionHost: FakeHost,
}));

vi.mock("./pi-core-types.js", () => ({
  createCurrentTurnMessage: (message: string) => ({ role: "abtars_current_turn", content: message }),
  loadAndValidatePiAgentCore: vi.fn().mockResolvedValue({
    module: {},
    installation: { executable: "/usr/bin/pi", packageRoot: "/usr/lib/pi", version: "0.84.2", source: "path", pinStatus: "at-pin", moduleRoots: { ai: "", tui: "", agentCore: "" } },
  }),
}));

// #1573: initialize() gates readiness on the runtime contract probe; unrelated
// steering tests receive a successful probe.
vi.mock("./pi-runtime-contract.js", () => ({
  validatePiRuntimeContract: vi.fn(async () => {}),
}));

import { PiCoreTransport } from "./pi-core-transport.js";
import { ModelHealthRegistry } from "./model-health-registry.js";
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
    candidates: makeCandidates(),
    healthRegistry: new ModelHealthRegistry(),
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

/** Resolve every deferred of a fake host so its sendPrompt can finish. */
function finishHost(host: (typeof hostInstances)[number]): void {
  host.startDeferred.resolve();
  host.settlementDeferred.resolve();
}

describe("PiCoreTransport — #1531 execution slot steering", () => {
  beforeEach(() => {
    hostInstances.length = 0;
  });

  it("steer without an active execution slot throws an explicit error", async () => {
    const t = makeTransport();
    await expect(t.steer("steer me", makeLease())).rejects.toThrow(/No active Pi execution to steer/);
  });

  it("steer waits for the opening execution's host readiness and delegates per-lease", async () => {
    const t = makeTransport();
    // sendPrompt suspends at host.start (held) — slot and hostReady exist.
    const sendP = t.sendPrompt("session_1", "hello");
    const host = hostInstances[0]!;
    expect(host).toBeDefined();

    const steerP = t.steer("steer me", makeLease({ sessionId: "session_1" }));
    // Host not steerable yet — steer must wait, not fail.
    await new Promise((r) => setTimeout(r, 20));
    expect(host.steer).not.toHaveBeenCalled();

    host.becomeSteerable();
    await vi.waitFor(() => expect(host.steer).toHaveBeenCalledTimes(1));
    await steerP;

    // A second lease awaits its per-lease acknowledgement.
    const ack = makeDeferred<void>();
    host.steer.mockReturnValueOnce(ack.promise);
    const secondSteer = t.steer("second", makeLease({ leaseId: "lease_2", sessionId: "session_1" }));
    await vi.waitFor(() => expect(host.steer).toHaveBeenCalledTimes(2));
    let secondSettled = false;
    secondSteer.then(() => { secondSettled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(secondSettled).toBe(false);

    ack.resolve();
    await secondSteer;
    expect(secondSettled).toBe(true);

    // sendPrompt never interacted with the execution-wide settlement latch
    // for these steers and is still open while the host is held at start.
    expect(host.waitForSettlement).not.toHaveBeenCalled();
    finishHost(host);
    await expect(sendP).resolves.toBe("");
  });

  it("steer rejects when the execution fails before host readiness", async () => {
    const t = makeTransport();
    const sendP = t.sendPrompt("session_1", "hello");
    const host = hostInstances[0]!;
    host.failReadiness(new Error("provider exploded"));

    await expect(t.steer("steer me", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/never became steerable/);
    expect(host.steer).not.toHaveBeenCalled();

    finishHost(host);
    await expect(sendP).resolves.toBe("");
  });

  it("steer never delivers to a replaced execution (generation isolation)", async () => {
    const t = makeTransport();
    const sendP1 = t.sendPrompt("session_1", "hello");
    const host1 = hostInstances[0]!;

    const steerP = t.steer("steer me", makeLease({ sessionId: "session_1" }));
    // A second send replaces the active slot before the first's host becomes ready.
    const sendP2 = t.sendPrompt("session_1", "again");
    const host2 = hostInstances[1]!;
    expect(host2).not.toBe(host1);

    host1.becomeSteerable();
    await expect(steerP).rejects.toThrow(/no longer current/);
    expect(host1.steer).not.toHaveBeenCalled();

    finishHost(host1);
    finishHost(host2);
    await sendP1.catch(() => {});
    await sendP2.catch(() => {});
  });

  it("steer after execution settlement is rejected, not silently dropped", async () => {
    const t = makeTransport();
    const sendP = t.sendPrompt("session_1", "hello");
    const host = hostInstances[0]!;
    host.becomeSteerable();
    host.startDeferred.resolve();

    // While the execution is still active (settlement pending), steering works.
    await t.steer("live", makeLease({ sessionId: "session_1" }));
    expect(host.steer).toHaveBeenCalledTimes(1);

    // Settle the execution — the slot is cleared on finalization.
    host.settlementDeferred.resolve();
    host.isSettled = true;
    await sendP;

    await expect(t.steer("dead", makeLease({ sessionId: "session_1" })))
      .rejects.toThrow(/No active Pi execution to steer/);
  });

  it("followUp uses the same slot machinery", async () => {
    const t = makeTransport();
    const sendP = t.sendPrompt("session_1", "hello");
    const host = hostInstances[0]!;
    host.becomeSteerable();

    const followP = t.followUp("continue", makeLease({ leaseId: "lease_f", sessionId: "session_1" }));
    await vi.waitFor(() => expect(host.followUp).toHaveBeenCalledTimes(1));
    await followP;

    finishHost(host);
    await sendP;
  });
});
