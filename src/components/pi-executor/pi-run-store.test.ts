import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { PiRunStore } from "./pi-run-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  // Create the kanban_board table that pi_runs references
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
  // Wrap transaction() like requireTaskDatabase() does
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

function makeStore(): PiRunStore {
  const db = createTestDb();
  return new PiRunStore({ db });
}

/** Insert a minimal pi_run for testing.  Returns the run id. */
function seedRun(store: PiRunStore, overrides: {
  id?: string;
  generation?: number;
  status?: string;
  pendingRequestId?: string | null;
  pendingRequestType?: string | null;
  cardId?: number;
  lastReplyRequestId?: string;
  lastReplyOutcome?: string;
}): string {
  const db = (store as any).db as TaskDatabase;
  const runId = overrides.id ?? store.generateId();
  const cardId = overrides.cardId ?? 1;
  // Ensure kanban_board row exists
  try {
    db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status) VALUES (?, ?, 'pi', 'running')`).run(cardId, `card-for-${runId}`);
  } catch { /* ignore */ }
  db.prepare(`INSERT OR REPLACE INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
    origin, execution_generation, current_session_id, status, pending_request_id, pending_request_type,
    last_ui_reply_request_id, last_ui_reply_outcome)
    VALUES (?, ?, 'test-ws', 'test goal', 'owner1', 'user', ?, 'session1', ?, ?, ?, ?, ?)`).run(
    runId, cardId, overrides.generation ?? 1, overrides.status ?? 'awaiting_input',
    overrides.pendingRequestId ?? null, overrides.pendingRequestType ?? null,
    overrides.lastReplyRequestId ?? null, overrides.lastReplyOutcome ?? null,
  );
  return runId;
}

describe("PiRunStore — #1395 UI claim/restore/setPending", () => {
  describe("claimPendingUi", () => {
    it("claims a matching pending request and clears pending fields", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const claim = store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      expect(claim.claimed).toBe(true);
      if (claim.claimed) expect(claim.requestType).toBe("select");

      const record = store.get(runId)!;
      expect(record.status).toBe("running");
      expect(record.pendingRequestId).toBeUndefined();
      expect(record.pendingRequestType).toBeUndefined();
      expect(record.lastUiReplyRequestId).toBe("req-1");
      expect(record.lastUiReplyGeneration).toBe(1);
      expect(record.lastUiReplyOutcome).toBe("claimed");
    });

    it("rejects sequential duplicate claim", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const first = store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      expect(first.claimed).toBe(true);

      const second = store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      expect(second.claimed).toBe(false);
      if (!second.claimed) expect(second.reason).toBe("already_consumed");
    });

    it("concurrent claims: only one winner", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "confirm" });

      // Simulate two concurrent callers using separate store instances sharing the same DB
      const db = (store as any).db as TaskDatabase;
      const store2 = new PiRunStore({ db });

      const c1 = store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      const c2 = store2.claimPendingUi({ runId, generation: 1, requestId: "req-1" });

      const winners = [c1, c2].filter(c => c.claimed).length;
      expect(winners).toBe(1);
    });

    it("rejects wrong generation", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "input" });

      const claim = store.claimPendingUi({ runId, generation: 2, requestId: "req-1" });
      expect(claim.claimed).toBe(false);
      if (!claim.claimed) expect(claim.reason).toBe("wrong_generation");
    });

    it("rejects wrong request ID", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "editor" });

      const claim = store.claimPendingUi({ runId, generation: 1, requestId: "req-2" });
      expect(claim.claimed).toBe(false);
      if (!claim.claimed) expect(claim.reason).toBe("request_mismatch");
    });

    it("rejects non-awaiting_input status", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "running" });

      const claim = store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      expect(claim.claimed).toBe(false);
      if (!claim.claimed) expect(claim.reason).toBe("wrong_status");
    });

    it("rejects missing run", () => {
      const store = makeStore();
      const claim = store.claimPendingUi({ runId: "nonexistent", generation: 1, requestId: "req-1" });
      expect(claim.claimed).toBe(false);
      if (!claim.claimed) expect(claim.reason).toBe("missing");
    });
  });

  describe("restorePendingUi", () => {
    it("restores a claimed request when outcome is still claimed", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });

      const restored = store.restorePendingUi({ runId, generation: 1, requestId: "req-1", requestType: "select" });
      expect(restored).toBe(true);

      const record = store.get(runId)!;
      expect(record.status).toBe("awaiting_input");
      expect(record.pendingRequestId).toBe("req-1");
      expect(record.pendingRequestType).toBe("select");
      expect(record.lastUiReplyOutcome).toBeUndefined();
    });

    it("does NOT restore after acknowledged outcome", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "input" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "acknowledged" });

      const restored = store.restorePendingUi({ runId, generation: 1, requestId: "req-1", requestType: "input" });
      expect(restored).toBe(false);
    });

    it("does NOT restore after delivery_unknown", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "editor" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });

      const restored = store.restorePendingUi({ runId, generation: 1, requestId: "req-1", requestType: "editor" });
      expect(restored).toBe(false);
    });
  });

  describe("recordUiReplyOutcome", () => {
    it("records acknowledged outcome", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });

      const ok = store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "acknowledged" });
      expect(ok).toBe(true);

      const record = store.get(runId)!;
      expect(record.lastUiReplyOutcome).toBe("acknowledged");
    });

    it("records delivery_unknown outcome", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "confirm" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });

      const ok = store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });
      expect(ok).toBe(true);

      const record = store.get(runId)!;
      expect(record.lastUiReplyOutcome).toBe("delivery_unknown");
    });

    it("does not record after already recorded", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "input" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "acknowledged" });

      // Try recording again — outcome is no longer 'claimed', should be no-op
      const ok = store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });
      expect(ok).toBe(false);
      const record = store.get(runId)!;
      expect(record.lastUiReplyOutcome).toBe("acknowledged");
    });
  });

  describe("setPendingUi", () => {
    it("sets a pending request on a running run", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "running" });

      const result = store.setPendingUi({ runId, generation: 1, requestId: "req-1", requestType: "input" });
      expect(result.ok).toBe(true);

      const record = store.get(runId)!;
      expect(record.status).toBe("awaiting_input");
      expect(record.pendingRequestId).toBe("req-1");
      expect(record.pendingRequestType).toBe("input");
    });

    it("rejects duplicate consumed request ID", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "running", lastReplyRequestId: "req-1", lastReplyOutcome: "acknowledged" });

      const result = store.setPendingUi({ runId, generation: 1, requestId: "req-1", requestType: "input" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("duplicate_request");
    });

    it("rejects when another request is already pending (busy)", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const result = store.setPendingUi({ runId, generation: 1, requestId: "req-2", requestType: "input" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("busy");
    });

    it("rejects wrong generation", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "running", generation: 1 });

      const result = store.setPendingUi({ runId, generation: 2, requestId: "req-1", requestType: "input" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("wrong_generation");
    });
  });

  describe("casTransition — nullable pending fields", () => {
    it("clears pending fields when null is passed", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const ok = store.casTransition(runId, "awaiting_input", "cancelling", {
        pendingRequestId: null,
        pendingRequestType: null,
      });
      expect(ok).toBe(true);

      const record = store.get(runId)!;
      expect(record.status).toBe("cancelling");
      expect(record.pendingRequestId).toBeUndefined();
      expect(record.pendingRequestType).toBeUndefined();
    });

    it("does not clear pending fields when undefined is passed (omitted)", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const ok = store.casTransition(runId, "awaiting_input", "cancelling");
      expect(ok).toBe(true);

      const record = store.get(runId)!;
      expect(record.status).toBe("cancelling");
      expect(record.pendingRequestId).toBe("req-1");
    });
  });

  describe("settleTerminal — clears pending fields", () => {
    it("clears pending fields on terminal settlement", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });

      const settlement = store.settleTerminal({
        runId,
        generation: 1,
        expectedStatuses: ["awaiting_input"],
        outcome: "completed",
        metadata: {},
      });
      expect(settlement.committed).toBe(true);

      const record = store.get(runId)!;
      expect(record.status).toBe("completed");
      expect(record.pendingRequestId).toBeUndefined();
      expect(record.pendingRequestType).toBeUndefined();
    });
  });

  describe("createPiCardAndRun", () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        runId: "test-run-1",
        sessionId: "spin-sess-1",
        title: "Pi: test task",
        goal: "do the thing",
        priority: "MEDIUM",
        workspaceAlias: "my-ws",
        ownerPrincipalId: "usr-1",
        origin: "user" as const,
        originPlatform: undefined,
        originChatId: undefined,
        originPeer: undefined,
        modelProvider: undefined,
        modelId: undefined,
        thinking: undefined,
        ...overrides,
      };
    }

    it("creates a card and run with no idempotency", () => {
      const store = makeStore();
      const result = store.createPiCardAndRun(makeInput());

      expect(result.runId).toBe("test-run-1");
      expect(result.cardId).toBeGreaterThan(0);
      expect(result.sessionId).toBe("spin-sess-1");
      expect(result.responseJson).toBeUndefined();

      // Verify the run was stored
      const run = store.get("test-run-1")!;
      expect(run.status).toBe("queued");
      expect(run.cardId).toBe(result.cardId);
      expect(run.workspaceAlias).toBe("my-ws");
      expect(run.ownerPrincipalId).toBe("usr-1");
      expect(run.origin).toBe("user");
    });

    it("handles peer-origin owner (#1357)", () => {
      const store = makeStore();
      const result = store.createPiCardAndRun(makeInput({
        origin: "peer" as const,
        ownerPrincipalId: "peer:remote-host",
        originPeer: "remote-host",
      }));

      const run = store.get(result.runId)!;
      expect(run.origin).toBe("peer");
      expect(run.ownerPrincipalId).toBe("peer:remote-host");
      expect(run.originPeer).toBe("remote-host");
    });

    it("accepts optional model fields", () => {
      const store = makeStore();
      const result = store.createPiCardAndRun(makeInput({
        modelProvider: "openai",
        modelId: "gpt-4",
        thinking: "high",
      }));

      const run = store.get(result.runId)!;
      expect(run.modelProvider).toBe("openai");
      expect(run.modelId).toBe("gpt-4");
      expect(run.thinking).toBe("high");
    });

    it("completes idempotency reservation when provided", () => {
      const store = makeStore();
      const db = (store as any).db as TaskDatabase;

      // Insert a pending ledger entry first (same DB, same schema)
      db.prepare(
        `INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state)
         VALUES ('usr-1', 'pi:delegate', 'idem-req-1', 'abc123', 'pending')`
      ).run();

      const result = store.createPiCardAndRun(makeInput({
        runId: "idem-run-1",
        idempotency: {
          clientId: "usr-1",
          operation: "pi:delegate",
          requestId: "idem-req-1",
          requestHash: "abc123",
        },
      }));

      expect(result.responseJson).toBeDefined();
      const parsed = JSON.parse(result.responseJson!);
      expect(parsed.task_id).toBe(result.cardId);
      expect(parsed.run_id).toBe("idem-run-1");
      expect(parsed.executor).toBe("pi");
      expect(parsed.generation).toBe(1);
      expect(parsed.session_id).toBe("spin-sess-1");
    });

    it("throws when idempotency reservation is not pending", () => {
      const store = makeStore();

      expect(() => store.createPiCardAndRun(makeInput({
        runId: "idem-run-2",
        idempotency: {
          clientId: "usr-1",
          operation: "pi:delegate",
          requestId: "nonexistent-req",
          requestHash: "abc123",
        },
      }))).toThrow("Pi idempotency reservation was not pending");
    });

    it("creates multiple runs with unique IDs", () => {
      const store = makeStore();
      const r1 = store.createPiCardAndRun(makeInput({ runId: "run-a" }));
      const r2 = store.createPiCardAndRun(makeInput({ runId: "run-b", title: "Pi: another" }));

      expect(r1.cardId).not.toBe(r2.cardId);
      expect(store.get("run-a")).toBeDefined();
      expect(store.get("run-b")).toBeDefined();
    });
  });
});
