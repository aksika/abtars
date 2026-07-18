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
  resetFailures: vi.fn(),
  setAutoPaused: vi.fn(),
  advanceNextRun: vi.fn(),
  updateState: vi.fn(),
  readState: vi.fn(() => null),
}));

vi.mock("./task-failure-buffer.js", () => ({
  addTaskFailure: vi.fn(),
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

// Prevent runAgent/runOrc's dynamic import of the real spin module (which pulls
// in user-registry → env-schema) from resolving after environment teardown.
vi.mock("../spin.js", () => ({
  spin: {
    dispatchAwait: vi.fn().mockResolvedValue({ cardId: 0, result: "done" }),
    dispatch: vi.fn(),
    injectGreeting: vi.fn().mockResolvedValue("ok"),
  },
}));

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
    const entry = makeEntry({ kind: "agent", prompt: "do something", delivery: "report" });
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

describe("CronQueue settlement (nextRunAt cursor)", () => {
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

  afterEach(() => { vi.restoreAllMocks(); });

  it("advances nextRunAt exactly once on recurring success and clears retrying", () => {
    const entry = makeEntry({ id: "succ", kind: "script", command: "echo ok", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    activeChildren[0]!.emit("exit", 0);
    expect(vi.mocked(stateStore.advanceNextRun)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(stateStore.advanceNextRun)).toHaveBeenCalledWith("succ", "*/5 * * * *");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("succ", expect.objectContaining({ retrying: false }));
  });

  it("does NOT advance nextRunAt on recurring failure — reschedules a future retry instead", () => {
    const entry = makeEntry({ id: "failr", kind: "script", command: "false", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    activeChildren[0]!.emit("exit", 1);
    expect(vi.mocked(stateStore.advanceNextRun)).not.toHaveBeenCalled();
    const retryCall = vi.mocked(stateStore.updateState).mock.calls.find(
      (c) => c[0] === "failr" && (c[1] as { retrying?: boolean }).retrying === true,
    );
    expect(retryCall).toBeTruthy();
    expect((retryCall![1] as { nextRunAt?: number }).nextRunAt).toBeGreaterThan(Date.now());
  });

  it("marks a one-shot failure completed and never reschedules", () => {
    const entry = makeEntry({ id: "oneshot", kind: "script", command: "false", schedule: undefined, at: new Date().toISOString() });
    queue.enqueue(entry);
    activeChildren[0]!.emit("exit", 1);
    expect(vi.mocked(stateStore.advanceNextRun)).not.toHaveBeenCalled();
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("oneshot", expect.objectContaining({ completed: true }));
  });
});

describe("CronQueue idle-gate", () => {
  let queue: CronQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    queue = new CronQueue("kiro-cli", ".");
  });

  it("defers agent task when user active", async () => {
    const { readLastPromptAt } = await import("../transport/bridge-lock-transport.js");
    vi.mocked(readLastPromptAt).mockReturnValue(Date.now());
    const entry = makeEntry({ kind: "agent", prompt: "test", delivery: "report" });
    queue.enqueue(entry);
    expect(queue.pending).toBe(0);
  });
});
