import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";
import { CronQueue } from "./cron-queue.js";
import type { CronEntry } from "../../cli/agentbridge-task.js";

// Mock child_process.spawn so no real bash commands run.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

// Mock cron-db so no real SQLite file is touched.
vi.mock("./cron-db.js", () => ({
  recordRun: vi.fn(),
  readEntry: vi.fn(),
  writeEntry: vi.fn(),
}));

// Controllable fake child used by spawn(). Test drives exit via `fakeChild.emit("exit", code)`.
function makeFakeChild(): child_process.ChildProcess {
  const child = new EventEmitter() as unknown as child_process.ChildProcess;
  (child as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
  (child as unknown as { pid: number }).pid = 99999;
  (child as unknown as { killed: boolean }).killed = false;
  return child;
}

function makeEntry(overrides: Partial<CronEntry> = {}): CronEntry {
  return {
    id: "t" + Math.random().toString(36).slice(2, 6),
    fireAt: Date.now() - 1000,
    message: "echo test",
    chatId: 1,
    type: "task",
    executor: "script",
    fired: false,
    createdAt: Date.now(),
    ...overrides,
  };
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
    // Complete any still-running child so dangling timers don't leak into other tests.
    for (const c of activeChildren) {
      if (!c.listenerCount("exit")) continue;
      c.emit("exit", 0);
    }
  });

  it("starts with no current job and empty queue", () => {
    expect(queue.currentJob).toBeNull();
    expect(queue.pending).toBe(0);
  });

  it("enqueue starts processing immediately if idle", () => {
    queue.enqueue(makeEntry({ id: "s1", message: "echo hi" }));
    expect(queue.currentJob).not.toBeNull();
    expect(queue.currentJob!.entryId).toBe("s1");
    expect(vi.mocked(child_process.spawn)).toHaveBeenCalledTimes(1);
  });

  it("deduplicates by entry ID (queued)", () => {
    queue.enqueue(makeEntry({ id: "s1" }));           // starts running
    queue.enqueue(makeEntry({ id: "s2" }));           // queued
    queue.enqueue(makeEntry({ id: "s2" }));           // duplicate, skipped
    expect(queue.pending).toBe(1);
  });

  it("deduplicates by entry ID (running)", () => {
    queue.enqueue(makeEntry({ id: "s1" }));           // starts running
    queue.enqueue(makeEntry({ id: "s1" }));           // duplicate of running, skipped
    expect(queue.pending).toBe(0);
  });

  it("priority-sorts: high promoted ahead of medium and low when current job finishes", () => {
    queue.enqueue(makeEntry({ id: "running" }));
    queue.enqueue(makeEntry({ id: "low1",  priority: "low" }));
    queue.enqueue(makeEntry({ id: "hi1",   priority: "high" }));
    queue.enqueue(makeEntry({ id: "med1",  priority: "medium" }));
    expect(queue.pending).toBe(3);

    // Complete the running job — next pick should be "hi1" (highest priority)
    activeChildren[0]!.emit("exit", 0);
    expect(queue.currentJob?.entryId).toBe("hi1");

    // Complete it — next is "med1"
    activeChildren[1]!.emit("exit", 0);
    expect(queue.currentJob?.entryId).toBe("med1");

    // And finally "low1"
    activeChildren[2]!.emit("exit", 0);
    expect(queue.currentJob?.entryId).toBe("low1");
  });
});
