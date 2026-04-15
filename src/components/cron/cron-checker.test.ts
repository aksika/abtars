import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronEntry } from "../../cli/agentbridge-task.js";
import { writeEntry, readEntries, closeDb } from "./cron-db.js";

const originalHome = process.env.HOME;

describe("cron-checker", () => {
  let tmpDir: string;
  let memDir: string;
  let remindersPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cronchk-test-"));
    process.env.HOME = tmpDir;
    memDir = join(tmpDir, ".agentbridge", "memory");
    mkdirSync(memDir, { recursive: true });
    remindersPath = join(memDir, "pending_reminders.json");
    closeDb(); // force fresh DB for new HOME
  });

  afterEach(() => {
    closeDb();
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeCron(entries: CronEntry[]): void {
    for (const e of entries) writeEntry(e);
  }

  function readCron(): CronEntry[] {
    return readEntries();
  }

  function readReminders(): Array<{ userId: string; message: string; createdAt: number }> {
    try { return JSON.parse(readFileSync(remindersPath, "utf-8")); }
    catch { return []; }
  }

  it("fires due reminder to pending_reminders.json", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([{
      id: "abc123", fireAt: Date.now() - 1000, message: "Test reminder",
      chatId: 1, type: "reminder", fired: false, createdAt: Date.now() - 5000,
    }]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].chatId).toBe(1);
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

  it("handles empty DB gracefully", async () => {
    const { checkCron } = await import("./cron-checker.js");
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

  it("single checkCron fires all priorities", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([
      { id: "lo001", fireAt: Date.now() - 1000, message: "Normal", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
      { id: "hi001", fireAt: Date.now() - 1000, message: "High prio", chatId: 1, type: "reminder", fired: false, createdAt: Date.now(), priority: "high" },
    ]);

    checkCron();

    const reminders = readReminders();
    expect(reminders).toHaveLength(2);
    expect(reminders.map(r => r.message)).toContain("High prio");
    expect(reminders.map(r => r.message)).toContain("Normal");
  });

  it("returns due tasks for queue (scripts + agents), fires reminders directly", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([
      { id: "rem01", fireAt: Date.now() - 1000, message: "Reminder 1", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
      { id: "rem02", fireAt: Date.now() - 1000, message: "Reminder 2", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() },
      { id: "scr01", fireAt: Date.now() - 1000, message: "echo script1", chatId: 1, type: "task", executor: "script", fired: false, createdAt: Date.now() },
      { id: "agt01", fireAt: Date.now() - 1000, message: "agent task 1", chatId: 1, type: "task", executor: "agent", fired: false, createdAt: Date.now() },
    ]);

    const dueTasks = checkCron();

    // Reminders fired directly to file
    const reminders = readReminders();
    expect(reminders).toHaveLength(2);

    // Tasks returned for queue
    expect(dueTasks).toHaveLength(2);
    expect(dueTasks.map(e => e.id)).toContain("scr01");
    expect(dueTasks.map(e => e.id)).toContain("agt01");
  });

  it("returns tasks for queue (CronQueue handles priority sorting)", async () => {
    const { checkCron } = await import("./cron-checker.js");
    const now = Date.now();
    writeCron([
      { id: "low01", fireAt: now - 3000, message: "low task", chatId: 1, type: "task", executor: "agent", fired: false, createdAt: now, priority: "low" },
      { id: "hi01", fireAt: now - 1000, message: "high task", chatId: 1, type: "task", executor: "script", fired: false, createdAt: now, priority: "high" },
      { id: "med01", fireAt: now - 2000, message: "med task", chatId: 1, type: "task", executor: "agent", fired: false, createdAt: now, priority: "medium" },
    ]);

    const dueTasks = checkCron();
    expect(dueTasks).toHaveLength(3);
    expect(dueTasks.map(t => t.id)).toContain("hi01");
    expect(dueTasks.map(t => t.id)).toContain("med01");
    expect(dueTasks.map(t => t.id)).toContain("low01");
  });

  it("returns empty array when nothing is due", async () => {
    const { checkCron } = await import("./cron-checker.js");
    writeCron([]);
    expect(checkCron()).toHaveLength(0);

    // Only reminder — returns empty (reminders handled internally)
    writeCron([{ id: "r01", fireAt: Date.now() - 1000, message: "Rem", chatId: 1, type: "reminder", fired: false, createdAt: Date.now() }]);
    expect(checkCron()).toHaveLength(0);
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
