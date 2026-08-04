import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LifecycleWakeScheduler, type LifecycleDueItem, type LifecycleDueSource, type LifecycleDueSourceId } from "./lifecycle-wake-scheduler.js";

function makeSource(id: LifecycleDueSourceId, items: LifecycleDueItem[], wake: (now: number) => void | Promise<void>): LifecycleDueSource {
  return { id, listDueItems: vi.fn(() => items), wakeDue: vi.fn(wake) };
}

function collect(calls: Array<{ source: string; now: number }>) {
  return (source: string) => async (now: number) => { calls.push({ source, now }); };
}

describe("LifecycleWakeScheduler #1539", () => {
  let scheduler: LifecycleWakeScheduler;
  let calls: Array<{ source: string; now: number }>;

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    scheduler = new LifecycleWakeScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it("arms a single timer for the earliest future due item and wakes it at due time", async () => {
    const now = Date.now();
    const source = makeSource("run-deadline", [
      { key: "a", dueAt: now + 10_000 },
      { key: "b", dueAt: now + 30_000 },
    ], collect(calls)("run-deadline"));
    scheduler.register(source);
    await scheduler.start();

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    // The earliest item woke the source; the timer re-armed for item b.
    expect(calls).toEqual([{ source: "run-deadline", now: expect.any(Number) }]);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // Item b fired its own level-triggered wake.
    expect(calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wakes every overdue item on the boot scan (start) before arming", async () => {
    const now = Date.now();
    const source = makeSource("task-admission", [
      { key: "a", dueAt: now - 5_000 },
      { key: "b", dueAt: now - 1_000 },
      { key: "c", dueAt: now + 60_000 },
    ], collect(calls)("task-admission"));
    scheduler.register(source);
    await scheduler.start();
    expect(calls).toEqual([{ source: "task-admission", now: expect.any(Number) }]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("re-arms when a source mutation changes the earliest due time", async () => {
    const now = Date.now();
    const items: LifecycleDueItem[] = [{ key: "a", dueAt: now + 60_000 }];
    const source = makeSource("kanban-retry", items, collect(calls)("kanban-retry"));
    scheduler.register(source);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);

    items[0] = { key: "a", dueAt: now + 5_000 };
    scheduler.sourceChanged("kanban-retry");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
  });

  it("serializes async wakes per source and rescans a dirtied source before arming", async () => {
    const now = Date.now();
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const items: LifecycleDueItem[] = [{ key: "a", dueAt: now - 1 }];
    const source: LifecycleDueSource = {
      id: "executor-lease",
      listDueItems: () => items,
      wakeDue: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (calls.length === 0) await firstGate;
        inFlight--;
        calls.push({ source: "executor-lease", now: Date.now() });
      }),
    };
    scheduler.register(source);
    const startPromise = scheduler.start();
    // While the first wake is in flight, a source mutation marks it dirty.
    scheduler.sourceChanged("executor-lease");
    resolveFirst();
    await startPromise;
    // Serialized: never two wakes in flight. The dirtied source was rescanned
    // and its still-overdue item woke once more (level-triggered), then no
    // timer is armed for a due item (no tight loop).
    expect(maxInFlight).toBe(1);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is a no-op for the safety scan while a timer is armed or a scan is running", async () => {
    const now = Date.now();
    const source = makeSource("task-admission", [{ key: "a", dueAt: now + 30_000 }], collect(calls)("task-admission"));
    scheduler.register(source);
    await scheduler.start();
    scheduler.safetyScan();
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("safety scan wakes overdue items only when the scheduler is completely idle", async () => {
    const now = Date.now();
    const source = makeSource("task-admission", [{ key: "a", dueAt: now - 1 }], collect(calls)("task-admission"));
    scheduler.register(source);
    // Never started: no timer armed, no scan running.
    scheduler.safetyScan();
    expect(calls).toEqual([{ source: "task-admission", now: expect.any(Number) }]);
  });

  it("excludes invalid dates instead of arming a tight loop", async () => {
    const now = Date.now();
    const source = makeSource("kanban-retry", [
      { key: "bad", dueAt: Number.NaN },
      { key: "neg", dueAt: -Infinity },
      { key: "good", dueAt: now + 60_000 },
    ], collect(calls)("kanban-retry"));
    scheduler.register(source);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(calls).toHaveLength(1);
  });

  it("re-arms clamped long delays", async () => {
    const now = Date.now();
    const far = now + 3_000_000_000;
    const source = makeSource("run-deadline", [{ key: "far", dueAt: far }], collect(calls)("run-deadline"));
    scheduler.register(source);
    await scheduler.start();
    expect(vi.getTimerCount()).toBe(1);
    // Max clamp fires early; the scan re-arms with the remaining delay.
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stop clears the timer and makes further scans no-ops", async () => {
    const now = Date.now();
    const source = makeSource("task-admission", [{ key: "a", dueAt: now + 10_000 }], collect(calls)("task-admission"));
    scheduler.register(source);
    await scheduler.start();
    scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(calls).toHaveLength(0);
  });

  it("unregister removes a source from future scans", async () => {
    const now = Date.now();
    const source = makeSource("kanban-retry", [{ key: "a", dueAt: now + 5_000 }], collect(calls)("kanban-retry"));
    const unregister = scheduler.register(source);
    await scheduler.start();
    unregister();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
