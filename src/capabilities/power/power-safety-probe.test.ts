import { describe, it, expect } from "vitest";
import { createPowerSafetyProbe } from "./power-safety-probe.js";

function makeReaders(overrides: Partial<ReturnType<typeof makeDefaultReaders>> = {}) {
  return { ...makeDefaultReaders(), ...overrides };
}

function makeDefaultReaders() {
  return {
    lastPromptAt: () => Date.now() - 30 * 60 * 1000, // 30 min ago
    isAnyExecutionActive: () => false,
    isSleepCycleActive: () => false,
    isTaskQueueEmpty: () => true,
    isMaintenanceActive: () => false,
    isTransitionActive: () => false,
    isPlatformSupported: () => true,
  };
}

describe("PowerSafetyProbe", () => {
  it("returns safe when all conditions pass", () => {
    const probe = createPowerSafetyProbe(makeReaders());
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "23:59" });
    expect(result.safe).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks on recent user activity", () => {
    const probe = createPowerSafetyProbe(makeReaders({ lastPromptAt: () => Date.now() - 5 * 60 * 1000 }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.safe).toBe(false);
    expect(result.reasons).toContain("recent_user_activity");
  });

  it("blocks on active execution", () => {
    const probe = createPowerSafetyProbe(makeReaders({ isAnyExecutionActive: () => true }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.reasons).toContain("active_execution");
  });

  it("blocks on sleep cycle active", () => {
    const probe = createPowerSafetyProbe(makeReaders({ isSleepCycleActive: () => true }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.reasons).toContain("sleep_cycle_active");
  });

  it("blocks on non-empty task queue", () => {
    const probe = createPowerSafetyProbe(makeReaders({ isTaskQueueEmpty: () => false }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.reasons).toContain("task_queue_busy");
  });

  it("blocks on active transition", () => {
    const probe = createPowerSafetyProbe(makeReaders({ isTransitionActive: () => true }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.reasons).toContain("transition_active");
  });

  it("blocks on unsupported platform", () => {
    const probe = createPowerSafetyProbe(makeReaders({ isPlatformSupported: () => false }));
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: "05:30" });
    expect(result.reasons).toContain("unsupported_platform");
  });

  it("blocks when outside window", () => {
    const future = new Date();
    future.setHours(future.getHours() + 1);
    const hour = String(future.getHours()).padStart(2, "0");
    const min = String(future.getMinutes()).padStart(2, "0");
    const probe = createPowerSafetyProbe(makeReaders());
    // Use a time just a few minutes from now as limit
    const soon = new Date(Date.now() - 60 * 1000); // 1 min ago
    const soonStr = `${String(soon.getHours()).padStart(2, "0")}:${String(soon.getMinutes()).padStart(2, "0")}`;
    const result = probe.inspect({ idleMinutes: 20, latestLocalTime: soonStr });
    expect(result.reasons).toContain("outside_window");
  });
});
