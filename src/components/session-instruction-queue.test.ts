import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ManagedSession, QueuedSessionInstruction, SteerEvent, SteerEventType } from "./spin-types.js";
import { queueInstruction, drainInstructionBatch, expireInstructions, onSteerEvent, subscribeSteerEvents } from "./session-instruction-queue.js";

function makeOrcSession(overrides?: Partial<ManagedSession>): ManagedSession {
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
    activeExecutionId: "1749563282_O_01_5_1712345678000",
    steeringAccepting: true,
    ...overrides,
  };
}

describe("session-instruction-queue", () => {
  describe("queueInstruction", () => {
    it("accepts a steering instruction when Orc is busy", () => {
      const session = makeOrcSession();
      const result = queueInstruction(session, { text: "focus on the memory module", source: "tui" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.instruction.sessionId).toBe("1749563282_O_01");
        expect(result.instruction.text).toBe("focus on the memory module");
        expect(result.instruction.source).toBe("tui");
        expect(result.instruction.executionId).toBe(session.activeExecutionId);
      }
      expect(session.instructionQueue.length).toBe(1);
    });

    it("rejects when steering acceptance gate is closed", () => {
      const session = makeOrcSession({ steeringAccepting: false });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_steerable");
    });

    it("rejects hollow (remote) sessions with not_local", () => {
      const session = makeOrcSession({ peer: "remote-host", remoteSessionId: "s1" });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_local");
    });

    it("rejects ended sessions with not_active", () => {
      const session = makeOrcSession({ status: "ended" });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_active");
    });

    it("rejects paused sessions with not_active", () => {
      const session = makeOrcSession({ status: "paused" });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_active");
    });

    it("rejects when no active execution with stale_execution", () => {
      const session = makeOrcSession({ activeExecutionId: undefined });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("stale_execution");
    });

    it("rejects text over 4 KiB with too_large", () => {
      const session = makeOrcSession();
      const result = queueInstruction(session, { text: "x".repeat(5000), source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("too_large");
    });

    it("rejects when queue has 20 items with queue_full", () => {
      const session = makeOrcSession();
      for (let i = 0; i < 20; i++) {
        session.instructionQueue.push({
          id: `steer_${i}`, sessionId: session.id, executionId: session.activeExecutionId!,
          source: "tui", text: `item ${i}`, createdAt: Date.now(),
        });
      }
      const result = queueInstruction(session, { text: "one more", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("queue_full");
    });

    it("rejects when total bytes exceed 32 KiB", () => {
      const session = makeOrcSession();
      session.instructionQueue.push({
        id: "steer_big", sessionId: session.id, executionId: session.activeExecutionId!,
        source: "tui", text: "x".repeat(31000), createdAt: Date.now(),
      });
      const result = queueInstruction(session, { text: "y".repeat(2000), source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("queue_full");
    });

    it("maintains FIFO order", () => {
      const session = makeOrcSession();
      queueInstruction(session, { text: "first", source: "tui" });
      queueInstruction(session, { text: "second", source: "tui" });
      queueInstruction(session, { text: "third", source: "tui" });
      expect(session.instructionQueue.map(i => i.text)).toEqual(["first", "second", "third"]);
    });

    it("publishes steer.queued event", () => {
      const events: any[] = [];
      onSteerEvent((e) => events.push(e));
      const session = makeOrcSession();
      queueInstruction(session, { text: "test", source: "tui" });
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("steer.queued");
      expect(events[0]!.instructionIds.length).toBe(1);
    });
  });

  describe("drainInstructionBatch", () => {
    it("drains all queued instructions", () => {
      const session = makeOrcSession();
      queueInstruction(session, { text: "a", source: "tui" });
      queueInstruction(session, { text: "b", source: "tui" });
      const batch = drainInstructionBatch(session);
      expect(batch.length).toBe(2);
      expect(batch[0]!.text).toBe("a");
      expect(batch[1]!.text).toBe("b");
      expect(session.instructionQueue.length).toBe(0);
    });

    it("returns empty array when nothing queued", () => {
      const session = makeOrcSession();
      expect(drainInstructionBatch(session)).toEqual([]);
    });

    it("publishes steer.consumed event", () => {
      const events: any[] = [];
      onSteerEvent((e) => events.push(e));
      const session = makeOrcSession();
      queueInstruction(session, { text: "test", source: "tui" });
      events.length = 0;
      drainInstructionBatch(session);
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("steer.consumed");
    });
  });

  describe("expireInstructions", () => {
    it("clears the queue and publishes steer.expired", () => {
      const events: any[] = [];
      onSteerEvent((e) => events.push(e));
      const session = makeOrcSession();
      queueInstruction(session, { text: "a", source: "tui" });
      queueInstruction(session, { text: "b", source: "tui" });
      events.length = 0;
      expireInstructions(session, "round_limit");
      expect(session.instructionQueue.length).toBe(0);
      expect(events.length).toBe(1);
      expect(events[0]!.type).toBe("steer.expired");
      expect(events[0]!.description).toContain("round_limit");
    });

    it("does nothing when queue is empty", () => {
      const session = makeOrcSession();
      expect(() => expireInstructions(session, "test")).not.toThrow();
    });
  });

  // ── #1362: Event identity tests ──────────────────────────────────────

  describe("subscribeSteerEvents — session/execution filters", () => {
    let unsubs: (() => void)[];

    beforeEach(() => { unsubs = []; });
    afterEach(() => { unsubs.forEach(u => u()); });

    it("delivers events only to the matching session subscriber", () => {
      const sessionA = makeOrcSession({ id: "sess_A", activeExecutionId: "exec_1" });
      const sessionB = makeOrcSession({ id: "sess_B", activeExecutionId: "exec_1" });
      const eventsA: SteerEvent[] = [];
      const eventsB: SteerEvent[] = [];
      unsubs.push(subscribeSteerEvents({ sessionId: "sess_A" }, e => eventsA.push(e)));
      unsubs.push(subscribeSteerEvents({ sessionId: "sess_B" }, e => eventsB.push(e)));

      queueInstruction(sessionA, { text: "for A", source: "tui" });
      expect(eventsA.length).toBe(1);
      expect(eventsB.length).toBe(0);
      expect(eventsA[0]!.sessionId).toBe("sess_A");
    });

    it("delivers events only to the matching execution subscriber", () => {
      const session = makeOrcSession({ id: "sess_X", activeExecutionId: "exec_1" });
      const eventsExec1: SteerEvent[] = [];
      const eventsExec2: SteerEvent[] = [];
      unsubs.push(subscribeSteerEvents({ sessionId: "sess_X", executionId: "exec_1" }, e => eventsExec1.push(e)));
      unsubs.push(subscribeSteerEvents({ sessionId: "sess_X", executionId: "exec_2" }, e => eventsExec2.push(e)));

      queueInstruction(session, { text: "gen1", source: "tui" });
      expect(eventsExec1.length).toBe(1);
      expect(eventsExec2.length).toBe(0);
    });

    it("unsubscribe isolation — stopped subscriber does not receive events", () => {
      const session = makeOrcSession({ id: "sess_U", activeExecutionId: "exec_1" });
      const events: SteerEvent[] = [];
      const unsub = subscribeSteerEvents({ sessionId: "sess_U" }, e => events.push(e));
      queueInstruction(session, { text: "first", source: "tui" });
      expect(events.length).toBe(1);
      unsub();
      queueInstruction(session, { text: "second", source: "tui" });
      // events still has the first event only
      expect(events.length).toBe(1);
    });

    it("activeExecutionId change preserves original generation in terminal events", () => {
      const events: SteerEvent[] = [];
      unsubs.push(onSteerEvent(e => events.push(e)));
      const session = makeOrcSession({ id: "sess_G", activeExecutionId: "exec_old" });

      // Queue instructions while on old generation
      queueInstruction(session, { text: "old gen", source: "tui" });
      expect(events.length).toBe(1);
      expect(events[0]!.executionId).toBe("exec_old");

      // Advance generation
      session.activeExecutionId = "exec_new";

      // Drain — old-gen instructions become stale and expire with their original generation
      events.length = 0;
      const batch = drainInstructionBatch(session);
      expect(batch.length).toBe(0);

      const expired = events.filter(e => e.type === "steer.expired");
      expect(expired.length).toBeGreaterThan(0);
      for (const e of expired) {
        expect(e.executionId).toBe("exec_old");
        expect(e.sessionId).toBe("sess_G");
      }
    });

    it("expireInstructions preserves original execution generation after generation advance", () => {
      const events: SteerEvent[] = [];
      unsubs.push(onSteerEvent(e => events.push(e)));
      const session = makeOrcSession({ id: "sess_E", activeExecutionId: "exec_old" });

      queueInstruction(session, { text: "gen1", source: "tui" });
      queueInstruction(session, { text: "gen2", source: "tui" });

      // Advance generation
      session.activeExecutionId = "exec_new";

      events.length = 0;
      expireInstructions(session, "round_limit");

      const expired = events.filter(e => e.type === "steer.expired");
      expect(expired.length).toBe(1);
      for (const e of expired) {
        expect(e.executionId).toBe("exec_old");
        expect(e.instructionIds.length).toBe(2);
      }
    });
  });
});
