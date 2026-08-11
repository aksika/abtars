import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

let home: string;
let board: typeof import("./kanban-board.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-state-schema-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  board = await import("./kanban-board.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const INCIDENT = {
  version: 1,
  category: "execution",
  code: "model_error",
  phase: "executing",
  message: "provider failed three times",
  retryability: "none",
  occurredAt: 1234567890,
};

const DEFERRED = {
  groupId: "g-deferred",
  occurrenceAt: 111,
  deadlineAt: 999,
  attempts: 2,
  retryAt: 555,
  diagnostic: { ...INCIDENT, code: "executor_unavailable" },
};

function realisticLegacyFile(): void {
  writeFileSync(join(home, "tasks", "task-state.json"), JSON.stringify({
    "active-task": {
      nextRunAt: 1000,
      lastStartedAt: 200,
      lastFinishedAt: 150,
      consecutiveFailures: 1,
      consecutiveDeferrals: 0,
      autoPaused: false,
      lastIncident: INCIDENT,
      activeRun: {
        runId: "active-task_run123",
        groupId: "active-task:group:42",
        attempt: 1,
        trigger: "schedule",
        occurrenceAt: 100,
        reservedAt: 110,
        deadlineAt: 1000 + 3600_000,
        phase: "executing",
        lastProgressAt: 120,
        progressSequence: 3,
        cardId: 7,
        sessionId: "sess-1",
        executionId: "exec-1",
        terminalRequest: { kind: "deadline_exceeded", requestedAt: 130, reason: "idle" },
      },
    },
    "paused-task": {
      nextRunAt: null,
      consecutiveFailures: 3,
      consecutiveDeferrals: 1,
      autoPaused: true,
      pausedAt: 500,
      priorFailure: "provider failed",
      lastIncident: INCIDENT,
    },
    "deferred-task": {
      nextRunAt: 555,
      lastStartedAt: 300,
      consecutiveFailures: 0,
      consecutiveDeferrals: 2,
      autoPaused: false,
      deferredAdmission: DEFERRED,
    },
  }));
}

describe("initTaskStateSchema #1601 migration", () => {
  it("imports every field of a realistic legacy file and renames it", () => {
    realisticLegacyFile();
    const db = board.requireTaskDatabase();

    const state = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get("active-task")!;
    expect(state.next_run_at).toBe(1000);
    expect(state.last_started_at).toBe(200);
    expect(state.last_finished_at).toBe(150);
    expect(state.consecutive_failures).toBe(1);
    expect(state.auto_paused).toBe(0);
    expect(JSON.parse(state.last_incident_json as string)).toEqual(INCIDENT);

    const run = db.prepare("SELECT * FROM task_runs WHERE run_id = ?").get("active-task_run123")!;
    expect(run.task_id).toBe("active-task");
    expect(run.group_id).toBe("active-task:group:42");
    expect(run.attempt).toBe(1);
    expect(run.trigger).toBe("schedule");
    expect(run.phase).toBe("executing");
    expect(run.last_progress_at).toBe(120);
    expect(run.progress_sequence).toBe(3);
    expect(run.card_id).toBe(7);
    expect(run.session_id).toBe("sess-1");
    expect(run.execution_id).toBe("exec-1");
    expect(JSON.parse(run.terminal_request_json as string)).toEqual({ kind: "deadline_exceeded", requestedAt: 130, reason: "idle" });
    // #1601: pre-migration runs are unprovable by design.
    expect(run.owner_pid).toBe(process.pid);
    expect(run.owner_started_at).toBeNull();
    expect(run.finished_at).toBeNull();

    const paused = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get("paused-task")!;
    expect(paused.auto_paused).toBe(1);
    expect(paused.paused_at).toBe(500);
    expect(paused.prior_failure).toBe("provider failed");
    expect(JSON.parse(paused.last_incident_json as string)).toEqual(INCIDENT);

    const deferred = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get("deferred-task")!;
    expect(JSON.parse(deferred.deferred_admission_json as string)).toEqual(DEFERRED);
    expect(deferred.consecutive_deferrals).toBe(2);

    expect(existsSync(join(home, "tasks", "task-state.json"))).toBe(false);
    expect(existsSync(join(home, "tasks", "task-state.json.migrated"))).toBe(true);
  });

  it("is a no-op on a second init", async () => {
    realisticLegacyFile();
    const db = board.requireTaskDatabase();
    const before = db.prepare("SELECT COUNT(*) AS c FROM task_runs").get()!.c as number;

    // Re-open through a second module instance (fresh connection, same file).
    vi.resetModules();
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
    const board2 = await import("./kanban-board.js");
    const db2 = board2.requireTaskDatabase();

    const after = db2.prepare("SELECT COUNT(*) AS c FROM task_runs").get()!.c as number;
    expect(after).toBe(before);
    expect(existsSync(join(home, "tasks", "task-state.json.migrated"))).toBe(true);
  });

  it("leaves tables empty and the JSON intact when the import fails mid-transaction", () => {
    // CHECK(trigger IN ...) violation on the second row rolls back the whole
    // transaction: no partial import, no rename, and the db open path survives.
    writeFileSync(join(home, "tasks", "task-state.json"), JSON.stringify({
      good: { nextRunAt: 1, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false },
      bad: {
        nextRunAt: 2, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false,
        activeRun: {
          runId: "bad-run", groupId: "g", attempt: 1, trigger: "bogus",
          occurrenceAt: 1, reservedAt: 2, deadlineAt: 3, phase: "reserved",
          lastProgressAt: 2,
        },
      },
    }));

    expect(() => board.requireTaskDatabase()).not.toThrow();
    const db = board.requireTaskDatabase();
    const taskCount = db.prepare("SELECT COUNT(*) AS c FROM task_state").get()!.c as number;
    const runCount = db.prepare("SELECT COUNT(*) AS c FROM task_runs").get()!.c as number;
    expect(taskCount).toBe(0);
    expect(runCount).toBe(0);
    expect(existsSync(join(home, "tasks", "task-state.json"))).toBe(true);
    expect(readFileSync(join(home, "tasks", "task-state.json"), "utf-8").length).toBeGreaterThan(0);
  });
});
