import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HeartbeatSystem } from "../components/heartbeat-system.js";
import {
  normalizeInstallType,
  decideStandbyResumeAction,
  createStandbyResumeHandler,
  type InstallType,
} from "./phase-heartbeat.js";

// Standby detection thresholds differ on WSL; pin isWsl false so the seam
// tests below exercise the same 3x-interval path production Mac/Linux runs.
vi.mock("../components/platform-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../components/platform-detect.js")>();
  return { ...actual, isWsl: () => false };
});

describe("normalizeInstallType", () => {
  it("defaults missing input to server", () => {
    expect(normalizeInstallType(undefined)).toBe("server");
  });

  it("accepts server and notebook case-insensitively with whitespace", () => {
    expect(normalizeInstallType("server")).toBe("server");
    expect(normalizeInstallType("  NOTEBOOK  ")).toBe("notebook");
  });

  it("fails safe to server on unrecognized values", () => {
    expect(normalizeInstallType("laptop")).toBe("server");
    expect(normalizeInstallType("")).toBe("server");
  });
});

describe("decideStandbyResumeAction", () => {
  it("exits only for daemon + server + attached supervisor", () => {
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "server", supervised: true })).toBe("exit");
  });

  it("continues when any single condition is missing", () => {
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "server", supervised: false })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "daemon", installType: "notebook", supervised: true })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "simple", installType: "server", supervised: true })).toBe("continue");
    expect(decideStandbyResumeAction({ installMode: "simple", installType: "notebook", supervised: false })).toBe("continue");
  });
});

describe("createStandbyResumeHandler wiring", () => {
  const gapMs = 7 * 60 * 1000;

  function effects() {
    return { exit: vi.fn(), writeReason: vi.fn() };
  }

  it("dark resume never exits and writes no restart reason", () => {
    const { exit, writeReason } = effects();
    const handler = createStandbyResumeHandler({
      installMode: "daemon", installType: "server", supervised: true,
      classify: () => "dark", exit, writeReason,
    });
    handler(gapMs);
    expect(exit).not.toHaveBeenCalled();
    expect(writeReason).not.toHaveBeenCalled();
  });

  it("full resume on daemon+server+supervisor exits with restart reason", () => {
    const { exit, writeReason } = effects();
    const handler = createStandbyResumeHandler({
      installMode: "daemon", installType: "server", supervised: true,
      classify: () => "full", exit, writeReason,
    });
    handler(gapMs);
    expect(writeReason).toHaveBeenCalledWith("resume after 7min suspend");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("full resume continues without exit or restart reason otherwise", () => {
    const cases = [
      { installMode: "daemon", installType: "notebook" as const, supervised: true },
      { installMode: "daemon", installType: "server" as const, supervised: false },
      { installMode: "simple", installType: "server" as const, supervised: false },
    ];
    for (const ctx of cases) {
      const { exit, writeReason } = effects();
      const handler = createStandbyResumeHandler({ ...ctx, classify: () => "full", exit, writeReason });
      handler(gapMs);
      expect(exit).not.toHaveBeenCalled();
      expect(writeReason).not.toHaveBeenCalled();
    }
  });
});

describe("standby resume through HeartbeatSystem (seam wiring)", () => {
  beforeEach(() => { vi.useFakeTimers({ now: 0 }); });
  afterEach(() => { vi.useRealTimers(); });

  // Drives a real heartbeat through one normal tick and one simulated
  // suspend: the interval timer fires only once after the clock jump, so
  // the recorded task executions prove whether the standby tick ran tasks.
  async function runStandbyTick(ctx: { installMode: string; installType: InstallType; supervised: boolean }) {
    const exit = vi.fn();
    const writeReason = vi.fn();
    const task = vi.fn().mockResolvedValue({ state: "idle" as const });
    const hb = new HeartbeatSystem({
      enabled: true,
      intervalMs: 5000,
      bridgeLockPath: "/tmp/test.lock",
      onStandbyResume: createStandbyResumeHandler({ ...ctx, classify: () => "full", exit, writeReason }),
    });
    hb.registerTask({ name: "probe", execute: task });
    hb.start();
    await vi.advanceTimersByTimeAsync(5000 + 10);
    const taskCallsBeforeSuspend = task.mock.calls.length;
    vi.setSystemTime(60_000);
    await vi.advanceTimersByTimeAsync(5000 + 10);
    hb.stop();
    return { exit, writeReason, task, taskCallsBeforeSuspend };
  }

  it("notebook resume keeps the bridge alive and skips the standby tick", async () => {
    const { exit, writeReason, task, taskCallsBeforeSuspend } = await runStandbyTick({
      installMode: "daemon", installType: "notebook", supervised: true,
    });
    expect(exit).not.toHaveBeenCalled();
    expect(writeReason).not.toHaveBeenCalled();
    expect(task.mock.calls.length).toBe(taskCallsBeforeSuspend);
  });

  it("daemon+server+supervisor resume exits for a supervised restart", async () => {
    const { exit, writeReason, task, taskCallsBeforeSuspend } = await runStandbyTick({
      installMode: "daemon", installType: "server", supervised: true,
    });
    expect(writeReason).toHaveBeenCalledWith("resume after 1min suspend");
    expect(exit).toHaveBeenCalledWith(0);
    expect(task.mock.calls.length).toBe(taskCallsBeforeSuspend);
  });
});
