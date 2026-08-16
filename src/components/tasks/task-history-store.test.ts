/**
 * task-history-store.test.ts — #1568: the SQL-backed task run history store.
 *
 * Query behavior, atomic append-once uniqueness (sequential and across two
 * independent connections), one-time legacy JSONL migration, and bounded
 * retention are all proven against real SQLite databases in isolated homes.
 * Each test loads fresh module instances (fresh kanban-board singleton →
 * fresh connection) against its own temporary home, mirroring the
 * task-state-cas.test.ts cross-process harness. The database-failure
 * propagation test lives in task-history-store-errors.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { Mock } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import type { TaskRunEvent, TaskOutcome } from "./task-history-store.js";
import type { TaskHistoryDb } from "./task-history-schema.js";
import type { ScheduledTask } from "./task-types.js";

// The schema module is stateless (its functions take the db handle), so a
// per-test injectable prune hook is safe to mock without importActual caches
// sharing state across tests.
vi.mock("./task-history-schema.js", async () => {
  const actual = await vi.importActual<typeof import("./task-history-schema.js")>("./task-history-schema.js");
  return {
    ...actual,
    pruneTaskRunHistory: vi.fn(actual.pruneTaskRunHistory) as unknown as typeof actual.pruneTaskRunHistory,
  };
});

let home: string;
let store: typeof import("./task-history-store.js");
let schema: typeof import("./task-history-schema.js");
let stateStore: typeof import("./task-state-store.js");
let board: typeof import("./kanban-board.js");

function pruneMock(): Mock {
  return schema.pruneTaskRunHistory as unknown as Mock;
}

/** Fresh module instances (fresh kanban-board singleton → fresh DB connection)
 * against the same home. */
async function loadStore(): Promise<typeof import("./task-history-store.js")> {
  vi.resetModules();
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  const s = await import("./task-history-store.js");
  board = await import("./kanban-board.js");
  return s;
}

function makeEvent(runId: string, taskId = "task", outcome: TaskOutcome = "success"): TaskRunEvent {
  const now = Date.now();
  return {
    runId,
    taskId,
    kind: "script",
    trigger: "schedule",
    startedAt: now - 1000,
    finishedAt: now,
    outcome,
  };
}

