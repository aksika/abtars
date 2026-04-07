/**
 * Integration tests — heartbeat tasks with real dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgeCheckTask } from "../components/heartbeat-tasks.js";
import type { AgeCheckDeps } from "../components/heartbeat-tasks.js";
import { resetBedtimeCounter } from "../components/daily-cycle.js";

let tmpDir: string;

function makeDeps(overrides: Partial<AgeCheckDeps> = {}): AgeCheckDeps {
  return {
    memory: null,
    bridgeLockPath: join(tmpDir, "bridge.lock"),
    sleepHour: 6, sleepMinute: 0,
    busyChats: new Set(),
    isSleepActive: () => false,
    doctorPath: "/bin/true",
    ...overrides,
  };
}

describe("Integration: age-check task", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hb-int-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("skips when current hour is before SLEEP_TIME", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 5, 0) }); // 05:00 < 06:00
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }));

    const task = createAgeCheckTask(makeDeps());
    await task.execute();

    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("skips when bridge started after today's SLEEP_TIME", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const now = new Date(2026, 3, 5, 10, 0); // 10:00 > 06:00
    vi.useFakeTimers({ now });
    // Bridge started at 08:00 today (after SLEEP_TIME 06:00)
    const todayAt8 = new Date(2026, 3, 5, 8, 0).getTime();
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: todayAt8 }));

    const task = createAgeCheckTask(makeDeps());
    await task.execute();

    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("triggers restart when past SLEEP_TIME and bridge started before it", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const now = new Date(2026, 3, 5, 10, 0); // 10:00
    vi.useFakeTimers({ now });
    // Bridge started yesterday
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }));

    resetBedtimeCounter();
    const task = createAgeCheckTask(makeDeps());
    // Need 6 quiet ticks before trigger
    for (let i = 0; i < 5; i++) await task.execute();
    expect(exitSpy).not.toHaveBeenCalled();
    await task.execute(); // 6th tick
    expect(exitSpy).toHaveBeenCalledWith(0);
    vi.useRealTimers();
  });

  it("skips when busy chats exist", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 10, 0) });
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }));

    const task = createAgeCheckTask(makeDeps({ busyChats: new Set(["telegram:100"]) }));
    await task.execute();

    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("skips when sleep is active", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 10, 0) });
    writeFileSync(join(tmpDir, "bridge.lock"), JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }));

    const task = createAgeCheckTask(makeDeps({ isSleepActive: () => true }));
    await task.execute();

    expect(exitSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
