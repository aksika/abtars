import { describe, it, expect, vi, beforeEach } from "vitest";
import { CronQueue } from "./task-queue.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("./task-state-store.js", () => ({
  incrementFailures: vi.fn().mockReturnValue(0),
  resetFailures: vi.fn(),
  setAutoPaused: vi.fn(),
  setRetrying: vi.fn(),
  updateState: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  appendRun: vi.fn(),
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
