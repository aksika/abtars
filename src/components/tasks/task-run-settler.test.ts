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
    // #1609: the escaped production regression — a short transient streak must
    // not pause. Failures 1-4 keep the task runnable; only the fifth pauses.
    name: "a scheduled failure at streak 4 stays runnable (#1609)",
    trigger: "schedule",
    runId: "run-sched-streak4",
    seed: { consecutiveFailures: 3, nextRunAt: SEED_NEXT_RUN },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("execution", "model_error", "executing", "provider down", "none"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(false);
      expect(s.pausedAt).toBeUndefined();
      expect(s.consecutiveFailures).toBe(4);
      expect(s.nextRunAt).toBeTypeOf("number");
    },
  },
  {
    name: "a scheduled failure at the 5-streak threshold still auto-pauses (#1609)",
    trigger: "schedule",
    runId: "run-sched-threshold",
    seed: { consecutiveFailures: 4, nextRunAt: SEED_NEXT_RUN },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("execution", "model_error", "executing", "provider down", "none"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(true);
      expect(s.pausedAt).toBeTypeOf("number");
      expect(s.consecutiveFailures).toBe(5);
    },
  },
  {
    // #1609: dependency faults count toward the threshold instead of pausing
    // on their first failed group; the transient retry is retained.
    name: "a permanent dependency fault counts without pausing immediately (#1609)",
    trigger: "schedule",
    runId: "run-sched-dependency",
    seed: { consecutiveFailures: 1, nextRunAt: SEED_NEXT_RUN },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("dependency", "executable_missing", "preflight", "adapter missing", "permanent"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(false);
      expect(s.consecutiveFailures).toBe(2);
    },
  },
  {
    // #1609: retained permanent classes still pause on their first counted group.
    name: "an unevidenceable contract still pauses on the first failed group (#1609)",
    trigger: "schedule",
    runId: "run-sched-contract",
    seed: { consecutiveFailures: 0, nextRunAt: SEED_NEXT_RUN },
    outcome: "failed",
    makeDiagnostic: () => failure.makeTaskFailure("supervision", "contract_uncovered", "executing", "root criteria without a mapped child contract", "none"),
    expectState: (s) => {
      expect(s.activeRun).toBeUndefined();
      expect(s.autoPaused).toBe(true);
      expect(s.pausedAt).toBeTypeOf("number");
      expect(s.consecutiveFailures).toBe(1);
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

  it("a child terminal fact that predates the request settles on its merits despite a deadline request", async () => {
    const { run } = await seedWithRequest("deadline_exceeded");
    const factAt = NOW - 5000;
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", detail: "finished before request", factAt });
    const { recentRuns } = await import("./task-history-store.js");
    const evs = recentRuns(ENTRY.id, 5);
    expect(evs[0]!.outcome).toBe("success");
    expect(evs[0]!.detail).toBe("finished before request");
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

  describe("fact precedence keys off the request time (#1600)", () => {
    async function seedWithRequestAt(
      kind: "cancelled" | "deadline_exceeded",
      requestedAt: number,
      deadlineAt: number,
      runId: string,
    ): Promise<import("./task-state-store.js").ActiveTaskRun> {
      const reserved = store.reserveRun(ENTRY.id, {
        runId, groupId: "g-1600", attempt: 1, trigger: "schedule",
        occurrenceAt: OCCURRENCE_AT, deadlineAt,
      });
      if (!reserved.ok) throw new Error("reserveRun failed");
      store.requestRunTerminal(ENTRY.id, runId, { kind, requestedAt, reason: "no progress for 15min" });
      return store.readState(ENTRY.id)!.activeRun!;
    }

    function record(entryId: string) {
      return import("./task-history-store.js").then(m => m.recentRuns(entryId, 5)[0]);
    }

    it("an idle-killed project run records deadline_exceeded, not the cause of its own abort", async () => {
      // Idle kill at minute 15 against a 2 h ceiling: the abort it triggers is a
      // consequence (fact at the kill instant), never an independent failure.
      const idleKillAt = NOW + 15 * 60_000;
      const run = await seedWithRequestAt("deadline_exceeded", idleKillAt, NOW + 120 * 60_000, "norm-idle-kill");
      settle.settleRunOnce({
        entry: ENTRY, run, outcome: "failed",
        diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "scheduled project cancelled: no progress for 15min", "none"),
        detail: "scheduled project cancelled: no progress for 15min",
        factAt: idleKillAt + 100,
      });
      const ev = await record(ENTRY.id);
      expect(ev!.outcome).toBe("failed");
      expect(ev!.diagnostic?.category).toBe("interruption");
      expect(ev!.diagnostic?.code).toBe("deadline_exceeded");
      expect(ev!.detail).toBe("scheduled project cancelled: no progress for 15min");
    });

    it("a child fact genuinely earlier than the request still settles on its own merits", async () => {
      // Guards against over-correcting into "deadline always wins".
      const killAt = NOW + 15 * 60_000;
      const run = await seedWithRequestAt("deadline_exceeded", killAt, NOW + 120 * 60_000, "norm-pre-kill");
      settle.settleRunOnce({
        entry: ENTRY, run, outcome: "failed",
        diagnostic: failure.makeTaskFailure("supervision", "lane_failed", "executing", "lane card 7 settled failed", "none"),
        detail: "lane card 7 settled failed",
        factAt: killAt - 5000,
      });
      const ev = await record(ENTRY.id);
      expect(ev!.outcome).toBe("failed");
      expect(ev!.diagnostic?.category).toBe("supervision");
      expect(ev!.diagnostic?.code).toBe("lane_failed");
    });

    it("a ceiling kill classifies exactly as today when the two instants coincide", async () => {
      // Ceiling kill: the wake fires at deadlineAt and requests terminal in the
      // same pass, so requestedAt and deadlineAt coincide within a scan.
      const deadlineAt = NOW + 10 * 60_000;
      const run = await seedWithRequestAt("deadline_exceeded", deadlineAt + 100, deadlineAt, "norm-ceiling-kill");
      settle.settleRunOnce({
        entry: ENTRY, run, outcome: "failed",
        diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "scheduled project cancelled: absolute ceiling exceeded", "none"),
        detail: "scheduled project cancelled: absolute ceiling exceeded",
        factAt: deadlineAt + 200,
      });
      const ev = await record(ENTRY.id);
      expect(ev!.outcome).toBe("failed");
      expect(ev!.diagnostic?.code).toBe("deadline_exceeded");
    });

    it("a child fact in the recovery gap (between deadline and late request) settles on its own merits", async () => {
      // Deliberate change: when the bridge was down across the deadline, recovery
      // records requestedAt well after deadlineAt. A child that genuinely
      // finished in that gap now wins instead of losing to the deadline verdict.
      const deadlineAt = NOW + 10 * 60_000;
      const recoveredAt = NOW + 20 * 60_000;
      const run = await seedWithRequestAt("deadline_exceeded", recoveredAt, deadlineAt, "norm-recovery-gap");
      settle.settleRunOnce({
        entry: ENTRY, run, outcome: "failed",
        diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "provider died during outage", "none"),
        detail: "provider died during outage",
        factAt: NOW + 12 * 60_000,
      });
      const ev = await record(ENTRY.id);
      expect(ev!.outcome).toBe("failed");
      expect(ev!.diagnostic?.category).toBe("execution");
      expect(ev!.diagnostic?.code).toBe("model_error");
    });
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

describe("settleRunOnce failure cascade (#1588)", () => {
  function reserve(runId: string, trigger: "schedule" | "manual" = "schedule"): import("./task-state-store.js").ActiveTaskRun {
    const reserved = store.reserveRun(ENTRY.id, {
      runId,
      groupId: "g-cascade",
      attempt: 1,
      trigger,
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE_AT,
    });
    if (!reserved.ok) throw new Error("reserveRun failed");
    return reserved.run;
  }

  it("fires exactly once for a failed run — the headline agent-task defect", () => {
    const run = reserve("cascade-fail");
    const calls: Array<[string, string, string]> = [];
    const settled = settle.settleRunOnce({
      entry: ENTRY, run, outcome: "failed",
      diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
      onFailure: (event) => calls.push([event.entryId, event.diagnostic.code, event.taskKind]),
    });
    expect(settled).toBe("settled");
    expect(calls).toEqual([["finance-daily", "model_error", "script"]]);
  });

  it("duplicate and late settlements add zero further invocations", () => {
    const run = reserve("cascade-once");
    const calls: Array<[string, string]> = [];
    const opts = {
      entry: ENTRY, run, outcome: "failed" as const,
      diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
      onFailure: (event: import("../sha/sha-types.js").ScheduledFailureEvent) => calls.push([event.entryId, event.diagnostic.code]),
    };
    expect(settle.settleRunOnce(opts)).toBe("settled");
    expect(settle.settleRunOnce(opts)).toBe("duplicate");
    expect(calls).toHaveLength(1);
    // A stale run whose reservation was already cleared: history appends but
    // the reservation check fails, so the cascade must not re-fire.
    const staleRun = { ...run, runId: "cascade-stale" };
    expect(settle.settleRunOnce({ ...opts, run: staleRun })).toBe("late");
    expect(calls).toHaveLength(1);
  });

  it("deferred and cancelled outcomes invoke it zero times", () => {
    const calls: string[] = [];
    const runDeferred = reserve("cascade-deferred");
    settle.settleRunOnce({
      entry: ENTRY, run: runDeferred, outcome: "deferred",
      diagnostic: failure.makeTaskFailure("admission", "executor_unavailable", "queued", "busy", "transient"),
      onFailure: (event) => calls.push(event.diagnostic.code),
    });
    const runCancelled = reserve("cascade-cancelled");
    settle.settleRunOnce({
      entry: ENTRY, run: runCancelled, outcome: "cancelled",
      diagnostic: failure.makeTaskFailure("interruption", "cancelled", "cancelling", "operator", "none"),
      onFailure: (event) => calls.push(event.diagnostic.code),
    });
    expect(calls).toEqual([]);
  });

  it("a timed_out outcome reports the effective diagnostic exactly once", () => {
    const run = reserve("cascade-timeout");
    const calls: string[] = [];
    settle.settleRunOnce({
      entry: ENTRY, run, outcome: "timed_out",
      diagnostic: failure.makeTaskFailure("supervision", "lane_timed_out", "executing", "deadline", "none"),
      onFailure: (event) => calls.push(event.diagnostic.category + "/" + event.diagnostic.code),
    });
    expect(calls).toEqual(["supervision/lane_timed_out"]);
  });
});

describe("settleRunOnce recovery episode reset (#1609)", () => {
  function reserve(runId: string): import("./task-state-store.js").ActiveTaskRun {
    const reserved = store.reserveRun(ENTRY.id, {
      runId,
      groupId: "g-episode",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE_AT,
    });
    if (!reserved.ok) throw new Error("reserveRun failed");
    return reserved.run;
  }

  it("a successful run resets the automatic-resume episode counter", () => {
    store.updateState(ENTRY.id, { autoResumeCount: 2, consecutiveFailures: 2 });
    const run = reserve("episode-reset");
    settle.settleRunOnce({ entry: ENTRY, run, outcome: "success" });
    const state = store.readState(ENTRY.id)!;
    expect(state.autoResumeCount).toBe(0);
    expect(state.consecutiveFailures).toBe(0);
  });

  it("a failed run keeps the episode counter intact", () => {
    store.updateState(ENTRY.id, { autoResumeCount: 2, consecutiveFailures: 0 });
    const run = reserve("episode-keep");
    settle.settleRunOnce({
      entry: ENTRY, run, outcome: "failed",
      diagnostic: failure.makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
    });
    const state = store.readState(ENTRY.id)!;
    expect(state.autoResumeCount).toBe(2);
    expect(state.consecutiveFailures).toBe(1);
  });
});

describe("settleRunOnce deliveryText (#1610)", () => {
  // Production-shaped: a multi-paragraph greeting longer than 200 characters,
  // like the escaped Molty morning-greeting regression.
  const GREETING = [
    "Good morning aksika!",
    "",
    "The day ahead looks clear and calm: no blocked projects are waiting on you, and all scheduled tasks finished cleanly overnight.",
    "",
    "Your main focus today is the steering consolidation work. Take it at your own pace.",
  ].join("\n");

  function reserve(runId: string): import("./task-state-store.js").ActiveTaskRun {
    const reserved = store.reserveRun(ENTRY.id, {
      runId,
      groupId: "g-dtext",
      attempt: 1,
      trigger: "schedule",
      occurrenceAt: OCCURRENCE_AT,
      deadlineAt: DEADLINE_AT,
    });
    if (!reserved.ok) throw new Error("reserveRun failed");
    return reserved.run;
  }

  it("persists bounded deliveryText separately from short detail and completes the card with the user payload", async () => {
    const { kanbanEnqueue, kanbanGetCard } = await import("./kanban-board.js");
    const { recentRuns } = await import("./task-history-store.js");
    const run = reserve("dtext-1");
    const cardId = kanbanEnqueue("Morning Greeting", "task", "dtext-1");
    const settled = settle.settleRunOnce({
      entry: ENTRY, run, outcome: "success",
      detail: "result for dtext-1",
      deliveryText: GREETING,
      cardId,
    });

    expect(settled).toBe("settled");
    const ev = recentRuns(ENTRY.id, 5)[0]!;
    expect(ev.deliveryText).toBe(GREETING);
    expect(ev.detail).toBe("result for dtext-1");
    expect(ev.detail!.length).toBeLessThanOrEqual(200);
    // The card carries the actual user-facing result beyond character 200.
    const card = kanbanGetCard(cardId)!;
    expect(card.result_summary).toBe(GREETING);
    expect(card.result_summary!.length).toBeGreaterThan(200);
  });

  it("repair from durable history reconstructs the same card summary from deliveryText", async () => {
    const { kanbanEnqueue, kanbanGetCard } = await import("./kanban-board.js");
    const { appendRunOnce, getRun } = await import("./task-history-store.js");
    const run = reserve("dtext-repair");
    const cardId = kanbanEnqueue("Morning Greeting", "task", "dtext-repair");
    // Crash after history append, before card mutation: the durable event is
    // authoritative, so repair must redo the card with the same payload.
    appendRunOnce({
      runId: run.runId,
      taskId: ENTRY.id,
      kind: "agent",
      trigger: "schedule",
      startedAt: run.reservedAt,
      finishedAt: Date.now(),
      outcome: "success",
      detail: "result for dtext-repair",
      deliveryText: GREETING,
      kanbanCardId: cardId,
    });
    const repaired = settle.settleRunFromHistory(ENTRY, run, getRun(run.runId)!);
    expect(repaired).toBe(true);
    const card = kanbanGetCard(cardId)!;
    expect(card.result_summary).toBe(GREETING);
    expect(card.result_summary!.length).toBeGreaterThan(200);
  });

  it("redacts secrets and bounds deliveryText at 4,000 characters before persist and card", async () => {
    const { kanbanEnqueue, kanbanGetCard } = await import("./kanban-board.js");
    const { recentRuns } = await import("./task-history-store.js");
    const run = reserve("dtext-bound");
    const cardId = kanbanEnqueue("Morning Greeting", "task", "dtext-bound");
    const secret = "sk-live_abcdefghijklmnopqrstuvwxyz0123456789";
    const padded = secret + "x".repeat(5000);
    const settled = settle.settleRunOnce({
      entry: ENTRY, run, outcome: "success",
      detail: "bound",
      deliveryText: padded,
      cardId,
    });

    expect(settled).toBe("settled");
    const ev = recentRuns(ENTRY.id, 5)[0]!;
    expect(ev.deliveryText).not.toContain(secret);
    expect(ev.deliveryText!.length).toBeLessThanOrEqual(4000);
    const card = kanbanGetCard(cardId)!;
    expect(card.result_summary!.length).toBeLessThanOrEqual(4000);
    expect(card.result_summary).not.toContain(secret);
  });

  it("keeps the truthful fallback when deliveryText and detail are both absent", async () => {
    const { kanbanEnqueue, kanbanGetCard } = await import("./kanban-board.js");
    const run = reserve("dtext-fallback");
    const cardId = kanbanEnqueue("No Output", "task", "dtext-fallback");
    const settled = settle.settleRunOnce({ entry: ENTRY, run, outcome: "success", cardId });
    expect(settled).toBe("settled");
    expect(kanbanGetCard(cardId)!.result_summary).toBe("completed");
  });
});
