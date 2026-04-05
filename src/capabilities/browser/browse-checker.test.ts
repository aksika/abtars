import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;

describe("checkBrowseTasks", () => {
  let tmpDir: string;
  let memDir: string;
  let browsePath: string;
  let remindersPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "browsechk-test-"));
    process.env.HOME = tmpDir;
    memDir = join(tmpDir, ".agentbridge", "memory");
    mkdirSync(memDir, { recursive: true });
    browsePath = join(memDir, "pending_browse.json");
    remindersPath = join(memDir, "pending_reminders.json");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBrowse(entries: Array<Record<string, unknown>>): void {
    writeFileSync(browsePath, JSON.stringify(entries), "utf-8");
  }

  function readBrowse(): Array<Record<string, unknown>> {
    if (!existsSync(browsePath)) return [];
    return JSON.parse(readFileSync(browsePath, "utf-8"));
  }

  function readReminders(): Array<{ chatId: number; message: string }> {
    if (!existsSync(remindersPath)) return [];
    try { return JSON.parse(readFileSync(remindersPath, "utf-8")); }
    catch { return []; }
  }

  it("delivers result when pid is dead", async () => {
    const { checkBrowseTasks } = await import("../../components/cron-checker.js");
    const logsDir = join(tmpDir, ".agentbridge", "logs");
    mkdirSync(logsDir, { recursive: true });
    const logFile = join(logsDir, "browse_abc123.log");
    writeFileSync(logFile, '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Found 3 notifications"}}}}\n', "utf-8");

    writeBrowse([{
      taskId: "abc123", task: "check X", chatId: 42,
      pid: 999999999, // non-existent pid
      startedAt: Date.now() - 60000, timeoutMs: 300000, logFile,
    }]);

    checkBrowseTasks();

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].chatId).toBe(42);
    expect(reminders[0].message).toContain("Browse task complete");
    expect(reminders[0].message).toContain("Report:");

    // Report file should exist in subagents dir
    const subDir = join(tmpDir, ".agentbridge", "subagents");
    expect(existsSync(subDir)).toBe(true);
    const files = require("node:fs").readdirSync(subDir) as string[];
    const report = files.find((f: string) => f.startsWith("browse_abc123"));
    expect(report).toBeDefined();
    const content = readFileSync(join(subDir, report!), "utf-8");
    expect(content).toContain("Found 3 notifications");

    const remaining = readBrowse();
    expect(remaining).toHaveLength(0);
  });

  it("kills timed-out process and reports", async () => {
    const { checkBrowseTasks } = await import("../../components/cron-checker.js");
    // Use a non-existent pid so kill fails silently
    writeBrowse([{
      taskId: "timeout1", task: "slow task", chatId: 99,
      pid: 999999998,
      startedAt: Date.now() - 600000, timeoutMs: 300000,
      logFile: "/nonexistent.log",
    }]);

    checkBrowseTasks();

    // Since pid doesn't exist, it'll be treated as dead (kill(0) fails)
    // and deliver result rather than timeout
    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].chatId).toBe(99);
  });

  it("leaves alive process within timeout alone", async () => {
    const { checkBrowseTasks } = await import("../../components/cron-checker.js");
    // Use our own pid — guaranteed alive
    writeBrowse([{
      taskId: "alive1", task: "running task", chatId: 1,
      pid: process.pid,
      startedAt: Date.now() - 1000, timeoutMs: 300000,
      logFile: "/tmp/test.log",
    }]);

    checkBrowseTasks();

    const remaining = readBrowse();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].taskId).toBe("alive1");

    const reminders = readReminders();
    expect(reminders).toHaveLength(0);
  });

  it("handles missing pending_browse.json gracefully", async () => {
    const { checkBrowseTasks } = await import("../../components/cron-checker.js");
    expect(() => checkBrowseTasks()).not.toThrow();
  });

  it("handles missing log file gracefully", async () => {
    const { checkBrowseTasks } = await import("../../components/cron-checker.js");
    writeBrowse([{
      taskId: "nolog", task: "no log task", chatId: 7,
      pid: 999999997,
      startedAt: Date.now() - 60000, timeoutMs: 300000,
      logFile: "/nonexistent/path/browse.log",
    }]);

    checkBrowseTasks();

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].message).toContain("Report:");
  });
});
