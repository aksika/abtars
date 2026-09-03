import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkCron, readPendingReminders, clearPendingReminders, setPausedRecoveryHook } from "./task-checker.js";
import { ScheduledRunCoordinator } from "./scheduled-run-coordinator.js";
import { createRunDeadlineSource, CANCELLATION_GRACE_MS } from "./due-sources.js";
import * as taskStore from "./task-store.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";
import { runCeilingMs, type ScheduledTask } from "./task-types.js";

vi.mock("./task-store.js", () => ({
  readEntries: vi.fn(),
}));

vi.mock("./kanban-board.js", () => ({
  kanbanGetCard: vi.fn(),
  kanbanDueRetryItems: vi.fn(() => []),
  setKanbanDueChangedHook: vi.fn(),
  resolveRootId: vi.fn(() => undefined),
}));

vi.mock("../reconciler.js", () => ({
  abortProjectById: vi.fn().mockResolvedValue(undefined),
}));

const kanbanMod = await import("./kanban-board.js");
const reconcilerMod = await import("../reconciler.js");

vi.mock("./task-state-store.js", () => ({
  createRunId: vi.fn(() => "generated-run"),
  readState: vi.fn(() => ({ nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false })),
  updateState: vi.fn(),
  advanceNextRun: vi.fn(),
  nextRunFromSchedule: vi.fn().mockReturnValue({ nextRunAt: Date.now() + 300000 }),
  reserveRun: vi.fn().mockReturnValue({ ok: true, run: { runId: "test-run", groupId: "test-group", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() } }),
  updateActiveRun: vi.fn().mockReturnValue(true),
  advanceRun: vi.fn().mockReturnValue("advanced"),
  requestRunTerminal: vi.fn().mockReturnValue("requested"),
  settleActiveRun: vi.fn(),
  setRunOutcome: vi.fn(),
  getRunOwner: vi.fn(),
  // #1609: durable paused-task WARN claims ride the checker evaluation.
  claimPauseWarn: vi.fn(() => true),
}));

// #1609: the checker delegates cooldown/cap decisions to the service.
vi.mock("./task-service.js", () => ({
  autoResumeIfDue: vi.fn(() => "cooling_down"),
}));

const serviceMod = await import("./task-service.js");

vi.mock("./task-history-store.js", () => ({
  todaySuccessCount: vi.fn(() => 0),
  appendRun: vi.fn(),
  appendRunOnce: vi.fn().mockReturnValue("recon-run"),
  hasRun: vi.fn(() => false),
  getRun: vi.fn(() => undefined),
}));

vi.mock("./task-failure-buffer.js", () => ({
  addTaskFailure: vi.fn(),
}));

beforeEach(() => {
  clearPendingReminders();
});

function makeTask(overrides: Partial<Extract<ScheduledTask, { kind: "agent" }>> = {}): ScheduledTask {
  const base: Extract<ScheduledTask, { kind: "agent" }> = {
    id: "t1",
    kind: "agent",
    prompt: "test task",
    interaction: { mode: "oneshot" },
    agent: "task",
    chatId: "1",
    delivery: "report",
    schedule: "0 9 * * *",
    enabled: true,
    priority: "medium",
    orchestration: { maxAgents: 1 },
  };
  return { ...base, ...overrides };
}

function activeRun(overrides: Record<string, unknown> = {}): any {
  return {
    runId: "interrupted-run", groupId: "interrupted-group", attempt: 1, trigger: "schedule",
    occurrenceAt: Date.now() - 120_000, reservedAt: Date.now() - 120_000,
    deadlineAt: Date.now() + 60_000, phase: "executing", lastProgressAt: Date.now() - 1_000,
    ...overrides,
  };
}

