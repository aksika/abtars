import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkCron, readPendingReminders, clearPendingReminders } from "./task-checker.js";
import * as taskStore from "./task-store.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("./task-store.js", () => ({
  readEntries: vi.fn(),
}));

vi.mock("./task-state-store.js", () => ({
  readState: vi.fn(() => ({ nextRunAt: Date.now() - 1000, consecutiveFailures: 0, autoPaused: false })),
  updateState: vi.fn(),
  advanceNextRun: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  todaySuccessCount: vi.fn(() => 0),
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
});
