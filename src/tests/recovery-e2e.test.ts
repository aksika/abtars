/**
 * Recovery E2E tests — verify standby resume + daily cycle behavior.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDailyCycleDue, resetBedtimeCounter, type DailyCycleDeps } from "../components/daily-cycle.js";
import { classifyResume } from "../components/platform-detect.js";

let tmpDir: string;

function makeDeps(overrides: Partial<DailyCycleDeps> = {}): DailyCycleDeps {
  return {
    sleepHour: 6, sleepMinute: 0,
    bridgeLockPath: join(tmpDir, "bridge.lock"),
    memory: null,
    busyChats: new Set(),
    isSleepActive: () => false,
    ...overrides,
  };
}

describe("Recovery E2E: standby resume + daily cycle", () => {
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("standby resume before SLEEP_TIME → no restart", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rec-"));
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 3, 0) }); // 03:00
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000 }));

    expect(isDailyCycleDue(makeDeps())).toBe(false);
  });

  it("standby resume after SLEEP_TIME + started before → restart", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rec-"));
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 8, 0) }); // 08:00
    // Bridge started yesterday (before today's SLEEP_TIME)
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }));

    resetBedtimeCounter();
    const deps = makeDeps();
    // Need 2 quiet ticks before it triggers
    expect(isDailyCycleDue(deps)).toBe(false);
    expect(isDailyCycleDue(deps)).toBe(true);
  });

  it("classifyResume returns valid wake type", () => {
    const result = classifyResume();
    expect(["dark", "full", "unknown"]).toContain(result);
  });

  it("sleep running during standby → no restart", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rec-"));
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 8, 0) }); // 08:00, past SLEEP_TIME
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000 }));

    // Sleep is active → should not restart
    expect(isDailyCycleDue(makeDeps({ isSleepActive: () => true }))).toBe(false);
  });

  it("full overnight: Power Nap wakes → 0 restarts before SLEEP_TIME, triggers after 2 quiet ticks", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rec-"));
    const bridgeLockPath = join(tmpDir, "bridge.lock");
    const bridgeStartedAt = new Date(2026, 3, 4, 20, 0).getTime(); // Started 8pm yesterday
    writeFileSync(bridgeLockPath, JSON.stringify({ pid: 1, startedAt: bridgeStartedAt, lastHeartbeat: bridgeStartedAt }));

    resetBedtimeCounter();
    const deps = makeDeps({ bridgeLockPath });

    // Before BED_TIME: all false
    vi.setSystemTime(new Date(2026, 3, 5, 4, 0));
    expect(isDailyCycleDue(deps)).toBe(false);

    // After BED_TIME: accumulate 2 quiet ticks (5min each)
    vi.setSystemTime(new Date(2026, 3, 5, 6, 0));
    expect(isDailyCycleDue(deps)).toBe(false);
    // 2nd tick triggers
    vi.setSystemTime(new Date(2026, 3, 5, 6, 5));
    expect(isDailyCycleDue(deps)).toBe(true);
  });
});
