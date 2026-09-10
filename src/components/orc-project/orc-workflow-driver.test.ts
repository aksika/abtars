import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let DriverMod: typeof import("./orc-workflow-driver.js");
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-driver-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  DriverMod = await import("./orc-workflow-driver.js");
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
});

afterAll(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Proposal = import("./orc-workflow-runner.js").PlanProposal;

let copSeq = 0;

describe("WorkflowDriver", () => {
  beforeEach(async () => {
    // Fresh tables per test on the shared file-home (the kanban connection is
    // a process singleton; never delete the home mid-file).
    const storeMod = await import("./orc-workflow-store.js");
    const store = new storeMod.WorkflowStore();
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_attempts (
        id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, contract_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, executor_kind TEXT NOT NULL, executor_id TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'pending',
        root_project_card_id INTEGER, root_project_generation INTEGER,
        cancel_reason TEXT,
        UNIQUE(card_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS project_input_requests (
        id TEXT PRIMARY KEY, project_card_id INTEGER NOT NULL,
        review_case_id TEXT NOT NULL, question TEXT NOT NULL,
        affected_criterion_ids TEXT NOT NULL,
        expected_response_kind TEXT NOT NULL DEFAULT 'text',
        context TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        answered_at TEXT, response_text TEXT
      );
    `);
  });

  it("drains on nerve wake and ignores unmapped cards", () => {
    const store = new StoreType();
    const runner = new RunnerType(store, ["general"]);
    const dispatched: string[] = [];
    const ports = {
      name: "fake",
      dispatch: (cmd: { nodeId: string }) => { dispatched.push(cmd.nodeId); },
    };
    const driver = DriverMod.startWorkflowDriver({
      callModel: async () => "{}",
      ports,
    });
    try {
      const cardRes = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES ('c','agent','O','running')`).run();
      const card = Number(cardRes.lastInsertRowid);
      copSeq++;
      const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `drv-${copSeq}` }).run;
      const proposal: Proposal = {
        requiredOutputs: ["o"],
        nodes: [
          { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
        ],
      };
      runner.acceptPlan(run.runId, proposal);
      expect(driver.drainWake("test")).toBe(1);
      expect(dispatched.length).toBe(1);
      // Second wake: command already claimed, nothing to do.
      expect(driver.drainWake("test")).toBe(0);
      // Audit sees the lease-fresh claim as lawful, never ownerless.
      const audit = driver.auditOnce(0);
      expect(audit.lawful).toContain(run.runId);
      expect(audit.ownerless).not.toContain(run.runId);
    } finally {
      driver.stop();
    }
  });

  it("audit submits due inspections with audit-derived identity", () => {
    const store = new StoreType();
    const runner = new RunnerType(store, ["general"]);
    const dispatched: string[] = [];
    const ports = { name: "fake", dispatch: (cmd: { nodeId: string }) => { dispatched.push(cmd.nodeId); } };
    const driver = DriverMod.startWorkflowDriver({ callModel: async () => "{}", ports });
    try {
      const cardRes = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES ('c','agent','O','running')`).run();
      const card = Number(cardRes.lastInsertRowid);
      copSeq++;
      const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `drv2-${copSeq}` }).run;
      runner.acceptPlan(run.runId, {
        requiredOutputs: ["o"],
        nodes: [
          { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
        ],
      });
      driver.drainWake("test");
      // Age the live claim past its lease with no attempt ever starting.
      store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`).run(run.runId);
      const audit = driver.auditOnce(0);
      expect(audit.inspections).toBe(1);
      // No attempt ever started: safe requeue to pending for redrive.
      expect(store.db.prepare(`SELECT status FROM workflow_commands WHERE run_id = ?`).get(run.runId)).toEqual({ status: "pending" });
      // Identical resubmission dedupes (same token+gen identity).
      const audit2 = driver.auditOnce(0);
      expect(audit2.inspections).toBe(0);
      void dispatched;
    } finally {
      driver.stop();
    }
  });
});
