import { describe, it, expect } from "vitest";
import { HardwareSleepController } from "./hardware-sleep-controller.js";
import { PowerTransitionStore } from "./power-transition-store.js";
import { createPowerSafetyProbe } from "./power-safety-probe.js";
import type { PowerSafetyProbe, PowerAdapter, FixedCommandRunner } from "./types.js";

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
  const NO_TEST_RUNTIME = () => false;

  it("inspect returns safe with all pass", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore(), NO_TEST_RUNTIME);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.inspect(entry);
    expect(r.safe).toBe(true);
    expect(r.suspendCommand).toBe("pmset sleepnow");
    expect(r.platform).toBe("darwin");
  });

  it("attempt returns ok and writes transition", async () => {
    const store = new PowerTransitionStore();
    let suspended = false;
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async (cmd, args) => {
      if (args[0] === "sleepnow") { suspended = true; return { stdout: "", stderr: "", exitCode: 0 }; }
      return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
    }), store, NO_TEST_RUNTIME);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("ok");
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
    const ctrl = new HardwareSleepController(probe, makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore(), NO_TEST_RUNTIME);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("deferred");
    expect("retryAt" in r && typeof r.retryAt).toBe("number");
  });

  it("attempt returns noop when outside window", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), new PowerTransitionStore(), NO_TEST_RUNTIME);
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "00:00", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("noop");
  });

  it("attempt fails on unsupported platform", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), null, new PowerTransitionStore(), NO_TEST_RUNTIME);
    const entry = { id: "test" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("failed");
    expect(r).toEqual({ status: "failed", error: "hardware-sleep not supported on this platform" });
  });

  it("attempt fails on unverified wake", async () => {
    const ctrl = new HardwareSleepController(makeSafeProbe(), makeAdapter(async () => ({ stdout: "no repeating events", stderr: "", exitCode: 0 })), new PowerTransitionStore(), NO_TEST_RUNTIME);
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
    const ctrl = new HardwareSleepController(probe, makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), store, NO_TEST_RUNTIME);
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
    }), store, NO_TEST_RUNTIME);
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
    }), new PowerTransitionStore(), NO_TEST_RUNTIME);
    // latestLocalTime must be in the future relative to test run time
    const entry = { id: "test", idleMinutes: 20, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    await ctrl.inspect(entry);
    expect(suspendCalled).toBe(false);
  });

  it("attempt fails under test runtime with structural interlock", async () => {
    const ctrl = new HardwareSleepController(
      makeSafeProbe(),
      makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })),
      new PowerTransitionStore(),
      () => true, // simulate test runtime
    );
    const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
    const r = await ctrl.attempt(entry);
    expect(r.status).toBe("failed");
    expect(r).toEqual({ status: "failed", error: "hardware suspend disabled under test runtime" });
  });

  describe("#1517 attempt-aware second check", () => {
    function attemptAwareProbe(store: PowerTransitionStore, beforeSecondCheck?: () => void): PowerSafetyProbe {
      let secondCheck = false;
      return createPowerSafetyProbe({
        lastPromptAt: () => Date.now() - 30 * 60 * 1000,
        isAnyExecutionActive: () => false,
        isSleepCycleActive: () => false,
        isTaskQueueEmpty: () => true,
        isMaintenanceActive: () => false,
        isTransitionActive: (excludeAttemptId?: string) => {
          if (secondCheck) {
            beforeSecondCheck?.();
            secondCheck = false;
          } else {
            secondCheck = true;
          }
          return store.isActiveExcept(excludeAttemptId);
        },
        isPlatformSupported: () => true,
      });
    }

    it("passes its own second check and suspends, retaining the marker", async () => {
      const store = new PowerTransitionStore();
      store.clear();
      let suspended = false;
      const ctrl = new HardwareSleepController(attemptAwareProbe(store), makeAdapter(async (cmd, args) => {
        if (args[0] === "sleepnow") { suspended = true; return { stdout: "", stderr: "", exitCode: 0 }; }
        return { stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 };
      }), store, NO_TEST_RUNTIME);
      const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
      const r = await ctrl.attempt(entry);
      expect(r.status).toBe("ok");
      expect(suspended).toBe(true);
      // An issued suspend retains the transition marker for wake/expiry recovery.
      const retained = store.read();
      expect(retained).not.toBeNull();
      expect(retained!.attemptId).toBeDefined();
    });

    it("blocks on a pre-existing foreign marker without touching it", async () => {
      const store = new PowerTransitionStore();
      store.clear();
      store.write({
        state: "suspending", taskId: "hardware-sleep", requestedAt: Date.now(),
        expiresAt: Date.now() + 3600_000, expectedWakeAt: Date.now() + 8 * 3600_000,
        attemptId: "foreign-attempt",
      });
      const ctrl = new HardwareSleepController(attemptAwareProbe(store), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), store, NO_TEST_RUNTIME);
      const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
      const r = await ctrl.attempt(entry);
      expect(r.status).toBe("deferred");
      expect(store.read()?.attemptId).toBe("foreign-attempt");
    });

    it("blocks when a replacement marker appears before the second check and keeps the newer marker", async () => {
      const store = new PowerTransitionStore();
      store.clear();
      const ctrl = new HardwareSleepController(attemptAwareProbe(store, () => {
        store.write({
          state: "suspending", taskId: "hardware-sleep", requestedAt: Date.now(),
          expiresAt: Date.now() + 3600_000, expectedWakeAt: Date.now() + 8 * 3600_000,
          attemptId: "replacement-attempt",
        });
      }), makeAdapter(async () => ({ stdout: MOLTY_FIXTURE, stderr: "", exitCode: 0 })), store, NO_TEST_RUNTIME);
      const entry = { id: "test", idleMinutes: 20, retryMinutes: 10, latestLocalTime: "23:59", expectedWakeTime: "07:55" } as any;
      const r = await ctrl.attempt(entry);
      expect(r.status).toBe("deferred");
      // The failing attempt's cleanup must not erase the newer marker.
      expect(store.read()?.attemptId).toBe("replacement-attempt");
    });

    it("treats a legacy marker without an attempt ID as active and does not exclude it", async () => {
      const store = new PowerTransitionStore();
      store.clear();
      store.write({
        state: "suspending", taskId: "hardware-sleep", requestedAt: Date.now(),
        expiresAt: Date.now() + 3600_000, expectedWakeAt: Date.now() + 8 * 3600_000,
      });
      expect(store.isActiveExcept("any-attempt-id")).toBe(true);
      expect(store.clearIfOwned("any-attempt-id")).toBe(false);
      expect(store.read()).not.toBeNull();
    });
  });
});
