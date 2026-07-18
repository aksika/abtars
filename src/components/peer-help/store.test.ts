import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let db: import("better-sqlite3").Database;
let dbPath: string;
let TEST_HOME: string;

function createKanbanTable(db: import("better-sqlite3").Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      assignee TEXT DEFAULT 'local',
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'queued',
      type TEXT,
      notes TEXT,
      result_summary TEXT,
      result_path TEXT,
      error TEXT,
      delivery_mode TEXT DEFAULT 'deliver',
      source_peer TEXT,
      goal TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

function makeNerve() {
  const fired: string[] = [];
  return {
    fire: (e: string, ...args: unknown[]) => { fired.push(e); void args; },
    get fired() { return fired; },
  };
}

function makeKanban() {
  return {
    kanbanGetCard(id: number) {
      const row = db.prepare("SELECT id, status, result_summary, error FROM kanban_board WHERE id = ?").get(id) as any;
      if (!row) return undefined;
      return { id: row.id, status: row.status, result_summary: row.result_summary, error: row.error };
    },
  };
}

beforeEach(async () => {
  const { resolveNativeDep } = await import("../../utils/lazy-require.js");
  const Database = resolveNativeDep("better-sqlite3");
  TEST_HOME = join(tmpdir(), `help-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  dbPath = join(TEST_HOME, "test.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  createKanbanTable(db);
});

afterEach(() => {
  db.close();
  try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
});

async function makeStore() {
  const { PeerHelpStore } = await import("./store.js");
  const nerve = makeNerve();
  const kanban = makeKanban();
  const store = new PeerHelpStore(db as any, kanban as any, nerve as any);
  return { store, nerve };
}

describe("PeerHelpStore", () => {
  describe("reserve", () => {
    it("inserts a pending row for new request", async () => {
      const { store } = await makeStore();
      const r = store.reserve("kp", "req1", "hash1");
      expect(r.status).toBe("new");

      const row = db.prepare("SELECT state FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?").get("kp", "req1") as any;
      expect(row.state).toBe("pending");
    });

    it("replays terminal state with stored response", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.completeDecision({ originPeer: "kp", requestId: "req1" }, "declined", {
        version: 1, request_id: "req1", decision: "declined", reason_code: "policy",
      });

      const r2 = store.reserve("kp", "req1", "hash1");
      expect(r2.status).toBe("replay");
      expect(r2.response?.decision).toBe("declined");
      expect(r2.response?.reason_code).toBe("policy");
    });

    it("returns conflict for different hash", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const r2 = store.reserve("kp", "req1", "hash2");
      expect(r2.status).toBe("conflict");
    });

    it("returns in_flight for pending with same hash", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const r2 = store.reserve("kp", "req1", "hash1");
      expect(r2.status).toBe("in_flight");
    });
  });

  describe("acceptGeneric — atomicity", () => {
    it("creates a kanban O card and flips row to accepted in one transaction", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const result = store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );

      expect(result.contribution_ref).toBe("help_abc");
      expect(result.local_card_id).toBeGreaterThan(0);

      const row = db.prepare("SELECT state, contribution_ref, local_card_id FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?").get("kp", "req1") as any;
      expect(row.state).toBe("accepted");
      expect(row.contribution_ref).toBe("help_abc");
      expect(row.local_card_id).toBe(result.local_card_id);

      const card = db.prepare("SELECT id, type, status, source_peer FROM kanban_board WHERE id = ?").get(result.local_card_id) as any;
      expect(card.type).toBe("O");
      expect(card.status).toBe("queued");
      expect(card.source_peer).toBe("kp");
    });

    it("fires card:queued once via nerve.fire after commit", async () => {
      const { store, nerve } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );
      expect(nerve.fired.filter(e => e === "card:queued")).toHaveLength(1);
    });

    it("throws on non-pending row and creates no card", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.completeDecision({ originPeer: "kp", requestId: "req1" }, "declined", {
        version: 1, request_id: "req1", decision: "declined",
      });

      expect(() => store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      )).toThrow();

      const cards = db.prepare("SELECT COUNT(*) as cnt FROM kanban_board").get() as any;
      expect(cards.cnt).toBe(0);
    });
  });

  describe("acceptPi", () => {
    it("stores run_id + accepted state without a generic card", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.acceptPi(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        "run_42",
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_pi" },
      );

      const row = db.prepare("SELECT state, local_run_id, local_card_id FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?").get("kp", "req1") as any;
      expect(row.state).toBe("accepted");
      expect(row.local_run_id).toBe("run_42");
      expect(row.local_card_id).toBeNull();
    });
  });

  describe("completeDecision", () => {
    it("persists declined response for replay", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.completeDecision(
        { originPeer: "kp", requestId: "req1" },
        "declined",
        { version: 1, request_id: "req1", decision: "declined", reason_code: "policy_denied" },
      );

      const row = db.prepare("SELECT state, response_json FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?").get("kp", "req1") as any;
      expect(row.state).toBe("declined");
      expect(JSON.parse(row.response_json).reason_code).toBe("policy_denied");
    });
  });

  describe("markUnknown", () => {
    it("sets unknown state and returns in_flight on same-hash retry", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.markUnknown("kp", "req1");

      const row = db.prepare("SELECT state FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?").get("kp", "req1") as any;
      expect(row.state).toBe("unknown");

      const r2 = store.reserve("kp", "req1", "hash1");
      expect(r2.status).toBe("in_flight");
    });
  });

  describe("recordWithdrawal", () => {
    it("returns noted for accepted contribution", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );

      const w = store.recordWithdrawal("kp", "req1", "help_abc");
      expect(w.status).toBe("noted");
    });

    it("returns already_terminal for declined", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const ref = "help_decl";
      store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: ref },
      );
      // Simulate terminal state: complete the card
      db.prepare("UPDATE peer_help_requests SET state = 'declined' WHERE origin_peer = 'kp' AND request_id = 'req1'").run();

      const w = store.recordWithdrawal("kp", "req1", ref);
      expect(w.status).toBe("already_terminal");
    });

    it("returns unknown_contribution on ref mismatch", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const w = store.recordWithdrawal("kp", "req1", "nonexistent");
      expect(w.status).toBe("unknown_contribution");
    });
  });

  describe("getPublicStatus", () => {
    it("maps accepted + card done → completed", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const { local_card_id } = store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );
      db.prepare("UPDATE kanban_board SET status = 'done', result_summary = 'done' WHERE id = ?").run(local_card_id);

      const s = store.getPublicStatus("kp", "req1", "help_abc");
      expect(s?.state).toBe("completed");
    });

    it("maps accepted + card failed → failed", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      const { local_card_id } = store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );
      db.prepare("UPDATE kanban_board SET status = 'failed', error = 'oops' WHERE id = ?").run(local_card_id);

      const s = store.getPublicStatus("kp", "req1", "help_abc");
      expect(s?.state).toBe("failed");
    });

    it("returns null on ref mismatch", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      expect(store.getPublicStatus("kp", "req1", "wrong_ref")).toBeNull();
    });
  });

  describe("contribution_ref UNIQUE constraint", () => {
    it("enforces unique contribution_ref", async () => {
      const { store } = await makeStore();
      store.reserve("kp", "req1", "hash1");
      store.acceptGeneric(
        { originPeer: "kp", requestId: "req1", requestHash: "hash1" },
        { goal: "do x", title: "[help:kp] do x", sourcePeer: "kp", sourceId: "req1", deliveryMode: "silent" },
        { version: 1, request_id: "req1", decision: "accepted", contribution_ref: "help_abc" },
      );

      store.reserve("kp", "req2", "hash2");
      expect(() => store.acceptGeneric(
        { originPeer: "kp", requestId: "req2", requestHash: "hash2" },
        { goal: "do y", title: "[help:kp] do y", sourcePeer: "kp", sourceId: "req2", deliveryMode: "silent" },
        { version: 1, request_id: "req2", decision: "accepted", contribution_ref: "help_abc" },
      )).toThrow();
    });
  });
});
