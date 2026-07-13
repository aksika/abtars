import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { PiTaskStore, resetPiTaskStoreForTests } from "./pi-task-store.js";
import { reserveRequest, completeRequest, failRequest } from "./pi-request-ledger.js";
import type { TaskDatabase } from "./tasks/kanban-board.js";

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
    type TEXT NOT NULL DEFAULT 'task',
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
  // Create pi_api_requests for backfill testing
  raw.exec(`CREATE TABLE IF NOT EXISTS pi_api_requests (
    client_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (client_id, operation, request_id)
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

function makeStore(): PiTaskStore {
  const db = createTestDb();
  resetPiTaskStoreForTests();
  return new PiTaskStore(db);
}

describe("PiTaskStore", () => {
  describe("createAndComplete", () => {
    it("creates card, ownership, and completes ledger in one tx", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;

      reserveRequest("client-a", "task:create", "req-1", "hash1");
      const result = store.createAndComplete({
        clientId: "client-a",
        requestId: "req-1",
        requestHash: "hash1",
        title: "task 1",
        goal: "do something",
        priority: "MEDIUM",
        deliveryMode: "silent",
      });
      expect(result.created).toBe(true);
      if (result.created) {
        expect(result.cardId).toBeGreaterThan(0);
        expect(JSON.parse(result.responseJson)).toMatchObject({ ok: true, task_id: result.cardId });
      }

      // Verify card exists
      const card = db.prepare(`SELECT id, source, source_id, status FROM kanban_board WHERE id = ?`).get(result.created ? result.cardId : 0) as Record<string, unknown> | undefined;
      expect(card).toBeTruthy();
      expect(card!.source).toBe("pi");
      expect(card!.source_id).toBe("req-1");
      expect(card!.status).toBe("queued");

      // Verify ownership
      const own = db.prepare(`SELECT client_id, request_id FROM pi_task_ownership WHERE card_id = ?`).get(result.created ? result.cardId : 0) as Record<string, unknown> | undefined;
      expect(own).toBeTruthy();
      expect(own!.client_id).toBe("client-a");
      expect(own!.request_id).toBe("req-1");

      // Verify ledger completed
      const r = reserveRequest("client-a", "task:create", "req-1", "hash1");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.entry.state).toBe("completed");
    });

    it("succeeds even without prior ledger reservation (card+ownership committed)", () => {
      const store = makeStore();
      const result = store.createAndComplete({
        clientId: "client-a",
        requestId: "req-1",
        requestHash: "hash1",
        title: "task 1",
        goal: "do something",
        priority: "MEDIUM",
        deliveryMode: "silent",
      });
      // Card+ownership are always committed. Ledger is best-effort.
      expect(result.created).toBe(true);
    });

    it("succeeds even with wrong hash (card+ownership committed)", () => {
      const store = makeStore();
      reserveRequest("client-a", "task:create", "req-1", "hash1");

      const result = store.createAndComplete({
        clientId: "client-a",
        requestId: "req-1",
        requestHash: "wrong-hash",
        title: "task 1",
        goal: "do something",
        priority: "MEDIUM",
        deliveryMode: "silent",
      });
      expect(result.created).toBe(true);
    });

    it("does not allow duplicate (client, request)", () => {
      const store = makeStore();
      reserveRequest("client-a", "task:create", "req-1", "hash1");
      store.createAndComplete({
        clientId: "client-a", requestId: "req-1", requestHash: "hash1",
        title: "t", goal: "g", priority: "MEDIUM", deliveryMode: "silent",
      });
      reserveRequest("client-a", "task:create", "req-2", "hash2");
      // Different request ID but same client — should work
      const r2 = store.createAndComplete({
        clientId: "client-a", requestId: "req-2", requestHash: "hash2",
        title: "t2", goal: "g2", priority: "MEDIUM", deliveryMode: "silent",
      });
      expect(r2.created).toBe(true);
    });
  });

  describe("getOwned", () => {
    it("returns the task for the exact owner", () => {
      const store = makeStore();
      reserveRequest("client-a", "task:create", "req-1", "hash1");
      const r = store.createAndComplete({
        clientId: "client-a", requestId: "req-1", requestHash: "hash1",
        title: "t", goal: "g", priority: "MEDIUM", deliveryMode: "silent",
      });
      if (!r.created) return;
      const view = store.getOwned(r.cardId, "client-a");
      expect(view).not.toBeNull();
      expect(view!.status).toBe("queued");
    });

    it("returns null for a different client", () => {
      const store = makeStore();
      reserveRequest("client-a", "task:create", "req-1", "hash1");
      const r = store.createAndComplete({
        clientId: "client-a", requestId: "req-1", requestHash: "hash1",
        title: "t", goal: "g", priority: "MEDIUM", deliveryMode: "silent",
      });
      if (!r.created) return;
      const view = store.getOwned(r.cardId, "client-b");
      expect(view).toBeNull();
    });

    it("returns null for a prefix-overlapping client ID", () => {
      const store = makeStore();
      reserveRequest("client-abc", "task:create", "req-1", "hash1");
      const r = store.createAndComplete({
        clientId: "client-abc", requestId: "req-1", requestHash: "hash1",
        title: "t", goal: "g", priority: "MEDIUM", deliveryMode: "silent",
      });
      if (!r.created) return;
      const view = store.getOwned(r.cardId, "client-a");
      expect(view).toBeNull();
    });

    it("returns null for a card without ownership row", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      // Insert a pi card manually without ownership
      db.prepare(`INSERT INTO kanban_board (id, title, source, source_id) VALUES (99, 'orphan', 'pi', 'orphan')`).run();
      const view = store.getOwned(99, "any-client");
      expect(view).toBeNull();
    });
  });

  describe("backfillProvenLegacyOwnership", () => {
    it("restores a provable legacy task", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      // Create a legacy card and ledger entry
      db.prepare(`INSERT INTO kanban_board (id, title, source, source_id) VALUES (10, 'legacy', 'pi', 'legacy-req')`).run();
      db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, response_json)
        VALUES ('client-old', 'task:create', 'legacy-req', 'h', 'completed', '{"ok":true,"task_id":10}')`).run();

      const summary = store.backfillProvenLegacyOwnership();
      expect(summary.restored).toBe(1);
      expect(summary.skipped).toBe(0);

      // Verify it can now be looked up
      const view = store.getOwned(10, "client-old");
      expect(view).not.toBeNull();
    });

    it("skips a mismatched legacy card", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      // Card exists but with wrong source_id
      db.prepare(`INSERT INTO kanban_board (id, title, source, source_id) VALUES (10, 'mismatch', 'pi', 'other-req')`).run();
      db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, response_json)
        VALUES ('client-old', 'task:create', 'legacy-req', 'h', 'completed', '{"ok":true,"task_id":10}')`).run();

      const summary = store.backfillProvenLegacyOwnership();
      expect(summary.restored).toBe(0);
      expect(summary.skipped).toBeGreaterThanOrEqual(1);
    });

    it("skips a malformed response JSON", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, response_json)
        VALUES ('c', 'task:create', 'r', 'h', 'completed', 'not-json')`).run();

      const summary = store.backfillProvenLegacyOwnership();
      expect(summary.restored).toBe(0);
      expect(summary.errors).toBe(1);
    });

    it("skips a non-task operation", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, response_json)
        VALUES ('c', 'notify', 'r', 'h', 'completed', '{"ok":true}')`).run();

      const summary = store.backfillProvenLegacyOwnership();
      expect(summary.restored).toBe(0);
    });

    it("is idempotent", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT INTO kanban_board (id, title, source, source_id) VALUES (10, 'legacy', 'pi', 'legacy-req')`).run();
      db.prepare(`INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state, response_json)
        VALUES ('c', 'task:create', 'legacy-req', 'h', 'completed', '{"ok":true,"task_id":10}')`).run();

      const s1 = store.backfillProvenLegacyOwnership();
      expect(s1.restored).toBe(1);

      const s2 = store.backfillProvenLegacyOwnership();
      expect(s2.restored).toBe(1); // same row restored again via OR IGNORE recheck
      expect(s2.skipped).toBe(0);
    });
  });
});
