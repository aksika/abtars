import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { computeDigest, computeEnvelopeDigest } from "../worker-contract.js";

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

describe("WorkflowStore readWorkerAcceptance (#1794)", () => {
  let store: Store;
  let cardSeqAcc = 90000;

  function nextCard(): number {
    return cardSeqAcc++;
  }

  function contractJson(cardId: number, id: string, criteria = ["done"]): { json: string; digest: string } {
    const base = {
      schema_version: 1, id,
      goal: "acceptance fixture",
      criteria: criteria.map((c) => ({ id: c, description: `${c} must hold` })),
      expected_artifacts: [{
        id: "o1", kind: "file", ref: "out/lane.md", required: true, criterion_ids: [...criteria],
      }],
      verification_commands: [{
        id: "v1", argv: ["test", "-f", "out/lane.md"], timeout_ms: 10_000, criterion_ids: [...criteria],
      }],
      required_capabilities: [],
      limits: {},
      provenance: { root_card_id: cardId, card_id: cardId, authored_by: "test", created_at: "2026-09-12T00:00:00.000Z" },
    };
    const digest = computeDigest(base);
    return { json: JSON.stringify({ ...base, digest }), digest };
  }

  function envelopeJson(
    attemptId: string, contractId: string, digest: string,
    criteria: Array<{ id: string; status: string }>,
  ): string {
    return JSON.stringify({
      schema_version: 1,
      attempt: {
        id: attemptId, ordinal: 1, contract_id: contractId, contract_digest: digest,
        executor_kind: "agent", executor_id: "spin-local",
        started_at: "2026-09-12T00:00:00.000Z", finished_at: "2026-09-12T00:01:00.000Z",
      },
      outcome: "completed",
      criteria: criteria.map((c) => ({ criterion_id: c.id, status: c.status, evidence_ids: ["v1"] })),
      checks: [{
        check_id: "v1", argv: ["test", "-f", "out/lane.md"],
        started_at: "2026-09-12T00:00:00.000Z", finished_at: "2026-09-12T00:00:01.000Z",
        timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "", stderr_excerpt: "",
      }],
      artifacts: [{ artifact_id: "o1", exists: true, kind: "file", ref: "out/lane.md" }],
      worker_report: { summary: "done", claims: [], unresolved_risks: [] },
    });
  }

  /** Seed a complete passing triple; overrides mutate one layer. */
  function seedPassing(cardId: number, attemptId: string, contractId?: string): { digest: string; envelope: string; contractId: string } {
    const cid = contractId ?? `ctr-${attemptId}`;
    const { json, digest } = contractJson(cardId, cid);
    store.db.prepare(
      `INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, schema_version, contract_json, contract_digest, created_at)
       VALUES (?, ?, 1, ?, 1, ?, ?, datetime('now'))`,
    ).run(cid, cardId, cid, json, digest);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle)
       VALUES (?, ?, ?, 1, 'agent', 'spin-local', 'settled', datetime('now'), 'completed')`,
    ).run(attemptId, cardId, cid);
    const envelope = envelopeJson(attemptId, cid, digest, [{ id: "done", status: "passed" }]);
    store.db.prepare(
      `INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run(attemptId, envelope, computeEnvelopeDigest(JSON.parse(envelope)));
    return { digest, envelope, contractId: cid };
  }

  beforeEach(() => {
    store = new WorkflowStoreType();
    ensureAttemptTables(store);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_contracts (
        id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        root_contract_id TEXT NOT NULL, parent_contract_id TEXT, source_attempt_id TEXT,
        schema_version INTEGER NOT NULL, contract_json TEXT NOT NULL, contract_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_results (
        attempt_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, envelope_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      DELETE FROM worker_contracts;
      DELETE FROM worker_results;
      DELETE FROM worker_attempts;
    `);
  });

  it("accepts passing evidence and returns the stored envelope verbatim", () => {
    const card = nextCard();
    const { envelope } = seedPassing(card, "att-ok");
    const verdict = store.readWorkerAcceptance(card, "att-ok");
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.envelopeJson).toBe(envelope);
  });

  it("fails closed on missing/malformed records", () => {
    const card = nextCard();
    seedPassing(card, "att-ok");
    // Unknown attempt.
    expect(store.readWorkerAcceptance(card, "att-ghost")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: attempt",
    });
    // Non-completed lifecycle is not acceptable evidence.
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'failed' WHERE id = 'att-ok'`).run();
    expect(store.readWorkerAcceptance(card, "att-ok")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: attempt",
    });
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed' WHERE id = 'att-ok'`).run();
    // Missing result.
    store.db.prepare(`DELETE FROM worker_results WHERE attempt_id = 'att-ok'`).run();
    expect(store.readWorkerAcceptance(card, "att-ok")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: envelope",
    });
    // Malformed result.
    store.db.prepare(
      `INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
       VALUES ('att-ok', '{not-json', 'd', datetime('now'))`,
    ).run();
    expect(store.readWorkerAcceptance(card, "att-ok")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: envelope",
    });
    // Structurally invalid envelope (missing criteria).
    store.db.prepare(`UPDATE worker_results SET envelope_json = '{"schema_version":1}' WHERE attempt_id = 'att-ok'`).run();
    expect(store.readWorkerAcceptance(card, "att-ok")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: envelope",
    });
    // Missing contract.
    const card2 = nextCard();
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle)
       VALUES ('att-nc', ?, 'ctr-missing', 1, 'agent', 'spin-local', 'settled', datetime('now'), 'completed')`,
    ).run(card2);
    store.db.prepare(
      `INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
       VALUES ('att-nc', '{"schema_version":1}', 'd', datetime('now'))`,
    ).run();
    expect(store.readWorkerAcceptance(card2, "att-nc")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: contract",
    });
    // Malformed contract JSON.
    const card3 = nextCard();
    seedPassing(card3, "att-mc");
    store.db.prepare(`UPDATE worker_contracts SET contract_json = '{broken' WHERE card_id = ?`).run(card3);
    expect(store.readWorkerAcceptance(card3, "att-mc")).toEqual({
      accepted: false, cause: "completed: acceptance_unreadable: contract",
    });
  });

  it("rejects identity mismatches without ever succeeding", () => {
    const card = nextCard();
    const { digest, contractId } = seedPassing(card, "att-id");
    const rewrite = (env: Record<string, unknown>): void => {
      store.db.prepare(`UPDATE worker_results SET envelope_json = ? WHERE attempt_id = 'att-id'`)
        .run(JSON.stringify(env));
    };
    const base = () => JSON.parse(envelopeJson("att-id", contractId, digest, [{ id: "done", status: "passed" }]));
    // Wrong digest with otherwise all-passed criteria: failed ids alone would
    // miss this, so the identity check must fire first.
    const wrongDigest = base();
    wrongDigest.attempt.contract_digest = "b".repeat(64);
    rewrite(wrongDigest);
    let verdict = store.readWorkerAcceptance(card, "att-id");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/acceptance_unmet: contract identity/);
    // Envelope names a different attempt.
    const wrongAttempt = base();
    wrongAttempt.attempt.id = "att-other";
    rewrite(wrongAttempt);
    verdict = store.readWorkerAcceptance(card, "att-id");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/acceptance_unmet: attempt identity/);
    // Envelope names a different contract than the attempt row.
    const wrongContract = base();
    wrongContract.attempt.contract_id = "ctr-other";
    rewrite(wrongContract);
    verdict = store.readWorkerAcceptance(card, "att-id");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/acceptance_unmet: contract identity/);
    // Old-contract result after card contract replacement never passes.
    const { digest: newDigest } = contractJson(card, "ctr-new");
    store.db.prepare(
      `INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, schema_version, contract_json, contract_digest, created_at)
       VALUES ('ctr-new', ?, 2, 'ctr-new', 1, ?, ?, datetime('now'))`,
    ).run(card, JSON.stringify({ ...JSON.parse(contractJson(card, "ctr-new").json), digest: newDigest }), newDigest);
    rewrite(base());
    verdict = store.readWorkerAcceptance(card, "att-id");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/not the current contract/);
  });

  it("diagnoses criterion-set mismatches with sorted ids", () => {
    const card = nextCard();
    const { contractId } = seedPassing(card, "att-crit");
    const currentDigest = (): string => (store.db.prepare(
      `SELECT contract_digest FROM worker_contracts WHERE card_id = ? ORDER BY revision DESC LIMIT 1`,
    ).get(card) as { contract_digest: string }).contract_digest;
    const rewrite = (criteria: Array<{ id: string; status: string }>): void => {
      store.db.prepare(`UPDATE worker_results SET envelope_json = ? WHERE attempt_id = 'att-crit'`)
        .run(envelopeJson("att-crit", contractId, currentDigest(), criteria));
    };
    // Failed criterion.
    rewrite([{ id: "done", status: "failed" }]);
    let verdict = store.readWorkerAcceptance(card, "att-crit");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/not-passed \[done\]/);
    // Missing criterion (empty set).
    rewrite([]);
    verdict = store.readWorkerAcceptance(card, "att-crit");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/missing \[done\]/);
    // Duplicate criterion.
    rewrite([{ id: "done", status: "passed" }, { id: "done", status: "passed" }]);
    verdict = store.readWorkerAcceptance(card, "att-crit");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/duplicate \[done\]/);
    // Unknown criterion.
    rewrite([{ id: "done", status: "passed" }, { id: "ghost", status: "passed" }]);
    verdict = store.readWorkerAcceptance(card, "att-crit");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause).toMatch(/unknown \[ghost\]/);
  });

  it("bounds rejection causes to 2000 characters", () => {
    const card = nextCard();
    const { contractId } = seedPassing(card, "att-big");
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `ghost-${i}`, status: "passed" as const }));
    const row = store.db.prepare(`SELECT contract_digest FROM worker_contracts WHERE card_id = ? ORDER BY revision DESC LIMIT 1`)
      .get(card) as { contract_digest: string };
    store.db.prepare(`UPDATE worker_results SET envelope_json = ? WHERE attempt_id = 'att-big'`)
      .run(envelopeJson("att-big", contractId, row.contract_digest, [...many, { id: "done", status: "passed" }]));
    const verdict = store.readWorkerAcceptance(card, "att-big");
    expect(verdict.accepted).toBe(false);
    if (!verdict.accepted) expect(verdict.cause.length).toBeLessThanOrEqual(2000);
  });

  it("treats superseded attempts as not current", () => {
    const card = nextCard();
    seedPassing(card, "att-old");
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle)
       VALUES ('att-new', ?, 'ctr-acc', 2, 'agent', 'spin-local', 'running', datetime('now'), 'running')`,
    ).run(card);
    expect(store.isCurrentAttemptForCard(card, "att-old")).toBe(false);
    expect(store.isCurrentAttemptForCard(card, "att-new")).toBe(true);
    expect(store.isCurrentAttemptForCard(card, "att-ghost")).toBe(false);
  });
});
