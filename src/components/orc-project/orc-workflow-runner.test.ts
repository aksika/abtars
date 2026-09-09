import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Runner = import("./orc-workflow-runner.js").WorkflowRunner;
type Store = import("./orc-workflow-store.js").WorkflowStore;
type Proposal = import("./orc-workflow-runner.js").PlanProposal;
type BudgetScope = import("./orc-workflow-store.js").BudgetScope;

let cardSeq = 5000;
let copSeq = 0;

function makeRunner(): { runner: Runner; store: Store } {
  const store = new StoreType();
  const runner = new RunnerType(store, ["general", "research", "write"]);
  return { runner, store };
}

function seedCard(store: Store): number {
  const id = cardSeq++;
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, type, status) VALUES (?, ?, 'task', 'O', 'running')`).run(id, `wf-rcard-${id}`);
  return id;
}

function admit(runner: Runner, card: number, budgets?: Partial<Record<BudgetScope, number>>) {
  copSeq++;
  return runner.admit({
    rootKind: "interactive", rootCardId: card, clientOperationId: `cop-t${copSeq}`,
    budgets,
  }).run;
}

const twoLane = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes-a"], acceptance: ["done"], dependsOn: [] },
    { label: "b", kind: "work", instructions: "research", capability: "research", outputs: ["notes-b"], acceptance: ["done"], dependsOn: [] },
    { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: ["a", "b"] },
  ],
});

function fakePort() {
  const dispatched: Array<{ nodeId: string; ordinal: number }> = [];
  return {
    port: {
      name: "fake-exec",
      dispatch: (cmd: { nodeId: string; ordinal: number }) => {
        dispatched.push({ nodeId: cmd.nodeId, ordinal: cmd.ordinal });
      },
    },
    dispatched,
  };
}

describe("WorkflowRunner Task 2", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    // Tables owned by other stores (see orc-workflow-store.test.ts harness note).
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
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  it("parallel plan dispatches roots; join releases the successor exactly once", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    expect(acc.revision).toBe(1);
    expect(acc.queued).toBe(2);
    const { port, dispatched } = fakePort();
    expect(runner.drain(10, port)).toBe(2);
    expect(dispatched.map((d) => d.nodeId).sort()).toEqual([acc.nodeIds[0], acc.nodeIds[1]].sort());
    // Complete A: C must NOT dispatch yet.
    runner.attemptSucceeded(run.runId, acc.nodeIds[0] as string, "att-a", "{}");
    expect(runner.drain(10, port)).toBe(0);
    // Complete B: C dispatches exactly once.
    runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, "att-b", "{}");
    expect(runner.drain(10, port)).toBe(1);
    expect(dispatched[dispatched.length - 1]?.nodeId).toBe(acc.nodeIds[2]);
    // Complete C: run succeeds with no ownerless residue.
    runner.attemptSucceeded(run.runId, acc.nodeIds[2] as string, "att-c", "{}");
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    const tick = runner.auditTick(0);
    expect(tick.ownerless).not.toContain(run.runId);
  });

  it("malformed plan creates no workers and reports field diagnostics", () => {
    const run = admit(runner, seedCard(store));
    const bad: Proposal = {
      requiredOutputs: ["ghost"],
      nodes: [
        { label: "x", kind: "work", instructions: "", capability: "nope", outputs: [], acceptance: [], dependsOn: ["x"] },
        { label: "y", kind: "work", instructions: "do", capability: "general", outputs: [], acceptance: [], dependsOn: ["zz"] },
      ],
    };
    expect(() => runner.acceptPlan(run.runId, bad)).toThrow(/plan rejected/);
    try {
      runner.acceptPlan(run.runId, bad);
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/dependsOn/);
      expect(msg).toMatch(/capability/);
      expect(msg).toMatch(/requiredOutputs/);
    }
    expect(store.listNodes(run.runId, 1)).toEqual([]);
    expect(store.countPendingCommands()).toBe(0);
    // A corrected proposal succeeds within the revision budget.
    const acc = runner.acceptPlan(run.runId, twoLane());
    expect(acc.queued).toBe(2);
  });

  it("plan-revision exhaustion fails the run with a reason", () => {
    const run = admit(runner, seedCard(store), { plan_revision: 1 } as Record<string, number>);
    const bad: Proposal = { requiredOutputs: ["ghost"], nodes: [] };
    expect(() => runner.acceptPlan(run.runId, bad)).toThrow(/plan rejected/);
    expect(store.getRun(run.runId)?.state).toBe("planning");
    expect(() => runner.acceptPlan(run.runId, bad)).toThrow(/plan rejected/);
    const done = store.getRun(run.runId);
    expect(done?.state).toBe("failed");
    expect(done?.failureCode).toBe("plan_rejected");
  });

  it("retry-safe failure retries once, then required failure settles explicitly", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    const b = acc.nodeIds[1] as string;
    runner.attemptSucceeded(run.runId, b, "att-b", "{}");
    runner.attemptFailed(run.runId, a, "att-a1", "flaky", true);
    const retry = store.db.prepare(
      `SELECT ordinal, status FROM workflow_commands WHERE run_id = ? AND node_id = ? ORDER BY ordinal`,
    ).all(run.runId, a) as Array<Record<string, unknown>>;
    expect(retry.map((r) => r["ordinal"])).toEqual([0, 1]);
    runner.drain(10, port);
    runner.attemptFailed(run.runId, a, "att-a2", "still broken", false);
    const done = store.getRun(run.runId);
    expect(done?.state).toBe("failed");
    expect(done?.failureCode).toBe("node_failed");
    // Dependent synthesis was skipped, never left queued.
    const nodes = store.listNodes(run.runId, 1);
    expect(nodes.find((n) => n["node_id"] === acc.nodeIds[2])?.["status"]).toBe("skipped");
    expect(nodes.some((n) => n["status"] === "queued" || n["status"] === "running")).toBe(false);
  });

  it("optional failure releases dependents; required failure without partial fails", () => {
    const run = admit(runner, seedCard(store));
    const proposal: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "opt", kind: "work", instructions: "nice", capability: "general", outputs: ["extra"], acceptance: ["done"], dependsOn: [], optional: true },
        { label: "main", kind: "work", instructions: "core", capability: "general", outputs: ["core"], acceptance: ["done"], dependsOn: [] },
        { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: ["opt", "main"] },
      ],
    };
    const acc = runner.acceptPlan(run.runId, proposal);
    const { port } = fakePort();
    runner.drain(10, port);
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-o", "meh", false);
    // Optional failure alone queues nothing new: S still waits on main.
    expect(runner.drain(10, port)).toBe(0);
    // Main success releases S (opt dep already satisfied at failure time).
    runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, "att-m", "{}");
    const sId = acc.nodeIds[2] as string;
    expect(runner.drain(10, port)).toBe(1);
    runner.attemptSucceeded(run.runId, sId, "att-s", "{}");
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
  });

  it("duplicate and stale completions cannot duplicate work or resurrect runs", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const a = acc.nodeIds[0] as string;
    const b = acc.nodeIds[1] as string;
    runner.attemptSucceeded(run.runId, a, "att-a", "{}");
    // Stale completion for an already-succeeded node is rejected loudly.
    expect(() => runner.attemptSucceeded(run.runId, a, "att-a-late", "{}")).toThrow(/conflicts with completion/);
    // Finish the run, then prove terminal runs reject late results.
    runner.attemptSucceeded(run.runId, b, "att-b", "{}");
    runner.attemptSucceeded(run.runId, acc.nodeIds[2] as string, "att-c", "{}");
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    expect(() => runner.attemptSucceeded(run.runId, b, "att-late", "{}")).toThrow(/terminal.*late result rejected/);
    const cmds = store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ?`).get(run.runId) as { c: number };
    expect(Number(cmds.c)).toBe(3);
  });

  it("restart after commit-before-wake loses no command", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    // Simulate a received-but-unapplied worker completion (commit happened
    // elsewhere, wake was lost): plant the ingress row directly.
    const payload = JSON.stringify({ kind: "AttemptSucceeded", body: { nodeId: acc.nodeIds[0], attemptId: "att-a", artifactsJson: "{}" } });
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('recv-1', ?, 'h', ?, 'received', datetime('now'))`,
    ).run(run.runId, payload);
    const rec = runner.startupRecovery();
    expect(rec.redrivenIngress).toBe(1);
    const { port, dispatched } = fakePort();
    // B was already queued at admission; A completed via redrive (no successor yet).
    expect(dispatched.length).toBe(0);
    expect(runner.drain(10, port)).toBe(1);
    expect(dispatched.map((d) => d.nodeId)).toEqual([acc.nodeIds[1]]);
    // Redrive is idempotent: the ingress row is now applied.
    expect(runner.startupRecovery().redrivenIngress).toBe(0);
  });

  it("audit flags ownerless runs but never healthy, admitted, or suspect ones", () => {
    const healthy = admit(runner, seedCard(store));
    runner.acceptPlan(healthy.runId, twoLane());
    const admittedOnly = admit(runner, seedCard(store));
    const suspect = admit(runner, seedCard(store));
    runner.acceptPlan(suspect.runId, twoLane());
    // Claim everything (nodes running), then let the lease lapse with no other
    // signal: suspect claims under inspection — never failure. (Drain is global:
    // it also claims the healthy run's two commands, which stay lease-fresh.)
    const { port: suspectPort } = fakePort();
    expect(runner.drain(10, suspectPort)).toBe(4);
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`).run(suspect.runId);
    const tick = runner.auditTick(0);
    expect(tick.lawful).toEqual(expect.arrayContaining([healthy.runId, admittedOnly.runId, suspect.runId]));
    expect(tick.ownerless).not.toContain(suspect.runId);
    expect(tick.dueInspections.length).toBe(2);
    // A run with genuinely nothing pending and mid-execution state is ownerless.
    const bare = admit(runner, seedCard(store));
    store.db.prepare(`UPDATE workflow_runs SET state = 'executing' WHERE run_id = ?`).run(bare.runId);
    const tick2 = runner.auditTick(0);
    expect(tick2.ownerless).toContain(bare.runId);
  });
});
