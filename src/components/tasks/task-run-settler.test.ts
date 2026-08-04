import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ScheduledTask } from "./task-types.js";
import type { TaskRuntimeState } from "./task-state-store.js";
import type { TerminalOutcome } from "./task-run-settler.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

let home: string;
let store: typeof import("./task-state-store.js");
let settle: typeof import("./task-run-settler.js");
let failure: typeof import("./task-failure.js");

beforeEach(async () => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "task-settler-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => home }));
  store = await import("./task-state-store.js");
  settle = await import("./task-run-settler.js");
  failure = await import("./task-failure.js");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const ENTRY: ScheduledTask = {
  id: "finance-daily",
  kind: "script",
  command: "finance report",
  schedule: "0 10 * * *",
  enabled: true,
  priority: "medium",
  delivery: "silent",
};

const NOW = Date.now();
const SEED_NEXT_RUN = NOW + 3_600_000;
const SEED_GROUP = "sched-g-42";
const OCCURRENCE_AT = NOW + 60_000;
const DEADLINE_AT = NOW + 10 * 60_000;

// A deferred occurrence already mid-re-admission: a manual run must continue
// the bounded deferral, not start over from attempt 1.
const SEED_DEFERRAL: TaskRuntimeState["deferredAdmission"] = {
  groupId: "g-manual-defer",
  occurrenceAt: OCCURRENCE_AT,
  deadlineAt: DEADLINE_AT,
  attempts: 2,
  retryAt: NOW + 120_000,
  diagnostic: {
    version: 1,
    category: "admission",
    code: "executor_unavailable",
    phase: "queued",
    message: "earlier deferral",
    retryability: "transient",
    occurredAt: NOW,
  },
};

interface SettleCase {
  name: string;
  trigger: "schedule" | "manual";
  runId: string;
  seed: Partial<TaskRuntimeState>;
  outcome: TerminalOutcome;
  makeDiagnostic: () => TaskFailureDiagnosticV1;
  expectState: (state: TaskRuntimeState) => void;
}

const CASES: SettleCase[] = [
  {
    // Regression for #1525: a manual failure applied the scheduled failure
    // patch — auto-paused, consumed the streak, advanced nextRunAt, dropped
    // the pending retry group. It must now record only its own incident.
    name: "a manual failure does not mutate scheduled policy",
    trigger: "manual",
    runId: "run-manual-fail",
    seed: { consecutiveFailures: 2, nextRunAt: SEED_NEXT_RUN, retrying: true, retryGroupId: SEED_GROUP, retryAttempt: 1 },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("execution", "model_error", "executing", "provider down", "none"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(false);
      expect(s.consecutiveFailures).toBe(2);
      expect(s.nextRunAt).toBe(SEED_NEXT_RUN);
      expect(s.retrying).toBe(true);
      expect(s.retryGroupId).toBe(SEED_GROUP);
      expect(s.lastIncident?.code).toBe("model_error");
    },
  },
  {
    // Guard against over-correcting #1525 into "manual and scheduled both skip
    // pause": a scheduled failure at the 3-streak threshold still auto-pauses.
    name: "a scheduled failure at the streak threshold still auto-pauses",
    trigger: "schedule",
    runId: "run-sched-threshold",
    seed: { consecutiveFailures: 2, nextRunAt: SEED_NEXT_RUN },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("execution", "model_error", "executing", "provider down", "none"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(true);
      expect(s.pausedAt).toBeTypeOf("number");
      expect(s.consecutiveFailures).toBe(3);
    },
  },
  {
    // #1525 deliberately excludes deferral: a manual admission deferral is the
    // same occurrence's bounded re-admission and must keep working.
    name: "a manual admission deferral still defers the same occurrence",
    trigger: "manual",
    runId: "run-manual-defer",
    seed: { deferredAdmission: SEED_DEFERRAL },
    outcome: "deferred",
    makeDiagnostic: () => failure.makeTaskFailure("admission", "executor_unavailable", "queued", "executor unavailable", "transient"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.deferredAdmission?.attempts).toBe(3);
      expect(s.deferredAdmission?.groupId).toBe("g-manual-defer");
      expect(s.nextRunAt).toBe(s.deferredAdmission?.retryAt);
      expect(s.autoPaused).toBe(false);
      expect(s.lastIncident?.code).toBe("executor_unavailable");
    },
  },
];

