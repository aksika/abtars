import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let WorkflowStoreType: typeof import("./orc-workflow-store.js").WorkflowStore;

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const mod = await import("./orc-workflow-store.js");
  WorkflowStoreType = mod.WorkflowStore;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Store = import("./orc-workflow-store.js").WorkflowStore;

let cardSeq = 1000;
function seedCard(store: Store): number {
  const id = cardSeq++;
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, type, status) VALUES (?, ?, 'task', 'O', 'running')`).run(id, `wf-card-${id}`);
  return id;
}

function admit(store: Store, cardId: number, cop: string) {
  return store.admitRun({
    rootKind: "interactive", rootCardId: cardId, clientOperationId: cop,
    budgets: { work_retry: 1, plan_revision: 2, review_repair: 2, protocol_correction: 1 },
  });
}

function ensureAttemptTables(store: Store): void {
  // worker_attempts / project_input_requests are owned by other stores and
  // created by their migrate() in production boot order (before any audit
  // runs); the audit probes read them, so harness DBs create minimal shapes.
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS worker_attempts (
      id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, contract_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL, executor_kind TEXT NOT NULL, executor_id TEXT NOT NULL,
      status TEXT NOT NULL, started_at TEXT NOT NULL,
      lifecycle TEXT NOT NULL DEFAULT 'pending',
      root_project_card_id INTEGER, root_project_generation INTEGER,
      UNIQUE(card_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS project_input_requests (
      id TEXT PRIMARY KEY, project_card_id INTEGER NOT NULL,
      review_case_id TEXT NOT NULL, question TEXT NOT NULL,
      affected_criterion_ids TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL
    );
  `);
}

