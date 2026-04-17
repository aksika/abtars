import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;

describe("browse-delivery", () => {
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

  it("deliverBrowseResult writes report and appends reminder", async () => {
    const { deliverBrowseResult } = await import("./browse-delivery.js");
    const entry = {
      taskId: "abc123", task: "check X", chatId: 42,
      pid: 0, startedAt: Date.now(), timeoutMs: 300000, logFile: "",
    };

    deliverBrowseResult(entry, "Found 3 notifications");

    const reminders = readReminders();
    expect(reminders).toHaveLength(1);
    expect(reminders[0].chatId).toBe(42);
    expect(reminders[0].message).toContain("Browse task complete");

    const subDir = join(tmpDir, ".agentbridge", "subagents");
    const files = readdirSync(subDir) as string[];
    const report = files.find((f: string) => f.startsWith("browse_abc123"));
    expect(report).toBeDefined();
    const content = readFileSync(join(subDir, report!), "utf-8");
    expect(content).toBe("Found 3 notifications");
  });

  it("deliverBrowseResult handles empty result", async () => {
    const { deliverBrowseResult } = await import("./browse-delivery.js");
    const entry = {
      taskId: "empty1", task: "empty task", chatId: 7,
      pid: 0, startedAt: Date.now(), timeoutMs: 300000, logFile: "",
    };

    deliverBrowseResult(entry, "");

    const subDir = join(tmpDir, ".agentbridge", "subagents");
    const files = readdirSync(subDir) as string[];
    const report = files.find((f: string) => f.startsWith("browse_empty1"));
    const content = readFileSync(join(subDir, report!), "utf-8");
    expect(content).toBe("(no output captured)");
  });

  it("checkBrowseTasks removes stale entries", async () => {
    const { checkBrowseTasks } = await import("./browse-delivery.js");
    writeBrowse([{
      taskId: "stale1", task: "old task", chatId: 1,
      pid: 0, startedAt: Date.now() - 600000, timeoutMs: 300000, logFile: "",
    }]);

    checkBrowseTasks();

    const remaining = readBrowse();
    expect(remaining).toHaveLength(0);
  });

  it("checkBrowseTasks keeps recent entries", async () => {
    const { checkBrowseTasks } = await import("./browse-delivery.js");
    writeBrowse([{
      taskId: "recent1", task: "running task", chatId: 1,
      pid: 0, startedAt: Date.now() - 1000, timeoutMs: 300000, logFile: "",
    }]);

    checkBrowseTasks();

    const remaining = readBrowse();
    expect(remaining).toHaveLength(1);
  });

  it("handles missing pending_browse.json gracefully", async () => {
    const { checkBrowseTasks } = await import("./browse-delivery.js");
    expect(() => checkBrowseTasks()).not.toThrow();
  });
});
