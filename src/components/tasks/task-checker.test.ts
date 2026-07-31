import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkCron, readPendingReminders, clearPendingReminders, reconcileActiveTaskRuns } from "./task-checker.js";
import * as taskStore from "./task-store.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("./task-store.js", () => ({
  readEntries: vi.fn(),
}));

vi.mock("./kanban-board.js", () => ({
  kanbanGetCard: vi.fn(),
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
  settleActiveRun: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  todaySuccessCount: vi.fn(() => 0),
  appendRun: vi.fn(),
  appendRunOnce: vi.fn().mockReturnValue("recon-run"),
  hasRun: vi.fn(() => false),
  getRun: vi.fn(() => undefined),
}));

beforeEach(() => {
  clearPendingReminders();
});

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
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

  it("does not let heartbeat reconcile an expired active run while its owner can settle", () => {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask()]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
      activeRun: {
        runId: "owner-run", groupId: "owner-group", attempt: 1, trigger: "schedule",
        occurrenceAt: Date.now() - 120_000, reservedAt: Date.now() - 120_000,
        deadlineAt: Date.now() - 1, phase: "cancelling", lastProgressAt: Date.now() - 1_000,
      },
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
});

describe("reconcileActiveTaskRuns #1516 restart identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function runWith(cardId: number | undefined, deadlineAt: number, phase = "executing", reattach?: (entry: any, run: any) => boolean, taskOverrides: Partial<ScheduledTask> = {}): void {
    vi.mocked(taskStore.readEntries).mockReturnValue([makeTask(taskOverrides)]);
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000,
      consecutiveFailures: 0,
      consecutiveDeferrals: 0,
      autoPaused: false,
      activeRun: {
        runId: "interrupted-run", groupId: "interrupted-group", attempt: 1, trigger: "schedule",
        occurrenceAt: Date.now() - 120_000, reservedAt: Date.now() - 120_000,
        deadlineAt, phase, lastProgressAt: Date.now() - 1_000,
        cardId,
      },
    });
    reconcileActiveTaskRuns(reattach);
  }

  it("terminalizes an interrupted run whose project reached a terminal card", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 77, status: "done" } as never);
    runWith(77, Date.now() + 60_000);
    expect(vi.mocked(stateStore.updateState)).not.toHaveBeenCalledWith("t1", expect.objectContaining({ activeRun: undefined }));
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", detail: "restart_recovery: project terminal (done)", runId: "interrupted-run" }));
    expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith("t1", "interrupted-run", expect.objectContaining({ consecutiveFailures: 1 }));
    expect(vi.mocked(kanbanMod.kanbanGetCard)).toHaveBeenCalledWith(77);
  });

  it("aborts a still-live project when the scheduled deadline passed during downtime", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 78, status: "queued" } as never);
    runWith(78, Date.now() - 1000);
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", detail: "restart_recovery: deadline passed", runId: "interrupted-run" }));
    expect(reconcilerMod.abortProjectById).toHaveBeenCalledWith(78, "restart_recovery: scheduled deadline passed");
  });

  it("reattaches a live project within deadline to the scheduled lifecycle owner", () => {
    vi.mocked(kanbanMod.kanbanGetCard).mockReturnValue({ id: 79, status: "running" } as never);
    const reattach = vi.fn(() => true);
    runWith(79, Date.now() + 60_000, "executing", reattach, { orchestration: { maxAgents: 4 } });
    expect(reattach).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), expect.objectContaining({ runId: "interrupted-run", cardId: 79 }));
    expect(vi.mocked(stateStore.updateState)).not.toHaveBeenCalledWith("t1", expect.objectContaining({ activeRun: undefined }));
    expect(vi.mocked(historyStore.appendRun)).not.toHaveBeenCalled();
  });

  it("repairs state from terminal history instead of only clearing the reservation", () => {
    const finishedAt = Date.now() - 1000;
    vi.mocked(historyStore.getRun).mockReturnValue({
      runId: "interrupted-run", taskId: "t1", kind: "agent", trigger: "schedule",
      startedAt: finishedAt - 1000, finishedAt, outcome: "success", groupId: "interrupted-group",
    });
    runWith(undefined, Date.now() + 60_000);
    expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();
    expect(vi.mocked(stateStore.settleActiveRun)).toHaveBeenCalledWith(
      "t1", "interrupted-run", expect.objectContaining({ consecutiveFailures: 0, lastFinishedAt: finishedAt }),
    );
  });
});
