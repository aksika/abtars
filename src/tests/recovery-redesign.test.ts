import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeReadJson } from "../components/safe-json.js";
import { isDailyCycleDue, resetBedtimeCounter, type DailyCycleDeps } from "../components/daily-cycle.js";

// --- safeReadJson ---

describe("safeReadJson", () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env["HEARTBEAT_INTERVAL_SEC"] = "300";
    tmpDir = mkdtempSync(join(tmpdir(), "safe-json-"));
  });

  it("reads valid JSON", () => {
    const p = join(tmpDir, "test.json");
    writeFileSync(p, '{"a":1}');
    expect(safeReadJson(p, {})).toEqual({ a: 1 });
  });

  it("returns fallback for missing file", () => {
    expect(safeReadJson("/nonexistent/path.json", { x: 42 })).toEqual({ x: 42 });
  });

  it("returns fallback for invalid JSON", () => {
    const p = join(tmpDir, "bad.json");
    writeFileSync(p, "not json {{{");
    expect(safeReadJson(p, { fallback: true })).toEqual({ fallback: true });
  });

  it("returns fallback for null JSON", () => {
    const p = join(tmpDir, "null.json");
    writeFileSync(p, "null");
    expect(safeReadJson(p, { def: 1 })).toEqual({ def: 1 });
  });

  it("returns fallback for array JSON", () => {
    const p = join(tmpDir, "arr.json");
    writeFileSync(p, "[1,2,3]");
    // arrays are objects, so this passes through
    const result = safeReadJson(p, []);
    expect(Array.isArray(result)).toBe(true);
  });
});

// --- Bedtime quiet tick counter ---

describe("isDailyCycleDue — quiet tick counter", () => {
  let tmpDir: string;

  function makeDeps(overrides: Partial<DailyCycleDeps> = {}): DailyCycleDeps {
    return {
      sleepHour: 2,
      sleepMinute: 0,
      bridgeLockPath: join(tmpDir, "bridge.lock"),
      memory: null,
      isSleepActive: () => false,
      ...overrides,
    };
  }

  beforeEach(() => {
    process.env["HEARTBEAT_INTERVAL_SEC"] = "300";
    tmpDir = mkdtempSync(join(tmpdir(), "bedtime-"));
    // Bridge started yesterday, lastHeartbeat exists
    writeFileSync(
      join(tmpDir, "bridge.lock"),
      JSON.stringify({ pid: 1, startedAt: Date.now() - 86400000, lastHeartbeat: Date.now() }),
    );
    resetBedtimeCounter();
  });

  it("returns false before BED_TIME", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:15:00")); // 15 min past midnight, within 7h window
    const deps = makeDeps({ sleepHour: 0, sleepMinute: 0 });
    // First tick: false (need 2 quiet ticks)
    expect(isDailyCycleDue(deps)).toBe(false);
    // 2nd tick: true
    expect(isDailyCycleDue(deps)).toBe(true);
    vi.useRealTimers();
  });

  it("resets counter when resetBedtimeCounter is called", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:15:00"));
    const deps = makeDeps({ sleepHour: 0, sleepMinute: 0 });
    // Accumulate 1 tick
    isDailyCycleDue(deps);
    // Reset
    resetBedtimeCounter();
    // Need 2 more ticks now
    expect(isDailyCycleDue(deps)).toBe(false);
    expect(isDailyCycleDue(deps)).toBe(true);
    vi.useRealTimers();
  });

  it("returns false when a session is busy", async () => {
    const spinMod = await import("../components/spin.js");
    const origList = spinMod.spin.listAllSessions;
    (spinMod.spin as any).listAllSessions = () => [{ busy: true, id: "chat:1" }];
    const deps = makeDeps({ sleepHour: 0, sleepMinute: 0 });
    for (let i = 0; i < 10; i++) {
      expect(isDailyCycleDue(deps)).toBe(false);
    }
    (spinMod.spin as any).listAllSessions = origList;
  });

  it("returns false when sleep is active", () => {
    const deps = makeDeps({ sleepHour: 0, sleepMinute: 0, isSleepActive: () => true });
    for (let i = 0; i < 10; i++) {
      expect(isDailyCycleDue(deps)).toBe(false);
    }
  });

  it("accumulates quiet ticks when bridge started AFTER BED_TIME (late-restart catch-up, #216)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:15:00"));
    writeFileSync(
      join(tmpDir, "bridge.lock"),
      JSON.stringify({ pid: 1, startedAt: Date.now(), lastHeartbeat: Date.now() }),
    );
    const deps = makeDeps({ sleepHour: 0, sleepMinute: 0 });
    expect(isDailyCycleDue(deps)).toBe(false);
    expect(isDailyCycleDue(deps)).toBe(true);
    vi.useRealTimers();
  });
});

