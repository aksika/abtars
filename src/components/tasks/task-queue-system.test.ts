import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronQueue } from "./task-queue.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("./task-state-store.js", () => ({
  createRunId: vi.fn((taskId: string) => `${taskId}_test-run`),
  incrementFailures: vi.fn().mockReturnValue(0),
  resetFailures: vi.fn(),
  setAutoPaused: vi.fn(),
  advanceNextRun: vi.fn(),
  nextRunFromSchedule: vi.fn().mockReturnValue({ nextRunAt: Date.now() + 300000 }),
  updateState: vi.fn(),
  readState: vi.fn(() => ({
    nextRunAt: Date.now() - 1000,
    consecutiveFailures: 0,
    consecutiveDeferrals: 0,
    autoPaused: false,
    activeRun: { runId: "sys-run", groupId: "sys-group", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() },
  })),
  reserveRun: vi.fn().mockReturnValue({ ok: true, run: { runId: "sys-run", groupId: "sys-group", attempt: 1, trigger: "schedule", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() } }),
  updateActiveRun: vi.fn().mockReturnValue(true),
  settleActiveRun: vi.fn().mockReturnValue(true),
}));

vi.mock("./task-history-store.js", () => ({
  appendRun: vi.fn(),
  appendRunOnce: vi.fn().mockReturnValue("sys-run"),
  hasRun: vi.fn().mockReturnValue(false),
}));

vi.mock("./task-store.js", () => ({
  readEntry: vi.fn(),
  writeEntry: vi.fn(),
}));

vi.mock("../transport/bridge-lock-transport.js", () => ({
  readLastPromptAt: vi.fn().mockReturnValue(0),
}));

function systemEntry(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "sleep-cycle",
    kind: "system",
    action: "sleep-cycle",
    schedule: "0 2 * * *",
    enabled: true,
    priority: "medium",
    delivery: "silent",
    ...overrides,
  };
}

describe("CronQueue.runSystem", () => {
  let queue: CronQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new CronQueue("kiro-cli", ".");
  });

  it("accepts and runs a system entry", () => {
    const entry = systemEntry();
    const result = queue.enqueue(entry);
    expect(result).toBeNull();
  });

  it("rejects duplicate system entry", () => {
    const entry = systemEntry();
    queue.enqueue(entry);
    const result = queue.enqueue(entry);
    expect(result).toContain("Already");
  });
});