describe("checkCron", () => {
  it("returns empty array when no tasks are due", () => {
    vi.mocked(taskStore.readEntries).mockReturnValue([]);
    const due = checkCron();
    expect(due).toEqual([]);
  });

  it("returns tasks that are due", () => {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    const due = checkCron();
    expect(due.length).toBeGreaterThanOrEqual(1);
  });

  it("#1600: reserves a due run with the shared absolute ceiling, not a 30-minute literal", () => {
    vi.clearAllMocks();
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    checkCron();
    const call = vi.mocked(stateStore.reserveRun).mock.calls.find(c => c[0] === "t1");
    expect(call).toBeDefined();
    const delta = call![1]!.deadlineAt - Date.now();
    expect(delta).toBeGreaterThan(runCeilingMs() - 1000);
    expect(delta).toBeLessThan(runCeilingMs() + 1000);
  });

  it("does not admit while an active run owns the task", () => {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
      autoResumeCount: 0,
      activeRun: activeRun({ runId: "owner-run", deadlineAt: Date.now() - 1, phase: "cancelling" }),
    });

    expect(checkCron()).toEqual([]);
    expect(vi.mocked(stateStore.updateState)).not.toHaveBeenCalledWith("t1", expect.objectContaining({ activeRun: undefined }));
    expect(vi.mocked(historyStore.appendRun)).not.toHaveBeenCalled();
  });

  it("does not stale-advance a deferred occurrence after a heartbeat outage", () => {
    const now = Date.now();
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: now - 10 * 60_000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 2,
      autoPaused: false,
      autoResumeCount: 0,
      deferredAdmission: {
        groupId: "t1:group",
        occurrenceAt: now - 11 * 60_000,
        deadlineAt: now + 20 * 60_000,
        attempts: 2,
        retryAt: now - 9 * 60_000,
        diagnostic: { version: 1, category: "admission", code: "session_capacity", phase: "queued", message: "busy", retryability: "transient", occurredAt: now - 10 * 60_000 },
      },
    });

    expect(checkCron()).toHaveLength(1);
    expect(stateStore.advanceNextRun).not.toHaveBeenCalled();
  });

  describe("auto-pause recovery on the heartbeat (#1609)", () => {
    function pausedState(overrides: Record<string, unknown> = {}): any {
      return {
        nextRunAt: Date.now() + 60_000,
        consecutiveFailures: 5,
        consecutiveDeferrals: 0,
        autoPaused: true,
        pausedAt: Date.now() - 1,
        autoResumeCount: 0,
        ...overrides,
      };
    }

    beforeEach(() => {
      vi.clearAllMocks();
      vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    });

    it("does not reserve a run in the same heartbeat as an automatic resume", () => {
      vi.mocked(stateStore.readState).mockReturnValue(pausedState());
      vi.mocked(serviceMod.autoResumeIfDue).mockReturnValue("resumed");
      const events: any[] = [];
      const unsub = (() => {
        setPausedRecoveryHook(e => events.push(e));
        return () => setPausedRecoveryHook(null);
      })();
      try {
        expect(checkCron()).toEqual([]);
      } finally {
        unsub();
      }
      expect(stateStore.reserveRun).not.toHaveBeenCalled();
      expect(events).toEqual([{ kind: "resumed", entryId: "t1", nextRunAt: expect.any(Number) }]);
    });

    it("escalates when the automatic-resume cap is exhausted and stays paused", () => {
      vi.mocked(stateStore.readState).mockReturnValue(pausedState({ autoResumeCount: 3 }));
      vi.mocked(serviceMod.autoResumeIfDue).mockReturnValue("cap_exhausted");
      const events: any[] = [];
      const unsub = (() => {
        setPausedRecoveryHook(e => events.push(e));
        return () => setPausedRecoveryHook(null);
      })();
      try {
        expect(checkCron()).toEqual([]);
      } finally {
        unsub();
      }
      expect(stateStore.reserveRun).not.toHaveBeenCalled();
      expect(stateStore.claimPauseWarn).toHaveBeenCalledWith("t1", expect.any(Number), expect.any(Number));
      expect(events).toEqual([{ kind: "cap_exhausted", entryId: "t1" }]);
    });

    it("within the cooldown it only consults the durable WARN claim — no state transition", () => {
      vi.mocked(stateStore.readState).mockReturnValue(pausedState());
      vi.mocked(serviceMod.autoResumeIfDue).mockReturnValue("cooling_down");
      expect(checkCron()).toEqual([]);
      expect(stateStore.claimPauseWarn).toHaveBeenCalledWith("t1", expect.any(Number), expect.any(Number));
      expect(stateStore.updateState).not.toHaveBeenCalled();
      expect(stateStore.reserveRun).not.toHaveBeenCalled();
    });

    it("a denied WARN claim suppresses the operator warning without touching state", () => {
      vi.mocked(stateStore.readState).mockReturnValue(pausedState());
      vi.mocked(serviceMod.autoResumeIfDue).mockReturnValue("cooling_down");
      vi.mocked(stateStore.claimPauseWarn).mockReturnValue(false);
      expect(checkCron()).toEqual([]);
      expect(stateStore.claimPauseWarn).toHaveBeenCalled();
      expect(stateStore.reserveRun).not.toHaveBeenCalled();
    });
  });
});