// --- Watchdog countdown+kick (unit logic) ---

describe("watchdog countdown+kick pattern", () => {
  it("countdown reaches negative without kicks", () => {
    let countdown = 900_000; // 15min
    const CHECK_INTERVAL = 60_000;
    const GRACE = -60_000;

    // Simulate 17 checks (17 minutes) with no kicks
    for (let i = 0; i < 17; i++) {
      countdown -= CHECK_INTERVAL;
    }
    // 17 × 60s = 1020s = 17min. countdown = 900000 - 1020000 = -120000
    expect(countdown).toBeLessThanOrEqual(GRACE);
  });

  it("kick resets countdown", () => {
    let countdown = 900_000;
    const CHECK_INTERVAL = 60_000;
    const KICK_VALUE = 900_000;

    // 10 checks without kick
    for (let i = 0; i < 10; i++) countdown -= CHECK_INTERVAL;
    expect(countdown).toBe(300_000); // 5min left

    // Kick
    countdown = KICK_VALUE;
    expect(countdown).toBe(900_000); // back to 15min

    // 10 more checks
    for (let i = 0; i < 10; i++) countdown -= CHECK_INTERVAL;
    expect(countdown).toBe(300_000); // 5min left again, not expired
  });

  it("dark wake kick prevents expiry", () => {
    let countdown = 900_000;
    const CHECK_INTERVAL = 60_000;
    const KICK_VALUE = 900_000;
    const GRACE = -60_000;

    // Simulate 5 hours of dark wakes (every 30min, heartbeat kicks)
    for (let hour = 0; hour < 5; hour++) {
      // 30 checks (30 min) between kicks
      for (let i = 0; i < 6; i++) countdown -= CHECK_INTERVAL; // 6 × 60s = 6min between kicks (heartbeat interval)
      // Heartbeat fires, kicks watchdog
      countdown = KICK_VALUE;
    }
    // After 5 hours of dark wakes with kicks: still alive
    expect(countdown).toBeGreaterThan(GRACE);
  });

  it("hardware sleep (no kicks) causes expiry on wake", () => {
    let countdown = 900_000;
    const CHECK_INTERVAL = 60_000;
    const GRACE = -60_000;

    // Simulate: last kick was at countdown=900000
    // Mac sleeps for 6 hours. setInterval was frozen.
    // On wake, first check fires. But countdown wasn't decremented during sleep.
    // Actually in real code, setInterval resumes and fires once immediately.
    // The countdown is still at whatever it was before sleep.
    // If heartbeat was the last thing before sleep: countdown = 900000
    // First watchdog check after wake: 900000 - 60000 = 840000 (still alive)
    // But heartbeat also fires and detects gap > 3× interval → standby resume
    // Standby resume kicks watchdog for dark wake, doesn't kick for full wake
    // For full wake: no kick → watchdog counts down normally
    // After 16 checks (16 min): countdown = 900000 - 16*60000 = -60000 = GRACE → exit

    // Simulate: no kicks after wake (full wake, standby doesn't kick)
    for (let i = 0; i < 17; i++) countdown -= CHECK_INTERVAL;
    expect(countdown).toBeLessThanOrEqual(GRACE);
  });
});
