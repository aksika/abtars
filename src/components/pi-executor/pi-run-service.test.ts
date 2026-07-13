/**
 * pi-run-service.test.ts — PiRunService.run() and lifecycle tests.
 *
 * Uses a real in-memory SQLite for the store, mocks PiExecutor and Spin.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { PiRunStore } from "./pi-run-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import type { PiExecutor } from "./pi-executor.js";
import type { Spin } from "../spin.js";
import { PiRunService } from "./pi-run-service.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  raw.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'pi',
    source_id TEXT,
    priority TEXT NOT NULL DEFAULT 'MEDIUM',
    type TEXT NOT NULL DEFAULT 'pi',
    notes TEXT,
    delivery_mode TEXT NOT NULL DEFAULT 'silent',
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    error TEXT,
    result_summary TEXT,
    result_path TEXT
  )`);
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params); },
        get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
  };
}

const mockExecute = vi.fn();
const mockReply = vi.fn();
const mockSteer = vi.fn();
const mockCancel = vi.fn();
const mockAllocateExternalSession = vi.fn();
const mockEndExternalSession = vi.fn();

function makeService(configOverrides: Record<string, unknown> = {}): PiRunService {
  const db = createTestDb();
  const store = new PiRunStore({ db });
  const executor = {
    execute: mockExecute,
    reply: mockReply,
    steer: mockSteer,
    cancel: mockCancel,
  } as unknown as PiExecutor;
  const spin = {
    allocateExternalSession: mockAllocateExternalSession,
    endExternalSession: mockEndExternalSession,
  } as unknown as Spin;
  return new PiRunService({
    store,
    executor,
    config: {
      enabled: true,
      sessionStorageRoot: "/tmp",
      workspaces: [{ alias: "test-ws", canonicalPath: "/tmp/test-ws" }],
      ...configOverrides,
    } as any,
    spin,
  });
}

beforeEach(() => {
  mockExecute.mockReset();
  mockReply.mockReset().mockResolvedValue({ claimed: true });
  mockSteer.mockReset().mockResolvedValue(true);
  mockCancel.mockReset().mockResolvedValue(true);
  mockAllocateExternalSession.mockReset().mockReturnValue({ id: "spin-sess-1" });
  mockEndExternalSession.mockReset();
});

describe("PiRunService.run()", () => {
  it("creates a Pi run and returns ref", async () => {
    const svc = makeService();

    const result = await svc.run(
      {
        goal: "implement feature",
        workspaceAlias: "test-ws",
        priority: "HIGH",
        owner: { principalId: "usr-1", origin: "user" },
      },
      { userId: "usr-1" },
    );

    expect(result.runId).toBeDefined();
    expect(result.cardId).toBeGreaterThan(0);
    expect(result.sessionId).toBe("spin-sess-1");
    expect(result.generation).toBe(1);
    // Verify it persists in the store
    const record = svc.store.get(result.runId)!;
    expect(record.status).toBe("queued");
    expect(record.workspaceAlias).toBe("test-ws");
    expect(record.ownerPrincipalId).toBe("usr-1");
    expect(record.origin).toBe("user");
  });

  it("accepts peer-origin owner (#1357)", async () => {
    const svc = makeService();

    const result = await svc.run(
      {
        goal: "remote pi task",
        workspaceAlias: "test-ws",
        owner: { principalId: "peer:remote-host", origin: "peer", peer: "remote-host" },
      },
      { userId: "peer:remote-host" },
    );

    expect(result.runId).toBeDefined();
    const record = svc.store.get(result.runId)!;
    expect(record.origin).toBe("peer");
    expect(record.originPeer).toBe("remote-host");
  });

  it("rejects if Pi executor is disabled", async () => {
    const svc = makeService({ enabled: false });

    await expect(svc.run(
      { goal: "x", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    )).rejects.toThrow("Pi executor is not enabled");
  });

  it("rejects caller mismatch", async () => {
    const svc = makeService();

    await expect(svc.run(
      { goal: "x", workspaceAlias: "test-ws", owner: { principalId: "usr-1", origin: "user" } },
      { userId: "usr-2" },
    )).rejects.toThrow("Caller must match the run owner");
  });

  it("rejects empty goal", async () => {
    const svc = makeService();

    await expect(svc.run(
      { goal: "  ", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    )).rejects.toThrow("Goal is required");
  });

  it("rejects oversize goal", async () => {
    const svc = makeService();
    const bigGoal = "x".repeat(4001);

    await expect(svc.run(
      { goal: bigGoal, workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    )).rejects.toThrow(/exceeds/);
  });

  it("rejects goal containing secrets", async () => {
    const svc = makeService();

    await expect(svc.run(
      { goal: "use sk-proj-ABC123DEF456GHI789JKL", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    )).rejects.toThrow("secret token");
  });

  it("compensates spin session on store failure", async () => {
    const svc = makeService();
    // Break the store by inserting a conflicting row first
    const badInput = {
      goal: "test",
      workspaceAlias: "test-ws",
      owner: { principalId: "u1", origin: "user" },
    };

    await expect(svc.run(badInput, { userId: "u1" })).rejects.toThrow();
    // Session should be cleaned up
    expect(mockEndExternalSession).toHaveBeenCalled();
  });
});

describe("PiRunService.get()", () => {
  it("returns run for the owner", async () => {
    const svc = makeService();
    const { runId } = await svc.run(
      { goal: "my task", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    );

    const view = svc.get(runId, { userId: "u1" });
    expect(view.runId).toBe(runId);
    expect(view.status).toBe("queued");
  });

  it("throws for non-existent run", async () => {
    const svc = makeService();
    expect(() => svc.get("nonexistent", { userId: "u1" })).toThrow("not found");
  });

  it("throws for unauthorized caller", async () => {
    const svc = makeService();
    const { runId } = await svc.run(
      { goal: "my task", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    );

    expect(() => svc.get(runId, { userId: "u2" })).toThrow("different principal");
  });
});

describe("PiRunService.list()", () => {
  it("returns only caller's runs", async () => {
    const svc = makeService();
    await svc.run(
      { goal: "task a", workspaceAlias: "test-ws", owner: { principalId: "u1", origin: "user" } },
      { userId: "u1" },
    );
    await svc.run(
      { goal: "task b", workspaceAlias: "test-ws", owner: { principalId: "u2", origin: "user" } },
      { userId: "u2" },
    );

    const list = svc.list({}, { userId: "u1" });
    expect(list).toHaveLength(1);
    expect(list[0]!.runId).toBeDefined();
  });
});
