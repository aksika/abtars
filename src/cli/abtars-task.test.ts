import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalHome = process.env.HOME;
const originalAbtarsHome = process.env.ABTARS_HOME;

describe("abtars-task", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "cron-test-"));
    process.env.HOME = tmpDir;
    delete process.env.ABTARS_HOME;
    mkdirSync(join(tmpDir, ".abtars", "memory"), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalAbtarsHome === undefined) delete process.env.ABTARS_HOME;
    else process.env.ABTARS_HOME = originalAbtarsHome;
    const { closeDb } = await import("../components/tasks/task-store.js");
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    const { closeDb } = await import("../components/tasks/task-store.js");
    closeDb();
    const mod = await import("./abtars-task.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      mod.main(["node", "abtars-task", ...args]);
    } finally {
      console.log = origLog;
    }
    return logs.join("\n");
  }

  it("add creates entry", async () => {
    const out = await run(["add", "--id", "christmas", "--at", "2026-12-25T08:00", "--message", "Christmas", "--chat-id", "123", "--kind", "reminder"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.action).toBe("added");
    expect(parsed.id).toBe("christmas");
  });

  it("list shows pending entries", async () => {
    await run(["add", "--id", "task-a", "--at", "2026-12-25T08:00", "--message", "A", "--chat-id", "1", "--kind", "reminder"]);
    await run(["add", "--id", "task-b", "--at", "2026-12-26T08:00", "--message", "B", "--chat-id", "1", "--kind", "agent"]);
    const out = await run(["list"]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toHaveLength(2);
  });

  it("list on empty returns empty", async () => {
    const out = await run(["list"]);
    const parsed = JSON.parse(out);
    expect(parsed.entries).toEqual([]);
  });

  it("remove deletes entry by id", async () => {
    const addOut = await run(["add", "--id", "test-x", "--at", "2026-12-25T08:00", "--message", "X", "--chat-id", "1", "--type", "reminder"]);
    const id = JSON.parse(addOut).id;
    const out = await run(["remove", id]);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "removed", id });
  });

  it("remove with invalid id exits with error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["remove", "nonexistent"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("add with missing --at exits with error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--id", "test", "--message", "X", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("add defaults type to reminder", async () => {
    const out = await run(["add", "--id", "test-y", "--at", "2026-12-25T08:00", "--message", "Y", "--chat-id", "1"]);
    expect(JSON.parse(out).ok).toBe(true);
  });

  it("rejects missing --id", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--at", "2026-12-25T08:00", "--message", "Z", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("rejects duplicate --id", async () => {
    await run(["add", "--id", "dup", "--at", "2026-12-25T08:00", "--message", "first", "--chat-id", "1"]);
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--id", "dup", "--at", "2026-12-26T08:00", "--message", "second", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("rejects invalid --id format", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--id", "-bad", "--at", "2026-12-25T08:00", "--message", "bad", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("rejects --id starting with digit", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--id", "9live", "--at", "2026-12-25T08:00", "--message", "nine", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("rejects --id ending with dash", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["add", "--id", "backup-", "--at", "2026-12-25T08:00", "--message", "dash", "--chat-id", "1"]);
    } catch { /* expected */ } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });
});
