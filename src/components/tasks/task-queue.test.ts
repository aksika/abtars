import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import { CronQueue } from "./task-queue.js";
import * as stateStore from "./task-state-store.js";
import type { ScheduledTask } from "./task-types.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

vi.mock("./task-state-store.js", () => ({
  incrementFailures: vi.fn().mockReturnValue(0),
  incrementDeferrals: vi.fn().mockReturnValue(0),
  resetFailures: vi.fn(),
  resetDeferrals: vi.fn(),
  setAutoPaused: vi.fn(),
  advanceNextRun: vi.fn(),
  nextRunFromSchedule: vi.fn().mockReturnValue({ nextRunAt: Date.now() + 300000 }),
  updateState: vi.fn(),
  readState: vi.fn(() => null),
  reserveRun: vi.fn().mockReturnValue({ ok: true, run: { runId: "test-run", groupId: "test-group", attempt: 1, trigger: "manual", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() } }),
  updateActiveRun: vi.fn().mockReturnValue(true),
  settleActiveRun: vi.fn().mockReturnValue(true),
}));

vi.mock("./task-failure-buffer.js", () => ({
  addTaskFailure: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  appendRun: vi.fn(),
  appendRunOnce: vi.fn().mockReturnValue("test-run"),
  hasRun: vi.fn().mockReturnValue(false),
}));

vi.mock("./task-store.js", () => ({
  readEntry: vi.fn(),
  writeEntry: vi.fn(),
}));

vi.mock("../transport/bridge-lock-transport.js", () => ({
  readLastPromptAt: vi.fn().mockReturnValue(0),
}));

// Prevent runAgent/runOrc's dynamic import of the real spin module (which pulls
// in user-registry → env-schema) from resolving after environment teardown.
vi.mock("../spin.js", () => ({
  spin: {
    dispatchAwait: vi.fn().mockResolvedValue({ cardId: 0, result: "done" }),
    dispatch: vi.fn(),
    injectGreeting: vi.fn().mockResolvedValue("ok"),
  },
}));

vi.mock("./scheduled-task-runner.js", () => {
  const MockRunner = function () {
    this.run = vi.fn().mockResolvedValue({ status: "success", safeDetail: "mocked" });
  };
  return { ScheduledTaskRunner: MockRunner };
});

function makeFakeChild(): child_process.ChildProcess {
  const child = new EventEmitter() as unknown as child_process.ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { pid: number }).pid = 99999;
  (child as unknown as { killed: boolean }).killed = false;
  return child;
}

function makeEntry(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  const base: ScheduledTask = {
    id: "t" + Math.random().toString(36).slice(2, 6),
    kind: "script",
    command: "echo test",
    chatId: "1",
    delivery: "silent",
    schedule: "*/5 * * * *",
    enabled: true,
    priority: "medium",
    ...overrides,
  };
  return base;
}

describe("CronQueue", () => {
  let queue: CronQueue;
  let activeChildren: child_process.ChildProcess[];

  beforeEach(() => {
    vi.clearAllMocks();
    activeChildren = [];
    vi.mocked(child_process.spawn).mockImplementation((() => {
      const c = makeFakeChild();
      activeChildren.push(c);
      return c;
    }) as unknown as typeof child_process.spawn);
    queue = new CronQueue("kiro-cli", ".");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues and runs a script", () => {
    const entry = makeEntry({ kind: "script", command: "echo hello" });
    const result = queue.enqueue(entry);
    expect(result).toBeNull();
    expect(activeChildren.length).toBe(1);
  });

  it("enqueues a system task", () => {
    const entry = makeEntry({ kind: "system", action: "sleep-cycle", delivery: "silent" });
    const result = queue.enqueue(entry);
    expect(result).toBeNull();
  });

  it("enqueues and runs an agent task", () => {
    const entry = makeEntry({ kind: "agent", prompt: "do something", agent: "task", interaction: { mode: "oneshot" }, delivery: "report" });
    const result = queue.enqueue(entry);
    expect(result).toBeNull();
  });

  it("rejects duplicate entry", () => {
    const entry = makeEntry({ id: "dup1", kind: "script", command: "echo hi" });
    queue.enqueue(entry);
    const result = queue.enqueue(entry);
    expect(result).toContain("Already running");
  });

  it("enqueue returns null on success", () => {
    const entry = makeEntry({ kind: "script", command: "echo ok" });
    expect(queue.enqueue(entry)).toBeNull();
  });
});


