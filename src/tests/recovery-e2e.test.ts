/**
 * Recovery E2E tests — verify standby resume + daily cycle behavior.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isDailyCycleDue, type DailyCycleDeps } from "../components/daily-cycle.js";
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

    expect(isDailyCycleDue(makeDeps())).toBe(true);
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

  it("full overnight: Power Nap wakes → 0 restarts before SLEEP_TIME, 1 after", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "rec-"));
    const bridgeLockPath = join(tmpDir, "bridge.lock");
    const bridgeStartedAt = new Date(2026, 3, 4, 20, 0).getTime(); // Started 8pm yesterday
    writeFileSync(bridgeLockPath, JSON.stringify({ pid: 1, startedAt: bridgeStartedAt, lastHeartbeat: bridgeStartedAt }));

    const deps = makeDeps({ bridgeLockPath });
    const results: boolean[] = [];

    // Simulate Power Nap wakes every 30min from 2am to 7am
    for (let hour = 2; hour <= 7; hour++) {
      for (const min of [0, 30]) {
        vi.setSystemTime(new Date(2026, 3, 5, hour, min));
        results.push(isDailyCycleDue(deps));
      }
    }

    // All before 06:00 should be false
    const before6 = results.slice(0, 8); // 02:00 to 05:30
    expect(before6.every(r => r === false)).toBe(true);

    // First tick at or after 06:00 should be true
    const at6 = results[8]; // 06:00
    expect(at6).toBe(true);
  });
});
