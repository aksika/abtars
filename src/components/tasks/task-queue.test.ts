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

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(stateStore.incrementFailures).mockReturnValue(0);
    vi.mocked(stateStore.readState).mockReturnValue(null);
    const { readLastPromptAt } = await import("../transport/bridge-lock-transport.js");
    vi.mocked(readLastPromptAt).mockReturnValue(0);
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

describe("CronQueue agent output validation", () => {
  let queue: CronQueue;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(stateStore.incrementFailures).mockReturnValue(0);
    vi.mocked(stateStore.readState).mockReturnValue(null);
    const { readLastPromptAt } = await import("../transport/bridge-lock-transport.js");
    vi.mocked(readLastPromptAt).mockReturnValue(0);
    queue = new CronQueue("kiro-cli", ".");
  });

  function flush(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve));
  }

  async function waitForUpdateState(id: string): Promise<void> {
    await vi.waitFor(() => {
      const calls = vi.mocked(stateStore.updateState).mock.calls.filter(c => c[0] === id);
      expect(calls.length).toBeGreaterThan(0);
    }, { timeout: 1000, interval: 1 });
  }

  it("fails on empty string response", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "" });
    const entry = makeEntry({ id: "empty-str", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("empty-str");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("empty-str", expect.objectContaining({ retrying: true }));
  });

  it("fails on whitespace-only response", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "   \n  \t  " });
    const entry = makeEntry({ id: "ws", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("ws");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("ws", expect.objectContaining({ retrying: true }));
  });

  it("fails on empty structured output (exit_code 0 with empty stdout/stderr)", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: JSON.stringify({ exit_code: 0, stdout: "", stderr: "" }) });
    const entry = makeEntry({ id: "struct-empty", kind: "agent", prompt: "test", delivery: "silent", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("struct-empty");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("struct-empty", expect.objectContaining({ retrying: true }));
  });

  it("fails on structured output with a non-zero exit code even when stdout is present", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({
      cardId: 5,
      result: JSON.stringify({ exit_code: 1, stdout: "command failed", stderr: "" }),
    });
    const entry = makeEntry({ id: "struct-failed", kind: "agent", prompt: "test", delivery: "silent", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("struct-failed");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("struct-failed", expect.objectContaining({ retrying: true }));
  });

  it("fails on synthetic sentinel (no output)", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "(no output)" });
    const entry = makeEntry({ id: "sentinel", kind: "agent", prompt: "test", delivery: "silent", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("sentinel");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("sentinel", expect.objectContaining({ retrying: true }));
  });

  it("fails on synthetic sentinel (task completed)", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "(task completed)" });
    const entry = makeEntry({ id: "sentinel2", kind: "agent", prompt: "test", delivery: "silent", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("sentinel2");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("sentinel2", expect.objectContaining({ retrying: true }));
  });

  it("fails on report output shorter than 100 bytes", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "short" });
    const entry = makeEntry({ id: "short-rpt", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("short-rpt");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("short-rpt", expect.objectContaining({ retrying: true }));
  });

  it("passes on valid report output at threshold (100 bytes)", async () => {
    const { spin } = await import("../spin.js");
    const { kanbanComplete, kanbanFail } = await import("./kanban-board.js");
    const content = "x".repeat(100);
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: content });
    const entry = makeEntry({ id: "valid-rpt", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("valid-rpt");
    const updateCalls = vi.mocked(stateStore.updateState).mock.calls.filter(c => c[0] === "valid-rpt");
    const lastCall = updateCalls[updateCalls.length - 1];
    expect(lastCall[1]).toMatchObject({ retrying: false });
  });

  it("passes on valid non-report output (any non-empty)", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: "valid output here" });
    const entry = makeEntry({ id: "valid-nr", kind: "agent", prompt: "test", delivery: "silent", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("valid-nr");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("valid-nr", expect.objectContaining({ retrying: false }));
  });

  it("fails on structured report output under 100 bytes", async () => {
    const { spin } = await import("../spin.js");
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: JSON.stringify({ exit_code: 0, stdout: "short", stderr: "" }) });
    const entry = makeEntry({ id: "short-struct", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("short-struct");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("short-struct", expect.objectContaining({ retrying: true }));
  });

  it("passes on structured output with valid stdout", async () => {
    const { spin } = await import("../spin.js");
    const stdoutContent = "x".repeat(100);
    vi.mocked(spin.dispatchAwait).mockResolvedValue({ cardId: 5, result: JSON.stringify({ exit_code: 0, stdout: stdoutContent, stderr: "" }) });
    const entry = makeEntry({ id: "struct-ok", kind: "agent", prompt: "test", delivery: "report", schedule: "*/5 * * * *" });
    queue.enqueue(entry);
    await waitForUpdateState("struct-ok");
    expect(vi.mocked(stateStore.updateState)).toHaveBeenCalledWith("struct-ok", expect.objectContaining({ retrying: false }));
  });
});
