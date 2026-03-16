import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;

describe("agentbridge-cron", () => {
  let tmpDir: string;
  let cronPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    process.env.HOME = tmpDir;
    cronPath = join(tmpDir, ".agentbridge", "memory", "cron.json");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    const mod = await import("./agentbridge-cron.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      mod.main(["node", "agentbridge-cron", ...args]);
    } finally {
      console.log = origLog;
    }
    return logs.join("\n");
  }

  it("add creates entry in cron.json", async () => {
    const out = await run(["add", "--at", "2026-12-25T08:00", "--message", "Christmas", "--chat-id", "123", "--type", "reminder"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("added");
    expect(parsed.id).toHaveLength(6);

    expect(existsSync(cronPath)).toBe(true);
    const entries = JSON.parse(readFileSync(cronPath, "utf-8"));
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Christmas");
    expect(entries[0].chatId).toBe(123);
    expect(entries[0].type).toBe("reminder");
    expect(entries[0].fired).toBe(false);
  });

  it("list shows pending entries", async () => {
    await run(["add", "--at", "2026-12-25T08:00", "--message", "A", "--chat-id", "1", "--type", "reminder"]);
    await run(["add", "--at", "2026-12-26T08:00", "--message", "B", "--chat-id", "1", "--type", "task"]);
    const out = await run(["list"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0].message).toBe("A");
    expect(parsed.entries[1].message).toBe("B");
  });

  it("list on empty returns empty", async () => {
    const out = await run(["list"]);
    const parsed = JSON.parse(out);
    expect(parsed.entries).toEqual([]);
  });

  it("remove deletes entry by id", async () => {
    const addOut = await run(["add", "--at", "2026-12-25T08:00", "--message", "X", "--chat-id", "1", "--type", "reminder"]);
    const id = JSON.parse(addOut).id;

    const out = await run(["remove", id]);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "removed", id });

    const entries = JSON.parse(readFileSync(cronPath, "utf-8"));
    expect(entries).toHaveLength(0);
  });

  it("remove with invalid id exits with error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["remove", "nonexistent"]);
    } catch {
      // expected
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("add with missing --at exits with error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--message", "X", "--chat-id", "1"]);
    } catch {
      // expected
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("add defaults type to reminder", async () => {
    const out = await run(["add", "--at", "2026-12-25T08:00", "--message", "Y", "--chat-id", "1"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);

    const entries = JSON.parse(readFileSync(cronPath, "utf-8"));
    expect(entries[0].type).toBe("reminder");
  });
});
