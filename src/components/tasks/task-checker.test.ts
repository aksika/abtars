import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkCron, readPendingReminders, clearPendingReminders } from "./task-checker.js";
import * as taskStore from "./task-store.js";
import * as stateStore from "./task-state-store.js";
import * as historyStore from "./task-history-store.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("./task-store.js", () => ({
  readEntries: vi.fn(),
}));

vi.mock("./task-state-store.js", () => ({
  readState: vi.fn(() => ({ nextRunAt: Date.now() - 1000, consecutiveFailures: 0, autoPaused: false })),
  updateState: vi.fn(),
  advanceNextRun: vi.fn(),
  reserveRun: vi.fn().mockReturnValue({ ok: true, run: { runId: "test-run", groupId: "test-group", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() } }),
  settleActiveRun: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  todaySuccessCount: vi.fn(() => 0),
  appendRun: vi.fn(),
  hasRun: vi.fn(() => false),
}));

beforeEach(() => {
  clearPendingReminders();
});

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    kind: "agent",
    prompt: "test task",
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
});
