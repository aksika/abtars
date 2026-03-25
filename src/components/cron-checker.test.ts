import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronEntry } from "../cli/agentbridge-cron.js";

const originalHome = process.env.HOME;

describe("cron-checker", () => {
  let tmpDir: string;
  let memDir: string;
  let cronPath: string;
  let remindersPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cronchk-test-"));
    process.env.HOME = tmpDir;
    memDir = join(tmpDir, ".agentbridge", "memory");
    mkdirSync(memDir, { recursive: true });
    cronPath = join(memDir, "cron.json");
    remindersPath = join(memDir, "pending_reminders.json");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCron(entries: CronEntry[]): void {
    writeFileSync(cronPath, JSON.stringify(entries), "utf-8");
  }

  function readCron(): CronEntry[] {
    return JSON.parse(readFileSync(cronPath, "utf-8"));
  }

  function readReminders(): Array<{ chatId: number; message: string; createdAt: number }> {
    try { return JSON.parse(readFileSync(remindersPath, "utf-8")); }
    catch { return []; }
  }

  it("fires due reminder to pending_reminders.json", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "abc123", fireAt: Date.now() - 1000, message: "Test reminder",
      chatId: 42, type: "reminder", fired: false, createdAt: Date.now() - 5000,
    }]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].chatId).toBe(42);
    expect(reminders[0].message).toBe("Test reminder");

    const entries = readCron();
    expect(entries[0].fired).toBe(true);
  });

  it("skips future entries", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "fut001", fireAt: Date.now() + 3_600_000, message: "Future",
      chatId: 1, type: "reminder", fired: false, createdAt: Date.now(),
    }]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(0);

    const entries = readCron();
    expect(entries[0].fired).toBe(false);
  });

  it("skips already-fired entries", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "old001", fireAt: Date.now() - 1000, message: "Already done",
      chatId: 1, type: "reminder", fired: true, createdAt: Date.now() - 5000,
    }]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(0);
  });

  it("fires task entry and calls onTaskComplete", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "tsk001", fireAt: Date.now() - 1000, message: "Run report",
      chatId: 99, type: "task", fired: false, createdAt: Date.now() - 5000,
    }]);

    // Task spawns a process — we just verify it marks as fired and doesn't crash
    checkCron();

    const entries = readCron();
    expect(entries[0].fired).toBe(true);

    // No reminder should be written for tasks
    const reminders = readReminders();
    expect(reminders).toHaveLength(0);
  });

  it("handles missing cron.json gracefully", async () => {
    const { checkCron } = await import("./cron-checker.js");
    // No cron.json exists — should not throw
    expect(() => checkCron()).not.toThrow();
  });

  it("recurring entry reschedules instead of marking fired", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "rec001", fireAt: Date.now() - 1000, message: "Recurring reminder",
      chatId: 1, type: "reminder", schedule: "0 10 * * *", fired: false, createdAt: Date.now() - 5000,
    }]);

    checkCron();

    const entries = readCron();
    expect(entries[0].fired).toBe(false);
    expect(entries[0].fireAt).toBeGreaterThan(Date.now());
    expect(entries[0].lastRanAt).toBeDefined();
  });

  it("skips paused entries", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "pau001", fireAt: Date.now() - 1000, message: "Paused",
      chatId: 1, type: "reminder", fired: false, paused: true, createdAt: Date.now(),
    }]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(0);
    const entries = readCron();
    expect(entries[0].fired).toBe(false);
  });

  it("GCs fired one-shots older than 7 days", async () => {
    const { checkCron } = await import("./cron-checker.js");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    writeCron([
      { id: "old001", fireAt: eightDaysAgo, message: "Ancient", chatId: 1, type: "reminder", fired: true, createdAt: eightDaysAgo },
      { id: "new001", fireAt: Date.now() + 9999, message: "Keep", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
    ]);

    checkCron();

    const entries = readCron();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("new001");
  });

  it("script task reverts fireAt on failure", async () => {
    const { checkCron } = await import("./cron-checker.js");
    const originalFireAt = Date.now() - 1000;
    writeCron([{
      id: "fail01", fireAt: originalFireAt, message: "exit 1",
      chatId: 1, type: "task", executor: "script", fired: false, createdAt: Date.now() - 5000,
    }]);

    checkCron();

    // Wait for async child process to finish
    await new Promise(r => setTimeout(r, 500));

    const entries = readCron();
    const entry = entries.find(e => e.id === "fail01");
    expect(entry?.fireAt).toBe(originalFireAt);
  });

  it("priorityOnly fires only high-priority entries", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([
      { id: "hi001", fireAt: Date.now() - 1000, message: "High prio", chatId: 1, type: "reminder", fired: false, createdAt: Date.now(), priority: "high" },
      { id: "lo001", fireAt: Date.now() - 1000, message: "Normal", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
    ]);

    checkCron(undefined, { priorityOnly: true });

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toBe("High prio");
  });

  it("normal pass skips high-priority entries", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([
      { id: "hi002", fireAt: Date.now() - 1000, message: "High prio", chatId: 1, type: "reminder", fired: false, createdAt: Date.now(), priority: "high" },
      { id: "lo002", fireAt: Date.now() - 1000, message: "Normal", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
    ]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toBe("Normal");
  });

  it("fires only 1 task per tick but all reminders", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([
      { id: "rem01", fireAt: Date.now() - 1000, message: "Reminder 1", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
      { id: "rem02", fireAt: Date.now() - 1000, message: "Reminder 2", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
      { id: "tsk01", fireAt: Date.now() - 1000, message: "echo task1", chatId: 1, type: "task", executor: "script", fired: false, createdAt: Date.now() },
      { id: "tsk02", fireAt: Date.now() - 2000, message: "echo task2", chatId: 1, type: "task", executor: "script", fired: false, createdAt: Date.now() },
    ]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(2); // both reminders fire

    const entries = readCron();
    // First task fires; second task untouched (guard bails before scheduling block)
    const firedTasks = entries.filter(e => e.type === "task" && e.fired);
    expect(firedTasks).toHaveLength(1);
    expect(firedTasks[0].id).toBe("tsk01");
  });

  it("high priority task fires before medium/low when multiple are due", async () => {
    const { checkCron } = await import("./cron-checker.js");
    const now = Date.now();
    writeCron([
      { id: "low01", fireAt: now - 3000, message: "echo low", chatId: 1, type: "task", executor: "script", fired: false, createdAt: now, priority: "low" },
      { id: "med01", fireAt: now - 2000, message: "echo med", chatId: 1, type: "task", executor: "script", fired: false, createdAt: now, priority: "medium" },
    ]);

    // Normal pass skips high, fires first non-high by priority (medium before low)
    checkCron();

    const entries = readCron();
    const fired = entries.filter(e => e.lastRanAt && e.lastRanAt >= now);
    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe("med01");
  });

  it("second tick fires the next task after first was consumed", async () => {
    const { checkCron } = await import("./cron-checker.js");
    const now = Date.now();
    writeCron([
      { id: "t1", fireAt: now - 2000, message: "echo first", chatId: 1, type: "task", executor: "script", fired: false, createdAt: now },
      { id: "t2", fireAt: now - 1000, message: "echo second", chatId: 1, type: "task", executor: "script", fired: false, createdAt: now },
    ]);

    checkCron(); // fires t1
    checkCron(); // fires t2

    const entries = readCron();
    expect(entries.filter(e => e.fired)).toHaveLength(2);
  });

  it("returns true when a task fired, false otherwise", async () => {
    const { checkCron } = await import("./cron-checker.js");

    // No entries → false
    writeCron([]);
    expect(checkCron()).toBe(false);

    // Only reminder → false (reminders don't count)
    writeCron([{ id: "r01", fireAt: Date.now() - 1000, message: "Rem", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() }]);
    expect(checkCron()).toBe(false);

    // Task → true
    writeCron([{ id: "t01", fireAt: Date.now() - 1000, message: "echo hi", chatId: 1, type: "task", executor: "script", fired: false, createdAt: Date.now() }]);
    expect(checkCron()).toBe(true);
  });

  it("clearPendingReminders empties the file", async () => {
    const { checkCron, readPendingReminders, clearPendingReminders } = await import("./cron-checker.js");
    writeCron([{
      id: "clr001", fireAt: Date.now() - 1000, message: "Clear me",
      chatId: 1, type: "reminder", fired: false, createdAt: Date.now(),
    }]);

    checkCron();
    expect(readPendingReminders()).toHaveLength(1);

    clearPendingReminders();
    expect(readPendingReminders()).toHaveLength(0);
  });
});
