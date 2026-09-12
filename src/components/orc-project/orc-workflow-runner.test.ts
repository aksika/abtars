import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { computeDigest, computeEnvelopeDigest } from "../worker-contract.js";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let RunnerMod: typeof import("./orc-workflow-runner.js");

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
  RunnerMod = runnerMod;
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
type ReviewBrief = import("./orc-workflow-runner.js").ReviewBrief;

let runner: Runner;
let store: Store;

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

/**
 * Finish a run through the mandatory host review + delivery obligation:
 * work-only plans can no longer succeed on worker outcomes alone
 * (AstraMaster-1/2). Drains the pending review command through the given
 * port, accepts the verdict, and acks delivery with a trivial sender.
 */
function acceptAndDeliver(
  runId: string,
  drain: () => number,
  senderName = "test-sender",
): void {
  drain();
  const review = store.listNodes(runId, store.currentRevision(runId))
    .find((n) => n["kind"] === "review")?.["node_id"] as string;
  expect(review).toBeTruthy();
  expect(runner.submitVerdict(runId, review, { verdict: "accept" })).toBe("accepted");
  const sender = {
    name: senderName,
    send: (_doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => "receipt-test",
  };
  expect(runner.executeDelivery(runId, review, sender)).toBe("acknowledged");
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
    // Complete C: the host review (mandatory for work-only plans) unblocks.
    runner.attemptSucceeded(run.runId, acc.nodeIds[2] as string, "att-c", "{}");
    expect(runner.drain(10, port)).toBe(1);
    acceptAndDeliver(run.runId, () => runner.drain(10, port));
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    const tick = runner.auditTick(0);
    expect(tick.ownerless).not.toContain(run.runId);
  });

  it("acceptPlan is initial-only; revisions append through submitPlanProposal", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    expect(() => runner.acceptPlan(run.runId, twoLane())).toThrow(/use submitPlanProposal/);
    expect(store.currentRevision(run.runId)).toBe(1);
  });

  it("delivery without an accepted obligation throws instead of acking", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    // Hand-plant a deliver command with no acceptance behind it.
    store.queueCommand({
      runId: run.runId, generation: 1, nodeId: acc.nodeIds[0] as string,
      action: "deliver", ordinal: 0, payloadJson: "{}",
    });
    const sender = { name: "test-sender", send: (_doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => "receipt-never" };
    expect(() => runner.executeDelivery(run.runId, acc.nodeIds[0] as string, sender))
      .toThrow(/no delivery obligation.*never accepted/);
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
    // Absolute outputs are rejected at the plan boundary (they die at
    // dispatch contract validation and would brick the run on claimed
    // commands — the bounded correction path fixes the plan instead).
    const absRun = admit(runner, seedCard(store));
    expect(() => runner.acceptPlan(absRun.runId, {
      requiredOutputs: ["out/report.md"],
      nodes: [{
        label: "w", kind: "work", instructions: "do", capability: "general",
        outputs: ["/home/u/out/report.md"], acceptance: ["done"], dependsOn: [],
      }],
    })).toThrow(/workspace-relative/);
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
    // Optional-input policy held (S ran without opt); mandatory review +
    // delivery still gate success.
    acceptAndDeliver(run.runId, () => runner.drain(10, port));
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
  });

  it("optional failure queues the released dependent (AstraMaster-5)", () => {
    const run = admit(runner, seedCard(store));
    const proposal: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "opt", kind: "work", instructions: "nice", capability: "general", outputs: ["extra"], acceptance: ["done"], dependsOn: [], optional: true },
        { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: ["opt"] },
      ],
    };
    const acc = runner.acceptPlan(run.runId, proposal);
    const { port, dispatched } = fakePort();
    expect(runner.drain(10, port)).toBe(1);
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-o", "meh", false);
    // The dependent was released AND given a command (previously the dep
    // row was satisfied but no command was queued — S stayed queued forever).
    expect(runner.drain(10, port)).toBe(1);
    expect(dispatched[dispatched.length - 1]?.nodeId).toBe(acc.nodeIds[1]);
    runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, "att-s", "{}");
    acceptAndDeliver(run.runId, () => runner.drain(10, port));
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
  });

  it("audit wraps the cursor so live runs are revisited (AstraMaster-6)", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const first = runner.auditTick(0);
    expect(first.lawful).toContain(run.runId);
    expect(first.checked).toBeGreaterThan(0);
    // Cursor at the end previously meant "never inspect again".
    const second = runner.auditTick(first.nextCursor);
    expect(second.checked).toBeGreaterThan(0);
    expect(second.lawful).toContain(run.runId);
  });

  it("due claims are inspected even with an open operation (AstraMaster-7)", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    expect(runner.drain(10, port)).toBe(2);
    // Age both claims past inspection AND leave a model op open (an
    // abandoned backend: op row stuck running, worker gone). Previously the
    // open op counted as lawful ownership first and shadowed the due claims.
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`).run(run.runId);
    store.upsertOperation({ opId: `op-${run.runId}-ghost`, runId: run.runId, kind: "planning", status: "running" });
    const tick = runner.auditTick(0);
    expect(tick.lawful).toContain(run.runId);
    expect(tick.dueInspections.length).toBe(2);
  });

  it("rejected proposal with budget requeues the planning round (rejection retry)", () => {

    const run = admit(runner, seedCard(store));
    const bad: Proposal = {
      requiredOutputs: ["ghost"],
      nodes: [
        { label: "x", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
      ],
    };
    // A backend reporting this rejection passes its round identity; the run
    // must get a fresh planning command, not a stranded claimed one.
    store.queueCommand({
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}",
    });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    expect(() => runner.submitPlanProposal(run.runId, bad, {
      planRound: { nodeId: "__plan__", ordinal: 0, payloadJson: "{}" },
    })).toThrow(/plan revision rejected/);
    expect(store.getRun(run.runId)?.state).toBe("planning");
    const retry = store.findPendingCommand(run.runId, "__plan__", "plan");
    expect(retry).not.toBeNull();
    expect(retry?.ordinal).toBe(1);
    expect(store.hasCommand(run.runId, "__plan__", "plan", "claimed")).toBe(false);
    // The retry round admits a valid proposal normally.
    const acc = runner.submitPlanProposal(run.runId, twoLane());
    expect(acc.revision).toBe(1);
  });

  it("never-started pending attempt inspects as alive, never inconclusive (#1794)", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    expect(runner.drain(10, port)).toBe(2);
    // Bind the first node to a pending attempt no executor ever picked up
    // (pump queue behind the machine cap — the Sept 10–12 lane-4 shape).
    const a = acc.nodeIds[0] as string;
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES ('att-wait', 96010, 'ctr', 1, 'agent', 'spin-local', 'pending', datetime('now'), 'pending', 1, 1)`,
    ).run();
    store.db.prepare(
      `UPDATE workflow_nodes SET worker_card_id = 96010, attempt_id = 'att-wait' WHERE run_id = ? AND node_id = ?`,
    ).run(run.runId, a);
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`).run(run.runId);
    expect(runner.inspectClaim(run.runId,
      { nodeId: a, action: "dispatch", ordinal: 0, generation: 1 }, 1)).toBe("applied:claimed");
    const cmd = store.db.prepare(
      `SELECT consecutive_inconclusive AS c FROM workflow_commands WHERE run_id = ? AND node_id = ?`,
    ).get(run.runId, a) as { c: number };
    expect(Number(cmd.c)).toBe(0);
    // Node untouched, run alive — queueing behind the cap is lawful waiting.
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("running");
    expect(store.getRun(run.runId)?.state).toBe("dispatched");
  });

  it("duplicate and stale completions cannot duplicate work or resurrect runs", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    const a = acc.nodeIds[0] as string;
    const b = acc.nodeIds[1] as string;
    runner.attemptSucceeded(run.runId, a, "att-a", "{}");
    // Stale completion for an already-succeeded node is rejected loudly.
    expect(() => runner.attemptSucceeded(run.runId, a, "att-a-late", "{}")).toThrow(/conflicts with completion/);
    // Finish the run through mandatory review + delivery, then prove
    // terminal runs reject late results.
    runner.attemptSucceeded(run.runId, b, "att-b", "{}");
    runner.attemptSucceeded(run.runId, acc.nodeIds[2] as string, "att-c", "{}");
    acceptAndDeliver(run.runId, () => runner.drain(10, port));
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    expect(() => runner.attemptSucceeded(run.runId, b, "att-late", "{}")).toThrow(/terminal.*late result rejected/);
    const cmds = store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ?`).get(run.runId) as { c: number };
    expect(Number(cmds.c)).toBe(5); // 3 dispatch + host review + deliver
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

  it("audit read failure throws instead of fabricating ownerless runs", () => {
    // #1792 inference-removal replacement for the retired gather_failed pin:
    // a technical read failure must surface loudly — the audit never reports
    // a run as ownerless (or lawful) from a partial/failed read.
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    store.db.exec(`DROP TABLE workflow_commands`);
    expect(() => runner.auditTick(0)).toThrow(/no such table/);
  });
});

  const reviewPlan = (): Proposal => ({
    requiredOutputs: ["report"],
    nodes: [
      { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      { label: "s", kind: "synthesis", instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
      { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["s"] },
    ],
  });

  function jobPorts() {
    const dispatched: Array<{ nodeId: string; action: string }> = [];
    const reviews: Array<{ nodeId: string; brief: ReviewBrief }> = [];
    const plannings: Array<{ nodeId: string; purpose: string }> = [];
    const ports = {
      executor: {
        name: "fake-exec",
        dispatch: (cmd: { nodeId: string; action: string }) => {
          dispatched.push({ nodeId: cmd.nodeId, action: cmd.action });
        },
      },
      reviewer: {
        name: "fake-reviewer",
        startReview: (cmd: { nodeId: string }, brief: ReviewBrief) => {
          reviews.push({ nodeId: cmd.nodeId, brief });
        },
      },
      planner: {
        name: "fake-planner",
        startPlanning: (cmd: { nodeId: string }, input: { purpose: string }) => {
          plannings.push({ nodeId: cmd.nodeId, purpose: input.purpose });
        },
      },
    };
    return { ports, dispatched, reviews, plannings };
  }

  /** Drive work+synthesis to completion so the review node dispatches. */
  function completeToReview(runId: string, acc: { nodeIds: string[] }, ports: ReturnType<typeof jobPorts>["ports"]): string {
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-a", "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, "att-s", "{}");
    runner.drain(10, ports);
    return acc.nodeIds[2] as string;
  }

describe("WorkflowRunner Task 3 — planning jobs and review verdicts", () => {
  beforeEach(() => {
    ({ runner, store } = makeRunner());
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

  const reviewPlan = (): Proposal => ({
    requiredOutputs: ["report"],
    nodes: [
      { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      { label: "s", kind: "synthesis", instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
      { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["s"] },
    ],
  });

  it("review accept creates a durable delivery obligation without succeeding the run", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports, dispatched, reviews } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    expect(dispatched.map((d) => d.nodeId)).toEqual([acc.nodeIds[0], acc.nodeIds[1]]);
    expect(reviews.length).toBe(1);
    const brief = reviews[0]?.brief;
    expect(brief?.requiredOutputs).toEqual(["report"]);
    expect(brief?.criteriaByNode["a"]).toEqual(["thorough"]);
    expect(brief?.evidenceIds).toEqual(expect.arrayContaining(["att-a", "att-s"]));
    expect(brief?.request.title).toMatch(/wf-rcard-/);
    expect(runner.submitVerdict(run.runId, rNode, { verdict: "accept" })).toBe("accepted");
    // Accepted content with unacknowledged delivery is NOT success yet.
    expect(store.getRun(run.runId)?.state).not.toBe("succeeded");
    expect(store.hasPendingDelivery(run.runId)).toBe(true);
    const cmds = store.db.prepare(`SELECT action FROM workflow_commands WHERE run_id = ? AND action = 'deliver'`).all(run.runId);
    expect(cmds.length).toBe(1);
  });

  it("changes_required queues bounded repair; re-review accepts only the repaired revision", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports, reviews } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    expect(reviews.length).toBe(1);
    const out = runner.submitVerdict(run.runId, rNode, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "missing sources" }],
    });
    expect(out).toBe("repair_queued");
    // Original review node stays open across the repair revision.
    const repairPlan: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "fix", kind: "work", instructions: "add sources", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      ],
    };
    const rev2 = runner.submitPlanProposal(run.runId, repairPlan, { baseRevision: 1 });
    expect(rev2.revision).toBe(2);
    const rev1Review = store.listNodes(run.runId, 1).find((n) => n["node_id"] === rNode);
    expect(rev1Review?.["status"]).toBe("running");
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, rev2.nodeIds[0] as string, "att-fix", "{}");
    // Re-review on the ORIGINAL node judges the repaired revision and accepts.
    expect(runner.submitVerdict(run.runId, rNode, { verdict: "accept" })).toBe("accepted");
    const verdict = JSON.parse(
      (store.listNodes(run.runId, 1).find((n) => n["node_id"] === rNode)?.["outcome"] as string),
    ) as { judgedRevision: number };
    expect(verdict.judgedRevision).toBe(2);
  });

  it("repair exhaustion and malformed verdicts fail explicitly, never silently", () => {
    const run = admit(runner, seedCard(store), { review_repair: 1, protocol_correction: 1 } as Partial<Record<BudgetScope, number>>);
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    expect(runner.submitVerdict(run.runId, rNode, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "thin" }],
    })).toBe("repair_queued");
    expect(runner.submitVerdict(run.runId, rNode, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "still thin" }],
    })).toBe("failed");
    expect(store.getRun(run.runId)?.state).toBe("failed");

    const run2 = admit(runner, seedCard(store), { protocol_correction: 1 } as Partial<Record<BudgetScope, number>>);
    const acc2 = runner.acceptPlan(run2.runId, reviewPlan());
    const { ports: ports2, reviews: reviews2 } = jobPorts();
    const r2 = completeToReview(run2.runId, acc2, ports2);
    expect(reviews2.length).toBe(1);
    expect(runner.submitVerdict(run2.runId, r2, { verdict: "changes_required", defects: [] })).toBe("correction_queued");
    // Correction requeues the review command; the reviewer gets a second brief.
    expect(runner.drain(10, ports2)).toBe(1);
    expect(reviews2.length).toBe(2);
    expect(runner.submitVerdict(run2.runId, r2, { verdict: "changes_required", defects: [{ criterion: "nope", detail: "x" }] })).toBe("failed");
    expect(store.getRun(run2.runId)?.state).toBe("failed");
  });

  it("cannot_assess fails the review with its reason", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    expect(runner.submitVerdict(run.runId, rNode, { verdict: "cannot_assess", reason: "artifact unreadable" })).toBe("unassessable");
    expect(store.getRun(run.runId)?.state).toBe("failed");
  });

  it("next-wave planning appends a revision and completes its authoring node", () => {
    const run = admit(runner, seedCard(store));
    const wave1: Proposal = {
      requiredOutputs: ["notes"],
      nodes: [
        { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["done"], dependsOn: [] },
        { label: "p", kind: "planning", instructions: "plan wave 2", capability: "general", outputs: [], acceptance: [], dependsOn: ["a"] },
      ],
    };
    const acc = runner.acceptPlan(run.runId, wave1);
    const { ports, plannings } = jobPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, acc.nodeIds[0] as string, "att-a", "{}");
    runner.drain(10, ports);
    expect(plannings.length).toBe(1);
    expect(plannings[0]?.purpose).toBe("next_wave");
    const wave2: Proposal = {
      requiredOutputs: ["notes", "report"],
      nodes: [
        { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: [] },
      ],
    };
    const rev2 = runner.submitPlanProposal(run.runId, wave2, {
      baseRevision: 1, completesNode: { revision: 1, nodeId: acc.nodeIds[1] as string, outcome: "proposed" },
    });
    expect(rev2.revision).toBe(2);
    // Authoring planning node completed (not cancelled); wave-2 work queued.
    const pNode = store.listNodes(run.runId, 1).find((n) => n["node_id"] === acc.nodeIds[1]);
    expect(pNode?.["status"]).toBe("succeeded");
    expect(store.getRun(run.runId)?.state).toBe("dispatched");
  });

  it("acceptance weakening is rejected without side effects", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, reviewPlan());
    const narrow: Proposal = {
      requiredOutputs: ["notes"],
      nodes: [
        { label: "x", kind: "work", instructions: "do", capability: "general", outputs: ["notes"], acceptance: ["done"], dependsOn: [] },
      ],
    };
    expect(() => runner.submitPlanProposal(run.runId, narrow, { baseRevision: 1 })).toThrow(/weakens acceptance.*report/);
    expect(store.currentRevision(run.runId)).toBe(1);
    // The admission's own queued command is untouched; the rejected revision
    // queued nothing.
    expect(store.countRunCommands(run.runId, "pending")).toBe(1);
  });

  it("single ExecutionPort keeps legacy dispatch-everything behavior", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, reviewPlan());
    const { port, dispatched } = fakePort();
    runner.drain(10, port);
    expect(dispatched.length).toBe(1);
    runner.attemptSucceeded(run.runId, dispatched[0]?.nodeId as string, "att-a", "{}");
    runner.drain(10, port);
    expect(dispatched.length).toBe(2);
    runner.attemptSucceeded(run.runId, dispatched[1]?.nodeId as string, "att-s", "{}");
    runner.drain(10, port);
    // Review command also flows to the single port (pre-cutover compat).
    expect(dispatched.length).toBe(3);
  });
});

