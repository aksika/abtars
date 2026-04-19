import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import * as child_process from "node:child_process";

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

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: vi.fn() };
});

vi.mock("../../paths.js", () => ({
  agentBridgeHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

import { hasSleepAuditToday } from "./sleep-trigger.js";
import { createSleepHandle } from "./index.js";

const TMP = join(import.meta.dirname, "..", "..", ".test-sleep-trigger");

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

describe("hasSleepAuditToday", () => {
  it("returns false if dir does not exist", () => {
    expect(hasSleepAuditToday("/nonexistent")).toBe(false);
  });

  it("returns false if no files for today", () => {
    expect(hasSleepAuditToday(TMP)).toBe(false);
  });

  it("returns true if audit .md exists for today", () => {
    writeFileSync(join(TMP, `sleep_${todayStr()}_0900.md`), "# Audit");
    expect(hasSleepAuditToday(TMP)).toBe(true);
  });

  it("returns false if lock has failed steps", () => {
    const state = { pid: 1, startedAt: Date.now(), steps: { "04a": { status: "failed" } } };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    expect(hasSleepAuditToday(TMP)).toBe(false);
  });

  it("returns true if lock has all ok steps and audit exists", () => {
    const state = { pid: 1, startedAt: Date.now(), steps: { "04a": { status: "ok" }, "retro": { status: "skipped" } } };
    writeFileSync(join(TMP, `sleep_${todayStr()}.lock`), JSON.stringify(state));
    writeFileSync(join(TMP, `sleep_${todayStr()}_0900.md`), "# Audit");
    expect(hasSleepAuditToday(TMP)).toBe(true);
  });
});

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

  it("spawn() consumes forceSleep and fires child_process.spawn at 17:00 (outside sleep window)", () => {
    const fakeChild = new EventEmitter() as unknown as child_process.ChildProcess;
    (fakeChild as unknown as { stdout: EventEmitter }).stdout = new EventEmitter();
    (fakeChild as unknown as { killed: boolean; pid: number }).killed = false;
    (fakeChild as unknown as { pid: number }).pid = 99999;
    vi.mocked(child_process.spawn).mockReturnValue(fakeChild);

    // Write audit for today so normal guards would reject
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(join(SLEEP_DIR, `sleep_${dateStr}_0900.md`), "# Audit");
    writeLockWithForceSleep("2026-04-19T12:00:00 test");

    const handle = createSleepHandle({
      sleepHour: 0,
      sleepAuditDir: SLEEP_DIR,
      memoryEnabled: false,
      onComplete: () => {},
    });

    handle.spawn();

    // Field cleared by spawnSleep
    expect(readLock().forceSleep).toBeFalsy();
    // spawn() was actually called (guards bypassed)
    expect(vi.mocked(child_process.spawn)).toHaveBeenCalledTimes(1);
  });

  it("spawn() without forceSleep respects the sleep-window guard", () => {
    vi.mocked(child_process.spawn).mockClear();
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
        onComplete: () => {},
      });
      handle.spawn();
      expect(vi.mocked(child_process.spawn)).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
