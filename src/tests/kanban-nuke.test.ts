/**
 * kanban-nuke.test.ts — #1707 Task 8: the two-step /kanban nuke. Command
 * records a marker and returns immediately; startup preflight removes exactly
 * the canonical kanban database files only for a fresh valid request, rebuilds
 * an empty valid board, and ignores everything else unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let kanban: typeof import("../components/tasks/kanban-board.js");
let nuke: typeof import("../components/tasks/kanban-nuke.js");
let handlersTasks: typeof import("../components/commands/handlers-tasks.js");

function dbPath(): string {
  return join(TEST_HOME, "kanban", "kanban.db");
}

function makeCtx(userId?: string): { ctx: import("../components/commands/types.js").CommandContext; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    userId: userId ?? "master",
    reply: async (text: string) => { replies.push(text); return undefined; },
  } as unknown as import("../components/commands/types.js").CommandContext;
  return { ctx, replies };
}

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = mkdtempSync(join(tmpdir(), "kanban-nuke-"));
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), "[]");
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  kanban = await import("../components/tasks/kanban-board.js");
  nuke = await import("../components/tasks/kanban-nuke.js");
  handlersTasks = await import("../components/commands/handlers-tasks.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

function seedBoard(cards: number): number {
  let last = 0;
  for (let i = 0; i < cards; i++) last = kanban.kanbanEnqueue(`card ${i}`, "agent");
  return last;
}

/**
 * Simulate a bridge restart: fresh module registry (no cached SQLite handle),
 * fresh imports. Production preflight always runs in this state.
 */
async function freshRegistry(): Promise<{ kanban: typeof kanban; nuke: typeof nuke; handlers: typeof handlersTasks }> {
  vi.resetModules();
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const k = await import("../components/tasks/kanban-board.js");
  const n = await import("../components/tasks/kanban-nuke.js");
  const h = await import("../components/commands/handlers-tasks.js");
  return { kanban: k, nuke: n, handlers: h };
}

