import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { HOME, BRIDGE_LOCK, SLEEP_DIR } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const HOME = join(tmpdir(), `ab-spawnsleep-test-${process.pid}`);
  return {
    HOME,
    BRIDGE_LOCK: join(HOME, "bridge.lock"),
    SLEEP_DIR: join(HOME, "sleep"),
  };
});

vi.mock("../../paths.js", () => ({
  abtarsHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

vi.mock("abmind", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("abmind");
  return {
    ...actual,
    runSleepCycle: vi.fn(async () => ({ ok: true, failCount: 0 })),
    hasSleepAuditToday: vi.fn(() => false),
  };
});

import { createSleepHandle } from "./index.js";
import { runSleepCycle } from "abmind";

const stubRuntime = { complete: async () => "" };

describe("createSleepHandle — bridge.lock.forceSleep consumption", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SLEEP_DIR, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(HOME, { recursive: true, force: true });
  });

  function writeLockWithForceSleep(value: string | null): void {
    const lock: Record<string, unknown> = { pid: 1, startedAt: Date.now() };
    if (value !== null) lock.forceSleep = value;
    writeFileSync(BRIDGE_LOCK, JSON.stringify(lock));
  }

  function readLock(): Record<string, unknown> {
    return JSON.parse(readFileSync(BRIDGE_LOCK, "utf-8"));
  }

  it("spawn() consumes forceSleep and invokes runSleepCycle at 17:00 (outside sleep window)", async () => {
    // Write audit for today so normal guards would reject
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(join(SLEEP_DIR, `sleep_${dateStr}_0900.md`), "# Audit");
    writeLockWithForceSleep("2026-04-19T12:00:00 test");

    const handle = createSleepHandle({
      sleepHour: 0,
      sleepAuditDir: SLEEP_DIR,
      memoryEnabled: false,
      runtime: stubRuntime,
      onComplete: () => {},
    });

    handle.spawn();
    // Let the mocked runSleepCycle Promise chain resolve
    for (let i = 0; i < 3; i++) await Promise.resolve();

    // Field cleared by spawnSleep
    expect(readLock().forceSleep).toBeFalsy();
    // runSleepCycle was actually invoked (guards bypassed)
    expect(vi.mocked(runSleepCycle)).toHaveBeenCalledTimes(1);
  });

  it("spawn() without forceSleep respects the sleep-window guard", async () => {
    writeLockWithForceSleep(null);
    // Fake time to 17:00 — outside 00:30-07:00
    vi.useFakeTimers();
    const fakeNow = new Date();
    fakeNow.setHours(17, 0, 0, 0);
    vi.setSystemTime(fakeNow);
    try {
      const handle = createSleepHandle({
        sleepHour: 0,
        sleepAuditDir: SLEEP_DIR,
        memoryEnabled: false,
        runtime: stubRuntime,
        onComplete: () => {},
      });
      handle.spawn();
      expect(vi.mocked(runSleepCycle)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
