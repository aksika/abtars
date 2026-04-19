import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { HOME, BRIDGE_LOCK, SLEEP_DIR } = vi.hoisted(() => {
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const HOME = join(tmpdir(), `ab-daily-cycle-test-${process.pid}`);
  return {
    HOME,
    BRIDGE_LOCK: join(HOME, "bridge.lock"),
    SLEEP_DIR: join(HOME, "sleep"),
  };
});

vi.mock("../paths.js", () => ({
  agentBridgeHome: () => HOME,
  reportsDir: (cat: string) => join(HOME, "reports", cat),
}));

import { isDailyCycleDue, resetBedtimeCounter } from "./daily-cycle.js";

function writeLock(extra: Record<string, unknown> = {}): void {
  writeFileSync(BRIDGE_LOCK, JSON.stringify({ pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now(), ...extra }));
}

function readLock(): Record<string, unknown> {
  return JSON.parse(readFileSync(BRIDGE_LOCK, "utf-8"));
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(SLEEP_DIR, { recursive: true });
  resetBedtimeCounter();
});

afterEach(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function baseDeps(overrides: Partial<Parameters<typeof isDailyCycleDue>[0]> = {}): Parameters<typeof isDailyCycleDue>[0] {
  return {
    sleepHour: 0,
    sleepMinute: 30,
    bridgeLockPath: BRIDGE_LOCK,
    sleepAuditDir: SLEEP_DIR,
    memory: null,
    busyChats: new Set<string>(),
    isSleepActive: () => false,
    ...overrides,
  };
}

describe("isDailyCycleDue — bridge.lock.forceSleep field", () => {
  it("returns true when forceSleep field is set, even with startedAt >= todaySleepTime", () => {
    writeLock({ forceSleep: "2026-04-19T12:00:00 test" });
    expect(isDailyCycleDue(baseDeps())).toBe(true);
  });

  it("does NOT clear the field (spawnSleep is the sole deleter)", () => {
    writeLock({ forceSleep: "2026-04-19T12:00:00 test" });
    isDailyCycleDue(baseDeps());
    expect(readLock().forceSleep).toBe("2026-04-19T12:00:00 test");
  });

  it("returns false when forceSleep is set AND a chat is busy (user-protection wins)", () => {
    writeLock({ forceSleep: "2026-04-19T12:00:00 test" });
    expect(isDailyCycleDue(baseDeps({ busyChats: new Set(["chat-1"]) }))).toBe(false);
    expect(readLock().forceSleep).toBe("2026-04-19T12:00:00 test"); // still not cleared
  });

  it("returns false when forceSleep is set AND sleep is already active (user-protection wins)", () => {
    writeLock({ forceSleep: "2026-04-19T12:00:00 test" });
    expect(isDailyCycleDue(baseDeps({ isSleepActive: () => true }))).toBe(false);
    expect(readLock().forceSleep).toBe("2026-04-19T12:00:00 test");
  });

  it("preserves normal path when forceSleep is absent (no spurious true)", () => {
    writeLock();  // no forceSleep field
    // Midnight before BED_TIME 00:30 — before-bedtime branch
    const now = new Date();
    const early = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(early);
    expect(isDailyCycleDue(baseDeps())).toBe(false);
    vi.useRealTimers();
  });
});
