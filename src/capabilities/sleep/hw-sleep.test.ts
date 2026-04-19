import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as child_process from "node:child_process";

const { HOME, SLEEP_DIR } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const HOME = join(tmpdir(), `ab-hwsleep-test-${process.pid}`);
  return {
    HOME,
    SLEEP_DIR: join(HOME, "sleep"),
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn(), execSync: vi.fn() };
});

vi.mock("../../paths.js", () => ({
  agentBridgeHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
  readAndClearForceSleep: vi.fn(() => null),
}));

import { createSleepHandle, type SleepHandle, type SleepOpts } from "./index.js";
import { readAndClearForceSleep } from "../../components/transport/bridge-lock-transport.js";

/** Drive Dreamy-exit so _awaitingHwSleep flips to true + counters reset. */
function armHwSleep(opts: Required<Pick<SleepOpts, "sleepHour" | "sleepAuditDir" | "memoryEnabled" | "onComplete">> & Partial<SleepOpts>): { handle: SleepHandle; getLastMsgTs: () => number; setMsgTs: (t: number) => void } {
  let msgTs = 0;
  const getLastMsgTs = () => msgTs;
  const setMsgTs = (t: number) => { msgTs = t; };
  const handle = createSleepHandle({ ...opts, getLastMsgTs });

  // Simulate Dreamy exit: spawn fires, we grab the child, emit exit(0).
  // This is the same path the real bridge goes through.
  process.env["HARDWARE_SLEEP_AFTER_DREAMY"] = "true";
  const fakeChild = new EventEmitter() as unknown as child_process.ChildProcess;
  (fakeChild as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
  (fakeChild as unknown as { pid: number }).pid = 99999;
  (fakeChild as unknown as { killed: boolean }).killed = false;
  vi.mocked(child_process.spawn).mockReturnValue(fakeChild);

  // Bypass spawn's guards via the forceSleep path (one-shot).
  vi.mocked(readAndClearForceSleep).mockReturnValueOnce("test-force");
  handle.spawn();
  fakeChild.emit("exit", 0);

  return { handle, getLastMsgTs, setMsgTs };
}

describe("checkHwSleep", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SLEEP_DIR, { recursive: true });
    vi.clearAllMocks();
    delete process.env["BED_QUIET_TICKS"];
    delete process.env["WAKE_TIME"];
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env["HARDWARE_SLEEP_AFTER_DREAMY"];
    vi.useRealTimers();
  });

  it("sleep-window cutoff: outside [BED, WAKE) → abandons, does not call execSync", () => {
    const now = new Date();
    now.setHours(10, 0, 0, 0);  // outside 00:30-07:00
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const { handle } = armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    expect(handle.awaitingHwSleep).toBe(true);

    handle.checkHwSleep();

    expect(handle.awaitingHwSleep).toBe(false);
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
  });

  it("overnight window (BED=23, WAKE=7) stays in window at hour=23 and hour=3", () => {
    process.env["WAKE_TIME"] = "07:00";
    const tryHour = (h: number, shouldSleep: boolean): void => {
      const now = new Date();
      now.setHours(h, 30, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(now);
      vi.mocked(child_process.execSync).mockClear();
      const { handle } = armHwSleep({ sleepHour: 23, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
      process.env["BED_QUIET_TICKS"] = "1";  // fire immediately on first quiet tick
      handle.checkHwSleep();  // first tick: seeds lastMsgTsSeenByHwCheck (or not, since msgTs=0)
      handle.checkHwSleep();  // second: increments or cuts off
      if (shouldSleep) {
        expect(handle.awaitingHwSleep, `h=${h}`).toBe(false);  // fired
      } else {
        expect(vi.mocked(child_process.execSync), `h=${h}`).not.toHaveBeenCalled();
      }
      vi.useRealTimers();
    };
    tryHour(23, true);  // 23:30 — inside overnight window, should fire
    tryHour(3, true);   // 03:30 — inside overnight window, should fire
    tryHour(8, false);  // 08:30 — outside window, cutoff fires, no execSync
  });

  it("counters reset on _awaitingHwSleep flip (no stale poisoning)", () => {
    // First arm + exhaust counter to simulate a prior cycle that left state non-zero
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "3";

    const { handle } = armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    handle.checkHwSleep();  // postSleepQuietTicks=1
    handle.checkHwSleep();  // =2
    // Not yet fired. Simulate Dreamy finishing AGAIN (force-sleep re-run) → counters should reset.
    const { handle: handle2 } = armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    // Only 1 call should NOT be enough to fire — confirms the counter was reset.
    vi.mocked(child_process.execSync).mockClear();
    handle2.checkHwSleep();
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
  });

  it("fires pmset/systemctl after BED_QUIET_TICKS quiet ticks", () => {
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "2";

    const { handle } = armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    handle.checkHwSleep();  // tick 1
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
    handle.checkHwSleep();  // tick 2 — fires
    expect(vi.mocked(child_process.execSync)).toHaveBeenCalledTimes(1);
    expect(handle.awaitingHwSleep).toBe(false);
  });

  it("new user message resets counter and logs postponed", () => {
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "2";

    const { handle, setMsgTs } = armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    handle.checkHwSleep();  // tick 1, counter=1
    setMsgTs(Date.now());    // new user message
    handle.checkHwSleep();  // resets counter to 0, logs postponed
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
    // Without a reset, another call would fire; with reset, it takes 2 more ticks.
    handle.checkHwSleep();  // counter=1
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
    handle.checkHwSleep();  // counter=2 — fires
    expect(vi.mocked(child_process.execSync)).toHaveBeenCalledTimes(1);
  });

  it("no-op when _awaitingHwSleep is false", () => {
    const handle = createSleepHandle({
      sleepHour: 0,
      sleepAuditDir: SLEEP_DIR,
      memoryEnabled: false,
      onComplete: () => {},
    });
    expect(handle.awaitingHwSleep).toBe(false);
    handle.checkHwSleep();
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
  });
});
