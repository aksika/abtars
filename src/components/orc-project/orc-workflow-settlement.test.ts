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

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-settle-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const workerMod = await import("../worker-supervision-store.js");
  const runnerMod = await import("./orc-workflow-runner.js");
  const wfMod = await import("./orc-workflow-store.js");
  WorkerStore = workerMod.WorkerSupervisionStore;
  RunnerType = runnerMod.WorkflowRunner;
  WfStoreType = wfMod.WorkflowStore;
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
