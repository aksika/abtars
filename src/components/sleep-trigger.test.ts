import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  // --- shouldRunOnStartup ---

  it("startup: runs when ≥8am and no audit today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunOnStartup()).toBe(true);
    vi.useRealTimers();
  });

  it("startup: runs before 8am if no recent audit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T07:59:00"));
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunOnStartup()).toBe(true);
    vi.useRealTimers();
  });

  it("startup: skips when audit exists today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    writeFileSync(join(auditDir, "sleep_20260315_0800.md"), "audit");
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunOnStartup()).toBe(false);
    vi.useRealTimers();
  });

  // --- shouldRunFromCron ---

  it("cron: runs when ≥8am, idle >10min, no audit, not spawned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(true);
    vi.useRealTimers();
  });

  it("cron: skips before 8am", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T07:59:00"));
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(false);
    vi.useRealTimers();
  });

  it("cron: skips when user active within 10min", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunFromCron(Date.now() - 5 * 60 * 1000)).toBe(false);
    vi.useRealTimers();
  });

  it("cron: skips when audit exists today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    writeFileSync(join(auditDir, "sleep_20260315_1000.md"), "audit");
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(false);
    vi.useRealTimers();
  });

  it("cron: runs when audit dir does not exist", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger("/nonexistent/audit/dir");
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(true);
    vi.useRealTimers();
  });

  // --- retry behavior ---

  it("cron: retries on next HB after failure (attempt 2)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;

    expect(trigger.shouldRunFromCron(lastMsg)).toBe(true);  // attempt 1
    trigger.reportFailure();
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(true);  // attempt 2 (next HB)
    vi.useRealTimers();
  });

  it("cron: attempt 3 requires 1h cooldown after 2nd failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;

    trigger.shouldRunFromCron(lastMsg);  // attempt 1
    trigger.reportFailure();
    trigger.shouldRunFromCron(lastMsg);  // attempt 2
    trigger.reportFailure();

    // Too soon — should skip
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false);

    // Advance 1h
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(true);  // attempt 3
    vi.useRealTimers();
  });

  it("cron: stops after 3 failures (exhausted)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;

    trigger.shouldRunFromCron(lastMsg);  // attempt 1
    trigger.reportFailure();
    trigger.shouldRunFromCron(lastMsg);  // attempt 2
    trigger.reportFailure();
    vi.advanceTimersByTime(60 * 60 * 1000);
    trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000);  // attempt 3
    trigger.reportFailure();

    // Exhausted — no more retries
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(false);
    vi.useRealTimers();
  });

  it("cron: stops retrying after success", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;

    trigger.shouldRunFromCron(lastMsg);  // attempt 1
    trigger.reportFailure();
    trigger.shouldRunFromCron(lastMsg);  // attempt 2
    trigger.reportSuccess();

    // Success blocks further attempts
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false);
    vi.useRealTimers();
  });

  it("startup failure allows cron retry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);

    trigger.shouldRunOnStartup();  // attempt 1
    trigger.reportFailure();

    // Cron should pick up retry
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(true);
    vi.useRealTimers();
  });
});
