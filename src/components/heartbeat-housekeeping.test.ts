import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHousekeepingTask } from "./heartbeat-housekeeping.js";
import type { AbtarsMemoryRuntime } from "./memory-runtime.js";
import { createDisabledRuntime } from "./memory-runtime.js";

function makeMemoryRuntime(overrides?: Partial<AbtarsMemoryRuntime>): AbtarsMemoryRuntime {
  return { ...createDisabledRuntime(), state: "ready" as const, ...overrides } as AbtarsMemoryRuntime;
}

describe("createHousekeepingTask", () => {
  let clock: number;
  let deps: ReturnType<typeof defaultDeps>;

  function defaultDeps() {
    return {
      now: () => clock,
      heartbeatIntervalMs: 60_000,
      memoryRuntime: null as AbtarsMemoryRuntime | null,
      cronQueueDepth: () => 0,
      notifyUpdate: vi.fn(),
    };
  }

  beforeEach(() => {
    clock = 100_000_000;
    deps = defaultDeps();
  });

  it("runs due children on first tick (nextEligibleAt starts at 0)", async () => {
    const task = createHousekeepingTask(deps);
    const result = await task.execute();
    expect(result.state).toBe("ran");
    expect(result.detail).toContain("metrics-sample");
    expect(result.detail).toContain("metrics-flush");
  });

  it("returns idle when no child is due on a subsequent tick", async () => {
    const task = createHousekeepingTask(deps);
    await task.execute();

    // Tick again immediately — no child should be due
    clock += 1000;
    const result = await task.execute();
    expect(result.state).toBe("idle");
    expect(result.detail).toBe("no work due");
  });

  it("runs a child again after its interval elapses", async () => {
    const task = createHousekeepingTask(deps);
    await task.execute();

    // Advance past metrics-sample's interval (heartbeatIntervalMs = 60s)
    clock += 61_000;
    const result = await task.execute();
    expect(result.state).toBe("ran");
    expect(result.detail).toContain("metrics-sample");
  });

  it("runs a child again after its interval elapses", async () => {
    clock = 1_000_000_000;
    const task = createHousekeepingTask(deps);
    await task.execute();

    // Advance past metrics-sample's interval (heartbeatIntervalMs = 60s)
    clock += 61_000;
    const result = await task.execute();
    expect(result.state).toBe("ran");
    expect(result.detail).toContain("metrics-sample");
  });

  it("isolates child failures and continues to next due child", async () => {
    deps.cronQueueDepth = () => { throw new Error("queue error"); };
    const task = createHousekeepingTask(deps);
    // metrics-sample fails, but later children still run before the aggregate failure.
    await expect(task.execute()).rejects.toThrow(/metrics-sample: queue error/);
  });

  it("produces correct elapsed-time schedules for 60s and 300s intervals", async () => {
    for (const intervalSec of [60, 300]) {
      deps = defaultDeps();
      deps.heartbeatIntervalMs = intervalSec * 1000;

      const task = createHousekeepingTask(deps);
      const result = await task.execute();
      expect(result.state).toBe("ran");
      expect(result.detail).toContain("metrics-sample");
    }
  });

  it("handles db-integrity with memory dependency", async () => {
    const runMaintenance = vi.fn().mockResolvedValue({ ok: true, summary: "integrity ok" });
    deps.memoryRuntime = makeMemoryRuntime({ runMaintenance });
    const task = createHousekeepingTask(deps);
    await task.execute();
  });

  it("escalates after 5 consecutive db-integrity failures", async () => {
    const runMaintenance = vi.fn().mockResolvedValue({ ok: false, summary: "corrupt" });
    deps.memoryRuntime = makeMemoryRuntime({ runMaintenance });

    const task = createHousekeepingTask(deps);
    for (let i = 0; i < 6; i++) {
      clock += 3600_001;
      if (i < 5) {
        await expect(task.execute()).rejects.toThrow(/Integrity failed/);
      } else {
        await expect(task.execute()).resolves.toMatchObject({ state: "ran" });
      }
    }
    expect(runMaintenance).toHaveBeenCalled();
  });

  it("does not catch up after a missed tick", async () => {
    const task = createHousekeepingTask(deps);
    await task.execute();

    clock += 86400_000;
    const result = await task.execute();
    expect(result.state).toBe("ran");

    clock += 1000;
    const result2 = await task.execute();
    expect(result2.state).toBe("idle");
  });
});
