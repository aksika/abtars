import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetEnv } from "../../components/env-schema.js";
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
  abtarsHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

vi.mock("../../components/transport/bridge-lock-transport.js", () => ({
  writeSleepStatus: vi.fn(),
  readAndClearForceSleep: vi.fn(() => null),
}));

vi.mock("abmind", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("abmind");
  return {
    ...actual,
    runSleepCycle: vi.fn(async () => ({ ok: true, failCount: 0 })),
    hasSleepAuditToday: vi.fn(() => false),
  };
});

import { createSleepHandle, type SleepHandle, type SleepOpts } from "./index.js";
import { readAndClearForceSleep } from "../../components/transport/bridge-lock-transport.js";

/** Stub runtime — replaced by mocked runSleepCycle in this test file. */
const stubRuntime = { complete: async () => "" };

/** Drive Dreamy-completion so _awaitingHwSleep flips to true + counters reset.
 *  Async because in-process runSleepCycle runs on a microtask chain. */
async function armHwSleep(opts: Required<Pick<SleepOpts, "sleepHour" | "sleepAuditDir" | "memoryEnabled" | "onComplete">> & Partial<SleepOpts>): Promise<{ handle: SleepHandle; getLastMsgTs: () => number; setMsgTs: (t: number) => void }> {
  let msgTs = 0;
  const getLastMsgTs = () => msgTs;
  const setMsgTs = (t: number) => { msgTs = t; };
  const handle = createSleepHandle({ runtime: stubRuntime, ...opts, getLastMsgTs });

  // In-process runSleepCycle is mocked to resolve ok — arms hw-sleep on first microtask flush.
  // Arm via a natural (non-forced) spawn: make current time inside the sleep window so
  // spawnSleep's guards pass without readAndClearForceSleep returning a truthy value.
  // Callers that want specific test-time semantics override vi.useFakeTimers AFTER awaiting this.
  process.env["HARDWARE_SLEEP_AFTER_DREAMY"] = "true";
  const prevTimers = vi.isFakeTimers();
  if (!prevTimers) {
    vi.useFakeTimers();
    const t = new Date();
    t.setHours(opts.sleepHour, 30, 0, 0);
    vi.setSystemTime(t);
  }
  handle.spawn();

  // Flush microtasks so the mocked Promise chain fires (running=false, _awaitingHwSleep=true).
  for (let i = 0; i < 3; i++) await Promise.resolve();

  if (!prevTimers) vi.useRealTimers();

  return { handle, getLastMsgTs, setMsgTs };
}

describe("checkHwSleep", () => {
  beforeEach(() => {
    process.env["HEARTBEAT_INTERVAL_SEC"] = "300";
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SLEEP_DIR, { recursive: true });
    vi.clearAllMocks();
    delete process.env["BED_QUIET_TICKS"];
    delete process.env["WAKE_TIME"];
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    delete process.env["HARDWARE_SLEEP_AFTER_DREAMY"];
    _resetEnv();
    vi.useRealTimers();
  });

  it("sleep-window cutoff: outside [BED, WAKE) → abandons, does not call execSync", async () => {
    // Arm hw-sleep first (inside window), THEN jump clock outside window to test cutoff.
    const { handle } = await armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    expect(handle.awaitingHwSleep).toBe(true);

    const now = new Date();
    now.setHours(10, 0, 0, 0);  // outside 00:30-07:00
    vi.useFakeTimers();
    vi.setSystemTime(now);

    handle.checkHwSleep();

    expect(handle.awaitingHwSleep).toBe(false);
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
  });

  it("overnight window (BED=23, WAKE=7) stays in window at hour=23 and hour=3", async () => {
    process.env["WAKE_TIME"] = "07:00";
    const tryHour = async (h: number, shouldSleep: boolean): Promise<void> => {
      const now = new Date();
      now.setHours(h, 30, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(now);
      vi.mocked(child_process.execSync).mockClear();
      const { handle } = await armHwSleep({ sleepHour: 23, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
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
    await tryHour(23, true);  // 23:30 — inside overnight window, should fire
    await tryHour(3, true);   // 03:30 — inside overnight window, should fire
    await tryHour(8, false);  // 08:30 — outside window, cutoff fires, no execSync
  });

  it("counters reset on _awaitingHwSleep flip (no stale poisoning)", async () => {
    // First arm + exhaust counter to simulate a prior cycle that left state non-zero
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "3";

    const { handle } = await armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    handle.checkHwSleep();  // postSleepQuietTicks=1
    handle.checkHwSleep();  // =2
    // Not yet fired. Simulate Dreamy finishing AGAIN (force-sleep re-run) → counters should reset.
    const { handle: handle2 } = await armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    // Only 1 call should NOT be enough to fire — confirms the counter was reset.
    vi.mocked(child_process.execSync).mockClear();
    handle2.checkHwSleep();
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
  });

  it("fires pmset/systemctl after BED_QUIET_TICKS quiet ticks", async () => {
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "2";

    const { handle } = await armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
    handle.checkHwSleep();  // tick 1
    expect(vi.mocked(child_process.execSync)).not.toHaveBeenCalled();
    handle.checkHwSleep();  // tick 2 — fires
    expect(vi.mocked(child_process.execSync)).toHaveBeenCalledTimes(1);
    expect(handle.awaitingHwSleep).toBe(false);
  });

  it("new user message resets counter and logs postponed", async () => {
    const now = new Date();
    now.setHours(3, 0, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    process.env["BED_QUIET_TICKS"] = "2";

    const { handle, setMsgTs } = await armHwSleep({ sleepHour: 0, sleepAuditDir: SLEEP_DIR, memoryEnabled: false, onComplete: () => {} });
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

  it("no-op when _awaitingHwSleep is false", async () => {
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
