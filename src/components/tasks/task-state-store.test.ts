import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let home: string;
let store: typeof import("./task-state-store.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-state-store-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  store = await import("./task-state-store.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("initializeState legacy repair", () => {
  it("preserves a valid incident while clearing incoherent auto-pause", () => {
    writeFileSync(join(home, "tasks", "task-state.json"), JSON.stringify({
      task: {
        nextRunAt: null,
        consecutiveFailures: 0,
        consecutiveDeferrals: 0,
        autoPaused: true,
        pausedAt: 123,
        lastIncident: {
          version: 1,
          category: "execution",
          code: "model_error",
          phase: "executing",
          message: "provider failed",
          retryability: "none",
          occurredAt: 122,
        },
      },
    }));

    store.initializeState([{
      id: "task", kind: "agent", prompt: "p", agent: "task", interaction: { mode: "oneshot" },
      delivery: "silent", enabled: true, priority: "medium", at: new Date().toISOString(),
    }]);

    const repaired = store.readState("task")!;
    expect(repaired.autoPaused).toBe(false);
    expect(repaired.lastIncident?.code).toBe("model_error");
  });
});

describe("advanceRun #1539 monotonic progression", () => {
  function seedRun(runId = "run-1", phase: any = "reserved", deadlineAt = Date.now() + 60_000): void {
    const result = store.reserveRun("task", {
      runId,
      groupId: "g-1",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: Date.now(),
      deadlineAt,
    });
    if (!result.ok) throw new Error("seed conflict");
    store.updateState("task", {
      activeRun: { ...result.run, phase },
    });
  }

  it("follows the legal phase sequence and rejects regression", () => {
    seedRun("run-seq", "reserved");
    expect(store.advanceRun("task", "run-seq", { phase: "queued" })).toBe("advanced");
    expect(store.advanceRun("task", "run-seq", { phase: "executing", progressAt: Date.now() + 1000 })).toBe("advanced");
    expect(store.advanceRun("task", "run-seq", { phase: "validating" })).toBe("advanced");
    // A run never transitions from executing back to queued.
    expect(store.advanceRun("task", "run-seq", { phase: "queued" })).toBe("regression");
    expect(store.readState("task")!.activeRun!.phase).toBe("validating");
  });

  it("rejects any phase write once the run is cancelling", () => {
    seedRun("run-cancel", "cancelling");
    expect(store.advanceRun("task", "run-cancel", { phase: "executing" })).toBe("regression");
    expect(store.advanceRun("task", "run-cancel", { phase: "delivery_pending" })).toBe("regression");
  });

  it("never decreases lastProgressAt and counts meaningful progress once", () => {
    seedRun("run-progress", "executing");
    const t1 = Date.now() + 10_000;
    const t2 = t1 + 5_000;
    expect(store.advanceRun("task", "run-progress", { progressAt: t2 })).toBe("advanced");
    expect(store.advanceRun("task", "run-progress", { progressAt: t1 })).toBe("advanced");
    const run = store.readState("task")!.activeRun!;
    expect(run.lastProgressAt).toBe(t2);
    expect(run.progressSequence).toBe(1);
    // Attachments merge without moving phase.
    expect(store.advanceRun("task", "run-progress", { attachments: { cardId: 42, executionId: "exec-1" } })).toBe("advanced");
    const updated = store.readState("task")!.activeRun!;
    expect(updated.cardId).toBe(42);
    expect(updated.executionId).toBe("exec-1");
    expect(updated.phase).toBe("executing");
    expect(updated.progressSequence).toBe(1);
  });

  it("returns stale for an unknown run ID", () => {
    seedRun("run-stale", "executing");
    expect(store.advanceRun("task", "other-run", { phase: "validating" })).toBe("stale");
    expect(store.advanceRun("missing-task", "run-stale", { phase: "validating" })).toBe("stale");
  });
});

describe("requestRunTerminal #1539 durable terminal request", () => {
  function seedRun(runId = "run-1"): void {
    const result = store.reserveRun("task", {
      runId,
      groupId: "g-1",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: Date.now(),
      deadlineAt: Date.now() + 60_000,
    });
    if (!result.ok) throw new Error("seed conflict");
  }

  it("records the first request and moves the run to cancelling", () => {
    seedRun("run-req");
    const req = { kind: "cancelled" as const, requestedAt: Date.now(), reason: "operator" };
    expect(store.requestRunTerminal("task", "run-req", req)).toBe("requested");
    const run = store.readState("task")!.activeRun!;
    expect(run.phase).toBe("cancelling");
    expect(run.terminalRequest).toEqual(req);
  });

  it("keeps cancellation recorded before a later deadline request", () => {
    seedRun("run-prio");
    store.requestRunTerminal("task", "run-prio", { kind: "cancelled", requestedAt: 1000, reason: "operator" });
    expect(store.requestRunTerminal("task", "run-prio", { kind: "deadline_exceeded", requestedAt: 2000, reason: "deadline" })).toBe("already_requested");
    expect(store.readState("task")!.activeRun!.terminalRequest!.kind).toBe("cancelled");
  });

  it("lets a deadline fill an absent request but never replace an earlier cancellation", () => {
    seedRun("run-dead");
    expect(store.requestRunTerminal("task", "run-dead", { kind: "deadline_exceeded", requestedAt: 1000, reason: "deadline" })).toBe("requested");
    expect(store.requestRunTerminal("task", "run-dead", { kind: "deadline_exceeded", requestedAt: 2000, reason: "deadline again" })).toBe("already_requested");
    // A later cancellation upgrades the deadline request.
    expect(store.requestRunTerminal("task", "run-dead", { kind: "cancelled", requestedAt: 3000, reason: "operator" })).toBe("requested");
    expect(store.readState("task")!.activeRun!.terminalRequest!.kind).toBe("cancelled");
  });

  it("returns stale for an unknown run ID", () => {
    seedRun("run-x");
    expect(store.requestRunTerminal("task", "nope", { kind: "cancelled", requestedAt: 1, reason: "x" })).toBe("stale");
  });
});
