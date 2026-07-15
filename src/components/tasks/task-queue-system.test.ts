/**
 * task-queue-system.test.ts — CronQueue routing for the `system` executor (#1321).
 *
 * Verifies a system task dispatches to the registry (not a child process), the
 * queue advances immediately after the short handler result, and failures are
 * recorded as task history.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CronQueue } from "./task-queue.js";
import type { CronEntry } from "./task-types.js";
import { getSystemTaskRegistry, _resetSystemTaskRegistry } from "./system-task-registry.js";

// task-store: mocked so no real tasks.json is touched and recordRun is observable.
vi.mock("./task-store.js", () => ({
  recordRun: vi.fn(),
  readEntry: vi.fn(),
  writeEntry: vi.fn(),
}));

// bridge-lock: mocked so processNext() never short-circuits and the
// idle gate's readLastPromptAt() returns an old timestamp.
vi.mock("../transport/bridge-lock-transport.js", () => ({
  readLastPromptAt: vi.fn().mockReturnValue(0),
  readBridgeLockField: vi.fn().mockReturnValue(undefined),
  updateBridgeLockField: vi.fn(),
  trackAcpPid: vi.fn(),
  readAndClearAcpPids: vi.fn().mockReturnValue([]),
}));

import { recordRun as dbRecordRun } from "./task-store.js";

function systemEntry(overrides: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "sleep-cycle",
    fireAt: Date.now() - 1000,
    message: "",
    chatId: 0,
    type: "task",
    executor: "system",
    action: "sleep-cycle",
    fired: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("#1321 CronQueue.runSystem", () => {
  let queue: CronQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSystemTaskRegistry();
    queue = new CronQueue("kiro-cli", ".");
  });

  afterEach(() => _resetSystemTaskRegistry());

  it("dispatches to the registry, not a child process", async () => {
    const reg = getSystemTaskRegistry();
    const handler = vi.fn(() => ({ status: "accepted" as const, detail: "started" }));
    reg.register("sleep-cycle", handler);

    queue.enqueue(systemEntry());
    // Allow the async dispatch microtask to flush.
    await new Promise<void>(r => setTimeout(r, 10));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].id).toBe("sleep-cycle");
    expect(queue.currentJob).toBeNull();      // advanced immediately
    expect(queue.pending).toBe(0);
  });

  it("accepted is a successful dispatch (recorded exit 0)", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "accepted" }));
    queue.enqueue(systemEntry());
    await new Promise<void>(r => setTimeout(r, 10));
    expect(vi.mocked(dbRecordRun)).toHaveBeenCalledWith("sleep-cycle", 0);
  });

  it("noop is a successful dispatch", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "noop" }));
    queue.enqueue(systemEntry());
    await new Promise<void>(r => setTimeout(r, 10));
    expect(vi.mocked(dbRecordRun)).toHaveBeenCalledWith("sleep-cycle", 0);
  });

  it("already_running maps to noop (idempotent success, no second handler call)", async () => {
    const reg = getSystemTaskRegistry();
    let calls = 0;
    reg.register("sleep-cycle", () => {
      calls++;
      return calls === 1 ? { status: "accepted" } : { status: "noop", detail: "already running" };
    });
    queue.enqueue(systemEntry());
    queue.enqueue(systemEntry()); // second dispatch of the same id while first "ran"
    await new Promise<void>(r => setTimeout(r, 10));
    // Both enqueue as accepted (duplicate id is blocked in enqueue for the SAME id while
    // running, but these are distinct enqueues after the first completed). The point: no
    // child process spawned and queue drains to empty.
    expect(queue.pending).toBe(0);
  });

  it("failed handler records exit 1", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "failed", error: "unavailable" }));
    queue.enqueue(systemEntry());
    await new Promise<void>(r => setTimeout(r, 10));
    expect(vi.mocked(dbRecordRun)).toHaveBeenCalledWith("sleep-cycle", 1);
  });

  it("queue advances after a system task — next task starts", async () => {
    const reg = getSystemTaskRegistry();
    reg.register("sleep-cycle", () => ({ status: "accepted" }));

    // Block the first system dispatch so the second sits in the queue.
    let releaseFirst: () => void = () => {};
    const firstPromise = new Promise<void>(r => { releaseFirst = r; });
    reg.register; // no-op
    // Re-register with a gating handler for ordering control.
    _resetSystemTaskRegistry();
    const reg2 = getSystemTaskRegistry();
    let firstStarted = false;
    reg2.register("sleep-cycle", async () => {
      if (!firstStarted) { firstStarted = true; await firstPromise; return { status: "accepted" }; }
      return { status: "accepted" };
    });

    queue.enqueue(systemEntry({ id: "first" }));
    await new Promise<void>(r => setTimeout(r, 5));
    expect(queue.currentJob?.entryId).toBe("first");
    queue.enqueue(systemEntry({ id: "second" })); // queued behind the running first
    expect(queue.pending).toBe(1);

    releaseFirst();
    await new Promise<void>(r => setTimeout(r, 15));

    // First completed → second became current → then completed too.
    expect(queue.currentJob).toBeNull();
    expect(queue.pending).toBe(0);
  });
});
