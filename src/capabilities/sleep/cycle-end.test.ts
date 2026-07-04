/**
 * cycle-end.test.ts — #1287: the night Dreamy session tears down on EVERY cycle
 * outcome. createSleepHandle must invoke opts.onCycleEnd exactly once per cycle on
 * success, partial-failure (!ok), and thrown-error paths — regardless of onComplete.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const { HOME, BRIDGE_LOCK, SLEEP_DIR } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const HOME = join(tmpdir(), `ab-cycleend-test-${process.pid}`);
  return { HOME, BRIDGE_LOCK: join(HOME, "bridge.lock"), SLEEP_DIR: join(HOME, "sleep") };
});

vi.mock("../../paths.js", () => ({
  abtarsHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

const { mockRunSleepCycle } = vi.hoisted(() => ({
  mockRunSleepCycle: vi.fn(async () => ({ ok: true, failCount: 0 })),
}));

vi.mock("abmind", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("abmind");
  return { ...actual, runSleepCycle: mockRunSleepCycle, hasSleepAuditToday: vi.fn(() => false) };
});

vi.mock("../../utils/abmind-lazy.js", () => ({
  abmind: () => ({
    hasSleepAuditToday: () => false,
    DEFAULT_LEVEL: "normal",
    parseLevel: (s: string) => s,
    runSleepCycle: mockRunSleepCycle,
  }),
  loadAbmind: async () => ({}),
}));

import { createSleepHandle } from "./index.js";

const stubRuntime = { complete: async () => "" };

/** Force-sleep bypasses the sleep-window/audit guards so runSleepCycle actually runs. */
function armForceSleep(): void {
  const today = new Date();
  const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  writeFileSync(join(SLEEP_DIR, `sleep_${dateStr}_0900.md`), "# Audit");
  writeFileSync(BRIDGE_LOCK, JSON.stringify({ pid: 1, startedAt: Date.now(), forceSleep: "2026-04-19T12:00:00 test" }));
}

async function settle(): Promise<void> {
  // Success path awaits a dynamic import() before .finally — needs macrotasks, not
  // just microtasks. Poll a few real ticks so the whole chain settles.
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 5));
}

describe("createSleepHandle — onCycleEnd teardown (#1287)", () => {
  beforeEach(() => {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(SLEEP_DIR, { recursive: true });
    vi.clearAllMocks();
    mockRunSleepCycle.mockImplementation(async () => ({ ok: true, failCount: 0 }));
  });
  afterEach(() => rmSync(HOME, { recursive: true, force: true }));

  function makeHandle(onCycleEnd: () => void) {
    return createSleepHandle({
      sleepHour: 0,
      sleepAuditDir: SLEEP_DIR,
      memoryEnabled: false,   // onComplete memory path off — teardown must still fire
      runtime: stubRuntime,
      onComplete: () => {},
      onCycleEnd,
    });
  }

  it("fires onCycleEnd on the success path", async () => {
    armForceSleep();
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).spawn();
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the partial-failure (!ok) path", async () => {
    armForceSleep();
    mockRunSleepCycle.mockImplementation(async () => ({ ok: false, failCount: 2 }));
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).spawn();
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onCycleEnd on the thrown-error path", async () => {
    armForceSleep();
    mockRunSleepCycle.mockImplementation(async () => { throw new Error("boom"); });
    const onCycleEnd = vi.fn();
    makeHandle(onCycleEnd).spawn();
    await settle();
    expect(onCycleEnd).toHaveBeenCalledTimes(1);
  });
});
