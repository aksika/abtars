import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatSystem } from "./heartbeat-system.js";
import type { HeartbeatTask } from "../types/index.js";

function makeHb() {
  return new HeartbeatSystem({ enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
}

describe("HeartbeatSystem", { timeout: 30000 }, () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start when disabled", () => {
    const hb = new HeartbeatSystem({ enabled: false, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
    hb.start();
    expect(hb.isRunning).toBe(false);
  });

  it("registers and runs tasks on tick", async () => {
    const hb = makeHb();
    const task: HeartbeatTask = { name: "test-task", execute: vi.fn().mockResolvedValue({ state: "idle" }) };
    hb.registerTask(task);
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(task.execute).toHaveBeenCalled();
    hb.stop();
  });

  it("stop clears timers", () => {
    const hb = makeHb();
    hb.start();
    hb.stop();
    expect(hb.isRunning).toBe(false);
  });

  it("calls onTick callback", async () => {
    const onTick = vi.fn();
    const hb = new HeartbeatSystem({ enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock", onTick });
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(onTick).toHaveBeenCalled();
    hb.stop();
  });

  it("seeds ? marker on register", () => {
    const hb = makeHb();
    hb.registerTask({ name: "test", execute: async () => ({ state: "idle" }) });
    const statuses = hb.getTaskStatuses();
    expect(statuses.get("test")).toEqual({ marker: "?", state: "never", detail: undefined });
  });

  it("maps ran outcome to ✓ marker", async () => {
    const hb = makeHb();
    hb.registerTask({ name: "test", execute: async () => ({ state: "ran", detail: "did work" }) });
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const st = hb.getTaskStatuses().get("test");
    expect(st?.marker).toBe("✓");
    expect(st?.state).toBe("ran");
    expect(st?.detail).toBe("did work");
    hb.stop();
  });

  it("maps idle outcome to — marker", async () => {
    const hb = makeHb();
    hb.registerTask({ name: "test", execute: async () => ({ state: "idle" }) });
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(hb.getTaskStatuses().get("test")?.marker).toBe("—");
    hb.stop();
  });

  it("maps exception to ✗ marker with bounded detail", async () => {
    const hb = makeHb();
    hb.registerTask({ name: "test", execute: async () => { throw new Error("boom"); } });
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const st = hb.getTaskStatuses().get("test");
    expect(st?.marker).toBe("✗");
    expect(st?.state).toBe("failed");
    expect(st?.detail).toContain("boom");
    hb.stop();
  });

  it("maps heavy skipped to — marker", async () => {
    const hb = makeHb();
    hb.registerTask({ name: "heavy", heavy: true, execute: async () => ({ state: "ran" }) });
    hb.registerTask({ name: "heavy2", heavy: true, execute: async () => ({ state: "ran" }) });
    hb.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    const st1 = hb.getTaskStatuses().get("heavy");
    const st2 = hb.getTaskStatuses().get("heavy2");
    expect(st1?.marker).toBe("✓");
    expect(st2?.marker).toBe("—");
    expect(st2?.state).toBe("skipped");
    hb.stop();
  });

  it("registers task names", () => {
    const hb = makeHb();
    hb.registerTask({ name: "a", execute: async () => ({ state: "idle" }) });
    hb.registerTask({ name: "b", execute: async () => ({ state: "idle" }) });
    expect(hb.getTaskNames()).toEqual(["a", "b"]);
  });

  it("provides intervalMs", () => {
    const hb = new HeartbeatSystem({ enabled: true, intervalMs: 12345, bridgeLockPath: "/tmp/test.lock" });
    expect(hb.intervalMs).toBe(12345);
  });
});