function db(): import("./kanban-board.js").TaskDatabase {
  return board.requireTaskDatabase();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "task-history-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  store = await loadStore();
  schema = await import("./task-history-schema.js");
  stateStore = await import("./task-state-store.js");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

// ── Reads (#1568 Task 2) ─────────────────────────────────────────────────────

describe("task_run_history reads", () => {
  it("recentRuns returns only the newest n matching events among thousands of distracting rows", () => {
    const now = Date.now();
    const insert = db().prepare(schema.INSERT_TASK_RUN_HISTORY);
    for (let i = 0; i < 5000; i++) {
      insert.run(...schema.eventToRow({
        ...makeEvent(`distract-${i}`, `other-${i % 100}`),
        finishedAt: now - i,
        startedAt: now - i,
      }));
    }
    for (let i = 0; i < 50; i++) {
      store.appendRun({
        ...makeEvent(`target-${i}`, "target-task", i % 2 === 0 ? "success" : "failed"),
        finishedAt: now - i,
        startedAt: now - i,
      });
    }
    const runs = store.recentRuns("target-task", 5);
    expect(runs).toHaveLength(5);
    expect(runs.map(r => r.runId)).toEqual(["target-0", "target-1", "target-2", "target-3", "target-4"]);
    expect(runs[0]!.outcome).toBe("success");
  }, 15_000);

  it("equal finishedAt values use the deterministic run_id tie-breaker", () => {
    const now = Date.now();
    for (const runId of ["tie-a", "tie-b", "tie-c"]) {
      store.appendRun({ ...makeEvent(runId, "tie-task"), finishedAt: now, startedAt: now });
    }
    expect(store.recentRuns("tie-task", 10).map(r => r.runId)).toEqual(["tie-c", "tie-b", "tie-a"]);
  });

  it("normalizes limits: zero and negative return [], fractional truncates, non-finite uses 10, oversized caps at 100", () => {
    for (let i = 0; i < 25; i++) {
      store.appendRun(makeEvent(`lim-${i}`));
    }
    expect(store.recentRuns("task", 0)).toEqual([]);
    expect(store.recentRuns("task", -3)).toEqual([]);
    expect(store.recentRuns("task", 2.9)).toHaveLength(2);
    expect(store.recentRuns("task", Number.NaN)).toHaveLength(10);
    expect(store.recentRuns("task", Number.POSITIVE_INFINITY)).toHaveLength(10);
    expect(store.recentRuns("task", 10_000)).toHaveLength(25);
  });

  it("round-trips every optional field through the live write and exact-ID reads", () => {
    const now = Date.now();
    const full: TaskRunEvent = {
      runId: "live-full",
      taskId: "full-task",
      kind: "agent",
      trigger: "manual",
      startedAt: now - 1000,
      finishedAt: now,
      outcome: "failed",
      exitCode: 2,
      detail: "detail text",
      deliveryText: "delivery text",
      resultPath: "/artifacts/r.md",
      kanbanCardId: 42,
      groupId: "g-42",
      diagnostic: { version: 1, category: "execution", code: "model_error", phase: "executing", message: "boom", retryability: "none", occurredAt: now },
    };
    store.appendRun(full);
    expect(store.getRun("live-full")).toEqual(full);
    expect(store.hasRun("live-full")).toBe(true);
    expect(store.hasRun("live-missing")).toBe(false);
    expect(store.getRun("live-missing")).toBeUndefined();
    const ev = store.recentRuns("full-task", 5)[0]!;
    expect(ev.diagnostic?.code).toBe("model_error");
    expect(ev.deliveryText).toBe("delivery text");
    expect(ev.kanbanCardId).toBe(42);
    expect(ev.exitCode).toBe(2);
  });

  it("todaySuccessCount counts only today's successes for the task, on the exact day boundary", () => {
    const now = Date.now();
    const todayStart = new Date(now).setHours(0, 0, 0, 0);
    store.appendRun({ ...makeEvent("today-in", "count-task", "success"), finishedAt: todayStart + 1000 });
    store.appendRun({ ...makeEvent("yesterday", "count-task", "success"), finishedAt: todayStart - 1 });
    store.appendRun({ ...makeEvent("failed-today", "count-task", "failed"), finishedAt: todayStart + 2000 });
    store.appendRun({ ...makeEvent("other-task", "other", "success"), finishedAt: todayStart + 3000 });
    expect(store.todaySuccessCount("count-task", now)).toBe(1);
    expect(store.todaySuccessCount("other", now)).toBe(1);
    expect(store.todaySuccessCount("missing", now)).toBe(0);
  });

  it("latestOutcomeByTask returns exactly one retained event per task, newest with run_id tie-break", () => {
    const now = Date.now();
    store.appendRun({ ...makeEvent("a-old", "task-a", "failed"), finishedAt: now - 5000 });
    store.appendRun({ ...makeEvent("a-new", "task-a", "success"), finishedAt: now - 1000 });
    store.appendRun({ ...makeEvent("b-only", "task-b", "success"), finishedAt: now - 3000 });
    store.appendRun({ ...makeEvent("c-tie-a", "task-c", "success"), finishedAt: now - 2000 });
    store.appendRun({ ...makeEvent("c-tie-b", "task-c", "failed"), finishedAt: now - 2000 });
    const latest = store.latestOutcomeByTask(now);
    expect(latest.size).toBe(3);
    expect(latest.get("task-a")!.runId).toBe("a-new");
    expect(latest.get("task-a")!.outcome).toBe("success");
    expect(latest.get("task-b")!.runId).toBe("b-only");
    expect(latest.get("task-c")!.runId).toBe("c-tie-b");
  });
});

// ── Append-once (#1568 Task 2/3) ─────────────────────────────────────────────

describe("append-once atomicity", () => {
  it("a duplicate returns null and never alters the first event", () => {
    const first: TaskRunEvent = {
      ...makeEvent("once-run", "once-task", "success"),
      detail: "winner payload",
      deliveryText: "winner delivery",
    };
    expect(store.appendRunOnce(first)).toBe("once-run");
    expect(store.appendRunOnce({ ...first, detail: "loser payload" })).toBeNull();
    expect(store.getRun("once-run")).toEqual(first);
  });

  it("appendRun is idempotent for an explicit duplicate run ID", () => {
    expect(store.appendRun(makeEvent("idem-run", "idem-task"))).toBe("idem-run");
    expect(store.appendRun(makeEvent("idem-run", "idem-task"))).toBe("idem-run");
    expect(store.recentRuns("idem-task", 10).filter(r => r.runId === "idem-run")).toHaveLength(1);
  });

  it("two independent connections racing the same runId produce exactly one row and one null", async () => {
    const connA = await loadStore();
    const connB = await loadStore();
    const event = makeEvent("race-run", "race-task", "success");
    const a = connA.appendRunOnce(event);
    const b = connB.appendRunOnce(event);
    expect([a, b]).toEqual(expect.arrayContaining(["race-run", null]));
    const viaA = connA.recentRuns("race-task", 10);
    const viaB = connB.recentRuns("race-task", 10);
    expect(viaA).toHaveLength(1);
    expect(viaA[0]!.runId).toBe("race-run");
    expect(viaA[0]!.taskId).toBe("race-task");
    expect(viaA[0]!.outcome).toBe("success");
    expect(viaA).toEqual(viaB);
  });
});

// ── Migration (#1568 Task 1) ─────────────────────────────────────────────────

describe("legacy task-history.jsonl migration", () => {
  function jsonlPath(): string {
    return join(home, "tasks", "task-history.jsonl");
  }

  it("imports every field, skips malformed/truncated lines, keeps the first duplicate, and renames after commit", () => {
    const now = Date.now();
    const full: TaskRunEvent = {
      runId: "run-full",
      taskId: "report-task",
      kind: "agent",
      trigger: "retry",
      startedAt: now - 1000,
      finishedAt: now,
      outcome: "failed",
      exitCode: 2,
      detail: "d",
      deliveryText: "dt",
      resultPath: "/p",
      kanbanCardId: 7,
      groupId: "g",
      diagnostic: { version: 1, category: "execution", code: "model_error", phase: "executing", message: "m", retryability: "none", occurredAt: now },
    };
    const dupA = makeEvent("dup", "t1", "success");
    const dupB = { ...makeEvent("dup", "t2", "failed"), startedAt: 3, finishedAt: 4 };
    writeFileSync(jsonlPath(), [
      JSON.stringify(full),
      JSON.stringify(dupA),
      JSON.stringify(dupB),
      "not-json",
      "",
      JSON.stringify({ runId: "no-outcome", taskId: "t3", kind: "script", trigger: "schedule", startedAt: 1, finishedAt: 2 }),
      '{"runId":"truncated-final"',
    ].join("\n"));

    // First API call opens the shared database and migrates.
    expect(store.getRun("run-full")).toEqual(full);
    expect(store.getRun("dup")!.taskId).toBe("t1"); // first valid row wins
    expect(store.getRun("dup")!.outcome).toBe("success");
    expect(store.getRun("truncated-final")).toBeUndefined();
    expect(store.getRun("no-outcome")).toBeUndefined();
    expect(store.recentRuns("t2", 5)).toHaveLength(0);

    expect(existsSync(jsonlPath())).toBe(false);
    expect(existsSync(jsonlPath() + ".migrated")).toBe(true);
    // The backup preserves every original byte for manual inspection.
    expect(readFileSync(jsonlPath() + ".migrated", "utf-8")).toContain("not-json");
  });

  it("a second initialization after a crash-between-commit-and-rename imports no duplicates", async () => {
    writeFileSync(jsonlPath(), [
      JSON.stringify(makeEvent("crash-1", "crash-task", "success")),
      JSON.stringify(makeEvent("crash-2", "crash-task", "failed")),
    ].join("\n"));
    store = await loadStore();
    expect(store.getRun("crash-1")).toBeDefined();
    expect(existsSync(jsonlPath() + ".migrated")).toBe(true);

    // Crash after commit but before rename: restore the source, reopen.
    const backedUp = readFileSync(jsonlPath() + ".migrated", "utf-8");
    rmSync(jsonlPath() + ".migrated");
    writeFileSync(jsonlPath(), backedUp);
    store = await loadStore();
    expect(store.getRun("crash-1")).toBeDefined();
    expect(store.recentRuns("crash-task", 10)).toHaveLength(2);
    expect(existsSync(jsonlPath())).toBe(false);
    expect(existsSync(jsonlPath() + ".migrated")).toBe(true);
  });

  it("an existing .migrated backup is never overwritten; the next suffix is used", async () => {
    writeFileSync(jsonlPath(), JSON.stringify(makeEvent("suf-1", "suf-task")));
    store = await loadStore();
    expect(store.getRun("suf-1")).toBeDefined();
    expect(existsSync(jsonlPath() + ".migrated")).toBe(true);

    // A second upgrade-generation file arrives while the first backup exists.
    const firstBackup = readFileSync(jsonlPath() + ".migrated", "utf-8");
    writeFileSync(jsonlPath(), JSON.stringify(makeEvent("suf-2", "suf-task")));
    store = await loadStore();
    expect(store.getRun("suf-2")).toBeDefined();
    expect(readFileSync(jsonlPath() + ".migrated", "utf-8")).toBe(firstBackup);
    expect(existsSync(jsonlPath() + ".migrated.1")).toBe(true);
    expect(readFileSync(jsonlPath() + ".migrated.1", "utf-8")).toContain("suf-2");
    expect(existsSync(jsonlPath())).toBe(false);
  });

  it("a failed rename leaves the source in place and the rows imported; the next open retries", async () => {
    writeFileSync(jsonlPath(), JSON.stringify(makeEvent("ren-1", "ren-task")));
    // A read-only tasks directory makes the post-commit rename fail.
    chmodSync(join(home, "tasks"), 0o555);
    try {
      store = await loadStore();
      expect(store.getRun("ren-1")).toBeDefined();
      expect(existsSync(jsonlPath())).toBe(true); // original untouched
    } finally {
      chmodSync(join(home, "tasks"), 0o700);
    }

    store = await loadStore();
    expect(store.recentRuns("ren-task", 10)).toHaveLength(1); // triggers re-init + rename
    expect(existsSync(jsonlPath())).toBe(false);
    expect(existsSync(jsonlPath() + ".migrated")).toBe(true);
  });

  it("a transaction failure rolls back the import, leaves the source intact, and a clean retry succeeds", async () => {
    const { resolveNativeDep } = await import("../../utils/lazy-require.js");
    const Database = resolveNativeDep("better-sqlite3") as new (p: string) => {
      prepare(sql: string): { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): unknown[] };
      exec(sql: string): void;
      transaction<T>(fn: () => T): () => T;
      close(): void;
    };
    mkdirSync(join(home, "kanban"), { recursive: true });
    const raw = new Database(join(home, "kanban", "kanban.db"));
    try {
      const wrapped = board.wrapTaskDatabase(raw);
      const stateSchema = await import("./task-state-schema.js");
      stateSchema.initTaskStateSchema(wrapped);
      writeFileSync(jsonlPath(), [
        JSON.stringify(makeEvent("tx-1", "tx-task", "success")),
        JSON.stringify(makeEvent("tx-2", "tx-task", "failed")),
      ].join("\n"));

      let failNextInsert = false;
      const failing: TaskHistoryDb = {
        ...wrapped,
        prepare(sql: string) {
          const stmt = wrapped.prepare(sql);
          return {
            ...stmt,
            run: (...params: unknown[]) => {
              if (failNextInsert && sql.includes("INSERT OR IGNORE INTO task_run_history")) {
                failNextInsert = false;
                throw new Error("forced insert failure");
              }
              return stmt.run(...params);
            },
          };
        },
      };

      failNextInsert = true;
      expect(() => schema.initTaskHistorySchema(failing)).not.toThrow();
      expect(existsSync(jsonlPath())).toBe(true);
      expect(wrapped.prepare("SELECT COUNT(*) AS n FROM task_run_history").get()).toEqual({ n: 0 });

      // The next open safely repeats the import and renames.
      schema.initTaskHistorySchema(wrapped);
      expect(wrapped.prepare("SELECT COUNT(*) AS n FROM task_run_history").get()).toEqual({ n: 2 });
      expect(existsSync(jsonlPath())).toBe(false);
      expect(existsSync(jsonlPath() + ".migrated")).toBe(true);
    } finally {
      raw.close();
    }
  });

  it("an empty legacy file is left in place and imports nothing", async () => {
    writeFileSync(jsonlPath(), "");
    await loadStore();
    expect(store.recentRuns("task", 5)).toEqual([]);
    expect(existsSync(jsonlPath())).toBe(true);
    expect(existsSync(jsonlPath() + ".migrated")).toBe(false);
  });
});

