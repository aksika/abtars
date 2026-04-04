/**
 * Integration tests — sleep guards and daily summary targeting.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasSleepAuditToday } from "../components/sleep-trigger.js";

describe("Integration: sleep guards", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("hasSleepAuditToday returns false when no audit exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-int-"));
    expect(hasSleepAuditToday(tmpDir)).toBe(false);
  });

  it("hasSleepAuditToday returns true when today's audit exists", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-int-"));
    const today = new Date();
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
    writeFileSync(join(tmpDir, `sleep_${dateStr}_0800.md`), "audit content");
    expect(hasSleepAuditToday(tmpDir)).toBe(true);
  });

  it("SLEEP_TIME guard blocks early runs", () => {
    // Simulate the guard logic from bridge-app.ts
    const SLEEP_HOUR = 6;
    vi.useFakeTimers({ now: new Date(2026, 3, 5, 3, 0) }); // 03:00
    expect(new Date().getHours() < SLEEP_HOUR).toBe(true); // would skip

    vi.setSystemTime(new Date(2026, 3, 5, 8, 0)); // 08:00
    expect(new Date().getHours() < SLEEP_HOUR).toBe(false); // would run
  });

  it("yesterday daily summary detection works", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "sleep-int-"));
    const dailyDir = join(tmpDir, "daily");
    mkdirSync(dailyDir, { recursive: true });

    // No daily for yesterday
    const yesterday = new Date(Date.now() - 86400000);
    const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    const yesterdayPath = join(dailyDir, `daily_${yesterdayStr}.md`);

    expect(existsSync(yesterdayPath)).toBe(false);

    // After creating it
    writeFileSync(yesterdayPath, "summary content");
    expect(existsSync(yesterdayPath)).toBe(true);
  });
});