describe("coordinator.recover #1539 restart ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyStore.getRun).mockReturnValue(undefined);
  });

  function runWith(cardId: number | undefined, deadlineAt: number, phase = "executing", reattach?: (entry: any, run: any) => boolean, taskOverrides: Partial<Extract<ScheduledTask, { kind: "agent" }>> = {}): Promise<void> {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask(taskOverrides)]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
      autoResumeCount: 0,
      activeRun: activeRun({ deadlineAt, phase, cardId }),
    });
    return new ScheduledRunCoordinator().recover([makeTask(taskOverrides)], reattach);
  }

  it("adopts a terminal done O project's actual outcome (success), not restart_interrupted", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 77, status: "done", result_path: null } as never);
    runWith(77, Date.now() + 60_000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "success",
        runId: "interrupted-run",
        detail: "restart_recovery: project terminal (done)",
      }));
      expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith("t1", "interrupted-run", expect.objectContaining({ consecutiveFailures: 0 }));
      expect(vi.mocked(kanbanMod.kanbanGetCard)).toHaveBeenCalledWith(77);
    });
  });

  it("settles a terminal failed O project with the project's own outcome", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 78, status: "failed", error: "worker exploded" } as never);
    runWith(78, Date.now() + 60_000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "failed",
        detail: "restart_recovery: project terminal (failed)",
      }));
    });
  });

  it("aborts a still-live project when the scheduled deadline passed during downtime", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 78, status: "queued" } as never);
    runWith(78, Date.now() - 1000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "failed",
        detail: "restart_recovery: deadline passed",
        runId: "interrupted-run",
      }));
      expect(reconcilerMod.abortProjectById).toHaveBeenCalledWith(78, "restart_recovery: scheduled deadline passed");
    });
  });

  it("reattaches a live project within deadline to the scheduled lifecycle owner", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 79, status: "running" } as never);
    const reattach = vi.fn(() => true);
    runWith(79, Date.now() + 60_000, "executing", reattach, { orchestration: { maxAgents: 4 } });
    return Promise.resolve().then(() => {
      expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), expect.objectContaining({ runId: "interrupted-run", cardId: 79 }));
      expect(vi.mocked(stateStore.updateState)).not.toHaveBeenCalledWith("t1", expect.objectContaining({ activeRun: undefined }));
      expect(vi.mocked(historyStore.appendRun)).not.toHaveBeenCalled();
    });
  });

  it("repairs state from terminal history instead of only clearing the reservation", () => {
    const finishedAt = Date.now() - 1000;
    vi.mocked(historyStore.getRun).mockReturnValue({
      runId: "interrupted-run", taskId: "t1", kind: "agent", trigger: "schedule",
      startedAt: finishedAt - 1000, finishedAt, outcome: "success", groupId: "interrupted-group",
    });
    runWith(undefined, Date.now() + 60_000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
      expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith(
        "t1", "interrupted-run", expect.objectContaining({ consecutiveFailures: 0, lastFinishedAt: finishedAt }),
      );
    });
  });

  // #1601: the uncertain fallback no longer guesses `failed` — a provably-dead
  // owner settles as `unknown`, and an unprovable/live owner is left untouched
  // for the run-deadline source to terminate on durable evidence.
  it("settles an uncertain run whose owner is provably dead as unknown and never replays it", () => {
    vi.mocked(stateStore.getRunOwner).mockReturnValue({ pid: 2147483647, startedAt: 1 });
    runWith(undefined, Date.now() + 60_000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        outcome: "unknown",
        runId: "interrupted-run",
      }));
      expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith("t1", "interrupted-run", expect.anything());
    });
  });

  it("leaves an uncertain run with unprovable ownership untouched for the deadline source", () => {
    vi.mocked(stateStore.getRunOwner).mockReturnValue(undefined);
    runWith(undefined, Date.now() + 60_000);
    return Promise.resolve().then(() => {
      expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
      expect(vi.mocked(stateStore.settleActiveRun)).not.toHaveBeenCalled();
    });
  });
});