describe("settleRunOnce manual-run policy (#1525)", () => {
  it.each(CASES)("$name", ({ trigger, runId, seed, outcome, makeDiagnostic, expectState }) => {
    const reserved = store.reserveRun(ENTRY.id, {
      runId,
      groupId: "g-" + runId.replace("run-", ""),
      attempt: 1,
      trigger,
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE_AT,
    });
    if (!reserved.ok) throw new Error(`reserveRun failed for ${runId}`);
    store.updateState(ENTRY.id, seed);

    const settled = settle.settleRunOnce({
      entry: ENTRY,
      run: reserved.run,
      outcome,
      diagnostic: makeDiagnostic(),
    });

    expect(settled).toBe("settled");
    const state = store.readState(ENTRY.id)!;
    expectState(state);
  });
});

describe("settleRunOnce terminal normalization (#1539)", () => {
  const DEADLINE = NOW + 10 * 60_000;

  async function seedWithRequest(kind: "cancelled" | "deadline_exceeded"): Promise<{ run: import("./task-state-store.js").ActiveTaskRun }> {
    const reserved = store.reserveRun(ENTRY.id, {
      runId: "norm-" + kind,
      groupId: "g-norm",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE,
    });
    if (!reserved.ok) throw new Error("reserveRun failed");
    store.requestRunTerminal(ENTRY.id, reserved.run.runId, { kind, requestedAt: NOW, reason: kind === "cancelled" ? "operator" : "deadline fired" });
    return { run: store.readState(ENTRY.id)!.activeRun! };
  }

  it("a durable cancellation wins over a later child success or failure", async () => {
    const { run } = await seedWithRequest("cancelled");
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "late success" });
    const state = store.readState(ENTRY.id)!;
    expect(state.activeRun).toBeUndefined();
    expect(state.consecutiveFailures).toBe(0);
    // The history row records the normalized cancellation.
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("cancelled");
    expect(evs[0]!.detail).toBe("late success");
  });

  it("a child terminal fact that predates the deadline settles on its merits despite a deadline request", async () => {
    const { run } = await seedWithRequest("deadline_exceeded");
    const factAt = DEADLINE - 5000;
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "finished before deadline", factAt });
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("success");
    expect(evs[0]!.detail).toBe("finished before deadline");
    expect(store.readState(ENTRY.id)!.activeRun).toBeUndefined();
  });

  it("a late success without a fact time settles as deadline_exceeded", async () => {
    const { run } = await seedWithRequest("deadline_exceeded");
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "observed after deadline" });
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("failed");
    expect(evs[0]!.diagnostic?.category).toBe("interruption");
    expect(evs[0]!.diagnostic?.code).toBe("deadline_exceeded");
  });

  it("a child fact whose own time is after the deadline still loses to the deadline", async () => {
    const { run } = await seedWithRequest("deadline_exceeded");
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "late", factAt: DEADLINE + 1000 });
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("failed");
    expect(evs[0]!.diagnostic?.code).toBe("deadline_exceeded");
  });

  it("without a terminal request the first child terminal fact wins unchanged", async () => {
    const reserved = store.reserveRun(ENTRY.id, {
      runId: "norm-plain",
      groupId: "g-plain",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE,
    });
    if (!reserved.ok) throw new Error("reserveRun failed");
    settle.settleRunOnce({ entry: ENTRY, run: reserved.run, outcome: "success", detail: "clean" });
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("success");
  });

  it("emits exactly one terminal notification for the winning settlement", async () => {
    const { run } = await seedWithRequest("cancelled");
    const seen: Array<[string, string]> = [];
    const unsub = settle.onRunTerminal((taskId, runId) => seen.push([taskId, runId]));
    try {
      settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "late" });
      settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "duplicate" });
      expect(seen).toEqual([["finance-daily", run.runId]]);
    } finally {
      unsub();
    }
  });
});
