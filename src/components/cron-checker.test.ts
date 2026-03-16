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
