import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SleepTrigger } from "./sleep-trigger.js";

describe("SleepTrigger", () => {
  let auditDir: string;

  beforeEach(() => {
    auditDir = mkdtempSync(join(tmpdir(), "sleep-trigger-"));
  });

  afterEach(() => {
    rmSync(auditDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("shouldRunOnStartup always returns true", () => {
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunOnStartup()).toBe(true);
  });

  it("shouldRunFromCron returns true when all conditions met (≥8am, idle >10min, no audit today)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000; // 15min ago
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(true);
    vi.useRealTimers();
  });

  it("shouldRunFromCron returns false before 8am", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T07:59:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false);
    vi.useRealTimers();
  });

  it("shouldRunFromCron returns false when user active within 10min", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 5 * 60 * 1000; // 5min ago
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false);
    vi.useRealTimers();
  });

  it("shouldRunFromCron returns false when audit file exists for today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    // Create audit file matching today's date
    writeFileSync(join(auditDir, "sleep_20260315_100000.md"), "audit");
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false);
    vi.useRealTimers();
  });

  it("shouldRunFromCron returns true when audit dir does not exist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger("/nonexistent/audit/dir");
    const lastMsg = Date.now() - 15 * 60 * 1000;
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(true);
    vi.useRealTimers();
  });
});
