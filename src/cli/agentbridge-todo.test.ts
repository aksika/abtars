import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We test by calling main() with custom argv, but the CLI writes to a hardcoded
// path (~/.agentbridge/memory/todo.md). To isolate, we mock the path via env override.
// Instead, we test the file operations directly by temporarily pointing HOME.

const originalHome = process.env.HOME;

describe("agentbridge-todo", () => {
  let tmpDir: string;
  let todoPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "todo-test-"));
    process.env.HOME = tmpDir;
    todoPath = join(tmpDir, ".agentbridge", "memory", "todo.md");
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Dynamic import so HOME is picked up fresh each time
  async function run(args: string[]): Promise<string> {
    // Re-import to pick up new HOME
    const mod = await import("./agentbridge-todo.js");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(" "));
    try {
      mod.main(["node", "agentbridge-todo", ...args]);
    } finally {
      console.log = origLog;
    }
    return logs.join("\n");
  }

  it("add creates file and appends item", async () => {
    const out = await run(["add", "Buy milk"]);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "added", description: "Buy milk" });
    expect(existsSync(todoPath)).toBe(true);
    const content = readFileSync(todoPath, "utf-8");
    expect(content).toContain("- [ ]");
    expect(content).toContain("Buy milk");
  });

  it("list shows items", async () => {
    await run(["add", "Item A"]);
    await run(["add", "Item B"]);
    const out = await run(["list"]);
    expect(out).toContain("Item A");
    expect(out).toContain("Item B");
  });

  it("list on empty returns empty message", async () => {
    const out = await run(["list"]);
    expect(JSON.parse(out).items).toEqual([]);
  });

  it("done marks item as complete", async () => {
    await run(["add", "Task 1"]);
    const out = await run(["done", "1"]);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "done", item: 1 });
    const content = readFileSync(todoPath, "utf-8");
    expect(content).toContain("- [x]");
    expect(content).not.toContain("- [ ]");
  });

  it("remove deletes item", async () => {
    await run(["add", "Task 1"]);
    await run(["add", "Task 2"]);
    const out = await run(["remove", "1"]);
    expect(JSON.parse(out)).toEqual({ ok: true, action: "removed", item: 1 });
    const content = readFileSync(todoPath, "utf-8");
    expect(content).not.toContain("Task 1");
    expect(content).toContain("Task 2");
  });

  it("done with invalid number reports error", async () => {
    await run(["add", "Only item"]);
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run(["done", "5"]);
    } catch {
      // expected
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });

  it("no command reports error", async () => {
    const origExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("exit"); }) as never;
    try {
      await run([]);
    } catch {
      // expected
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(1);
  });
});
