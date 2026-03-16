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

  it("startup: skips before 8am", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T07:59:00"));
    const trigger = new SleepTrigger(auditDir);
    expect(trigger.shouldRunOnStartup()).toBe(false);
    vi.useRealTimers();
  });

  it("startup: skips when audit exists today", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    writeFileSync(join(auditDir, "sleep_20260315_080000.md"), "audit");
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
    writeFileSync(join(auditDir, "sleep_20260315_100000.md"), "audit");
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

  // --- spawnedToday guard ---

  it("cron: skips after startup already spawned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    trigger.shouldRunOnStartup(); // sets spawnedToday
    expect(trigger.shouldRunFromCron(Date.now() - 15 * 60 * 1000)).toBe(false);
    vi.useRealTimers();
  });

  it("cron: skips after cron already spawned", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T10:00:00"));
    const trigger = new SleepTrigger(auditDir);
    const lastMsg = Date.now() - 15 * 60 * 1000;
    trigger.shouldRunFromCron(lastMsg); // first call sets spawnedToday
    expect(trigger.shouldRunFromCron(lastMsg)).toBe(false); // second call blocked
    vi.useRealTimers();
  });
});