describe("WorkflowStore", () => {
  let store: Store;

  beforeEach(() => {
    store = new WorkflowStoreType();
    ensureAttemptTables(store);
    store.db.exec(`DELETE FROM workflow_ingress`);
    store.db.exec(`DELETE FROM workflow_deliveries`);
    store.db.exec(`DELETE FROM workflow_commands`);
    store.db.exec(`DELETE FROM workflow_budgets`);
    store.db.exec(`DELETE FROM workflow_node_deps`);
    store.db.exec(`DELETE FROM workflow_nodes`);
    store.db.exec(`DELETE FROM workflow_plan_revisions`);
    store.db.exec(`DELETE FROM workflow_operations`);
    store.db.exec(`DELETE FROM workflow_runs`);
  });

  it("admits a run and dedupes on client_operation_id", () => {
    const card = seedCard(store);
    const first = admit(store, card, "cop-a1");
    expect(first.disposition).toBe("admitted");
    expect(first.row.state).toBe("admitted");
    expect(first.row.budgets.work_retry).toBe(1);
    const second = admit(store, card, "cop-a1");
    expect(second.disposition).toBe("duplicate");
    expect(second.row.runId).toBe(first.row.runId);
  });

  it("rejects conflicting admission on the same operation id", () => {
    const card = seedCard(store);
    admit(store, card, "cop-conf");
    const other = seedCard(store);
    expect(() => admit(store, other, "cop-conf")).toThrow(/conflicting admission/);
  });

  it("rejects admission for a missing root card and non-finite budgets", () => {
    expect(() => admit(store, 999999, "cop-miss")).toThrow(/root card .* missing/);
    const card = seedCard(store);
    expect(() => store.admitRun({
      rootKind: "interactive", rootCardId: card, clientOperationId: "cop-bad",
      budgets: { work_retry: 1, plan_revision: Infinity, review_repair: 2, protocol_correction: 1 },
    })).toThrow(/finite/);
  });

  it("commits a transition once and dedupes the identical replay", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c1");
    const event = {
      eventId: "ev-1", runId: run.runId, payloadHash: "h1",
      payloadJson: JSON.stringify({ kind: "X", n: 1 }),
      generation: 1, stateVersion: 0,
    };
    const first = store.commitTransition(event, () => ({}));
    expect(first.disposition).toBe("applied");
    const replay = store.commitTransition(event, () => { throw new Error("applier must not run on replay"); });
    expect(replay.disposition).toBe("duplicate");
    expect(store.getRun(run.runId)?.stateVersion).toBe(1);
  });

  it("reports conflicting duplicates with diagnostics and no writes", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c2");
    const base = {
      eventId: "ev-2", runId: run.runId, payloadJson: JSON.stringify({ kind: "X", n: 1 }),
      generation: 1, stateVersion: 0,
    };
    expect(store.commitTransition({ ...base, payloadHash: "h1" }, () => ({} as never)).disposition).toBe("applied");
    const res = store.commitTransition({ ...base, payloadHash: "DIFFERENT" }, () => ({} as never));
    expect(res.disposition).toBe("conflict");
    expect(res.diagnostics).toMatch(/conflicting duplicate/);
    expect(store.getRun(run.runId)?.stateVersion).toBe(1);
  });

  it("a malformed ingress row raises instead of vanishing as a duplicate", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c3");
    expect(() => store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, disposition, received_at)
       VALUES ('ev-bad', ?, 'h', 'received', datetime('now')) ON CONFLICT(event_id) DO NOTHING`,
    ).run(run.runId)).toThrow(/NOT NULL/);
  });

  it("fences generation/version and consumes terminal leftovers as noop", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c4");
    const stale = {
      eventId: "ev-stale", runId: run.runId, payloadHash: "h", payloadJson: "{}",
      generation: 1, stateVersion: 99,
    };
    expect(() => store.commitTransition(stale, () => ({}))).toThrow(/fence mismatch/);
    // Terminal run: a pre-existing received row is genuinely moot -> noop.
    // (The version must ALSO have advanced: matching versions mean the event
    // is still applicable, so the fence passes and the applier runs.)
    store.db.prepare(`UPDATE workflow_runs SET state = 'failed', state_version = 5 WHERE run_id = ?`).run(run.runId);
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('ev-term', ?, 'h', '{}', 'received', datetime('now'))`,
    ).run(run.runId);
    const res = store.commitTransition(
      { eventId: "ev-term", runId: run.runId, payloadHash: "h", payloadJson: "{}", generation: 1, stateVersion: 0 },
      () => ({}),
    );
    expect(res.disposition).toBe("noop");
  });

  it("claim/complete enforces owner+token fencing", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c5");
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "n1", action: "dispatch", ordinal: 0, payloadJson: "{}" });
    const key = { runId: run.runId, generation: 1, nodeId: "n1", action: "dispatch" as const, ordinal: 0 };
    const c1 = store.claimCommand(key, "A");
    expect(c1).not.toBeNull();
    expect(store.claimCommand(key, "B")).toBeNull();
    expect(() => store.completeCommand(key, "B", c1?.token ?? "")).toThrow(/rejected/);
    expect(() => store.completeCommand(key, "A", "stale-token")).toThrow(/rejected/);
    store.completeCommand(key, "A", c1?.token ?? "");
    const row = store.db.prepare(`SELECT status, next_inspection_at FROM workflow_commands WHERE run_id = ?`).get(run.runId) as Record<string, unknown>;
    expect(row["status"]).toBe("done");
    expect(row["next_inspection_at"]).toBeNull();
  });

  it("consumeBudget is a bounded CAS", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c6");
    expect(store.consumeBudget(run.runId, "work_retry")).toBe(true);
    expect(store.consumeBudget(run.runId, "work_retry")).toBe(false);
  });

  it("single-open-operation index rejects a second open op of the same kind+revision", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c7");
    store.upsertOperation({ opId: "op-1", runId: run.runId, kind: "review", revision: 1, status: "pending" });
    expect(() => store.upsertOperation({ opId: "op-2", runId: run.runId, kind: "review", revision: 1, status: "pending" })).toThrow(/UNIQUE/);
    // Same kind in a different revision is a different job: allowed.
    store.upsertOperation({ opId: "op-3", runId: run.runId, kind: "review", revision: 2, status: "pending" });
    // Terminal release frees the slot for the same revision.
    store.upsertOperation({ opId: "op-1", runId: run.runId, kind: "review", revision: 1, status: "failed" });
    store.upsertOperation({ opId: "op-4", runId: run.runId, kind: "review", revision: 1, status: "pending" });
  });

  it("probeRun reports all seven signals", () => {
    const card = seedCard(store);
    const { row: run } = admit(store, card, "cop-c8");
    // Fresh admission: run is admitted-state (audit treats as lawful) with no pending rows.
    const empty = store.probeRun(run.runId, card);
    expect(empty).toEqual({
      pending: false, freshClaim: false, dueClaim: false, liveAttempt: false,
      pendingInput: false, openOp: false, pendingDelivery: false,
    });
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "n1", action: "dispatch", ordinal: 0, payloadJson: "{}" });
    expect(store.probeRun(run.runId, card).pending).toBe(true);
  });
});
