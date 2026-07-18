import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ManagedSession, QueuedSessionInstruction, SteerEvent } from "./spin-types.js";
import {
  queueInstruction, leaseInstructions, markDelivered, markConsumed,
  restoreBeforeDelivery, failAfterDelivery, expireInstructions,
  onSteerEvent, subscribeSteerEvents,
} from "./session-instruction-queue.js";

function makeSession(overrides?: Partial<ManagedSession>): ManagedSession {
  return {
    id: "1749563282_O_01",
    userId: "aksika",
    platform: "tui",
    chatId: 0,
    delivery: "simple",
    active: false,
    status: "ready",
    idleTimeoutMs: 7200000,
    lastActiveAt: Date.now(),
    messageCount: 10,
    tokenCount: 100,
    toolCallCount: 0,
    log: [],
    shortIndex: 1,
    busy: true,
    queue: [],
    fullMode: false,
    pendingStart: false,
    seen: false,
    compacting: false,
    ctxWarned: false,
    compactFailures: 0,
    primingTerms: [],
    completions: [],
    instructionQueue: [],
    activeExecutionId: "exec_1",
    steeringAccepting: true,
    ...overrides,
  };
}

describe("leaseInstructions (#1444)", () => {
  it("returns null when queue is empty", () => {
    const session = makeSession();
    expect(leaseInstructions(session)).toBeNull();
  });

  it("leases matching queued instructions", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    queueInstruction(session, { text: "b", source: "tui" });

    const lease = leaseInstructions(session);
    expect(lease).not.toBeNull();
    expect(lease!.instructions.length).toBe(2);
    expect(lease!.kind).toBe("steer");
    expect(lease!.sessionId).toBe(session.id);
  });

  it("sets instruction state to leased", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    leaseInstructions(session);
    expect(session.instructionQueue[0]!.state).toBe("leased");
  });

  it("only leases current generation (expires stale)", () => {
    const session = makeSession({ activeExecutionId: "exec_new" });
    // Add a stale instruction
    session.instructionQueue.push({
      id: "stale_1", sessionId: session.id, executionId: "exec_old",
      kind: "steer", source: "tui", text: "old", bytes: 3, createdAt: Date.now(), state: "queued",
    });
    queueInstruction(session, { text: "current", source: "tui" });

    const lease = leaseInstructions(session);
    expect(lease).not.toBeNull();
    expect(lease!.instructions.length).toBe(1);
    expect(lease!.instructions[0]!.text).toBe("current");
    // Stale instruction should be expired
    expect(session.instructionQueue.find(i => i.id === "stale_1")?.state).toBe("expired");
  });

  it("filters by kind", () => {
    const session = makeSession();
    queueInstruction(session, { text: "steer", source: "tui", kind: "steer" });
    queueInstruction(session, { text: "follow", source: "tui", kind: "followUp" });

    const steerLease = leaseInstructions(session, "steer");
    expect(steerLease).not.toBeNull();
    expect(steerLease!.instructions.length).toBe(1);
    expect(steerLease!.instructions[0]!.text).toBe("steer");
  });

  it("maintains FIFO order within kind", () => {
    const session = makeSession();
    queueInstruction(session, { text: "first", source: "tui" });
    queueInstruction(session, { text: "second", source: "tui" });
    queueInstruction(session, { text: "third", source: "tui" });

    const lease = leaseInstructions(session);
    expect(lease!.instructions.map(i => i.text)).toEqual(["first", "second", "third"]);
  });
});

describe("markDelivered / markConsumed (#1444)", () => {
  it("transitions leased → delivered", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    expect(session.instructionQueue[0]!.state).toBe("delivered");
  });

  it("transitions delivered → consumed and removes from queue", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    markConsumed(lease, session);
    expect(session.instructionQueue.length).toBe(0);
  });

  it("publishes steer.consumed on markConsumed", () => {
    const events: SteerEvent[] = [];
    const unsub = onSteerEvent(e => events.push(e));
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    events.length = 0;
    markConsumed(lease, session);
    expect(events.length).toBe(1);
    expect(events[0]!.type).toBe("steer.consumed");
    unsub();
  });

  it("is idempotent on duplicate markConsumed", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    markConsumed(lease, session);
    // Second call should be no-op
    expect(() => markConsumed(lease, session)).not.toThrow();
  });
});

