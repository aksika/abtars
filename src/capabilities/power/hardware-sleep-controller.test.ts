import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { HardwareSleepController } from "./hardware-sleep-controller.js";
import { PowerTransitionStore } from "./power-transition-store.js";
import { createPowerSafetyProbe } from "./power-safety-probe.js";
import type { PowerSafetyProbe, PowerAdapter, FixedCommandRunner } from "./types.js";

const TEST_FILE = join(homedir(), ".abtars", "state", "power-transition.json");

function makeSafeProbe(): PowerSafetyProbe {
  return createPowerSafetyProbe({
    lastPromptAt: () => Date.now() - 30 * 60 * 1000,
    isAnyExecutionActive: () => false,
    isSleepCycleActive: () => false,
    isTaskQueueEmpty: () => true,
    isMaintenanceActive: () => false,
    isTransitionActive: () => false,
    isPlatformSupported: () => true,
  });
}

function makeAdapter(run?: FixedCommandRunner): PowerAdapter {
  const fakeRun = run ?? (async () => ({ stdout: "", stderr: "", exitCode: 0 }));
  return {
    platform: "darwin",
    verifyWakeSchedule: async (expectedLocalTime: string) => {
      const { stdout } = await fakeRun("/usr/bin/pmset", ["-g", "sched"]);
      const { parsePmsetSchedOutput } = await import("./pmset-parser.js");
      return parsePmsetSchedOutput(stdout, expectedLocalTime);
    },
    suspend: async () => {
      await fakeRun("/usr/bin/pmset", ["sleepnow"]);
    },
  };
}

const MOLTY_FIXTURE = `Repeating power events:\n  wakepoweron at 7:55AM every day\n`;

describe("HardwareSleepController", () => {
  beforeEach(() => {
    try { mkdirSync(join(homedir(), ".abtars", "state"), { recursive: true }); } catch {}
    try { unlinkSync(TEST_FILE); } catch {}
  });

  afterEach(() => {
    try { unlinkSync(TEST_FILE); } catch {}
  });

  it("inspect returns safe with all pass", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore());
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.inspect(entry);
    expect(r.safe).toBe(true);
    expect(r.suspendCommand).toBe("pmset sleepnow");
    expect(r.platform).toBe("darwin");
  });

  it("attempt returns accepted and writes transition", async () => {
    const store = new PowerTransitionStore();
    let suspended = false;
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async (cmd, args) => {
      if (args[0] === "sleepnow") { suspended = true; return { stdout: "", stderr: "", exitCode: 0 }; }
      return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
    }), store);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("accepted");
    expect(suspended).toBe(true);
    expect(store.read()).not.toBeNull();
  });

  it("attempt defers on busy", async () => {
    const probe = createPowerSafetyProbe({
      lastPromptAt: () => Date.now() - 5 * 60 * 1000, // 5 min ago — less than 20 min idle
      isAnyExecutionActive: () => false,
      isSleepCycleActive: () => false,
      isTaskQueueEmpty: () => true,
      isMaintenanceActive: () => false,
      isTransitionActive: () => false,
      isPlatformSupported: () => true,
    });
    const ctrl = new HardwareSleepController(probe, makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore());
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("deferred");
    expect("retryAt" in r && typeof r.retryAt).toBe("number");
  });

  it("attempt returns noop when outside window", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const pastStr = `${String(past.getHours()).padStart(2, "0")}:${String(past.getMinutes()).padStart(2, "0")}`;
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore());
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: pastStr, expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("noop");
  });

  it("attempt fails on unsupported platform", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), null, new PowerTransitionStore());
    const entry = { id: "test" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("failed");
    expect(r).toEqual({ status: "failed", error: "hardware-sleep not supported on this platform" });
  });

  it("attempt fails on unverified wake", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: "no repeating events", stderr: "", exitCode: 0 })), new PowerTransitionStore());
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("failed");
  });

  it("attempt clears transition on second-check failure", async () => {
    const store = new PowerTransitionStore();
    let secondCheck = false;
    const probe = createPowerSafetyProbe({
      lastPromptAt: () => Date.now() - 30 * 60 * 1000,
      isAnyExecutionActive: () => secondCheck,
      isSleepCycleActive: () => false,
      isTaskQueueEmpty: () => true,
      isMaintenanceActive: () => false,
      isTransitionActive: () => {
        if (!secondCheck) { secondCheck = true; return false; }
        return true; // block on second check
      },
      isPlatformSupported: () => true,
    });
    const ctrl = new HardwareSleepController(probe, makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), store);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("deferred");
    expect(store.read()).toBeNull();
  });

  it("attempt clears transition on suspend error", async () => {
    const store = new PowerTransitionStore();
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async (cmd, args) => {
      if (args[0] === "sleepnow") throw new Error("suspend failed");
      return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
    }), store);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("failed");
    expect(store.read()).toBeNull();
  });

  it("inspect returns zero suspend calls", async () => {
    let suspendCalled = false;
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async (cmd, args) => {
      if (args[0] === "sleepnow") { suspendCalled = true; return { stdout: "", stderr: "", exitCode: 0 }; }
      return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
    }), new PowerTransitionStore());
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    await ctrl.inspect(entry);
    expect(suspendCalled).toBe(false);
  });
});