describe("#1707 /kanban nuke", () => {
  it("command writes a marker and returns immediately without pausing", async () => {
    seedBoard(3);
    const before = Date.now();
    const { ctx, replies } = makeCtx();
    const t0 = Date.now();
    await handlersTasks.handleKanban("/kanban nuke", ctx);
    expect(Date.now() - t0).toBeLessThan(2_000); // immediate, never waits
    expect(replies[0]).toContain("+ Nuke requested");

    // Marker present and fresh:
    const raw = (kanban.requireTaskDatabase().prepare(`SELECT value FROM kanban_control WHERE key = 'nuke_requested_at'`).get() as { value: string }).value;
    const requestedAt = Number(raw);
    expect(requestedAt).toBeGreaterThanOrEqual(before);
    expect(Date.now() - requestedAt).toBeLessThan(nuke.KANBAN_NUKE_MAX_AGE_MS);

    // The bridge is untouched: cards still present preflight.
    expect(kanban.kanbanGetCard(1)).toBeTruthy();
  });

  it("non-master users cannot invoke nuke", async () => {
    seedBoard(1);
    const { ctx, replies } = makeCtx("some-random-user");
    await handlersTasks.handleKanban("/kanban nuke", ctx);
    expect(replies[0]).toContain("Owner-only");
    const markerTable = kanban.requireTaskDatabase().prepare(`SELECT name FROM sqlite_master WHERE name = 'kanban_control'`).get();
    expect(markerTable).toBeUndefined();
  });

  it("two-step journey across a restart: fresh marker → files removed → empty valid board rebuilt", async () => {
    // Process 1: live bridge takes the command through its cached connection.
    seedBoard(5);
    const { ctx } = makeCtx();
    await handlersTasks.handleKanban("/kanban nuke", ctx);

    // Process 2 (restart): preflight runs BEFORE any cached connection opens.
    const p2 = await freshRegistry();
    expect(p2.nuke.runKanbanNukePreflightIfNeeded().performed).toBe(true);

    // Rebuilt board is empty and valid through the normal cached path:
    expect(p2.kanban.kanbanList("*")).toHaveLength(0);
    expect(existsSync(dbPath())).toBe(true);
    const check = p2.kanban.requireTaskDatabase().prepare(`PRAGMA quick_check`).get() as Record<string, unknown>;
    expect(Object.values(check)[0]).toBe("ok");
  });

  it("works across the normal in-process restart after shutdown closes the cached board", async () => {
    seedBoard(2);
    const { ctx } = makeCtx();
    await handlersTasks.handleKanban("/kanban nuke", ctx);

    // main.ts restarts in the same process; Bridge.shutdown closes and resets
    // the module cache before startBridge runs its next preflight.
    kanban.closeTaskDatabase();
    expect(nuke.runKanbanNukePreflightIfNeeded().performed).toBe(true);
    expect(kanban.kanbanList("*")).toHaveLength(0);
  });

  it("expired markers are ignored unchanged", async () => {
    seedBoard(2);
    kanban.requireTaskDatabase().exec(`CREATE TABLE IF NOT EXISTS kanban_control (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    kanban.requireTaskDatabase().prepare(`INSERT INTO kanban_control (key, value) VALUES ('nuke_requested_at', ?)`)
      .run(String(Date.now() - nuke.KANBAN_NUKE_MAX_AGE_MS - 60_000));

    const result = nuke.runKanbanNukePreflightIfNeeded();
    expect(result.performed).toBe(false);
    expect(kanban.kanbanList("*")).toHaveLength(2); // untouched
    expect(existsSync(dbPath())).toBe(true);
  });

  it("future timestamps are ignored unchanged", async () => {
    seedBoard(1);
    kanban.requireTaskDatabase().exec(`CREATE TABLE IF NOT EXISTS kanban_control (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    kanban.requireTaskDatabase().prepare(`INSERT INTO kanban_control (key, value) VALUES ('nuke_requested_at', ?)`)
      .run(String(Date.now() + 10 * 60_000));

    const result = nuke.runKanbanNukePreflightIfNeeded();
    expect(result.performed).toBe(false);
    expect(kanban.kanbanGetCard(1)).toBeTruthy();
  });

  it("malformed markers are ignored unchanged", async () => {
    seedBoard(1);
    kanban.requireTaskDatabase().exec(`CREATE TABLE IF NOT EXISTS kanban_control (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    kanban.requireTaskDatabase().prepare(`INSERT INTO kanban_control (key, value) VALUES ('nuke_requested_at', ?)`)
      .run("not-a-timestamp");

    const result = nuke.runKanbanNukePreflightIfNeeded();
    expect(result.performed).toBe(false);
    expect(kanban.kanbanGetCard(1)).toBeTruthy();
  });

  it("old databases without the control table are ignored unchanged", async () => {
    seedBoard(2); // no kanban_control table created
    const result = nuke.runKanbanNukePreflightIfNeeded();
    expect(result.performed).toBe(false);
    expect(kanban.kanbanList("*")).toHaveLength(2);
  });

  it("a fresh nuke overwrites an old expired marker", async () => {
    seedBoard(1);
    kanban.requireTaskDatabase().exec(`CREATE TABLE IF NOT EXISTS kanban_control (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    kanban.requireTaskDatabase().prepare(`INSERT INTO kanban_control (key, value) VALUES ('nuke_requested_at', ?)`)
      .run(String(Date.now() - nuke.KANBAN_NUKE_MAX_AGE_MS - 1));
    // First preflight ignores it:
    expect(nuke.runKanbanNukePreflightIfNeeded().performed).toBe(false);
    // New command overwrites the stale value; a restarted bridge performs it.
    const { ctx } = makeCtx();
    await handlersTasks.handleKanban("/kanban nuke", ctx);
    const p2 = await freshRegistry();
    expect(p2.nuke.runKanbanNukePreflightIfNeeded().performed).toBe(true);
  });

  it("no live handle survives into deletion — cached access after preflight sees the rebuilt board", async () => {
    seedBoard(3);
    const { ctx } = makeCtx();
    await handlersTasks.handleKanban("/kanban nuke", ctx);

    // Restarted process: preflight before any cached open...
    const p2 = await freshRegistry();
    expect(p2.nuke.runKanbanNukePreflightIfNeeded().performed).toBe(true);
    // ...then normal cached access sees the rebuilt board, not a ghost inode:
    expect(p2.kanban.kanbanList("*")).toHaveLength(0);
    p2.kanban.kanbanEnqueue("post-nuke", "agent");
    expect(p2.kanban.kanbanGetCard(1)?.title).toBe("post-nuke");
  });

  it("missing database file is a no-op", () => {
    expect(nuke.runKanbanNukePreflightIfNeeded()).toMatchObject({ performed: false, reason: "no database" });
  });
});