// ── Retention (#1568 Task 4) ─────────────────────────────────────────────────

describe("pruneTaskRunHistory retention", () => {
  const DAY = 86_400_000;

  function bulkSeed(count: number, prefix: string, baseFinishedAt: number): void {
    const insert = db().prepare(schema.INSERT_TASK_RUN_HISTORY);
    for (let i = 0; i < count; i++) {
      insert.run(...schema.eventToRow({
        ...makeEvent(`${prefix}-${i}`, `${prefix}-task`),
        finishedAt: baseFinishedAt - i,
        startedAt: baseFinishedAt - i,
      }));
    }
  }

  it("appendRun prunes the old row it just inserted (write-driven retention)", () => {
    // The winning writer owns cleanup: an insert of an already-expired event
    // is removed by the same call's post-insert prune.
    store.appendRun({ ...makeEvent("write-old", "write-task"), finishedAt: Date.now() - 95 * DAY, startedAt: Date.now() - 95 * DAY });
    expect(store.getRun("write-old")).toBeUndefined();
    store.appendRun(makeEvent("write-recent", "write-task"));
    expect(store.getRun("write-recent")).toBeDefined();
  });

  it("removes rows older than 90 days, keeps the exact boundary and recent rows", () => {
    const now = Date.now();
    const insert = db().prepare(schema.INSERT_TASK_RUN_HISTORY);
    for (const e of [
      { ...makeEvent("old-1", "age-task"), finishedAt: now - 91 * DAY, startedAt: now - 91 * DAY },
      { ...makeEvent("old-2", "age-task"), finishedAt: now - 95 * DAY, startedAt: now - 95 * DAY },
      { ...makeEvent("boundary", "age-task"), finishedAt: now - 90 * DAY, startedAt: now - 90 * DAY },
      { ...makeEvent("recent", "age-task"), finishedAt: now - 1000, startedAt: now - 1000 },
    ]) {
      insert.run(...schema.eventToRow(e));
    }
    const result = schema.pruneTaskRunHistory(db(), now);
    expect(result).toEqual({ expired: 2, overflow: 0 });
    expect(store.getRun("old-1")).toBeUndefined();
    expect(store.getRun("old-2")).toBeUndefined();
    expect(store.getRun("boundary")).toBeDefined();
    expect(store.getRun("recent")).toBeDefined();
  });

  it("deletes exactly the oldest excess above 10,000, deterministically with run_id tie-break", () => {
    const now = Date.now();
    // 10,000 distinct-age rows plus a five-row tied oldest block = 10,005.
    bulkSeed(10_000, "ov", now);
    const insert = db().prepare(schema.INSERT_TASK_RUN_HISTORY);
    for (let i = 0; i < 5; i++) {
      insert.run(...schema.eventToRow({
        ...makeEvent(`ov-${10_000 + i}`, "ov-task"),
        finishedAt: now - 10_000,
        startedAt: now - 10_000,
      }));
    }
    const result = schema.pruneTaskRunHistory(db(), now);
    expect(result.expired).toBe(0);
    expect(result.overflow).toBe(5);
    // The oldest eligible rows are the tied block, removed in run_id ASC order.
    expect(store.getRun("ov-10000")).toBeUndefined();
    expect(store.getRun("ov-10001")).toBeUndefined();
    expect(store.getRun("ov-10004")).toBeUndefined();
    expect(store.getRun("ov-9999")).toBeDefined();
    expect(db().prepare("SELECT COUNT(*) AS n FROM task_run_history").get()).toEqual({ n: 10_000 });
  }, 30_000);

  it("never prunes history for an unfinished reservation, then removes it once settled", () => {
    const now = Date.now();
    const res = stateStore.reserveRun("prot-task", {
      runId: "prot-old", groupId: "g-prot", attempt: 1, trigger: "schedule",
      occurrenceAt: now, deadlineAt: now + 60_000,
    });
    expect(res.ok).toBe(true);
    store.appendRun({ ...makeEvent("prot-old", "prot-task"), finishedAt: now, startedAt: now });
    db().prepare("UPDATE task_run_history SET finished_at = ? WHERE run_id = ?").run(now - 91 * DAY, "prot-old");
    bulkSeed(10_005, "pressure", now);

    const first = schema.pruneTaskRunHistory(db(), now);
    expect(first.expired).toBe(0);
    expect(first.overflow).toBe(5);
    expect(store.getRun("prot-old")).toBeDefined();

    // Once the reservation settles, the same old row becomes an age victim.
    db().prepare("UPDATE task_runs SET finished_at = ? WHERE run_id = ?").run(now, "prot-old");
    const second = schema.pruneTaskRunHistory(db(), now);
    expect(second.expired).toBe(1);
    expect(second.overflow).toBe(0);
    expect(store.getRun("prot-old")).toBeUndefined();
  }, 30_000);

  it("keeps the protected old event available for settlement repair after pruning", () => {
    const now = Date.now();
    const entry: ScheduledTask = {
      id: "repair-task", kind: "script", command: "true", schedule: "0 9 * * *",
      enabled: true, priority: "medium", delivery: "silent",
    };
    const res = stateStore.reserveRun("repair-task", {
      runId: "repair-old", groupId: "g-repair", attempt: 1, trigger: "schedule",
      occurrenceAt: now, deadlineAt: now + 60_000,
    });
    if (!res.ok) throw new Error("seed conflict");
    store.appendRun({ ...makeEvent("repair-old", "repair-task"), detail: "pre-crash result", finishedAt: now, startedAt: now });
    db().prepare("UPDATE task_run_history SET finished_at = ? WHERE run_id = ?").run(now - 91 * DAY, "repair-old");
    bulkSeed(10_005, "pr", now);

    schema.pruneTaskRunHistory(db(), now);
    expect(store.getRun("repair-old")).toBeDefined();

    // Crash recovery: the surviving history row repairs the interrupted settlement.
    const event = store.getRun("repair-old")!;
    expect(event.detail).toBe("pre-crash result");
    const run = stateStore.readState("repair-task")!.activeRun!;
    return import("./task-run-settler.js").then(settler => {
      expect(settler.settleRunFromHistory(entry, run, event)).toBe(true);
      expect(stateStore.readState("repair-task")!.activeRun).toBeUndefined();
    });
  }, 30_000);

  it("a cleanup failure after a committed insert never changes the insert result", () => {
    const mock = pruneMock();
    mock.mockImplementation(() => {
      throw new Error("prune boom");
    });
    try {
      const result = store.appendRunOnce(makeEvent("prune-ok", "prune-task"));
      expect(result).toBe("prune-ok");
      expect(store.getRun("prune-ok")).toBeDefined();
      // A retry sees a truthful duplicate, not a second row.
      expect(store.appendRunOnce(makeEvent("prune-ok", "prune-task"))).toBeNull();
      expect(store.recentRuns("prune-task", 10)).toHaveLength(1);
    } finally {
      mock.mockRestore();
    }
  });
});
