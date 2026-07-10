import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ManagedSession, QueuedSessionInstruction } from "./spin-types.js";
import { queueInstruction, drainInstructionBatch, expireInstructions, onSteerEvent } from "./session-instruction-queue.js";

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

    it("rejects non-Orc sessions with not_orc", () => {
      const session = makeOrcSession({ id: "1749563282_A_01" });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_orc");
    });

    it("rejects when Orc is not busy with not_busy", () => {
      const session = makeOrcSession({ busy: false });
      const result = queueInstruction(session, { text: "hello", source: "tui" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not_busy");
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
});
