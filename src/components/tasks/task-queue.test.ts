import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import { CronQueue } from "./task-queue.js";
import { ScheduledRunCoordinator } from "./scheduled-run-coordinator.js";
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
  advanceRun: vi.fn().mockReturnValue("advanced"),
  requestRunTerminal: vi.fn().mockReturnValue("requested"),
  settleActiveRun: vi.fn().mockReturnValue(true),
  setRunOutcome: vi.fn(),
}));

vi.mock("./task-failure-buffer.js", () => ({
  addTaskFailure: vi.fn(),
}));

vi.mock("./task-history-store.js", () => ({
  appendRun: vi.fn(),
  appendRunOnce: vi.fn().mockReturnValue("test-run"),
  hasRun: vi.fn().mockReturnValue(false),
  getRun: vi.fn().mockReturnValue(undefined),
}));

vi.mock("./task-store.js", () => ({
  readEntry: vi.fn(),
  writeEntry: vi.fn(),
}));

const historyStore = await import("./task-history-store.js");

vi.mock("../transport/bridge-lock-transport.js", () => ({
  readLastPromptAt: vi.fn().mockReturnValue(0),
}));

// Prevent runAgent's dynamic import of the real spin module (which pulls
// in user-registry → env-schema) from resolving after environment teardown.
vi.mock("../spin.js", () => ({
  spin: {
    dispatchAwait: vi.fn().mockResolvedValue({ cardId: 0, result: "done" }),
    dispatch: vi.fn(),
    injectGreeting: vi.fn().mockResolvedValue("ok"),
  },
}));