describe("WorkflowRunner Task 4 — cancellation, delivery, input, inspection", () => {
  beforeEach(() => {
    ({ runner, store } = makeRunner());
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
      CREATE TABLE IF NOT EXISTS retry_budget_reservations (
        source_attempt_id TEXT PRIMARY KEY, target_attempt_id TEXT UNIQUE NOT NULL,
        reserved_attempts INTEGER NOT NULL CHECK(reserved_attempts = 1),
        reserved_tokens INTEGER NOT NULL, reserved_cost REAL NOT NULL,
        reserved_switches INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','claimed','released','consumed')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attempt_lease_snapshots (
        attempt_id TEXT PRIMARY KEY, card_id INTEGER,
        claim_generation INTEGER NOT NULL, executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL, high_water_sequence INTEGER NOT NULL,
        state_version INTEGER DEFAULT 1, next_evaluation_at TEXT,
        closed_at TEXT, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    store.db.exec(`DELETE FROM worker_attempts`);
    store.db.exec(`DELETE FROM project_input_requests`);
    store.db.exec(`DELETE FROM retry_budget_reservations`);
    store.db.exec(`DELETE FROM attempt_lease_snapshots`);
  });

  const reviewPlan = (): Proposal => ({
    requiredOutputs: ["report"],
    nodes: [
      { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      { label: "s", kind: "synthesis", instructions: "draft", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
      { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["s"] },
    ],
  });

  function senderOk() {
    const sent: Array<{ key: string }> = [];
    return {
      sent,
      sender: {
        name: "ok-sender",
        send: (doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => {
          sent.push({ key: doc.idempotenceKey });
          return `receipt-for-${doc.idempotenceKey}`;
        },
      },
    };
  }

  it("cancellation fences attempts, releases reservations, and blocks late results", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES ('att-live', 91001, 'ctr', 1, 'spin', 'ex', 'running', datetime('now'), 'running', ?, 1)`,
    ).run(run.rootCardId);
    store.db.prepare(
      `INSERT INTO retry_budget_reservations (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
       VALUES ('att-live', 'att-next', 1, 0, 0, 0, 'active', datetime('now'), datetime('now'))`,
    ).run();
    const res = runner.requestCancel(run.runId, "operator stop");
    expect(res.cancelled).toBe(true);
    expect(res.attemptsFenced).toBe(1);
    expect(store.getRun(run.runId)?.state).toBe("cancelled");
    const att = store.db.prepare(`SELECT lifecycle FROM worker_attempts WHERE id = 'att-live'`).get() as { lifecycle: string };
    expect(att.lifecycle).toBe("cancel_requested");
    const rsv = store.db.prepare(`SELECT status FROM retry_budget_reservations WHERE source_attempt_id = 'att-live'`).get() as { status: string };
    expect(rsv.status).toBe("released");
    // Idempotent second cancel; late results rejected, never resurrected.
    expect(runner.requestCancel(run.runId, "again").cancelled).toBe(false);
    expect(() => runner.attemptSucceeded(run.runId, "whatever", "att-late", "{}")).toThrow(/terminal.*late result rejected/);
    expect(store.getRun(run.runId)?.state).toBe("cancelled");
  });

  it("zero-worker failure settles immediately with no clock involvement", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    // B succeeds first; A then fails while still queued — no worker ever
    // touched A, yet the run settles synchronously in the same call.
    runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, "att-b", "{}");
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-never", "admission revoked", false);
    expect(store.getRun(run.runId)?.state).toBe("failed");
    // Its stale dispatch command completes without dispatch on drain.
    const { port, dispatched } = fakePort();
    expect(runner.drain(10, port)).toBe(0);
    expect(dispatched.length).toBe(0);
  });

  it("delivery acknowledges with receipt; duplicates cannot resend", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    runner.submitVerdict(run.runId, rNode, { verdict: "accept" });
    const { sender, sent } = senderOk();
    expect(runner.executeDelivery(run.runId, rNode, sender)).toBe("acknowledged");
    expect(sent.length).toBe(1);
    expect(sent[0]?.key).toBe(`${run.runId}/${rNode}/1`);
    const row = store.db.prepare(`SELECT outcome FROM workflow_deliveries WHERE run_id = ?`).get(run.runId) as { outcome: string };
    expect(row.outcome).toBe("acknowledged");
    // Acknowledgment with all nodes terminal settles the run: a duplicate
    // delivery is rejected as a late result, and nothing resends.
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    expect(() => runner.executeDelivery(run.runId, rNode, sender)).toThrow(/terminal.*late result rejected/);
    expect(sent.length).toBe(1);
  });

  it("ambiguous send resolves unknown without resend; definitive failure retries bounded", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    const { ports } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    runner.submitVerdict(run.runId, rNode, { verdict: "accept" });
    let calls = 0;
    const flaky = {
      name: "flaky-sender",
      send: (_doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => {
        calls++;
        throw new Error("transport timeout: outcome unknown");
      },
    };
    expect(runner.executeDelivery(run.runId, rNode, flaky)).toBe("unknown");
    expect(calls).toBe(1);
    const row = store.db.prepare(`SELECT outcome FROM workflow_deliveries WHERE run_id = ?`).get(run.runId) as { outcome: string };
    expect(row.outcome).toBe("unknown");

    const run2 = admit(runner, seedCard(store));
    const acc2 = runner.acceptPlan(run2.runId, reviewPlan());
    const { ports: ports2 } = jobPorts();
    const r2 = completeToReview(run2.runId, acc2, ports2);
    runner.submitVerdict(run2.runId, r2, { verdict: "accept" });
    let n = 0;
    const eventual = {
      name: "eventual-sender",
      send: (doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => {
        n++;
        if (n === 1) {
          const err = new Error("refused") as Error & { definitive: boolean };
          err.definitive = true;
          throw err;
        }
        return `ok-${doc.idempotenceKey}`;
      },
    };
    expect(runner.executeDelivery(run2.runId, r2, eventual)).toBe("retry_queued");
    expect(runner.executeDelivery(run2.runId, r2, eventual)).toBe("acknowledged");
    expect(n).toBe(2);
  });

  it("input request pauses visibly; answer resumes; double answer rejected", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const q = "which region?";
    const id = runner.requestInput(run.runId, q, ["report"], "text");
    expect(typeof id).toBe("string");
    expect(store.getRun(run.runId)?.state).toBe("awaiting_input");
    expect(() => runner.requestInput(run.runId, "again?", [])).toThrow(/already awaiting/);
    expect(runner.answerInput(id, "us-west").runId).toBe(run.runId);
    expect(store.getRun(run.runId)?.state).toBe("executing");
    expect(() => runner.answerInput(id, "twice")).toThrow(/unknown or already answered/);
  });

  it("capacity refusal releases the claim; other errors surface without wedging drain", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const busyPort = { name: "full-exec", dispatch: (_cmd: unknown) => { throw new RunnerMod.CapacityBusy(); } };    expect(runner.drain(10, busyPort)).toBe(0);
    const pending = store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ? AND status = 'pending'`).get(run.runId) as { c: number };
    expect(Number(pending.c)).toBe(2);
    const { port, dispatched } = fakePort();
    expect(runner.drain(10, port)).toBe(2);
    expect(dispatched.length).toBe(2);

    const run2 = admit(runner, seedCard(store));
    runner.acceptPlan(run2.runId, twoLane());
    const boom = { name: "boom", dispatch: (_cmd: unknown) => { throw new Error("executor exploded"); } };
    expect(() => runner.drain(10, boom)).toThrow(/executor exploded/);
  });

  it("breaker refusal fails required work immediately and spares review", () => {
    const run = admit(runner, seedCard(store));
    runner.acceptPlan(run.runId, twoLane());
    const policy = {
      check: (input: { action: string }) => (input.action === "dispatch" ? "refused" as const : "ok" as const),
    };
    const { port } = fakePort();
    runner.drain(10, port, { policy });
    expect(store.getRun(run.runId)?.state).toBe("failed");
    expect(store.getRun(run.runId)?.failureCode).toBe("resource_unavailable");

    const run2 = admit(runner, seedCard(store));
    const proposal: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "opt", kind: "work", instructions: "nice", capability: "general", outputs: ["extra"], acceptance: ["done"], dependsOn: [], optional: true },
        { label: "main", kind: "work", instructions: "core", capability: "general", outputs: ["report"], acceptance: ["done"], dependsOn: [] },
        { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["opt", "main"] },
      ],
    };
    const acc2 = runner.acceptPlan(run2.runId, proposal);
    runner.drain(10, port, { policy });
    const nodes = store.listNodes(run2.runId, 1);
    const optId = acc2.nodeIds[0] as string;
    expect(nodes.find((n) => n["node_id"] === optId)?.["status"]).toBe("skipped");
    // Review was never blanket-blocked by the execution fuse: it stays queued.
    expect(nodes.find((n) => n["kind"] === "review")?.["status"]).toBe("queued");
  });

  it("inspection requeues work that never started, fenced by fresh tokens", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const key = { nodeId: acc.nodeIds[0] as string, action: "dispatch" as const, ordinal: 0, generation: 1 };
    const claimed = store.claimCommand({ runId: run.runId, ...key }, "gone");
    expect(claimed).not.toBeNull();
    // Age the claim past the lease with no attempt ever starting.
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`).run(run.runId);
    const out = runner.inspectClaim(run.runId, key, 1);
    expect(out).toMatch(/^applied:pending$/);
    // Stale token from the expired claim completes nothing after re-claim.
    const reclaimed = store.claimCommand({ runId: run.runId, ...key }, "fresh");
    expect(reclaimed).not.toBeNull();
    expect(() => store.completeCommand({ runId: run.runId, ...key }, "gone", claimed?.token ?? "")).toThrow(/rejected/);
    store.completeCommand({ runId: run.runId, ...key }, "fresh", reclaimed?.token ?? "");
  });

  it("SHA final handoff queues review once; non-final and unknown cards noop", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, reviewPlan());
    expect(runner.acceptShaHandoff({ rootCardId: run.rootCardId, stage: "solution", result: "ok", final: false })).toBe("noop");
    // Review node blocked behind work: nothing queued yet, still recorded.
    expect(runner.acceptShaHandoff({ rootCardId: run.rootCardId, stage: "solution", result: "ok", final: true })).toBe("noop");
    // Complete the work; the reviewer claims the review command, then dies
    // without a verdict. Complete its orphaned claim; the handoff re-queues.
    const { ports } = jobPorts();
    const rNode = completeToReview(run.runId, acc, ports);
    const claim = store.db.prepare(
      `SELECT generation, ordinal, owner, claim_token FROM workflow_commands WHERE run_id = ? AND node_id = ? AND action = 'review' AND status = 'claimed'`,
    ).get(run.runId, rNode) as { generation: number; ordinal: number; owner: string; claim_token: string };
    store.completeCommand(
      { runId: run.runId, generation: Number(claim["generation"]), nodeId: rNode, action: "review", ordinal: Number(claim["ordinal"]) },
      claim["owner"] as string, claim["claim_token"] as string,
    );
    expect(runner.acceptShaHandoff({ rootCardId: run.rootCardId, stage: "solution", result: "ok", final: true })).toBe("applied");
    // A second handoff finds the replacement already pending: noop.
    expect(runner.acceptShaHandoff({ rootCardId: run.rootCardId, stage: "solution", result: "ok", final: true })).toBe("noop");
    expect(runner.acceptShaHandoff({ rootCardId: 987654321, stage: "x", result: "y", final: true })).toBe("no-run:noop");
  });

  it("diagnostics are bounded and never raw payloads", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const big = `x`.repeat(5000);
    runner.attemptFailed(run.runId, acc.nodeIds[0] as string, "att-1", big, false);
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === acc.nodeIds[0]);
    expect((node?.["outcome"] as string).length).toBeLessThan(2200);
  });
});

describe("WorkflowRunner durable acceptance (#1794)", () => {
  let cardSeqAcc = 91000;
  let attSeqAcc = 0;

  function nextWorkerCard(): number {
    return cardSeqAcc++;
  }

  function evidenceShapes(cardId: number, attemptId: string, contractId: string) {
    const base = {
      schema_version: 1, id: contractId,
      goal: "acceptance fixture",
      criteria: [{ id: "done", description: "lane done" }],
      expected_artifacts: [{
        id: "o1", kind: "file", ref: "out/lane.md", required: true, criterion_ids: ["done"],
      }],
      verification_commands: [{
        id: "v1", argv: ["test", "-f", "out/lane.md"], timeout_ms: 10_000, criterion_ids: ["done"],
      }],
      required_capabilities: [],
      limits: {},
      provenance: { root_card_id: cardId, card_id: cardId, authored_by: "test", created_at: "2026-09-12T00:00:00.000Z" },
    };
    const digest = computeDigest(base);
    const contractJson = JSON.stringify({ ...base, digest });
    const envelope = (status: string): string => JSON.stringify({
      schema_version: 1,
      attempt: {
        id: attemptId, ordinal: 1, contract_id: contractId, contract_digest: digest,
        executor_kind: "agent", executor_id: "spin-local",
        started_at: "2026-09-12T00:00:00.000Z", finished_at: "2026-09-12T00:01:00.000Z",
      },
      outcome: "completed",
      criteria: [{ criterion_id: "done", status, evidence_ids: ["v1"] }],
      checks: [{
        check_id: "v1", argv: ["test", "-f", "out/lane.md"],
        started_at: "2026-09-12T00:00:00.000Z", finished_at: "2026-09-12T00:00:01.000Z",
        timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "", stderr_excerpt: "",
      }],
      artifacts: [{ artifact_id: "o1", exists: true, kind: "file", ref: "out/lane.md" }],
      worker_report: { summary: "done", claims: [], unresolved_risks: [] },
    });
    return { contractJson, digest, envelope };
  }

  /** Insert a contract + completed attempt + stored result (no node binding). */
  function insertEvidence(
    cardId: number, attemptId: string, status: "passed" | "failed" = "passed",
  ): { contractId: string; envelope: string } {
    const contractId = `ctr-${attemptId}`;
    const { contractJson, digest, envelope } = evidenceShapes(cardId, attemptId, contractId);
    store.db.prepare(
      `INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, schema_version, contract_json, contract_digest, created_at)
       VALUES (?, ?, 1, ?, 1, ?, ?, datetime('now'))`,
    ).run(contractId, cardId, contractId, contractJson, digest);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle)
       VALUES (?, ?, ?, 1, 'agent', 'spin-local', 'settled', datetime('now'), 'completed')`,
    ).run(attemptId, cardId, contractId);
    const body = envelope(status);
    store.db.prepare(
      `INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run(attemptId, body, computeEnvelopeDigest(JSON.parse(body)));
    return { contractId, envelope: body };
  }

  /** Bind a node to a worker card with a completed attempt + stored result. */
  function seedBoundCompletion(
    runId: string, nodeId: string, status: "passed" | "failed" = "passed",
  ): { cardId: number; attemptId: string; envelope: string } {
    const cardId = nextWorkerCard();
    const attemptId = `att-acc-${attSeqAcc++}`;
    const { envelope } = insertEvidence(cardId, attemptId, status);
    store.bindNodeWorker(runId, 1, nodeId, cardId, attemptId);
    return { cardId, attemptId, envelope };
  }

  function ageClaims(runId: string): void {
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-10 minutes') WHERE run_id = ?`)
      .run(runId);
  }

  function dispatchKey(runId: string, nodeId: string) {
    return { nodeId, action: "dispatch" as const, ordinal: 0, generation: 1 };
  }

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    // Fresh worker-evidence tables: this suite owns the durable acceptance
    // fixtures (earlier suites create partial worker_attempts shapes).
    store.db.exec(`DROP TABLE IF EXISTS worker_results`);
    store.db.exec(`DROP TABLE IF EXISTS worker_contracts`);
    store.db.exec(`DROP TABLE IF EXISTS worker_attempts`);
    store.db.exec(`
      CREATE TABLE worker_attempts (
        id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, contract_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, executor_kind TEXT NOT NULL, executor_id TEXT NOT NULL,
        status TEXT NOT NULL, started_at TEXT NOT NULL,
        lifecycle TEXT NOT NULL DEFAULT 'pending',
        generation INTEGER DEFAULT 1,
        root_project_card_id INTEGER, root_project_generation INTEGER,
        cancel_reason TEXT,
        UNIQUE(card_id, ordinal)
      );
      CREATE TABLE worker_contracts (
        id TEXT PRIMARY KEY, card_id INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        root_contract_id TEXT NOT NULL, parent_contract_id TEXT, source_attempt_id TEXT,
        schema_version INTEGER NOT NULL, contract_json TEXT NOT NULL, contract_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE worker_results (
        attempt_id TEXT PRIMARY KEY, envelope_json TEXT NOT NULL, envelope_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
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
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  it("inspection of a completed claim succeeds only on passing stored evidence", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    expect(runner.drain(10, port)).toBe(2);
    const a = acc.nodeIds[0] as string;
    const b = acc.nodeIds[1] as string;
    const { envelope } = seedBoundCompletion(run.runId, a, "passed");
    ageClaims(run.runId);
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, a), 1)).toBe("applied:done");
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === a);
    expect(node?.["status"]).toBe("succeeded");
    expect(node?.["outcome"]).toBe(envelope);
    // S still waits on B: no duplicate or early successor.
    expect(runner.drain(10, port)).toBe(0);
    runner.attemptSucceeded(run.runId, b, "att-b", "{}");
    expect(runner.drain(10, port)).toBe(1);
  });

  it("inspection rejects failed evidence on a required node and skips dependents", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    seedBoundCompletion(run.runId, a, "failed");
    ageClaims(run.runId);
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, a), 1)).toBe("applied:done");
    const nodes = store.listNodes(run.runId, 1);
    expect(nodes.find((n) => n["node_id"] === a)?.["status"]).toBe("failed");
    expect(nodes.find((n) => n["node_id"] === a)?.["outcome"]).toMatch(/acceptance_unmet/);
    expect(nodes.find((n) => n["node_id"] === acc.nodeIds[2])?.["status"]).toBe("skipped");
    expect(store.readBudgets(run.runId)["work_retry"]?.consumed).toBe(0);
  });

  it("inspection rejects failed evidence on an optional node but releases dependents", () => {
    const run = admit(runner, seedCard(store));
    const proposal: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "opt", kind: "work", instructions: "nice", capability: "general", outputs: ["extra"], acceptance: ["done"], dependsOn: [], optional: true },
        { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: ["opt"] },
      ],
    };
    const acc = runner.acceptPlan(run.runId, proposal);
    const { port, dispatched } = fakePort();
    expect(runner.drain(10, port)).toBe(1);
    const opt = acc.nodeIds[0] as string;
    seedBoundCompletion(run.runId, opt, "failed");
    ageClaims(run.runId);
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, opt), 1)).toBe("applied:done");
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === opt)?.["status"]).toBe("failed");
    // The allowed dependent is released with a real command, not just a
    // satisfied dep row.
    expect(runner.drain(10, port)).toBe(1);
    expect(dispatched[dispatched.length - 1]?.nodeId).toBe(acc.nodeIds[1]);
  });

  it("inspection fails closed when the completed attempt has no stored result", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    const { attemptId } = seedBoundCompletion(run.runId, a, "passed");
    store.db.prepare(`DELETE FROM worker_results WHERE attempt_id = ?`).run(attemptId);
    ageClaims(run.runId);
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, a), 1)).toBe("applied:done");
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === a);
    expect(node?.["status"]).toBe("failed");
    expect(node?.["outcome"]).toMatch(/acceptance_unreadable: envelope/);
  });

  it("direct completion for a superseded attempt throws stale and changes nothing", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    const { attemptId: oldId, cardId } = seedBoundCompletion(run.runId, a, "passed");
    // A retry successor is already the current attempt for the card.
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle)
       VALUES ('att-acc-new', ?, ?, 2, 'agent', 'spin-local', 'running', datetime('now'), 'running')`,
    ).run(cardId, `ctr-${oldId}`);
    expect(() => runner.attemptSucceeded(run.runId, a, oldId, "{}")).toThrow(/stale attempt/);
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("running");
    expect(store.readBudgets(run.runId)["work_retry"]?.consumed).toBe(0);
    // The current attempt still succeeds normally through stored evidence
    // under the same (unreplaced) contract.
    store.db.prepare(`UPDATE worker_attempts SET lifecycle = 'completed', status = 'settled' WHERE id = 'att-acc-new'`).run();
    const shapes = evidenceShapes(cardId, "att-acc-new", `ctr-${oldId}`);
    const body = shapes.envelope("passed");
    store.db.prepare(
      `INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
       VALUES ('att-acc-new', ?, ?, datetime('now'))`,
    ).run(body, computeEnvelopeDigest(JSON.parse(body)));
    runner.attemptSucceeded(run.runId, a, "att-acc-new", "{}");
    const done = store.listNodes(run.runId, 1).find((n) => n["node_id"] === a);
    expect(done?.["status"]).toBe("succeeded");
    expect(done?.["outcome"]).toBe(body);
  });

  it("recovery then inspection then recovery applies exactly once", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    const { envelope } = seedBoundCompletion(run.runId, a, "passed");
    // Recovery applies the unconsumed completion (claimed command, node open).
    expect(runner.recoverUnconsumedCompletions(10)).toBe(1);
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("succeeded");
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === a)?.["outcome"]).toBe(envelope);
    // Reordered inspection finds the terminal node and only finishes the
    // orphaned claim; a second recovery finds nothing to apply.
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, a), 1)).toBe("noop:done");
    expect(runner.recoverUnconsumedCompletions(10)).toBe(0);
    const succ = store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ? AND node_id = ?`)
      .get(run.runId, acc.nodeIds[2]) as { c: number };
    expect(Number(succ.c)).toBe(0); // S still waits on B: exactly-once held.
  });

  it("quality rejection leaves the retry allowance for genuine flakes", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const { port } = fakePort();
    runner.drain(10, port);
    const a = acc.nodeIds[0] as string;
    const b = acc.nodeIds[1] as string;
    seedBoundCompletion(run.runId, a, "failed");
    ageClaims(run.runId);
    expect(runner.inspectClaim(run.runId, dispatchKey(run.runId, a), 1)).toBe("applied:done");
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === a)?.["status"]).toBe("failed");
    // A genuinely retry-safe failure on the sibling still spends the
    // untouched allowance and requeues.
    runner.attemptFailed(run.runId, b, "att-b1", "flaky transport", true);
    const cmds = store.db.prepare(
      `SELECT ordinal FROM workflow_commands WHERE run_id = ? AND node_id = ? ORDER BY ordinal`,
    ).all(run.runId, b) as Array<{ ordinal: number }>;
    expect(cmds.map((c) => Number(c.ordinal))).toEqual([0, 1]);
    expect(store.readBudgets(run.runId)["work_retry"]?.consumed).toBe(1);
  });

  it("rejected unapplied ingress replays as a consumed failure, never a success", () => {
    const run = admit(runner, seedCard(store));
    const acc = runner.acceptPlan(run.runId, twoLane());
    const a = acc.nodeIds[0] as string;
    const { attemptId } = seedBoundCompletion(run.runId, a, "failed");
    // Plant the legacy abstract success request for node A with its real
    // attempt identity; the guarded applier must consume it as a failure.
    const realPayload = JSON.stringify({
      kind: "AttemptSucceeded",
      body: { nodeId: a, attemptId, artifactsJson: "{}" },
    });
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('replay-rej-1', ?, 'h', ?, 'received', datetime('now'))`,
    ).run(run.runId, realPayload);
    expect(runner.startupRecovery().redrivenIngress).toBe(1);
    const nodes = store.listNodes(run.runId, 1);
    expect(nodes.find((n) => n["node_id"] === a)?.["status"]).toBe("failed");
    expect(nodes.find((n) => n["node_id"] === a)?.["outcome"]).toMatch(/acceptance_unmet/);
    const ing = store.db.prepare(`SELECT disposition, payload_json FROM workflow_ingress WHERE event_id = 'replay-rej-1'`)
      .get() as { disposition: string; payload_json: string };
    expect(ing.disposition).toBe("applied");
    expect(ing.payload_json).toBe(realPayload);
  });
});
