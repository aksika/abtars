import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as liveness from "./run-liveness.js";

vi.mock("../nerve.js", () => ({ nerve: { on: vi.fn(), off: vi.fn(), fire: vi.fn() } }));
vi.mock("./task-log-ctx.js", () => ({ logTaskDebug: vi.fn(), logTaskTrace: vi.fn() }));
vi.mock("./system-task-registry.js", () => ({ getSystemTaskRegistry: () => ({ dispatch: vi.fn() }) }));
vi.mock("./scheduled-task-runner.js", () => ({ ScheduledTaskRunner: class {} }));
vi.mock("./task-failure-buffer.js", () => ({ addTaskFailure: vi.fn() }));
vi.mock("../spin.js", () => ({ spin: { executionSupervisor: { get: vi.fn() } } }));
vi.mock("./due-sources.js", () => ({ settleExpiredRun: vi.fn() }));

let home: string;
let store: typeof import("./task-state-store.js");
let settler: typeof import("./task-run-settler.js");
let coordinatorMod: typeof import("./scheduled-run-coordinator.js");
let board: typeof import("./kanban-board.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-unknown-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  store = await import("./task-state-store.js");
  settler = await import("./task-run-settler.js");
  coordinatorMod = await import("./scheduled-run-coordinator.js");
  board = await import("./kanban-board.js");
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function makeEntry(id = "task"): Parameters<typeof settler.settleRunOnce>[0]["entry"] {
  return {
    id,
    kind: "script",
    command: "true",
    schedule: "0 9 * * *",
    enabled: true,
    priority: "medium",
    delivery: "silent",
  } as Parameters<typeof settler.settleRunOnce>[0]["entry"];
}

/** The shared kanban database, opened through the mocked home. */
function boardDb(): ReturnType<typeof board.requireTaskDatabase> {
  return board.requireTaskDatabase();
}

function reserveFutureRun(taskId: string, runId: string): import("./task-state-store.js").ActiveTaskRun {
  const res = store.reserveRun(taskId, {
    runId,
    groupId: `g:${runId}`,
    attempt: 1,
    trigger: "schedule",
    occurrenceAt: Date.now(),
    deadlineAt: Date.now() + 3600_000,
  });
  if (!res.ok) throw new Error("seed conflict");
  return res.run;
}

describe("settleRunOnce with `unknown` #1601", () => {
  it("settles as unknown without counting a failure or auto-pausing", () => {
    const run = reserveFutureRun("task", "run-unknown");
    const result = settler.settleRunOnce({
      entry: makeEntry(),
      run,
      outcome: "unknown",
      diagnostic: { version: 1, category: "interruption", code: "owner_lost", phase: "executing", message: "owner lost", retryability: "transient", occurredAt: Date.now() },
    });
    expect(result).toBe("settled");

    const state = store.readState("task")!;
    expect(state.activeRun).toBeUndefined();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.consecutiveDeferrals).toBe(0);
    expect(state.autoPaused).toBe(false);
    expect(state.lastIncident?.code).toBe("owner_lost");
    expect(state.lastFinishedAt).toBeGreaterThan(0);
    expect(state.nextRunAt).toBeGreaterThan(Date.now());
  });

  it("writes the durable terminal outcome on the run row", () => {
    const run = reserveFutureRun("task", "run-outcome");
    settler.settleRunOnce({ entry: makeEntry(), run, outcome: "unknown" });
    const row = boardDb().prepare("SELECT outcome FROM task_runs WHERE run_id = ?").get(run.runId) as { outcome: string | null };
    expect(row.outcome).toBe("unknown");
  });

  it("does not fire the failure cascade for an unknown outcome", () => {
    const run = reserveFutureRun("task", "run-cascade");
    const onFailure = vi.fn();
    settler.settleRunOnce({ entry: makeEntry(), run, outcome: "unknown", onFailure });
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("a manual trigger reports only its own outcome and never advances the schedule", () => {
    const res = store.reserveRun("task", {
      runId: "run-manual", groupId: "g:run-manual", attempt: 1, trigger: "manual",
      occurrenceAt: Date.now(), deadlineAt: Date.now() + 3600_000,
    });
    if (!res.ok) throw new Error("seed conflict");
    settler.settleRunOnce({ entry: makeEntry(), run: res.run, outcome: "unknown" });
    const state = store.readState("task")!;
    expect(state.activeRun).toBeUndefined();
    expect(state.nextRunAt).toBeNull();
    expect(state.lastIncident?.code).toBe("owner_lost");
  });

  it("terminates the owning card with the owner_lost message instead of orphaning it", () => {
    const run = reserveFutureRun("task", "run-card");
    const cardId = boardDb().prepare("INSERT INTO kanban_board (title, source, status) VALUES ('p', 'task', 'running')").run().lastInsertRowid as number;
    settler.settleRunOnce({ entry: makeEntry(), run, outcome: "unknown", cardId });
    const card = boardDb().prepare("SELECT status, error FROM kanban_board WHERE id = ?").get(cardId) as { status: string; error: string | null };
    expect(card.status).toBe("failed");
    expect(card.error).toContain("owner_lost");
  });

  it("frees the reservation so the task can be admitted again", () => {
    const run = reserveFutureRun("task", "run-again");
    settler.settleRunOnce({ entry: makeEntry(), run, outcome: "unknown" });
    const next = store.reserveRun("task", {
      runId: "run-after", groupId: "g:run-after", attempt: 1, trigger: "schedule",
      occurrenceAt: Date.now(), deadlineAt: Date.now() + 3600_000,
    });
    expect(next.ok).toBe(true);
  });
});

describe("coordinator.recover() liveness pass #1601", () => {
  it("recovers a provably-dead owner (falsified start time) as unknown, never failed", async () => {
    const run = reserveFutureRun("task", "run-dead-ts");
    // Falsify owner_started_at: pid still exists, start time mismatches.
    board.requireTaskDatabase().prepare(
      "UPDATE task_runs SET owner_started_at = ? WHERE run_id = ?",
    ).run((liveness.currentProcessStartTime() ?? 0) + 1, run.runId);

    const coordinator = new coordinatorMod.ScheduledRunCoordinator();
    await coordinator.recover([makeEntry()]);

    expect(store.readState("task")!.activeRun).toBeUndefined();
    const history = await import("./task-history-store.js");
    expect(history.getRun(run.runId)!.outcome).toBe("unknown");
  });

  it("recovers a provably-dead owner (nonexistent pid) as unknown", async () => {
    const run = reserveFutureRun("task", "run-dead-pid");
    board.requireTaskDatabase().prepare(
      "UPDATE task_runs SET owner_pid = ? WHERE run_id = ?",
    ).run(2147483647, run.runId);

    const coordinator = new coordinatorMod.ScheduledRunCoordinator();
    await coordinator.recover([makeEntry()]);

    expect(store.readState("task")!.activeRun).toBeUndefined();
    const history = await import("./task-history-store.js");
    expect(history.getRun(run.runId)!.outcome).toBe("unknown");
  });

  it("leaves an unprovable owner (owner_started_at NULL) untouched", async () => {
    const run = reserveFutureRun("task", "run-unprovable");
    board.requireTaskDatabase().prepare(
      "UPDATE task_runs SET owner_started_at = NULL WHERE run_id = ?",
    ).run(run.runId);

    const coordinator = new coordinatorMod.ScheduledRunCoordinator();
    await coordinator.recover([makeEntry()]);

    expect(store.readState("task")!.activeRun!.runId).toBe("run-unprovable");
  });

  it("leaves a live owner untouched", async () => {
    const run = reserveFutureRun("task", "run-live");
    board.requireTaskDatabase().prepare(
      "UPDATE task_runs SET owner_started_at = ? WHERE run_id = ?",
    ).run(liveness.currentProcessStartTime(), run.runId);

    const coordinator = new coordinatorMod.ScheduledRunCoordinator();
    await coordinator.recover([makeEntry()]);

    expect(store.readState("task")!.activeRun!.runId).toBe("run-live");
  });
});