describe("run-deadline due source #1539", () => {
  let coordinator: ScheduledRunCoordinator;
  let source: ReturnType<typeof createRunDeadlineSource>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(historyStore.getRun).mockReturnValue(undefined);
    coordinator = new ScheduledRunCoordinator();
    source = createRunDeadlineSource(coordinator);
  });

  function liveRunWith(runOverrides: Record<string, unknown>): void {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
      autoResumeCount: 0,
      activeRun: activeRun({ runId: "live-run", groupId: "live-group", ...runOverrides }),
    });
  }

  it("leaves unexpired runs untouched", () => {
    liveRunWith({ deadlineAt: Date.now() + 60_000, phase: "executing" });
    source.wakeDue(Date.now());
    expect(vi.mocked(stateStore.requestRunTerminal)).not.toHaveBeenCalled();
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
  });

  it("requests the durable deadline terminal once for an expired owned run and waits for the grace", () => {
    liveRunWith({ deadlineAt: Date.now() - 1000, phase: "executing" });
    coordinator.start(makeTask(), {
      runId: "live-run", groupId: "live-group", attempt: 1, trigger: "schedule",
      occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() - 1000,
      phase: "executing", lastProgressAt: Date.now(),
    }, "scheduled");
    source.wakeDue(Date.now());
    expect(vi.mocked(stateStore.requestRunTerminal)).toHaveBeenCalledWith(
      "t1", "live-run", expect.objectContaining({ kind: "deadline_exceeded" }),
    );
    // Within the grace window: no fallback settlement yet.
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
  });

  it("records the durable deadline request for an expired unowned run without settling immediately", () => {
    liveRunWith({ deadlineAt: Date.now() - 1000, phase: "executing" });
    source.wakeDue(Date.now());
    expect(vi.mocked(stateStore.requestRunTerminal)).toHaveBeenCalledWith(
      "t1", "live-run", expect.objectContaining({ kind: "deadline_exceeded" }),
    );
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
  });

  it("settles a cancelling run past its cancellation grace as deadline_exceeded even when the deadline has passed", () => {
    liveRunWith({
      deadlineAt: Date.now() - 60_000,
      phase: "cancelling",
      terminalRequest: { kind: "deadline_exceeded", requestedAt: Date.now() - CANCELLATION_GRACE_MS - 1000, reason: "deadline fired" },
    });
    source.wakeDue(Date.now());
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
      runId: "live-run",
      outcome: "failed",
      detail: "cancellation grace elapsed",
    }));
    expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith("t1", "live-run", expect.anything());
    // No new terminal request is recorded — the grace fallback owns it.
    expect(vi.mocked(stateStore.requestRunTerminal)).not.toHaveBeenCalled();
  });

  it("records the durable deadline request once for a cancelling run inside its grace", () => {
    liveRunWith({
      deadlineAt: Date.now() - 60_000,
      phase: "cancelling",
      terminalRequest: { kind: "deadline_exceeded", requestedAt: Date.now() - 1000, reason: "deadline fired" },
    });
    source.wakeDue(Date.now());
    expect(vi.mocked(stateStore.requestRunTerminal)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
  });

  it("replays terminal history before any deadline decision", () => {
    liveRunWith({ deadlineAt: Date.now() - 1000, phase: "executing" });
    vi.mocked(historyStore.getRun).mockReturnValue({
      runId: "live-run", taskId: "t1", kind: "agent", trigger: "schedule",
      startedAt: Date.now() - 1000, finishedAt: Date.now(), outcome: "success", groupId: "live-group",
    });
    source.wakeDue(Date.now());
    expect(vi.mocked(stateStore.requestRunTerminal)).not.toHaveBeenCalled();
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
    expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith(
      "t1", "live-run", expect.objectContaining({ consecutiveFailures: 0 }),
    );
  });

  it("lists deadline and cancellation-grace follow-up items for arming", () => {
    liveRunWith({
      deadlineAt: Date.now() + 5_000,
      phase: "cancelling",
      terminalRequest: { kind: "cancelled", requestedAt: Date.now(), reason: "operator" },
    });
    const items = source.listDueItems();
    expect(items.some(i => i.key === "run:live-run" && i.dueAt > Date.now())).toBe(true);
    expect(items.some(i => i.key === "grace:live-run")).toBe(true);
  });

  it("#1539 projects worker-card milestones into the owning root run's progress", () => {
    const coordinator = new ScheduledRunCoordinator();
    const run = {
      runId: "proj-run", groupId: "g", attempt: 1 as const, trigger: "schedule" as const,
      occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60_000,
      phase: "executing" as const, lastProgressAt: Date.now(), cardId: 7,
    };
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false, autoResumeCount: 0,
      activeRun: run,
    });
    coordinator.start(makeTask({ orchestration: { maxAgents: 2 } }), run, "scheduled");
    // A worker card (source "agent") resolves to the root O card carrying the
    // scheduled run identity (source_id = runId).
    vi.mocked(kanbanMod.kanbanGetCard).mockImplementation((id: number) => {
      if (id === 7) return { id: 7, source: "task", source_id: "proj-run" } as never;
      if (id === 12) return { id: 12, source: "agent", source_id: "whatever", parent_id: 7 } as never;
      return undefined as never;
    });
    vi.mocked(kanbanMod.resolveRootId).mockReturnValue(7);
    coordinator.projectCardProgress(12);
    expect(vi.mocked(stateStore.advanceRun)).toHaveBeenCalledWith(
      "t1", "proj-run", expect.objectContaining({ progressAt: expect.any(Number) }),
    );
  });
});
