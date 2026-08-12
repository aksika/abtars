import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { PiRunStore } from "./pi-run-store.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { ensureKanbanBoardSchema } from "../tasks/kanban-board.js";

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
  // #1638: the shared claim path transitions cards through the production
  // helper — the fixture must use the real board schema so it can never drift.
  ensureKanbanBoardSchema(raw);
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
  return new PiRunStore({ db, sessionStorageRoot: "/tmp/sessions" });
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
      const store2 = new PiRunStore({ db, sessionStorageRoot: "/tmp/sessions" });

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

    it("does NOT restore after delivery_unknown outcome", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "input" });
      store.claimPendingUi({ runId, generation: 1, requestId: "req-1" });
      store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });

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
    it("records delivery_unknown outcome from 'claimed'", () => {
      const store = makeStore();
      const runId = seedRun(store, { status: "awaiting_input", pendingRequestId: "req-1", pendingRequestType: "select" });
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
      store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });

      // Try recording again — outcome is no longer 'claimed', should be no-op
      const ok = store.recordUiReplyOutcome({ runId, generation: 1, requestId: "req-1", outcome: "delivery_unknown" });
      expect(ok).toBe(false);
      const record = store.get(runId)!;
      expect(record.lastUiReplyOutcome).toBe("delivery_unknown");
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
      const runId = seedRun(store, { status: "running", lastReplyRequestId: "req-1", lastReplyOutcome: "delivery_unknown" });

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

  describe("cleanupOldCommands / cleanupConsumedApprovals (#1551)", () => {
    function insertCommand(store: PiRunStore, id: string, state: string, updatedAt: string) {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`
        INSERT INTO remote_pi_commands (origin_peer, command_id, run_id, payload_hash, state, created_at, updated_at)
        VALUES ('peer1', ?, 'run-x', 'h', ?, ?, ?)
      `).run(id, state, updatedAt, updatedAt);
    }
    function insertApproval(store: PiRunStore, id: string, consumedAt: string) {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`
        INSERT INTO remote_pi_approvals_consumed (approval_id, run_id, origin_peer, command_id, consumed_at)
        VALUES (?, 'run-x', 'peer1', 'c1', ?)
      `).run(id, consumedAt);
    }

    it("deletes a completed command older than the cutoff", () => {
      const store = makeStore();
      insertCommand(store, "old", "completed", "2020-01-01T00:00:00.000Z");

      const deleted = store.cleanupOldCommands(168);

      expect(deleted).toBe(1);
    });

    it("does not delete a completed command inside the retention window", () => {
      const store = makeStore();
      insertCommand(store, "recent", "completed", new Date().toISOString());

      const deleted = store.cleanupOldCommands(168);

      expect(deleted).toBe(0);
    });

    it("does not delete an old command still in a non-terminal state", () => {
      const store = makeStore();
      insertCommand(store, "pending-old", "pending", "2020-01-01T00:00:00.000Z");

      const deleted = store.cleanupOldCommands(168);

      expect(deleted).toBe(0);
    });

    it("deletes a consumed approval older than the cutoff regardless of state", () => {
      const store = makeStore();
      insertApproval(store, "appr-old", "2020-01-01T00:00:00.000Z");

      const deleted = store.cleanupConsumedApprovals(168);

      expect(deleted).toBe(1);
    });

    it("does not delete a recently consumed approval", () => {
      const store = makeStore();
      insertApproval(store, "appr-recent", new Date().toISOString());

      const deleted = store.cleanupConsumedApprovals(168);

      expect(deleted).toBe(0);
    });
  });

  describe("createSupervisedRun (#1638)", () => {
    function ensureCard(store: PiRunStore, cardId: number): void {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status) VALUES (?, ?, 'agent', 'queued')`).run(cardId, `w-card-${cardId}`);
    }

    it("creates one subordinate run row per W card at generation 1", () => {
      const store = makeStore();
      ensureCard(store, 7001);
      const first = store.createSupervisedRun({
        cardId: 7001, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "peer:kp", sessionId: "s1",
      });
      expect(first.created).toBe(true);
      expect(first.generation).toBe(1);

      const again = store.createSupervisedRun({
        cardId: 7001, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "peer:kp", sessionId: "s1",
      });
      expect(again.created).toBe(false);
      expect(again.runId).toBe(first.runId);
      expect(store.getByCardId(7001)?.executionGeneration).toBe(1);
    });

    it("two W cards get distinct run rows", () => {
      const store = makeStore();
      ensureCard(store, 7101);
      ensureCard(store, 7102);
      const a = store.createSupervisedRun({ cardId: 7101, workspaceAlias: "repo-a", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
      const b = store.createSupervisedRun({ cardId: 7102, workspaceAlias: "repo-b", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
      expect(a.runId).not.toBe(b.runId);
    });
  });

  describe("canonical workspace claims (#1638)", () => {
    function seedQueued(store: PiRunStore, cardId: number, alias: string): string {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'agent', 'queued', 'W')`).run(cardId, `w-${cardId}`);
      db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id, origin, execution_generation, current_session_id, status) VALUES (?, ?, ?, 'g', 'p', 'supervised', 1, 's', 'queued')`).run(`pirun_${cardId}`, cardId, alias);
      return `pirun_${cardId}`;
    }

    it("first claim wins; a second run on the same canonical path is busy", () => {
      const store = makeStore();
      const a = seedQueued(store, 7201, "repo-a");
      const b = seedQueued(store, 7202, "repo-a");
      const first = store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/repo-a" });
      expect(first.kind).toBe("claimed");
      const second = store.claimSupervisedGeneration({ runId: b, expectedGeneration: 1, canonicalPath: "/canon/repo-a" });
      expect(second.kind).toBe("busy");
      // the losing run stays queued with no claim and no process
      expect(store.get(b)?.status).toBe("queued");
      expect(store.listWorkspaceClaims()).toHaveLength(1);
    });

    it("alias synonyms contend on the same canonical path", () => {
      const store = makeStore();
      const a = seedQueued(store, 7301, "repo-a");
      const b = seedQueued(store, 7302, "repo-b");
      const first = store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/shared" });
      expect(first.kind).toBe("claimed");
      const second = store.claimSupervisedGeneration({ runId: b, expectedGeneration: 1, canonicalPath: "/canon/shared" });
      expect(second.kind).toBe("busy");
    });

    it("distinct workspaces can both claim", () => {
      const store = makeStore();
      const a = seedQueued(store, 7401, "repo-a");
      const b = seedQueued(store, 7402, "repo-b");
      expect(store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/a" }).kind).toBe("claimed");
      expect(store.claimSupervisedGeneration({ runId: b, expectedGeneration: 1, canonicalPath: "/canon/b" }).kind).toBe("claimed");
      expect(store.listWorkspaceClaims()).toHaveLength(2);
    });

    it("exact same (run,generation) holder is idempotent", () => {
      const store = makeStore();
      const a = seedQueued(store, 7501, "repo-a");
      expect(store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/a" }).kind).toBe("claimed");
      expect(store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/a" }).kind).toBe("idempotent");
    });

    it("stale release cannot free a newer claim holder", () => {
      const store = makeStore();
      const a = seedQueued(store, 7601, "repo-a");
      store.claimSupervisedGeneration({ runId: a, expectedGeneration: 1, canonicalPath: "/canon/a" });
      // a stale generation (never held) cannot release the live holder
      const stale = store.releaseWorkspaceClaim({ canonicalPath: "/canon/a", runId: a, generation: 99 });
      expect(stale.released).toBe(false);
      expect(store.listWorkspaceClaims()).toHaveLength(1);
      // the real holder releases cleanly
      const real = store.releaseWorkspaceClaim({ canonicalPath: "/canon/a", runId: a, generation: 1 });
      expect(real.released).toBe(true);
      expect(store.listWorkspaceClaims()).toHaveLength(0);
    });

    it("standalone claimQueuedGeneration keeps run+card queued while the path is busy", () => {
      const store = makeStore();
      const holder = seedQueued(store, 7701, "repo-a");
      const waiter = seedQueued(store, 7702, "repo-a");
      store.claimSupervisedGeneration({ runId: holder, expectedGeneration: 1, canonicalPath: "/canon/shared" });
      const claim = store.claimQueuedGeneration(7702, "/canon/shared");
      expect(claim.claimed).toBe(false);
      expect(claim.reason).toBe("busy");
      expect(store.get(waiter)?.status).toBe("queued");
      const db = (store as any).db as TaskDatabase;
      const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(7702) as { status: string };
      expect(card.status).toBe("queued");
    });

    it("standalone claimQueuedGeneration starts after the holder releases", () => {
      const store = makeStore();
      const holder = seedQueued(store, 7801, "repo-a");
      const waiter = seedQueued(store, 7802, "repo-a");
      store.claimSupervisedGeneration({ runId: holder, expectedGeneration: 1, canonicalPath: "/canon/shared" });
      expect(store.claimQueuedGeneration(7802, "/canon/shared").claimed).toBe(false);
      store.releaseWorkspaceClaim({ canonicalPath: "/canon/shared", runId: holder, generation: 1 });
      const claim = store.claimQueuedGeneration(7802, "/canon/shared");
      expect(claim.claimed).toBe(true);
      if (claim.claimed) {
        expect(store.get(claim.runId)?.status).toBe("starting");
      }
      const db = (store as any).db as TaskDatabase;
      const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(7802) as { status: string };
      expect(card.status).toBe("running");
    });

    it("capacity release restores a supervised generation to queued", () => {
      const store = makeStore();
      const runId = seedQueued(store, 7851, "repo-a");
      expect(store.claimSupervisedGeneration({ runId, expectedGeneration: 1, canonicalPath: "/canon/capacity" }).kind).toBe("claimed");

      const released = store.releaseWorkspaceClaim({
        canonicalPath: "/canon/capacity", runId, generation: 1, restoreQueued: true,
      });
      expect(released.released).toBe(true);
      expect(store.get(runId)?.status).toBe("queued");
      expect(store.listWorkspaceClaims()).toHaveLength(0);
    });
  });

  describe("queueSupervisedGeneration (#1638)", () => {
    function seedInterrupted(store: PiRunStore, cardId: number, resumeCapability = "available"): string {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'agent', 'queued', 'W')`).run(cardId, `w-${cardId}`);
      db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id, origin, execution_generation, current_session_id, pi_session_file, resume_capability, status) VALUES (?, ?, 'repo-a', 'g', 'p', 'supervised', 1, 's1', '/sessions/s1.md', ?, 'interrupted')`).run(`pirun_q_${cardId}`, cardId, resumeCapability);
      return `pirun_q_${cardId}`;
    }

    it("advances only the run generation, never the W card", () => {
      const store = makeStore();
      const runId = seedInterrupted(store, 7901);
      const advanced = store.queueSupervisedGeneration({ runId, expectedGeneration: 1, newSessionId: "s2", sessionFile: "/sessions/s1.md", continuity: "resumed" });
      expect(advanced.committed).toBe(true);
      expect(advanced.newGeneration).toBe(2);
      const run = store.get(runId);
      expect(run?.executionGeneration).toBe(2);
      expect(run?.status).toBe("queued");
      expect(run?.currentSessionId).toBe("s2");
      const db = (store as any).db as TaskDatabase;
      const card = db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(7901) as { status: string };
      expect(card.status).toBe("queued");
    });

    it("rejects resumed when the session is not durable, and stale generation", () => {
      const store = makeStore();
      const runId = seedInterrupted(store, 7902, "never_started");
      const notResumable = store.queueSupervisedGeneration({ runId, expectedGeneration: 1, newSessionId: "s2", continuity: "resumed" });
      expect(notResumable.committed).toBe(false);
      expect(notResumable.reason).toBe("not_resumable");
      const stale = store.queueSupervisedGeneration({ runId, expectedGeneration: 99, newSessionId: "s2", continuity: "fresh" });
      expect(stale.committed).toBe(false);
      expect(stale.reason).toBe("stale");
    });

    it("resolveSessionContinuity decides resumed vs fresh from durable state", () => {
      const store = makeStore();
      const resumedRun = seedInterrupted(store, 7903, "available");
      const resumed = store.resolveSessionContinuity(resumedRun);
      expect(resumed.continuity).toBe("resumed");
      expect(resumed.sessionFile).toBe("/sessions/s1.md");
      const freshRun = seedInterrupted(store, 7904, "never_started");
      const fresh = store.resolveSessionContinuity(freshRun);
      expect(fresh.continuity).toBe("fresh");
    });

    it("fresh continuity clears the old session so start cannot resume it", () => {
      const store = makeStore();
      const runId = seedInterrupted(store, 7905, "available");
      const db = (store as any).db as TaskDatabase;
      db.prepare(`UPDATE pi_runs SET pi_session_id = 'old-session' WHERE id = ?`).run(runId);

      const advanced = store.queueSupervisedGeneration({
        runId, expectedGeneration: 1, newSessionId: "fresh-session", continuity: "fresh",
      });
      expect(advanced.committed).toBe(true);
      const run = store.get(runId);
      expect(run?.status).toBe("queued");
      expect(run?.piSessionFile).toBeUndefined();
      expect(run?.piSessionId).toBeUndefined();
      expect(run?.resumeCapability).toBe("never_started");
    });
  });

  describe("#1647 — explicit generation intent and resume admission", () => {
    /** Store with an isolated real session root under a fresh tmp dir. */
    function makeSessionStore(): { store: PiRunStore; root: string; cleanup: () => void } {
      const db = createTestDb();
      const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
      const store = new PiRunStore({ db, sessionStorageRoot: root });
      return { store, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }

    function writeSession(root: string, file: string, id: string): string {
      const path = join(root, file);
      writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n", "utf-8");
      return path;
    }

    /** Standalone run: card running, run starting, workspace claim held. */
    function seedActive(store: PiRunStore, cardId: number, runId: string, opts: { status?: string; origin?: string; piSessionId?: string; piSessionFile?: string; resumeCapability?: string; generation?: number } = {}): void {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'pi', 'running', 'pi')`).run(cardId, `pi-${cardId}`);
      db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
        origin, execution_generation, generation_intent, current_session_id, status,
        pi_session_id, pi_session_file, resume_capability)
        VALUES (?, ?, 'repo-a', 'g', 'p', ?, ?, 'initial', 'c-sess', ?, ?, ?, ?)`).run(
        runId, cardId, opts.origin ?? "user", opts.generation ?? 1, opts.status ?? "running",
        opts.piSessionId ?? null, opts.piSessionFile ?? null, opts.resumeCapability ?? "never_started",
      );
    }

    function cardStatus(store: PiRunStore, cardId: number): string {
      const db = (store as any).db as TaskDatabase;
      return (db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string }).status;
    }

    it("new standalone and supervised runs persist intent 'initial' and non-optimistic capability", () => {
      const { store } = makeSessionStore();
      const created = store.createPiCardAndRun({
        runId: "int-1", sessionId: "s", title: "t", goal: "g", workspaceAlias: "w",
        ownerPrincipalId: "p", origin: "user",
      });
      expect(store.get("int-1")!.generationIntent).toBe("initial");
      expect(store.get("int-1")!.resumeCapability).toBe("never_started");
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'agent', 'queued', 'W')`).run(created.cardId + 1, "w-card");
      const sup = store.createSupervisedRun({ cardId: created.cardId + 1, workspaceAlias: "w", goal: "g", ownerPrincipalId: "p", sessionId: "s" });
      expect(store.get(sup.runId)!.generationIntent).toBe("initial");
      expect(store.get(sup.runId)!.resumeCapability).toBe("never_started");
    });

    it("admission revalidates the persisted target, persists resume intent, and queues run+card once", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "s1.jsonl", "sess-1");
        const runId = "res-ok";
        seedActive(store, 7911, runId, { status: "interrupted", piSessionId: "sess-1", piSessionFile: file, resumeCapability: "available" });
        // Card must be in a resumable state (failed|done).
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE kanban_board SET status = 'failed' WHERE id = 7911`).run();

        const commit = store.queueResumeGeneration({ runId, expectedGeneration: 1, newSessionId: "new-c-sess" });
        expect(commit.committed).toBe(true);
        expect(commit.newGeneration).toBe(2);
        const run = store.get(runId)!;
        expect(run.status).toBe("queued");
        expect(run.executionGeneration).toBe(2);
        expect(run.generationIntent).toBe("resume");
        expect(run.currentSessionId).toBe("new-c-sess");
        // The verified target is preserved — never replaced by a fresh identity.
        expect(run.piSessionId).toBe("sess-1");
        expect(run.piSessionFile).toBe(file);
        expect(run.resumeCapability).toBe("available");
        expect(cardStatus(store, 7911)).toBe("queued");
      } finally { cleanup(); }
    });

    it("admission fails closed when the persisted target is missing, malformed, or mismatched", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const goodFile = writeSession(root, "good.jsonl", "sess-g");
        const badIdFile = writeSession(root, "badid.jsonl", "sess-other");
        const malformed = join(root, "malformed.jsonl");
        writeFileSync(malformed, "not json at all\n", "utf-8");

        const cases: Array<{ piSessionId?: string; piSessionFile?: string; cap: string }> = [
          { piSessionId: "sess-g", piSessionFile: undefined, cap: "available" },           // identity incomplete
          { piSessionId: "sess-g", piSessionFile: join(root, "missing.jsonl"), cap: "available" }, // file gone
          { piSessionId: "sess-g", piSessionFile: malformed, cap: "available" },            // malformed header
          { piSessionId: "sess-g", piSessionFile: badIdFile, cap: "available" },            // id mismatch
          { piSessionId: "sess-g", piSessionFile: goodFile, cap: "never_started" },         // capability stale
        ];
        for (let i = 0; i < cases.length; i++) {
          const runId = `res-bad-${i}`;
          const cardId = 7920 + i;
          seedActive(store, cardId, runId, {
            status: "interrupted",
            piSessionId: cases[i]!.piSessionId,
            piSessionFile: cases[i]!.piSessionFile,
            resumeCapability: cases[i]!.cap,
          });
          const db = (store as any).db as TaskDatabase;
          db.prepare(`UPDATE kanban_board SET status = 'failed' WHERE id = ?`).run(cardId);

          const commit = store.queueResumeGeneration({ runId, expectedGeneration: 1, newSessionId: "x" });
          expect(commit.committed).toBe(false);
          expect(commit.reason).toBe(cases[i]!.cap === "never_started" ? "not_resumable" : "session_missing");
          // Nothing changed: run and card stay exactly as they were.
          const run = store.get(runId)!;
          expect(run.executionGeneration).toBe(1);
          expect(run.status).toBe("interrupted");
          expect(run.generationIntent).toBe("initial");
          expect(cardStatus(store, cardId)).toBe("failed");
        }
      } finally { cleanup(); }
    });

    it("admission rolls back the generation bump when the card transition cannot apply", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "s2.jsonl", "sess-2");
        const runId = "res-cardmismatch";
        seedActive(store, 7931, runId, { status: "interrupted", piSessionId: "sess-2", piSessionFile: file, resumeCapability: "available" });
        // Card is 'running' — not a legal failed|done -> queued source.
        const commit = store.queueResumeGeneration({ runId, expectedGeneration: 1, newSessionId: "x" });
        expect(commit.committed).toBe(false);
        expect(commit.reason).toBe("card_mismatch");
        const run = store.get(runId)!;
        expect(run.executionGeneration).toBe(1);
        expect(run.status).toBe("interrupted");
        expect(run.currentSessionId).toBe("c-sess");
        expect(cardStatus(store, 7931)).toBe("running");
      } finally { cleanup(); }
    });

    it("admission rejects stale generation and non-resumable status", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "s3.jsonl", "sess-3");
        const runId = "res-stale";
        seedActive(store, 7932, runId, { status: "interrupted", piSessionId: "sess-3", piSessionFile: file, resumeCapability: "available" });
        expect(store.queueResumeGeneration({ runId, expectedGeneration: 99, newSessionId: "x" }).committed).toBe(false);
        expect(store.queueResumeGeneration({ runId, expectedGeneration: 1, newSessionId: "x" }).reason).toBe("card_mismatch");
      } finally { cleanup(); }
    });

    it("admission refuses supervised rows so the Pi lane cannot own a W card", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "supervised.jsonl", "sup-session");
        const runId = "res-supervised";
        seedActive(store, 7933, runId, {
          origin: "supervised", status: "interrupted", piSessionId: "sup-session",
          piSessionFile: file, resumeCapability: "available",
        });
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE kanban_board SET status = 'failed' WHERE id = ?`).run(7933);

        const commit = store.queueResumeGeneration({ runId, expectedGeneration: 1, newSessionId: "new-c" });
        expect(commit).toEqual({ committed: false, reason: "not_resumable" });
        expect(store.get(runId)!.executionGeneration).toBe(1);
        expect(cardStatus(store, 7933)).toBe("failed");
      } finally { cleanup(); }
    });
  });

  describe("#1647 — paired standalone finalization", () => {
    /** Store with an isolated real session root under a fresh tmp dir. */
    function makeSessionStore(): { store: PiRunStore; root: string; cleanup: () => void } {
      const db = createTestDb();
      const root = mkdtempSync(join(tmpdir(), "pi-sessions-"));
      const store = new PiRunStore({ db, sessionStorageRoot: root });
      return { store, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
    }

    function writeSession(root: string, file: string, id: string): string {
      const path = join(root, file);
      writeFileSync(path, JSON.stringify({ type: "session", id }) + "\n", "utf-8");
      return path;
    }

    function seedActive(store: PiRunStore, cardId: number, runId: string, opts: { status?: string; origin?: string; piSessionId?: string; piSessionFile?: string; resumeCapability?: string; generation?: number } = {}): void {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO kanban_board (id, title, source, status, type) VALUES (?, ?, 'pi', 'running', 'pi')`).run(cardId, `pi-${cardId}`);
      db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
        origin, execution_generation, generation_intent, current_session_id, status,
        pi_session_id, pi_session_file, resume_capability)
        VALUES (?, ?, 'repo-a', 'g', 'p', ?, ?, 'initial', 'c-sess', ?, ?, ?, ?)`).run(
        runId, cardId, opts.origin ?? "user", opts.generation ?? 1, opts.status ?? "running",
        opts.piSessionId ?? null, opts.piSessionFile ?? null, opts.resumeCapability ?? "never_started",
      );
    }

    function cardStatus(store: PiRunStore, cardId: number): string {
      const db = (store as any).db as TaskDatabase;
      return (db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string }).status;
    }

    function claimWorkspace(store: PiRunStore, runId: string, generation: number): void {
      const db = (store as any).db as TaskDatabase;
      db.prepare(`INSERT OR IGNORE INTO pi_workspace_claims (canonical_path, run_id, execution_generation, owner_kind, acquired_at)
        VALUES (?, ?, ?, 'standalone', datetime('now'))`).run(`/ws/${runId}-${generation}`, runId, generation);
    }

    it("interruptGeneration pairs run interrupted with card failed and releases the exact claim", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "i1.jsonl", "sess-i1");
        const runId = "int-pair";
        seedActive(store, 7941, runId, { piSessionId: "sess-i1", piSessionFile: file, resumeCapability: "available" });
        claimWorkspace(store, runId, 1);
        claimWorkspace(store, runId, 2); // a newer generation's claim must survive

        const result = store.interruptGeneration({ runId, generation: 1, continuity: { ok: true, sessionId: "sess-i1", canonicalFile: file } });
        expect(result.committed).toBe(true);
        const run = store.get(runId)!;
        expect(run.status).toBe("interrupted");
        expect(run.observedPid).toBeUndefined();
        expect(run.resumeCapability).toBe("available");
        expect(run.piSessionId).toBe("sess-i1");
        expect(cardStatus(store, 7941)).toBe("failed");
        const db = (store as any).db as TaskDatabase;
        const claims = db.prepare(`SELECT execution_generation FROM pi_workspace_claims WHERE run_id = ?`).all(runId) as Array<{ execution_generation: number }>;
        expect(claims.map(c => c.execution_generation)).toEqual([2]);
      } finally { cleanup(); }
    });

    it("interruptGeneration records a non-available capability when proof cannot be obtained", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const runId = "int-noproof";
        seedActive(store, 7942, runId, { piSessionId: "sess-gone", piSessionFile: join(root, "gone.jsonl"), resumeCapability: "available" });
        const result = store.interruptGeneration({
          runId, generation: 1,
          continuity: { ok: false, capability: "session_missing", reason: "file gone" },
        });
        expect(result.committed).toBe(true);
        const run = store.get(runId)!;
        expect(run.status).toBe("interrupted");
        expect(run.resumeCapability).toBe("session_missing");
        // Historical identity is preserved, not wiped.
        expect(run.piSessionId).toBe("sess-gone");
        expect(cardStatus(store, 7942)).toBe("failed");
      } finally { cleanup(); }
    });

    it("interruptGeneration rolls back the run update on card mismatch and refuses supervised rows", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        // Card not running -> card CAS cannot apply -> full rollback.
        const standalone = "int-cardmismatch";
        seedActive(store, 7943, standalone, {});
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE kanban_board SET status = 'queued' WHERE id = 7943`).run();
        const lost = store.interruptGeneration({ runId: standalone, generation: 1, continuity: { ok: false, capability: "session_missing", reason: "x" } });
        expect(lost.committed).toBe(false);
        expect(lost.reason).toBe("card_mismatch");
        expect(store.get(standalone)!.status).toBe("running");

        // Supervised rows are refused — the Worker attempt owns the W card.
        const supervised = "int-sup";
        seedActive(store, 7944, supervised, { origin: "supervised" });
        const refused = store.interruptGeneration({ runId: supervised, generation: 1, continuity: { ok: false, capability: "session_missing", reason: "x" } });
        expect(refused.committed).toBe(false);
        expect(refused.reason).toBe("supervised");
        expect(store.get(supervised)!.status).toBe("running");
      } finally { cleanup(); }
    });

    it("stale interruption and duplicate interruption mutate nothing", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const file = writeSession(root, "i2.jsonl", "sess-i2");
        const runId = "int-stale";
        seedActive(store, 7945, runId, { piSessionId: "sess-i2", piSessionFile: file, resumeCapability: "available" });
        const stale = store.interruptGeneration({ runId, generation: 99, continuity: { ok: true, sessionId: "sess-i2", canonicalFile: file } });
        expect(stale.committed).toBe(false);
        expect(stale.reason).toBe("stale_generation");
        expect(store.get(runId)!.status).toBe("running");

        const first = store.interruptGeneration({ runId, generation: 1, continuity: { ok: true, sessionId: "sess-i2", canonicalFile: file } });
        expect(first.committed).toBe(true);
        const duplicate = store.interruptGeneration({ runId, generation: 1, continuity: { ok: true, sessionId: "sess-i2", canonicalFile: file } });
        expect(duplicate.committed).toBe(false);
        expect(duplicate.reason).toBe("wrong_status");
      } finally { cleanup(); }
    });

    it("settleTerminal requires the card transition and releases the exact claim", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        const runId = "term-cardmismatch";
        seedActive(store, 7946, runId, {});
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE kanban_board SET status = 'queued' WHERE id = 7946`).run();
        const lost = store.settleTerminal({ runId, generation: 1, expectedStatuses: ["running"], outcome: "failed", metadata: { error: "x" } });
        expect(lost.committed).toBe(false);
        expect(lost.reason).toBe("card_mismatch");
        expect(store.get(runId)!.status).toBe("running");
        expect(cardStatus(store, 7946)).toBe("queued");

        // Winning settlement pairs run + card and releases the claim in-tx.
        db.prepare(`UPDATE kanban_board SET status = 'running' WHERE id = 7946`).run();
        claimWorkspace(store, runId, 1);
        const won = store.settleTerminal({ runId, generation: 1, expectedStatuses: ["running"], outcome: "failed", metadata: { error: "x" } });
        expect(won.committed).toBe(true);
        expect(store.get(runId)!.status).toBe("failed");
        expect(cardStatus(store, 7946)).toBe("failed");
        const claims = db.prepare(`SELECT COUNT(*) as cnt FROM pi_workspace_claims WHERE run_id = ?`).get(runId) as { cnt: number };
        expect(claims.cnt).toBe(0);
      } finally { cleanup(); }
    });

    it("settleTerminal refuses supervised rows without touching the W card", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        const runId = "term-supervised";
        seedActive(store, 7947, runId, { origin: "supervised" });
        const result = store.settleTerminal({
          runId, generation: 1, expectedStatuses: ["running"], outcome: "failed", metadata: { error: "x" },
        });
        expect(result).toEqual({ committed: false, reason: "supervised" });
        expect(store.get(runId)!.status).toBe("running");
        expect(cardStatus(store, 7947)).toBe("running");
      } finally { cleanup(); }
    });

    it("casTransition fences lifecycle writes to the expected generation", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        const runId = "cas-generation";
        seedActive(store, 7948, runId, { generation: 2 });
        expect(store.casTransition(runId, "running", "failed", { error: "stale" }, 1)).toBe(false);
        expect(store.get(runId)!.status).toBe("running");
        expect(store.casTransition(runId, "running", "failed", { error: "current" }, 2)).toBe(true);
        expect(store.get(runId)!.error).toBe("current");
      } finally { cleanup(); }
    });

    it("recoverNonterminal derives capability from session proof, not ID presence", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const flushed = writeSession(root, "r1.jsonl", "sess-r1");
        const flushedRun = "rec-flushed";
        seedActive(store, 7951, flushedRun, { piSessionId: "sess-r1", piSessionFile: flushed, resumeCapability: "available" });

        const unflushedRun = "rec-unflushed";
        seedActive(store, 7952, unflushedRun, { piSessionId: "sess-r2", piSessionFile: join(root, "not-there.jsonl"), resumeCapability: "available" });

        const db = (store as any).db as TaskDatabase;
        claimWorkspace(store, flushedRun, 1);

        const recovery = store.recoverNonterminal();
        expect(recovery.interrupted).toBe(2);
        expect(store.get(flushedRun)!.status).toBe("interrupted");
        expect(store.get(flushedRun)!.resumeCapability).toBe("available");
        expect(cardStatus(store, 7951)).toBe("failed");
        const claims = db.prepare(`SELECT COUNT(*) as cnt FROM pi_workspace_claims WHERE run_id = ?`).get(flushedRun) as { cnt: number };
        expect(claims.cnt).toBe(0);
        // An unflushed session must NOT recover as available.
        expect(store.get(unflushedRun)!.resumeCapability).toBe("session_missing");
        expect(cardStatus(store, 7952)).toBe("failed");
      } finally { cleanup(); }
    });

    it("recoverNonterminal preserves queued resume intent and refuses a vanished target", () => {
      const { store, root, cleanup } = makeSessionStore();
      try {
        const runId = "rec-queued-resume";
        seedActive(store, 7953, runId, { status: "queued", piSessionId: "sess-q", piSessionFile: join(root, "vanished.jsonl"), resumeCapability: "available", generation: 2 });
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE pi_runs SET generation_intent = 'resume' WHERE id = ?`).run(runId);

        const recovery = store.recoverNonterminal();
        expect(recovery.queuedCardIds).toContain(7953);
        const run = store.get(runId)!;
        // Intent preserved exactly; capability recorded truthfully.
        expect(run.generationIntent).toBe("resume");
        expect(run.status).toBe("queued");
        expect(run.resumeCapability).toBe("session_missing");
      } finally { cleanup(); }
    });

    it("recoverNonterminal interrupts supervised rows without touching the W card", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        const runId = "rec-sup";
        seedActive(store, 7954, runId, { origin: "supervised", status: "starting" });
        const recovery = store.recoverNonterminal();
        expect(recovery.supervisedInterruptedRunIds).toContain(runId);
        expect(store.get(runId)!.status).toBe("interrupted");
        // W card untouched by the Pi lane.
        expect(cardStatus(store, 7954)).toBe("running");
      } finally { cleanup(); }
    });

    it("recoverNonterminal isolates a card CAS conflict to that row", () => {
      const { store, cleanup } = makeSessionStore();
      try {
        const conflict = "rec-card-conflict";
        const winner = "rec-card-winner";
        seedActive(store, 7955, conflict);
        seedActive(store, 7956, winner);
        const db = (store as any).db as TaskDatabase;
        db.prepare(`UPDATE kanban_board SET status = 'done' WHERE id = ?`).run(7955);

        const recovery = store.recoverNonterminal();
        expect(recovery.interrupted).toBe(1);
        expect(store.get(conflict)!.status).toBe("running");
        expect(cardStatus(store, 7955)).toBe("done");
        expect(store.get(winner)!.status).toBe("interrupted");
        expect(cardStatus(store, 7956)).toBe("failed");
      } finally { cleanup(); }
    });
  });
});
