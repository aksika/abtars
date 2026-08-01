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
  createRunId: vi.fn((taskId: string) => `${taskId}_test-run`),
  incrementFailures: vi.fn().mockReturnValue(0),
  incrementDeferrals: vi.fn().mockReturnValue(0),
  resetFailures: vi.fn(),
  resetDeferrals: vi.fn(),
  setAutoPaused: vi.fn(),
  advanceNextRun: vi.fn(),
  nextRunFromSchedule: vi.fn().mockReturnValue({ nextRunAt: Date.now() + 300000 }),
  updateState: vi.fn(),
  readState: vi.fn(() => ({
    nextRunAt: Date.now() - 1000,
    consecutiveFailures: 0,
    consecutiveDeferrals: 0,
    autoPaused: false,
    activeRun: { runId: "test-run", groupId: "test-group", attempt: 1, trigger: "manual", occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000, phase: "reserved", lastProgressAt: Date.now() },
  })),
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

const historyStore = await import("./task-history-store.js");

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

  it("terminalizes a supplied reservation rejected as duplicate-current", () => {
    const entry = makeEntry({ id: "dup2", kind: "script", command: "echo hi" });
    queue.enqueue(entry);
    const reservation = {
      runId: "supplied-run", groupId: "g", attempt: 1 as const, trigger: "schedule" as const,
      occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000,
      phase: "reserved", lastProgressAt: Date.now(),
    };
    const result = queue.enqueue(entry, false, reservation);
    expect(result).toContain("Already running");
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
      runId: "supplied-run",
      outcome: "cancelled",
      detail: "queue_admission_rejected: duplicate-current",
    }));
  });

  it("terminalizes a supplied reservation rejected as duplicate-queued", () => {
    const a = makeEntry({ id: "dup3a", kind: "script", command: "echo a" });
    const b = makeEntry({ id: "dup3b", kind: "script", command: "echo b" });
    queue.enqueue(a);
    queue.enqueue(b);
    // A finishes; B becomes current, leaving the queue empty.
    activeChildren[0]!.emit("exit", 0);

    const reservation = (runId: string) => ({
      runId, groupId: "g", attempt: 1 as const, trigger: "schedule" as const,
      occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000,
      phase: "reserved", lastProgressAt: Date.now(),
    });
    expect(queue.enqueue(a, false, reservation("supplied-queued"))).toBeNull();
    const result = queue.enqueue(a, false, reservation("supplied-queued-2"));
    expect(result).toContain("Already queued");
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
      runId: "supplied-queued-2",
      outcome: "cancelled",
      detail: "queue_admission_rejected: duplicate-queued",
    }));
  });

  it("reserves manual executions at admission so queued jobs own a run ID", () => {
    const entry = makeEntry({ kind: "script", command: "echo test" });
    queue.enqueue(entry);
    expect(vi.mocked(stateStore.reserveRun)).toHaveBeenCalledTimes(1);
  });

  it("clears the reservation on script spawn failure", () => {
    const entry = makeEntry({ kind: "script", command: "nope" });
    queue.enqueue(entry);
    const child = activeChildren[0]!;
    child.emit("error", new Error("ENOENT"));
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed",
      detail: "ENOENT",
      diagnostic: expect.objectContaining({ category: "dependency", code: "executable_missing" }),
    }));
  });

  it("cancels an owned script run by terminating its child through the process handle", () => {
    vi.useFakeTimers();
    try {
      const entry = makeEntry({ kind: "script", command: "sleep 100" });
      queue.enqueue(entry);
      const child = activeChildren[0]!;
      (child as unknown as { exitCode: number | null }).exitCode = null;
      const kill = vi.fn();
      (child as unknown as { kill: typeof kill }).kill = kill;

      expect(queue.cancel("test-run", "live_recovery: deadline exceeded")).toBe("requested");
      expect(kill).toHaveBeenCalledWith("SIGTERM");

      // The executor's own exit path settles the run exactly once and clears
      // the cancellation fallback timer instead of leaving it behind.
      child.emit("exit", 143);
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        runId: "test-run",
        outcome: "failed",
      }));
      const settles = vi.mocked(historyStore.appendRunOnce).mock.calls.length;
      child.emit("exit", 143);
      expect(vi.mocked(historyStore.appendRunOnce).mock.calls.length).toBe(settles);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a late exit after spawn failure cannot clear a newer job's current state", () => {
    const entry = makeEntry({ id: "late-exit-1", kind: "script", command: "nope" });
    queue.enqueue(entry);
    const failedChild = activeChildren[0]!;
    failedChild.emit("error", new Error("ENOENT"));

    const second = makeEntry({ id: "late-exit-2", kind: "script", command: "echo second" });
    queue.enqueue(second);
    expect(queue.currentJob?.entryId).toBe("late-exit-2");
    expect(activeChildren).toHaveLength(2);

    failedChild.emit("exit", 1);
    expect(queue.currentJob?.entryId).toBe("late-exit-2");
    expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledTimes(1);
  });

  it("detaches owned process listeners after terminal settlement", () => {
    const entry = makeEntry({ id: "detach-1", kind: "script", command: "echo ok" });
    queue.enqueue(entry);
    const child = activeChildren[0]!;
    child.emit("exit", 0);
    expect((child as unknown as EventEmitter).listenerCount("exit")).toBe(0);
    expect((child as unknown as EventEmitter).listenerCount("error")).toBe(0);
    expect((child as unknown as EventEmitter).listenerCount("data")).toBe(0);
  });

  it("settles a script exactly once when its deadline fires; a late exit cannot replace it", () => {
    vi.useFakeTimers();
    try {
      const entry = makeEntry({ kind: "script", command: "sleep 100" });
      const activeRun = {
        runId: "deadline-run", groupId: "deadline-group", attempt: 1 as const, trigger: "manual" as const,
        occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60_000,
        phase: "reserved" as const, lastProgressAt: Date.now(),
      };
      vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: activeRun });
      vi.mocked(stateStore.readState).mockReturnValue({
        nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false,
        activeRun,
      });

      queue.enqueue(entry);
      const child = activeChildren[0]!;
      (child as unknown as { exitCode: number | null }).exitCode = null;
      (child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();

      vi.advanceTimersByTime(60_001);
      expect((child as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith("SIGTERM");
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        runId: "deadline-run",
        outcome: "timed_out",
        detail: "deadline: script timed out",
      }));

      // The owned exit listener is detached after the deadline settlement; a
      // late exit produces no second terminal event.
      const settlesBefore = vi.mocked(historyStore.appendRunOnce).mock.calls.length;
      child.emit("exit", 1);
      expect(vi.mocked(historyStore.appendRunOnce).mock.calls.length).toBe(settlesBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
