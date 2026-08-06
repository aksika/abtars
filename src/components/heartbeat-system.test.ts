import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatSystem } from "./heartbeat-system.js";
import { updateLastHeartbeat as updateLastHeartbeatMock } from "./transport/bridge-lock-transport.js";
import type { HeartbeatTask, HeartbeatTaskOutcome } from "../types/index.js";

vi.mock("./transport/bridge-lock-transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport/bridge-lock-transport.js")>();
  return { ...actual, updateLastHeartbeat: vi.fn(actual.updateLastHeartbeat) };
});

// The standby threshold is 180min on WSL but 3x the tick interval elsewhere. Pin
// isWsl() to false so the standby-detection tests exercise the same path Molty
// runs on, independently of the host the suite happens to execute on.
vi.mock("./platform-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./platform-detect.js")>();
  return { ...actual, isWsl: () => false };
});

function makeHb() {
  return new HeartbeatSystem({ enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock" });
}

describe("HeartbeatSystem", { timeout: 30000 }, () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
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

  it("#1584: a hung task does not block the liveness write", async () => {
    const hb = makeHb();
    const hung = vi.fn().mockImplementation(() => new Promise<never>(() => {}));
    hb.registerTask({ name: "hung", execute: hung });
    hb.start();
    await vi.advanceTimersByTimeAsync(5000 + 10);
    expect(updateLastHeartbeatMock).toHaveBeenCalled();
    hb.stop();
  });

  it("#1584: a task hanging past the standby threshold must not trigger a standby restart", async () => {
    const onStandbyResume = vi.fn();
    let release: (() => void) | null = null;
    const hung = vi.fn().mockImplementation(
      () => new Promise<HeartbeatTaskOutcome>((resolve) => { release = () => resolve({ state: "idle" }); }),
    );
    const hb = new HeartbeatSystem({
      enabled: true, intervalMs: 5000, bridgeLockPath: "/tmp/test.lock", onStandbyResume,
    });
    hb.registerTask({ name: "hung", execute: hung });
    hb.start();

    // First tick runs and hangs; the next four fire and are skipped. The skipped
    // span (20s) exceeds the 15s standby threshold (3 x interval).
    await vi.advanceTimersByTimeAsync(5000 + 10);
    await vi.advanceTimersByTimeAsync(4 * 5000);
    release?.();
    await vi.advanceTimersByTimeAsync(5000 + 10);

    expect(onStandbyResume).not.toHaveBeenCalled();
    hb.stop();
  });

  it("#1584: a hung task does not produce overlapping task passes", async () => {
    const hb = makeHb();
    const hung = vi.fn().mockImplementation(() => new Promise<never>(() => {}));
    hb.registerTask({ name: "hung", execute: hung });
    hb.registerTask({ name: "after", execute: vi.fn().mockResolvedValue({ state: "idle" }) });
    hb.start();
    vi.advanceTimersByTime(2 * 5000 + 10);
    expect(hung).toHaveBeenCalledTimes(1);
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