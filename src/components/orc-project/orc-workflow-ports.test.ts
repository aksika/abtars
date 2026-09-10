import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let Ports: typeof import("./orc-workflow-ports.js");

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-ports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  Ports = await import("./orc-workflow-ports.js");
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

let copSeq = 0;

function setup(): { runner: Runner; store: Store } {
  const store = new StoreType();
  return { runner: new RunnerType(store, ["general", "research", "write"]), store };
}

function seedCard(store: Store): number {
  // AUTOINCREMENT ids (worker children share the sequence; fixed ids collide).
  const res = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES (?, 'agent', 'O', 'running')`)
    .run(`wf-port-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return Number(res.lastInsertRowid);
}

function admit(runner: Runner, card: number) {
  copSeq++;
  return runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `port-${copSeq}` }).run;
}

const workPlan = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "a", kind: "work", instructions: "research thoroughly", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
    { label: "s", kind: "synthesis", instructions: "draft it", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
  ],
});

describe("WorkflowPorts", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = setup());
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  it("worker port creates a supervised child, binds it, and ensures supervision", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, workPlan());
    let woke = 0;
    const port = new Ports.WorkflowWorkerPort({ runner, wakePump: () => { woke++; } });
    const claimed = store.claimCommand(
      { runId: run.runId, generation: 1, nodeId: acc.nodeIds[0] as string, action: "dispatch", ordinal: 0 }, "workflow-worker",
    );
    expect(claimed).not.toBeNull();
    port.dispatch(claimed!.row);
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === acc.nodeIds[0]);
    expect(Number(node?.["worker_card_id"])).toBeGreaterThan(0);
    const attempt = store.db.prepare(`SELECT root_project_card_id, lifecycle FROM worker_attempts WHERE id = ?`)
      .get(node?.["attempt_id"] as string) as { root_project_card_id: number; lifecycle: string };
    expect(attempt.root_project_card_id).toBe(run.rootCardId);
    expect(attempt.lifecycle).toBe("pending");
    const sup = store.db.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(run.rootCardId) as { state: string };
    expect(sup.state).toBe("awaiting_contract");
    expect(woke).toBe(1);
  });

  it("worker port fails visibly when supervision is terminal", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, workPlan());
    store.db.prepare(`INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, generation, updated_at)
      VALUES (?, 'c', 'blocked', 1, datetime('now'))`).run(run.rootCardId);
    const port = new Ports.WorkflowWorkerPort({ runner });
    expect(() => port.dispatch({
      runId: run.runId, generation: 1, nodeId: acc.nodeIds[0] as string, action: "dispatch", ordinal: 0,
      status: "claimed", payloadJson: JSON.stringify({ nodeId: acc.nodeIds[0], revision: 1 }),
      createdAt: "", claimedAt: "", doneAt: null, owner: "x", claimToken: "y",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    })).toThrow(/not dispatchable/);
  });

  it("planner backend admits a valid proposal and completes its claim", async () => {
    const run = admit(runner, seedCard(store));
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async () => JSON.stringify({
        nodes: [
          { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
        ],
        requiredOutputs: ["o"],
      }),
    });
    const cmd = {
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    };
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    backend.startPlanning(cmd, {
      runId: run.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.currentRevision(run.runId)).toBe(1);
    const done = store.db.prepare(`SELECT status FROM workflow_commands WHERE run_id = ? AND node_id = '__plan__'`).get(run.runId) as { status: string };
    expect(done.status).toBe("done");
  });

  it("planner backend corrects once, then surfaces persistent failure", async () => {
    const run = admit(runner, seedCard(store));
    let calls = 0;
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async () => {
        calls++;
        return calls === 1 ? "not json at all" : JSON.stringify({ nodes: [], requiredOutputs: [] });
      },
    });
    const cmd = {
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    };
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    backend.startPlanning(cmd, {
      runId: run.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    // Claim left for lease expiry + inspection (bounded, terminating explicitly).
    const left = store.db.prepare(`SELECT status FROM workflow_commands WHERE run_id = ? AND node_id = '__plan__'`).get(run.runId) as { status: string };
    expect(left.status).toBe("claimed");
  });

  it("reviewer backend forwards the verdict for host application", async () => {
    const run = admit(runner, seedCard(store));
    const judged: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
        { label: "s", kind: "synthesis", instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
        { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["s"] },
      ],
    };
    const acc = runner.acceptPlan(run.runId, judged);
    const backend = new Ports.SpinReviewerBackend({
      runner,
      callModel: async () => JSON.stringify({ verdict: "cannot_assess", reason: "no artifact to read" }),
    });
    const rNode = acc.nodeIds[2] as string;
    // Complete the work first: cannot_assess then fails a fully-judged run.
    runner.attemptSucceeded(run.runId, acc.nodeIds[0] as string, "att-a", "{}");
    runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, "att-s", "{}");
    const cmd = {
      runId: run.runId, generation: 1, nodeId: rNode, action: "review" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: JSON.stringify({ nodeId: rNode, revision: 1 }),
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-reviewer", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    };
    const brief = runner.assembleBrief(run.runId, 1, rNode);
    backend.startReview(cmd, brief);
    await new Promise((r) => setTimeout(r, 50));
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === rNode);
    expect(node?.["status"]).toBe("failed");
    expect(store.getRun(run.runId)?.state).toBe("failed");
  });
});