describe("restoreBeforeDelivery / failAfterDelivery (#1444)", () => {
  it("restores leased → queued", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    restoreBeforeDelivery(lease);
    expect(session.instructionQueue[0]!.state).toBe("queued");
    expect(session.instructionQueue.length).toBe(1);
  });

  it("fails delivered and removes from queue", () => {
    const events: SteerEvent[] = [];
    onSteerEvent(e => events.push(e));
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    failAfterDelivery(lease, session, "test_failure");
    expect(session.instructionQueue.length).toBe(0);
    expect(events.some(e => e.type === "steer.failed")).toBe(true);
  });

  it("restoreBeforeDelivery is no-op on already-delivered", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    restoreBeforeDelivery(lease); // should not change delivered state
    expect(session.instructionQueue[0]!.state).toBe("delivered");
  });

  it("failAfterDelivery is no-op on already-consumed", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    const lease = leaseInstructions(session)!;
    markDelivered(lease);
    markConsumed(lease, session);
    // Now lease instructions are consumed — fail should be no-op
    const events: SteerEvent[] = [];
    onSteerEvent(e => events.push(e));
    failAfterDelivery(lease, session, "late_fail");
    expect(events.filter(e => e.type === "steer.failed").length).toBe(0);
  });
});

describe("expireInstructions + stale generations (#1444)", () => {
  it("expireInstructions sets state and clears queue", () => {
    const session = makeSession();
    queueInstruction(session, { text: "a", source: "tui" });
    queueInstruction(session, { text: "b", source: "tui" });
    expireInstructions(session, "round_limit");
    expect(session.instructionQueue.length).toBe(0);
  });

  it("expireInstructions publishes steer.expired with original executionId", () => {
    const events: SteerEvent[] = [];
    onSteerEvent(e => events.push(e));
    const session = makeSession({ activeExecutionId: "exec_old" });
    queueInstruction(session, { text: "old_gen", source: "tui" });
    session.activeExecutionId = "exec_new";
    events.length = 0;
    expireInstructions(session, "test");
    const expired = events.filter(e => e.type === "steer.expired");
    expect(expired.length).toBe(1);
    expect(expired[0]!.executionId).toBe("exec_old");
  });

  it("leaseInstructions expires stale generations before leasing", () => {
    const events: SteerEvent[] = [];
    onSteerEvent(e => events.push(e));
    const session = makeSession({ activeExecutionId: "exec_new" });
    session.instructionQueue.push({
      id: "s1", sessionId: session.id, executionId: "exec_old",
      kind: "steer", source: "tui", text: "stale", bytes: 5, createdAt: Date.now(), state: "queued",
    });
    queueInstruction(session, { text: "fresh", source: "tui" });
    events.length = 0;
    const lease = leaseInstructions(session);
    expect(lease).not.toBeNull();
    expect(lease!.instructions.length).toBe(1);
    expect(lease!.instructions[0]!.text).toBe("fresh");
    const failed = events.filter(e => e.type === "steer.failed");
    expect(failed.length).toBe(1);
    expect(failed[0]!.executionId).toBe("exec_old");
  });
});

describe("followUp kind support (#1444)", () => {
  it("queues and leases followUp independently from steer", () => {
    const session = makeSession();
    queueInstruction(session, { text: "steer_1", source: "tui", kind: "steer" });
    queueInstruction(session, { text: "follow_1", source: "tui", kind: "followUp" });

    const steerLease = leaseInstructions(session, "steer");
    expect(steerLease).not.toBeNull();
    expect(steerLease!.instructions.length).toBe(1);
    expect(steerLease!.instructions[0]!.text).toBe("steer_1");

    const followLease = leaseInstructions(session, "followUp");
    expect(followLease).not.toBeNull();
    expect(followLease!.instructions.length).toBe(1);
    expect(followLease!.instructions[0]!.text).toBe("follow_1");
  });
});

describe("concurrent session isolation (#1444)", () => {
  it("leases from one session do not affect another", () => {
    const sessionA = makeSession({ id: "sess_A", activeExecutionId: "exec_A" });
    const sessionB = makeSession({ id: "sess_B", activeExecutionId: "exec_B" });

    queueInstruction(sessionA, { text: "for A", source: "tui" });
    queueInstruction(sessionB, { text: "for B", source: "tui" });

    const leaseA = leaseInstructions(sessionA);
    expect(leaseA).not.toBeNull();
    expect(leaseA!.instructions[0]!.text).toBe("for A");
    expect(sessionB.instructionQueue[0]!.state).toBe("queued");
  });
});
