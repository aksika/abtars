import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "../worker-contract.js";

let TEST_HOME: string;
let WorkerStore: typeof import("../worker-supervision-store.js").WorkerSupervisionStore;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let WfStoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let commitJoint: typeof import("./orc-workflow-settlement.js").commitSupervisedOutcome;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-settle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const workerMod = await import("../worker-supervision-store.js");
  const runnerMod = await import("./orc-workflow-runner.js");
  const wfMod = await import("./orc-workflow-store.js");
  const settleMod = await import("./orc-workflow-settlement.js");
  WorkerStore = workerMod.WorkerSupervisionStore;
  RunnerType = runnerMod.WorkflowRunner;
  WfStoreType = wfMod.WorkflowStore;
  commitJoint = settleMod.commitSupervisedOutcome;
});

afterEach(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

const DIGEST = "a".repeat(64);
const CONTRACT: WorkerAcceptanceContractV1 = {
  schema_version: 1,
  id: "c_joint_001",
  digest: DIGEST,
  goal: "Build report",
  criteria: [{ id: "c1", description: "Report must exist" }],
  expected_artifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
  verification_commands: [{ id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] }],
  required_capabilities: ["shell"],
  limits: {},
  provenance: { root_card_id: 100, card_id: 101, authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
};

function envelopeFor(attemptId: string): WorkerResultEnvelopeV1 {
  return {
    schema_version: 1,
    attempt: {
      id: attemptId, ordinal: 1, contract_id: "c_joint_001", contract_digest: DIGEST,
      executor_kind: "agent", executor_id: "spin-01",
      started_at: "2026-07-12T00:00:00.000Z", finished_at: "2026-07-12T00:01:00.000Z",
    },
    outcome: "completed",
    criteria: [{ criterion_id: "c1", status: "passed", evidence_ids: ["v1"] }],
    checks: [{
      check_id: "v1", argv: ["test", "-f", "output/report.md"],
      started_at: "2026-07-12T00:00:00.000Z", finished_at: "2026-07-12T00:00:01.000Z",
      timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "", stderr_excerpt: "",
    }],
    artifacts: [{ artifact_id: "a1", exists: true, kind: "file", ref: "output/report.md", size: 1024 }],
    worker_report: { summary: "Done", claims: [], unresolved_risks: [] },
  };
}

describe("WorkflowSettlement joint commit", () => {
  let store: InstanceType<typeof WorkerStore>;

  beforeEach(() => {
    store = new WorkerStore();
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  function seedSupervisedRun() {
    const wf = new WfStoreType(store.db);
    const runner = new RunnerType(wf, ["general", "research", "write"]);
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO kanban_board (id, title, source, source_id, status, type, created_at, updated_at)
      VALUES (100, 'proj', 'agent', NULL, 'running', 'O', ?, ?), (101, 'worker', 'agent', NULL, 'running', 'W', ?, ?)`)
      .run(now, now, now, now);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS project_supervision (
        project_card_id INTEGER PRIMARY KEY, contract_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL DEFAULT 'awaiting_contract',
        generation INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
      );
    `);
    store.db.prepare(`INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
      VALUES (100, 'c', 'awaiting_contract', 1, datetime('now'))`).run();
    store.insertContract(CONTRACT, 101);    const admitted = wf.admitRun({
      rootKind: "interactive", rootCardId: 100, clientOperationId: `joint-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      budgets: { work_retry: 1, plan_revision: 2, review_repair: 2, protocol_correction: 1 },
    });
    const acc = runner.acceptPlan(admitted.row.runId, {
      requiredOutputs: ["report"],
      nodes: [
        { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
        { label: "s", kind: "synthesis", instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
      ],
    });
    wf.bindNodeWorker(admitted.row.runId, 1, acc.nodeIds[0] as string, 101, "a_joint_001");
    return { wf, runner, runId: admitted.row.runId, nodeA: acc.nodeIds[0] as string, nodeS: acc.nodeIds[1] as string };
  }

  function seedAttempt(id: string, rootCard: number | null, status = "running") {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_failure_classifications (
        id TEXT PRIMARY KEY, attempt_id TEXT UNIQUE NOT NULL, input_digest TEXT NOT NULL,
        classification_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    store.insertAttempt({
      id, card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status, started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: rootCard, root_project_generation: 1,
    });
  }

  it("supervised settlement commits the successor in the same transaction", () => {
    const { runId, nodeA, nodeS } = seedSupervisedRun();
    seedAttempt("a_joint_001", 100);
    const res = store.terminalSettlement({
      attemptId: "a_joint_001", expectedGeneration: 1,
      desiredState: "completed", stableReason: "test", envelope: envelopeFor("a_joint_001"),
    });
    expect(res.kind).toBe("settled");
    // Attempt terminal AND successor queued atomically: node succeeded, S released.
    const wf = new WfStoreType(store.db);
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === nodeA)?.["status"]).toBe("succeeded");
    const succ = wf.db.prepare(`SELECT node_id FROM workflow_commands WHERE run_id = ? AND node_id = ?`).get(runId, nodeS);
    expect(succ).toBeDefined();
    // Ingress recorded with the deterministic attempt identity.
    const ing = wf.db.prepare(`SELECT disposition FROM workflow_ingress WHERE event_id = ?`).get("attempt-a_joint_001-completed") as { disposition: string };
    expect(ing.disposition).toBe("applied");
  });

  it("unmapped attempts settle with zero runner effects", () => {
    const { runId } = seedSupervisedRun();
    seedAttempt("a_plain_001", null);
    const res = store.terminalSettlement({
      attemptId: "a_plain_001", expectedGeneration: 1,
      desiredState: "completed", stableReason: "test", envelope: envelopeFor("a_plain_001"),
    });
    expect(res.kind).toBe("settled");
    const wf = new WfStoreType(store.db);
    // No attempt-derived ingress: only admission + plan rows exist.
    expect(wf.db.prepare(`SELECT COUNT(*) AS c FROM workflow_ingress WHERE event_id LIKE 'attempt-%'`).get()).toEqual({ c: 0 });
    expect(wf.listNodes(runId, 1).every((n) => n["status"] === "queued")).toBe(true);
  });

  it("hook failure is contained: settlement persists, successor recovered later", () => {
    const { runId, nodeA } = seedSupervisedRun();
    seedAttempt("a_joint_002", 100);
    // Pre-succeed the node so the hook's applier fence throws inside the joint txn.
    const wf = new WfStoreType(store.db);
    wf.setNodeOutcome(runId, 1, nodeA, "succeeded", "{}", "att-old");
    const res = store.terminalSettlement({
      attemptId: "a_joint_002", expectedGeneration: 1,
      desiredState: "completed", stableReason: "test", envelope: envelopeFor("a_joint_002"),
    });
    // Settlement persisted despite the contained hook failure...
    expect(res.kind).toBe("settled");
    expect(store.getAttempt("a_joint_002")?.lifecycle).toBe("completed");
    // ...and nothing half-applied: no duplicate successor for the node.
    const cmds = wf.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ? AND node_id = ?`).get(runId, nodeA) as { c: number };
    expect(Number(cmds.c)).toBeLessThanOrEqual(1);
  });

  it("failed settlement with automatic retryability queues a retry", () => {
    const { runId, nodeA } = seedSupervisedRun();
    seedAttempt("a_joint_003", 100);
    new WfStoreType(store.db).bindNodeWorker(runId, 1, nodeA, 101, "a_joint_003");
    store.db.prepare(`INSERT INTO attempt_failure_classifications (id, attempt_id, input_digest, classification_json, created_at)
      VALUES ('fc-1', 'a_joint_003', 'd', ?, datetime('now'))`)
      .run(JSON.stringify({ retryability: "automatic" }));
    const res = store.terminalSettlement({
      attemptId: "a_joint_003", expectedGeneration: 1,
      desiredState: "failed", stableReason: "transport reset", envelope: envelopeFor("a_joint_003"),
    });
    expect(res.kind).toBe("settled");
    const wf = new WfStoreType(store.db);
    const cmds = wf.db.prepare(`SELECT ordinal FROM workflow_commands WHERE run_id = ? AND node_id = ? ORDER BY ordinal`).all(runId, nodeA) as Array<{ ordinal: number }>;
    expect(cmds.map((c) => Number(c.ordinal))).toContain(1);
  });
});

describe("durable worker acceptance (#1794)", () => {
  let store: InstanceType<typeof WorkerStore>;

  beforeEach(() => {
    store = new WorkerStore();
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  function seedRun(lanes: Array<{ label: string; optional?: boolean; deps?: string[] }>) {
    const wf = new WfStoreType(store.db);
    const runner = new RunnerType(wf, ["general", "research", "write"]);
    const now = new Date().toISOString();
    store.db.prepare(`INSERT INTO kanban_board (id, title, source, source_id, status, type, created_at, updated_at)
      VALUES (100, 'proj', 'agent', NULL, 'running', 'O', ?, ?), (101, 'worker', 'agent', NULL, 'running', 'W', ?, ?)`)
      .run(now, now, now, now);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS project_supervision (
        project_card_id INTEGER PRIMARY KEY, contract_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL DEFAULT 'awaiting_contract',
        invalid_contract_proposals INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1,
        review_round INTEGER NOT NULL DEFAULT 0,
        repair_round INTEGER NOT NULL DEFAULT 0,
        active_review_case_id TEXT,
        accepted_decision_id TEXT,
        blocked_reason TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    store.db.prepare(`INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
      VALUES (100, 'c', 'awaiting_contract', 1, datetime('now'))`).run();
    store.insertContract(CONTRACT, 101);
    const admitted = wf.admitRun({
      rootKind: "interactive", rootCardId: 100, clientOperationId: `acc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      budgets: { work_retry: 1, plan_revision: 2, review_repair: 2, protocol_correction: 1 },
    });
    const acc = runner.acceptPlan(admitted.row.runId, {
      requiredOutputs: lanes.map((l) => `${l.label}.md`),
      nodes: lanes.map((l) => ({
        label: l.label, kind: "work" as const, instructions: "research", capability: "research",
        outputs: [`${l.label}.md`], acceptance: ["thorough"], dependsOn: l.deps ?? [],
        ...(l.optional ? { optional: true } : {}),
      })),
    });
    return { wf, runner, runId: admitted.row.runId, nodeIds: acc.nodeIds as string[] };
  }

  function seedWorkerAttempt(id: string, criterionStatus: "passed" | "failed" = "passed"): void {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_failure_classifications (
        id TEXT PRIMARY KEY, attempt_id TEXT UNIQUE NOT NULL, input_digest TEXT NOT NULL,
        classification_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    store.insertAttempt({
      id, card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    const env = envelopeFor(id);
    if (criterionStatus !== "passed") {
      (env.criteria[0] as { status: string }).status = criterionStatus;
    }
    const res = store.terminalSettlement({
      attemptId: id, expectedGeneration: 1,
      desiredState: "completed", stableReason: "test", envelope: env,
    });
    expect(res.kind).toBe("settled");
  }

  function budgets(runId: string): Record<string, { allowed: number; consumed: number }> {
    return new WfStoreType(store.db).readBudgets(runId) as Record<string, { allowed: number; consumed: number }>;
  }

  it("passing result succeeds with the stored envelope verbatim (caller envelope is null)", () => {
    const { wf, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    wf.bindNodeWorker(runId, 1, nodeIds[0] as string, 101, "a_acc_001");
    seedWorkerAttempt("a_acc_001");
    // The joint hook always arrives with envelopeJson:null — the stored
    // result persisted in the settlement transaction is the authority.
    const stored = store.getResult("a_acc_001");
    expect(stored).toBeDefined();
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === nodeIds[0])?.["status"]).toBe("succeeded");
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === nodeIds[0])?.["outcome"])
      .toBe(stored?.envelope_json);
    const ing = wf.db.prepare(`SELECT disposition FROM workflow_ingress WHERE event_id = ?`)
      .get("attempt-a_acc_001-completed") as { disposition: string };
    expect(ing.disposition).toBe("applied");
  });

  it("rejected required result fails the node, skips dependents, consumes no work_retry", () => {
    const { wf, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    const s = nodeIds[1] as string;
    wf.bindNodeWorker(runId, 1, a, 101, "a_rej_001");
    seedWorkerAttempt("a_rej_001", "failed");
    const nodes = wf.listNodes(runId, 1);
    expect(nodes.find((n) => n["node_id"] === a)?.["status"]).toBe("failed");
    expect(nodes.find((n) => n["node_id"] === a)?.["outcome"]).toMatch(/acceptance_unmet/);
    expect(nodes.find((n) => n["node_id"] === s)?.["status"]).toBe("skipped");
    // Quality failure never consumes the work_retry allowance: the budget
    // row is untouched by the rejection.
    expect(budgets(runId)["work_retry"]?.consumed).toBe(0);
  });

  it("rejected optional result stays visible while allowed downstream work is queued", () => {
    const { wf, runId, nodeIds } = seedRun([{ label: "opt", optional: true }, { label: "s", deps: ["opt"] }]);
    const opt = nodeIds[0] as string;
    const s = nodeIds[1] as string;
    wf.bindNodeWorker(runId, 1, opt, 101, "a_opt_001");
    seedWorkerAttempt("a_opt_001", "failed");
    const nodes = wf.listNodes(runId, 1);
    // The gap stays visible on the optional node itself...
    expect(nodes.find((n) => n["node_id"] === opt)?.["status"]).toBe("failed");
    expect(nodes.find((n) => n["node_id"] === opt)?.["outcome"]).toMatch(/acceptance_unmet/);
    // ...while the allowed dependent is released with a real command.
    const cmd = wf.findPendingCommand(runId, s, "dispatch");
    expect(cmd).not.toBeNull();
    expect(budgets(runId)["work_retry"]?.consumed).toBe(0);
  });

  it("missing stored result fails closed through recovery, never {} success", () => {
    const { wf, runner, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    const s = nodeIds[1] as string;
    // A completed attempt with NO result row (evidence lost before any hook
    // ran): recovery observes the unconsumed completion and must fail closed.
    store.insertAttempt({
      id: "a_nores_001", card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed', status = 'settled' WHERE id = 'a_nores_001'`).run();
    wf.bindNodeWorker(runId, 1, a, 101, "a_nores_001");
    expect(wf.claimCommand({ runId, generation: 1, nodeId: a, action: "dispatch", ordinal: 0 }, "gone-exec")).not.toBeNull();
    expect(runner.recoverUnconsumedCompletions(10)).toBe(1);
    const nodes = wf.listNodes(runId, 1);
    expect(nodes.find((n) => n["node_id"] === a)?.["status"]).toBe("failed");
    expect(nodes.find((n) => n["node_id"] === a)?.["outcome"]).toMatch(/acceptance_unreadable: envelope/);
    expect(nodes.find((n) => n["node_id"] === s)?.["status"]).toBe("skipped");
    expect(budgets(runId)["work_retry"]?.consumed).toBe(0);
  });

  it("stale completion for a superseded attempt changes nothing", () => {
    const { wf, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    // A completed older attempt with passing evidence, but a retry successor
    // is already the current attempt: the late redrive of the old completion
    // must neither fail nor succeed the replacement work. Rows are inserted
    // directly so no prior joint ingress exists for the stale event.
    store.insertAttempt({
      id: "a_old_001", card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed', status = 'settled' WHERE id = 'a_old_001'`).run();
    store.insertResult("a_old_001", envelopeFor("a_old_001"));
    store.insertAttempt({
      id: "a_new_002", card_id: 101, contract_id: "c_joint_001", ordinal: 2,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:02:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    wf.bindNodeWorker(runId, 1, a, 101, "a_new_002");
    commitJoint(store.db, {
      attemptId: "a_old_001", cardId: 101, rootCardId: 100,
      lifecycle: "completed", generation: 1, stableReason: "late redrive", envelopeJson: null,
    });
    // Contained: the node still runs the replacement attempt, and the stale
    // event left no ingress trace (the joint transaction rolled back).
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("queued");
    const ing = wf.db.prepare(`SELECT COUNT(*) AS c FROM workflow_ingress WHERE event_id = ?`)
      .get("attempt-a_old_001-completed") as { c: number };
    expect(Number(ing.c)).toBe(0);
  });

  it("missed joint hook recovers the same stored outcome, exactly once", () => {
    const { wf, runner, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    // Rows exist but the hook never ran: insert the terminal attempt and its
    // passing result directly (no terminalSettlement, no hook).
    store.insertAttempt({
      id: "a_missed_001", card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed', status = 'settled' WHERE id = 'a_missed_001'`).run();
    store.insertResult("a_missed_001", envelopeFor("a_missed_001"));
    wf.bindNodeWorker(runId, 1, a, 101, "a_missed_001");
    // Production shape of a lost hook: the dispatch command was claimed by
    // the executor (no longer pending) while the node still awaits its
    // completion.
    expect(wf.claimCommand({ runId, generation: 1, nodeId: a, action: "dispatch", ordinal: 0 }, "gone-exec")).not.toBeNull();
    expect(runner.recoverUnconsumedCompletions(10)).toBe(1);
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("succeeded");
    // Recovery is idempotent: no second application, no duplicate successor.
    expect(runner.recoverUnconsumedCompletions(10)).toBe(0);
    const succ = wf.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ? AND node_id = ?`)
      .get(runId, nodeIds[1]) as { c: number };
    expect(Number(succ.c)).toBe(1);
  });

  it("unapplied success ingress replays through the guard without rewriting the payload", () => {
    const { wf, runner, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    store.insertAttempt({
      id: "a_replay_001", card_id: 101, contract_id: "c_joint_001", ordinal: 1,
      executor_kind: "agent", executor_id: "spin-01",
      status: "running", started_at: "2026-07-12T00:00:00.000Z",
      root_project_card_id: 100, root_project_generation: 1,
    });
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed', status = 'settled' WHERE id = 'a_replay_001'`).run();
    const stored = envelopeFor("a_replay_001");
    store.insertResult("a_replay_001", stored);
    wf.bindNodeWorker(runId, 1, a, 101, "a_replay_001");
    // Crash between worker commit and wake: the persisted request carries the
    // legacy abstract payload, but the guarded applier decides from stored
    // evidence.
    const payload = JSON.stringify({
      kind: "AttemptSucceeded",
      body: { nodeId: a, attemptId: "a_replay_001", artifactsJson: "{}" },
    });
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('replay-1', ?, 'h', ?, 'received', datetime('now'))`,
    ).run(runId, payload);
    expect(runner.startupRecovery().redrivenIngress).toBe(1);
    // The node carries the stored envelope, not the stale "{}" payload...
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === a)?.["outcome"])
      .toBe(JSON.stringify(stored));
    // ...while the ingress row retains its original persisted payload.
    const ing = wf.db.prepare(`SELECT payload_json, disposition FROM workflow_ingress WHERE event_id = 'replay-1'`)
      .get() as { payload_json: string; disposition: string };
    expect(ing.payload_json).toBe(payload);
    expect(ing.disposition).toBe("applied");
  });

  it("cancelled runs never resurrect through joint or recovery paths", () => {
    const { wf, runner, runId, nodeIds } = seedRun([{ label: "a" }, { label: "s", deps: ["a"] }]);
    const a = nodeIds[0] as string;
    wf.bindNodeWorker(runId, 1, a, 101, "a_cancel_001");
    seedWorkerAttempt("a_cancel_001");
    // Reopen, then cancel: the completed-but-reopened work must stay dead.
    wf.setNodeOutcome(runId, 1, a, "running", "reopened", "a_cancel_001");
    expect(runner.requestCancel(runId, "operator stop").cancelled).toBe(true);
    expect(runner.recoverUnconsumedCompletions(10)).toBe(0);
    commitJoint(store.db, {
      attemptId: "a_cancel_001", cardId: 101, rootCardId: 100,
      lifecycle: "completed", generation: 1, stableReason: "late", envelopeJson: null,
    });
    expect(wf.getRun(runId)?.state).toBe("cancelled");
    expect(wf.listNodes(runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("cancelled");
  });
});
