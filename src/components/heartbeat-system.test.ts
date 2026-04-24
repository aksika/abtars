import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatSystem } from "./heartbeat-system.js";

describe("HeartbeatSystem", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("does not start when disabled", () => {
    const hb = new HeartbeatSystem({ enabled: false, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
    hb.start();
    expect(hb.isRunning).toBe(false);
  });

  it("registers and runs tasks on tick", async () => {
    const hb = new HeartbeatSystem({ enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
    const task = { name: "test-task", execute: vi.fn().mockResolvedValue(undefined) };
    hb.registerTask(task);
    hb.start();
    // Advance past initial delay + first tick
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(task.execute).toHaveBeenCalled();
    hb.stop();
  });

  it("stop clears timers", () => {
    const hb = new HeartbeatSystem({ enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
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
});