vi.mock("./scheduled-task-runner.js", () => {
  const MockRunner = function (this: { run: ReturnType<typeof vi.fn> }) {
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
  return {
    id: "t" + Math.random().toString(36).slice(2, 6),
    kind: "script",
    command: "echo test",
    chatId: "1",
    delivery: "silent",
    schedule: "*/5 * * * *",
    enabled: true,
    priority: "medium",
    ...overrides,
  } as ScheduledTask;
}

function makeReservation(runId = "test-run", trigger: "manual" | "schedule" = "manual"): any {
  return {
    runId, groupId: "test-group", attempt: 1 as const, trigger,
    occurrenceAt: Date.now(), reservedAt: Date.now(), deadlineAt: Date.now() + 60000,
    phase: "reserved", lastProgressAt: Date.now(),
  };
}

function baseState(): any {
  return {
    nextRunAt: Date.now() - 1000,
    consecutiveFailures: 0,
    consecutiveDeferrals: 0,
    autoPaused: false,
  };
}

describe("CronQueue #1539 two-lane admission", () => {
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
    // Explicit defaults: later tests may re-set these per case.
    vi.mocked(stateStore.readState).mockReturnValue({ ...baseState(), activeRun: makeReservation() });
    vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: makeReservation() });
    queue = new CronQueue(new ScheduledRunCoordinator());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queue.destroy();
  });

  it("enqueues and runs a script", () => {
    const entry = makeEntry({ kind: "script", command: "echo hello" });
    const result = queue.enqueue(entry);
    expect(result).toBeNull();
    expect(activeChildren.length).toBe(1);
  });

  it("#1539 advances a script run queued -> executing (never stuck in reserved)", () => {
    const entry = makeEntry({ kind: "script", command: "echo hello" });
    queue.enqueue(entry);
    const phases = vi.mocked(stateStore.advanceRun).mock.calls
      .filter(call => (call[2] as { phase?: string }).phase !== undefined)
      .map(call => (call[2] as { phase: string }).phase);
    expect(phases).toEqual(["queued", "executing"]);
  });

  it("#1539 advances a system run queued -> executing", () => {
    const entry = makeEntry({ kind: "system", action: "sleep-cycle", delivery: "silent" });
    queue.enqueue(entry);
    const phases = vi.mocked(stateStore.advanceRun).mock.calls
      .filter(call => (call[2] as { phase?: string }).phase !== undefined)
      .map(call => (call[2] as { phase: string }).phase);
    expect(phases).toEqual(["queued", "executing"]);
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
    const result = queue.enqueue(entry, false, makeReservation("supplied-run", "schedule"));
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
    const runA = makeReservation("run-a", "schedule");
    const runB = makeReservation("run-b", "schedule");
    const states: Record<string, any> = {
      "dup3a": { ...baseState(), activeRun: runA },
      "dup3b": { ...baseState(), activeRun: runB },
    };
    vi.mocked(stateStore.readState).mockImplementation((id: string) => states[id] ?? null);
    vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: runA });
    // a runs; b is pending behind it in the scheduled lane.
    queue.enqueue(a, false, runA);
    queue.enqueue(b, false, runB);
    const result = queue.enqueue(b, false, makeReservation("supplied-queued-2", "schedule"));
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
      let terminalRequest: any = undefined;
      vi.mocked(stateStore.readState).mockImplementation(() => ({
        ...baseState(),
        activeRun: { ...makeReservation(), terminalRequest },
      }));
      vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: { ...makeReservation(), terminalRequest } });
      vi.mocked(stateStore.requestRunTerminal).mockImplementation((_taskId: string, _runId: string, request: any) => {
        terminalRequest = request;
        return "requested";
      });
      queue.enqueue(entry);
      const child = activeChildren[0]!;
      (child as unknown as { exitCode: number | null }).exitCode = null;
      const kill = vi.fn();
      (child as unknown as { kill: typeof kill }).kill = kill;

      expect(queue.cancel("test-run", "live_recovery: deadline exceeded")).toBe("requested");
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      expect(vi.mocked(stateStore.requestRunTerminal)).toHaveBeenCalledWith(
        expect.anything(), "test-run", expect.objectContaining({ kind: "cancelled" }),
      );

      // The executor's own exit path settles the run exactly once and clears
      // the cancellation fallback timer instead of leaving it behind. The
      // durable cancellation request normalizes the late exit to cancelled.
      child.emit("exit", 143);
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({
        runId: "test-run",
        outcome: "cancelled",
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

  it("settles a script exactly once when its deadline fires through the coordinator; a late exit cannot replace it", () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ScheduledRunCoordinator();
      const q = new CronQueue(coordinator);
      const entry = makeEntry({ id: "deadline-1", kind: "script", command: "sleep 100" });
      const activeRun = makeReservation("deadline-run", "manual");
      vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: activeRun });
      vi.mocked(stateStore.readState).mockReturnValue({
        nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false, autoResumeCount: 0,
        activeRun,
      });
      q.enqueue(entry);
      const child = activeChildren[0]!;
      (child as unknown as { exitCode: number | null }).exitCode = null;
      (child as unknown as { kill: ReturnType<typeof vi.fn> }).kill = vi.fn();

      // The durable deadline wake requests the terminal and signals the child.
      coordinator.deadlineExpired("deadline-1", "deadline-run", "deadline exceeded");
      expect((child as unknown as { kill: ReturnType<typeof vi.fn> }).kill).toHaveBeenCalledWith("SIGTERM");
      expect(vi.mocked(stateStore.requestRunTerminal)).toHaveBeenCalledWith(
        "deadline-1", "deadline-run", expect.objectContaining({ kind: "deadline_exceeded" }),
      );
      expect(vi.mocked(historyStore.appendRunOnce)).not.toHaveBeenCalled();

      // The killed child exits; the run settles as cancelled/deadline once and
      // the owned listeners are detached.
      child.emit("exit", 143);
      const settles = vi.mocked(historyStore.appendRunOnce).mock.calls.length;
      expect(settles).toBe(1);
      expect(vi.mocked(historyStore.appendRunOnce)).toHaveBeenCalledWith(expect.objectContaining({ runId: "deadline-run" }));
      child.emit("exit", 1);
      expect(vi.mocked(historyStore.appendRunOnce).mock.calls.length).toBe(settles);
      expect(vi.getTimerCount()).toBe(0);
      q.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("CronQueue #1539 lane semantics", () => {
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
    vi.mocked(stateStore.readState).mockReturnValue({ ...baseState(), activeRun: makeReservation() });
    vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: makeReservation() });
    queue = new CronQueue(new ScheduledRunCoordinator());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    queue.destroy();
  });

  it("runs a long scheduled script and an unrelated manual script concurrently in separate lanes", () => {
    const scheduled = makeEntry({ id: "sched-long", kind: "script", command: "sleep 100" });
    const manual = makeEntry({ id: "manual-other", kind: "script", command: "echo hi" });
    const schedRun = makeReservation("sched-run", "schedule");
    const manualRun = makeReservation("manual-run", "manual");
    const states: Record<string, any> = {
      "sched-long": { ...baseState(), activeRun: schedRun },
      "manual-other": { ...baseState(), activeRun: manualRun },
    };
    vi.mocked(stateStore.readState).mockImplementation((id: string) => states[id] ?? null);
    vi.mocked(stateStore.reserveRun).mockImplementation(() => ({ ok: true, run: states["sched-long"].activeRun }));

    queue.enqueue(scheduled, false, schedRun);
    queue.enqueue(manual, true, manualRun);

    // Both lanes hold a current job while the scheduled script is still running.
    expect(queue.currentJobs.map(j => j.entryId)).toEqual(expect.arrayContaining(["sched-long", "manual-other"]));
    expect(activeChildren).toHaveLength(2);

    // The scheduled lane's terminal releases only that lane.
    activeChildren[0]!.emit("exit", 0);
    expect(queue.currentJobs.map(j => j.entryId)).toEqual(["manual-other"]);
  });

  it("excludes a second occurrence of the same task globally across lanes", () => {
    const first = makeEntry({ id: "same-task", kind: "script", command: "sleep 100" });
    const runA = makeReservation("sched-run", "schedule");
    vi.mocked(stateStore.readState).mockReturnValue({ ...baseState(), activeRun: runA });
    vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: runA });
    queue.enqueue(first, false, runA);
    const result = queue.enqueue(first, true, makeReservation("manual-run", "manual"));
    expect(result).toContain("Already running");
    expect(activeChildren).toHaveLength(1);
  });

  it("releases a lane only when the terminal run ID matches (stale notification isolation)", () => {
    vi.useFakeTimers();
    try {
      const coord = new ScheduledRunCoordinator();
      const q = new CronQueue(coord);
      const a = makeEntry({ id: "stale-a", kind: "script", command: "echo a" });
      const runA = makeReservation("stale-a-run", "schedule");
      vi.mocked(stateStore.reserveRun).mockReturnValue({ ok: true, run: runA });
      vi.mocked(stateStore.readState).mockReturnValue({
        nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false, autoResumeCount: 0,
        activeRun: runA,
      });
      q.enqueue(a, false, runA);
      // A terminal event for an unknown/old run must not clear the live lane.
      q.destroy();
      coord.cancel("stale-a-run", "test");
      q.destroy();
      // The live lane survives: the run is still current.
      expect(q.currentJob?.entryId).toBe("stale-a");
      q.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the reservation once and releases the lane when start finds the reservation stale", () => {
    const entry = makeEntry({ id: "stale-start", kind: "script", command: "echo hi" });
    const reservation = makeReservation("stale-start-run", "schedule");
    vi.mocked(stateStore.readState).mockReturnValue({
      nextRunAt: Date.now() - 1000, consecutiveFailures: 0, consecutiveDeferrals: 0, autoPaused: false, autoResumeCount: 0,
      activeRun: undefined,
    });
    const result = queue.enqueue(entry, false, reservation);
    expect(result).toBeNull();
    // The lane recorded the job, start returned stale, and the lane released
    // without executing side effects.
    expect(queue.currentJob).toBeNull();
    expect(activeChildren).toHaveLength(0);
  });
});
