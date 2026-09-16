import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import { ProjectReviewStore } from "../project-acceptance/project-review-store.js";
import { resolveWorkerExecutorIntent } from "../worker-executor-routing.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { RootProjectionOutcome } from "./orc-workflow-ports.js";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let Ports: typeof import("./orc-workflow-ports.js");
let Kanban: typeof import("../tasks/kanban-board.js");
let nerve: typeof import("../nerve.js")["nerve"];

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-ports-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  Ports = await import("./orc-workflow-ports.js");
  Kanban = await import("../tasks/kanban-board.js");
  nerve = (await import("../nerve.js")).nerve;
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
    // #1792: first dispatch starts execution (the executor claim fence only
    // claims under executing/repairing); awaiting stays until dispatch.
    expect(sup.state).toBe("executing");
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

  it("planner backend hands exhausted corrections to the runner budget (#1795 §2a)", async () => {
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
    // Durable rejection, not a swallowed throw: exactly one plan_revision
    // consumed, the failed round superseded, a fresh round requeued, and the
    // run still planning with no revision admitted.
    const budgets = store.readBudgets(run.runId);
    expect(budgets["plan_revision"].consumed).toBe(1);
    const cmds = store.db.prepare(`SELECT ordinal, status FROM workflow_commands WHERE run_id = ? AND node_id = '__plan__' ORDER BY ordinal`).all(run.runId) as Array<{ ordinal: number; status: string }>;
    expect(cmds).toEqual([{ ordinal: 0, status: "cancelled" }, { ordinal: 1, status: "pending" }]);
    expect(store.getRun(run.runId)?.state).toBe("planning");
    expect(store.currentRevision(run.runId)).toBe(0);
  });

  it("planner exhaustion with zero budget fails the run with the rejection diagnostics", async () => {
    copSeq++;
    const card = seedCard(store);
    const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `port-zero-${copSeq}`, budgets: { plan_revision: 0 } }).run;
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async () => "not json at all",
    });
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    backend.startPlanning({
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    }, {
      runId: run.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 50));
    // No requeue, no stranded claim, no inspection no_workers: the run fails
    // with the rejection diagnostics.
    const done = store.getRun(run.runId);
    expect(done?.state).toBe("failed");
    expect(done?.failureCode).toBe("plan_rejected");
    expect(done?.failureReason).toMatch(/proposal/);
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

  it("reviewer prompt carries the goal and criterion ids (AstraMaster-8)", async () => {
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
    const prompts: string[] = [];
    const backend = new Ports.SpinReviewerBackend({
      runner,
      callModel: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ verdict: "accept" });
      },
    });
    const rNode = acc.nodeIds[2] as string;
    const cmd = {
      runId: run.runId, generation: 1, nodeId: rNode, action: "review" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: JSON.stringify({ nodeId: rNode, revision: 1 }),
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-reviewer", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    };
    backend.startReview(cmd, runner.assembleBrief(run.runId, 1, rNode));
    await new Promise((r) => setTimeout(r, 50));
    expect(prompts.length).toBe(1);
    // Valid criticism needs exact criterion ids and the goal: both present.
    expect(prompts[0]).toContain("Acceptance criteria by node");
    expect(prompts[0]).toContain("thorough");
    expect(prompts[0]).toContain("complete");
    expect(prompts[0]).toContain("Goal:");
  });

  it("backends wake the drain on settlement, not on failure (AstraMaster-3)", async () => {
    const run = admit(runner, seedCard(store));
    let wakes = 0;
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async () => JSON.stringify({
        nodes: [
          { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
        ],
        requiredOutputs: ["o"],
      }),
      onSettled: () => { wakes++; },
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
    expect(wakes).toBe(1);

    // Persistent model failure: the rejection is durable and budgeted, the
    // round is requeued, and the drain is woken for it (#1795 §2a — the old
    // swallow-and-inspect behavior is gone).
    const run2 = admit(runner, seedCard(store));
    let wakes2 = 0;
    const failing = new Ports.SpinPlannerBackend({
      runner,
      callModel: async () => "not json at all",
      onSettled: () => { wakes2++; },
    });
    const cmd2 = {
      runId: run2.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    };
    store.queueCommand({ runId: run2.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run2.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    failing.startPlanning(cmd2, {
      runId: run2.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(wakes2).toBe(1);
    expect(store.readBudgets(run2.runId)["plan_revision"].consumed).toBe(1);
  });

  it("planner prompt carries the full goal and bound workspace on initial and correction rounds (#1795)", async () => {
    const card = seedCard(store);
    // Lane-4 instructions, optionality, handoff names, and report rules sit
    // beyond the old 2000-unit cutoff: slicing them away must fail this test.
    const tailMarker = `LANE4-TAIL-MARKER-${card}`;
    const longGoal = `lane1-x research the topic\nlane2-rss gather feeds\n`
      + `filler constraint line for padding purposes\n`.repeat(60)
      + `${tailMarker}\nlane4-web is optional; write handoff lane4-web-handoff.md; final report Daily-Briefing-2026-09-14.md\n`;
    expect(longGoal.length).toBeGreaterThan(2000);
    expect(longGoal.indexOf(tailMarker)).toBeGreaterThan(2000);
    store.db.prepare(`UPDATE kanban_board SET goal = ? WHERE id = ?`).run(longGoal, card);
    const run = admit(runner, card);
    const ws = join(TEST_HOME, `ws-1795-${card}`);
    mkdirSync(ws, { recursive: true });
    const reviewStore = new ProjectReviewStore(store.db);
    reviewStore.ensureAwaitingContract(card);
    expect(reviewStore.bindWorkspace(card, ws)).toEqual({ ok: true });

    const prompts: string[] = [];
    let calls = 0;
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async (prompt: string) => {
        prompts.push(prompt);
        calls++;
        if (calls === 1) return JSON.stringify({ nodes: [], requiredOutputs: [] });
        return JSON.stringify({
          nodes: [
            { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
          ],
          requiredOutputs: ["o"],
        });
      },
    });
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    backend.startPlanning({
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    }, {
      runId: run.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    // Only the external ModelCall input is captured: the full task tail and
    // the bound workspace arrive intact on BOTH rounds.
    expect(prompts.length).toBe(2);
    for (const prompt of prompts) {
      expect(prompt).toContain(tailMarker);
      expect(prompt).toContain(`Workspace root: ${ws}`);
    }
    expect(prompts[1]).toContain("REJECTED");
    expect(store.currentRevision(run.runId)).toBe(1);
  });
});

// ── #1799 runner-root promotion ─────────────────────────────────────────────

describe("#1799 runner-root promotion", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = setup());
    for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
      store.db.exec(`DELETE FROM ${t}`);
    }
  });

  function seedQueuedCard(opts?: { source?: string; sourceId?: string | null; title?: string }): number {
    const res = store.db.prepare(
      `INSERT INTO kanban_board (title, source, source_id, type, status) VALUES (?, ?, ?, 'O', 'queued')`,
    ).run(
      opts?.title ?? `wf-port-q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      opts?.source ?? "agent",
      opts?.sourceId ?? null,
    );
    return Number(res.lastInsertRowid);
  }

  function admitFor(card: number, rootKind: "peer" | "interactive" | "scheduled", scheduledRunId?: string) {
    copSeq++;
    return runner.admit({
      rootKind, rootCardId: card,
      scheduledRunId: scheduledRunId ?? null,
      clientOperationId: `port-q-${copSeq}`,
    }).run;
  }

  function claimDispatchRow(runId: string, nodeId: string) {
    const claimed = store.claimCommand(
      { runId, generation: 1, nodeId, action: "dispatch", ordinal: 0 }, "workflow-worker",
    );
    expect(claimed).not.toBeNull();
    return claimed!.row;
  }

  function cardStatus(cardId: number): string {
    return (store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(cardId) as { status: string }).status;
  }

  function supervisionState(cardId: number): string {
    return (store.db.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { state: string }).state;
  }

  function promotionRows(cardId: number): Record<string, unknown>[] {
    const t = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kanban_card_transitions'`).get();
    if (!t) return [];
    return store.db.prepare(
      `SELECT * FROM kanban_card_transitions WHERE card_id = ? AND to_status = 'running' AND actor = 'dispatch'`,
    ).all(cardId) as Record<string, unknown>[];
  }

  function childCards(rootId: number): Record<string, unknown>[] {
    return store.db.prepare(`SELECT id FROM kanban_board WHERE parent_id = ?`).all(rootId) as Record<string, unknown>[];
  }

  function rootAttempts(rootId: number): Record<string, unknown>[] {
    const t = store.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_attempts'`).get();
    if (!t) return [];
    return store.db.prepare(`SELECT id, lifecycle FROM worker_attempts WHERE root_project_card_id = ?`).all(rootId) as Record<string, unknown>[];
  }

  function captureCardEvents() {
    const events: Array<{ event: string; cardId: number }> = [];
    const onQueued = (cardId: number) => events.push({ event: "card:queued", cardId });
    const onRunning = (cardId: number) => events.push({ event: "card:running", cardId });
    nerve.on("card:queued", onQueued);
    nerve.on("card:running", onRunning);
    return {
      events,
      stop: () => {
        nerve.off("card:queued", onQueued);
        nerve.off("card:running", onRunning);
      },
    };
  }

  /** Seed a live scheduled task run row (project-authority.test.ts shape). */
  function seedLiveTaskRun(runId: string): void {
    store.db.prepare(
      `INSERT INTO task_runs (run_id, task_id, group_id, attempt, trigger, occurrence_at, reserved_at, deadline_at, phase, last_progress_at, owner_pid)
       VALUES (?, ?, ?, 1, 'schedule', 0, 0, 9999999999999, 'executing', 0, 1)`,
    ).run(runId, `task-${runId}`, `g-${runId}`);
  }

  /**
   * #1799: commit a durable write in the exact concurrent-write window —
   * after the projection preflight SELECTs, before the promotion CAS UPDATE
   * executes. Interposes on the first `UPDATE kanban_board SET` prepare (the
   * promotion CAS; the preflight is SELECT-only) and runs the mutation on the
   * base connection first. The real kanbanTransition then executes against
   * post-mutation state: no mocked success, no mocked transition.
   */
  function racingDb(
    base: Store["db"],
    mutate: (db: Store["db"]) => void,
  ): Store["db"] {
    let armed = true;
    return {
      prepare(sql: string) {
        if (armed && sql.startsWith("UPDATE kanban_board SET")) {
          armed = false;
          mutate(base);
          return base.prepare(sql);
        }
        return base.prepare(sql);
      },
      exec(sql: string) { base.exec(sql); },
      transaction<T>(fn: () => T): T { return base.transaction(fn); },
      transactionImmediate<T>(fn: () => T): T { return base.transactionImmediate(fn); },
    };
  }

  for (const kind of ["peer", "interactive"] as const) {
    it(`first dispatch promotes a queued ${kind} root before the child publishes`, () => {
      const card = seedQueuedCard();
      const run = admitFor(card, kind);
      const acc = runner.acceptPlan(run.runId, workPlan());
      const nodeId = acc.nodeIds[0] as string;
      const cap = captureCardEvents();
      // Root status at the exact moment the child's card:queued is observed.
      let rootStatusAtChildEvent: string | null = null;
      const probe = (childId: number) => {
        const child = store.db.prepare(`SELECT parent_id FROM kanban_board WHERE id = ?`).get(childId) as { parent_id: number | null } | undefined;
        if (child?.parent_id === card) rootStatusAtChildEvent = cardStatus(card);
      };
      nerve.on("card:queued", probe);
      try {
        const port = new Ports.WorkflowWorkerPort({ runner });
        port.dispatch(claimDispatchRow(run.runId, nodeId));
      } finally {
        nerve.off("card:queued", probe);
        cap.stop();
      }
      // The child's post-commit card:queued pumped against an already-running root.
      expect(rootStatusAtChildEvent).toBe("running");
      const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === nodeId);
      const childId = Number(node?.["worker_card_id"]);
      expect(childId).toBeGreaterThan(0);
      const runningIdx = cap.events.findIndex((e) => e.event === "card:running" && e.cardId === card);
      const queuedIdx = cap.events.findIndex((e) => e.event === "card:queued" && e.cardId === childId);
      expect(runningIdx).toBeGreaterThanOrEqual(0);
      expect(queuedIdx).toBeGreaterThanOrEqual(0);
      expect(runningIdx).toBeLessThan(queuedIdx);
      // Durable and correct.
      expect(cardStatus(card)).toBe("running");
      expect(childCards(card)).toHaveLength(1);
      const attempts = rootAttempts(card);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!["lifecycle"]).toBe("pending");
      expect(attempts[0]!["id"]).toBe(node?.["attempt_id"]);
      expect(supervisionState(card)).toBe("executing");
    });
  }

  it("re-entry under executing supervision repairs a queued root with exactly one journal row", () => {
    const card = seedQueuedCard();
    const run = admitFor(card, "interactive");
    const acc = runner.acceptPlan(run.runId, workPlan());
    const nodeId = acc.nodeIds[0] as string;
    // Crash window: supervision reached executing, the card never left queued.
    const review = new ProjectReviewStore(store.db);
    review.ensureAwaitingContract(card);
    expect(review.stateTransition(card, ["awaiting_contract"], "executing")).toBe(true);
    expect(cardStatus(card)).toBe("queued");

    const port = new Ports.WorkflowWorkerPort({ runner });
    const row = claimDispatchRow(run.runId, nodeId);
    port.dispatch(row);
    expect(cardStatus(card)).toBe("running");
    expect(promotionRows(card)).toHaveLength(1);
    // A second dispatch creates its own child but no second promotion row:
    // already-running is idempotent, journal-free, event-free.
    const cap = captureCardEvents();
    try {
      port.dispatch(row);
    } finally {
      cap.stop();
    }
    expect(cardStatus(card)).toBe("running");
    expect(promotionRows(card)).toHaveLength(1);
    expect(cap.events.filter((e) => e.event === "card:running" && e.cardId === card)).toHaveLength(0);
  });

  it("non-executable supervision fails the dispatch with no child or attempt", () => {
    const card = seedQueuedCard();
    const run = admitFor(card, "peer");
    const acc = runner.acceptPlan(run.runId, workPlan());
    const nodeId = acc.nodeIds[0] as string;
    const review = new ProjectReviewStore(store.db);
    review.ensureAwaitingContract(card);
    expect(review.stateTransition(card, ["awaiting_contract"], "reviewing")).toBe(true);

    const port = new Ports.WorkflowWorkerPort({ runner });
    expect(() => port.dispatch(claimDispatchRow(run.runId, nodeId)))
      .toThrow(Ports.WorkflowDispatchError);
    expect(cardStatus(card)).toBe("queued");
    expect(childCards(card)).toHaveLength(0);
    expect(rootAttempts(card)).toHaveLength(0);
  });

  it("a rejected execution transition fails the dispatch with no child or attempt", () => {
    // Scheduled root whose owning run finished after admission: the
    // awaiting_contract → executing CAS loses its authority check.
    const schedId = `sched-rej-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    seedLiveTaskRun(schedId);
    const card = seedQueuedCard({ source: "task", sourceId: schedId });
    const run = admitFor(card, "scheduled", schedId);
    const acc = runner.acceptPlan(run.runId, workPlan());
    const nodeId = acc.nodeIds[0] as string;
    store.db.prepare(`UPDATE task_runs SET finished_at = ?, outcome = 'success' WHERE run_id = ?`).run(Date.now(), schedId);

    const port = new Ports.WorkflowWorkerPort({ runner });
    expect(() => port.dispatch(claimDispatchRow(run.runId, nodeId)))
      .toThrow(Ports.WorkflowDispatchError);
    expect(cardStatus(card)).toBe("queued");
    expect(childCards(card)).toHaveLength(0);
    expect(rootAttempts(card)).toHaveLength(0);
  });

  it("all dispatch writes land on the runner database, never the global one", async () => {
    const { resolveNativeDep } = await import("../../utils/lazy-require.js") as {
      resolveNativeDep: (name: string) => unknown;
    };
    const Database = resolveNativeDep("better-sqlite3") as new (p: string) => {
      prepare(sql: string): {
        run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
        get(...p: unknown[]): Record<string, unknown> | undefined;
        all(...p: unknown[]): Record<string, unknown>[];
      };
      exec(sql: string): void;
      transaction<T>(fn: () => T): () => T;
      close(): void;
    };
    const rawIso = new Database(":memory:");
    try {
      const isoDb = Kanban.wrapTaskDatabase(rawIso as never);
      Kanban.ensureKanbanBoardSchema(isoDb);
      // A real runner database carries the full bootstrap: the promotion CAS
      // predicate joins task_runs for the scheduled branch, so the isolated
      // database needs that schema too (production always has it).
      const taskState = await import("../tasks/task-state-schema.js");
      taskState.initTaskStateSchema(isoDb as never);
      const isoStore = new StoreType(isoDb);
      const isoRunner = new RunnerType(isoStore, ["general", "research", "write"]);
      const title = `iso-root-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const card = Number(isoDb.prepare(
        `INSERT INTO kanban_board (title, source, type, status) VALUES (?, 'agent', 'O', 'queued')`,
      ).run(title).lastInsertRowid);
      copSeq++;
      const isoRun = isoRunner.admit({
        rootKind: "interactive", rootCardId: card, clientOperationId: `port-iso-${copSeq}`,
      }).run;
      const acc = isoRunner.acceptPlan(isoRun.runId, workPlan());
      const nodeId = acc.nodeIds[0] as string;
      const claimed = isoStore.claimCommand(
        { runId: isoRun.runId, generation: 1, nodeId, action: "dispatch", ordinal: 0 }, "workflow-worker",
      );
      expect(claimed).not.toBeNull();
      new Ports.WorkflowWorkerPort({ runner: isoRunner }).dispatch(claimed!.row);

      // Everything landed on the injected connection.
      expect((isoDb.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(card) as { status: string }).status).toBe("running");
      expect((isoDb.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(card) as { state: string }).state).toBe("executing");
      const isoChildren = isoDb.prepare(`SELECT id FROM kanban_board WHERE parent_id = ?`).all(card) as Record<string, unknown>[];
      expect(isoChildren).toHaveLength(1);
      const isoAttempt = isoDb.prepare(`SELECT id, lifecycle FROM worker_attempts WHERE root_project_card_id = ?`).all(card) as Record<string, unknown>[];
      expect(isoAttempt).toHaveLength(1);
      expect(isoAttempt[0]!["lifecycle"]).toBe("pending");
      // Nothing leaked to the global database (unique run/title/attempt ids).
      expect(store.db.prepare(`SELECT id FROM kanban_board WHERE title = ?`).get(title)).toBeUndefined();
      expect(store.db.prepare(`SELECT run_id FROM workflow_runs WHERE run_id = ?`).get(isoRun.runId)).toBeUndefined();
      expect(store.db.prepare(`SELECT id FROM worker_attempts WHERE id = ?`).get(isoAttempt[0]!["id"] as string)).toBeUndefined();
    } finally {
      rawIso.close();
    }
  });

  it("a stale run reference after cancellation fails the dispatch with no child", () => {
    const card = seedQueuedCard();
    const run = admitFor(card, "interactive");
    const acc = runner.acceptPlan(run.runId, workPlan());
    const nodeId = acc.nodeIds[0] as string;
    store.db.prepare(`UPDATE workflow_runs SET state = 'cancelled' WHERE run_id = ?`).run(run.runId);

    const cap = captureCardEvents();
    try {
      const port = new Ports.WorkflowWorkerPort({ runner });
      expect(() => port.dispatch(claimDispatchRow(run.runId, nodeId)))
        .toThrow(/root not dispatchable/);
    } finally {
      cap.stop();
    }
    expect(cardStatus(card)).toBe("queued");
    expect(childCards(card)).toHaveLength(0);
    expect(rootAttempts(card)).toHaveLength(0);
    expect(promotionRows(card)).toHaveLength(0);
    expect(cap.events.filter((e) => e.event === "card:running" && e.cardId === card)).toHaveLength(0);
  });

  it("a cancellation racing the promotion CAS wins: no journal, no event", () => {
    const card = seedQueuedCard();
    const run = admitFor(card, "peer");
    runner.acceptPlan(run.runId, workPlan());
    const review = new ProjectReviewStore(store.db);
    review.ensureAwaitingContract(card);
    expect(review.stateTransition(card, ["awaiting_contract"], "executing")).toBe(true);

    const raced = racingDb(store.db, (db) => {
      db.prepare(`UPDATE workflow_runs SET state = 'cancelled' WHERE run_id = ?`).run(run.runId);
    });
    const cap = captureCardEvents();
    let outcome: RootProjectionOutcome;
    try {
      outcome = Ports.projectRunnerRootRunning(raced, {
        runId: run.runId, rootCardId: card, scheduledRunId: null,
      });
    } finally {
      cap.stop();
    }
    expect(outcome.ok).toBe(false);
    expect(cardStatus(card)).toBe("queued");
    expect(promotionRows(card)).toHaveLength(0);
    expect(cap.events.filter((e) => e.event === "card:running" && e.cardId === card)).toHaveLength(0);
  });

  it("a supervision generation change racing the promotion CAS wins", () => {
    const card = seedQueuedCard();
    const run = admitFor(card, "interactive");
    runner.acceptPlan(run.runId, workPlan());
    const review = new ProjectReviewStore(store.db);
    review.ensureAwaitingContract(card);
    expect(review.stateTransition(card, ["awaiting_contract"], "executing")).toBe(true);

    const raced = racingDb(store.db, (db) => {
      db.prepare(`UPDATE project_supervision SET generation = generation + 1 WHERE project_card_id = ?`).run(card);
    });
    const outcome = Ports.projectRunnerRootRunning(raced, {
      runId: run.runId, rootCardId: card, scheduledRunId: null,
    });
    expect(outcome.ok).toBe(false);
    expect(cardStatus(card)).toBe("queued");
    expect(promotionRows(card)).toHaveLength(0);
  });

  it("a scheduled-run completion racing the promotion CAS wins", () => {
    const schedId = `sched-race-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    seedLiveTaskRun(schedId);
    const card = seedQueuedCard({ source: "task", sourceId: schedId });
    const run = admitFor(card, "scheduled", schedId);
    runner.acceptPlan(run.runId, workPlan());
    const review = new ProjectReviewStore(store.db);
    review.ensureAwaitingContract(card);
    expect(review.stateTransition(card, ["awaiting_contract"], "executing")).toBe(true);

    const raced = racingDb(store.db, (db) => {
      db.prepare(`UPDATE task_runs SET finished_at = ?, outcome = 'success' WHERE run_id = ?`).run(Date.now(), schedId);
    });
    const cap = captureCardEvents();
    let outcome: RootProjectionOutcome;
    try {
      outcome = Ports.projectRunnerRootRunning(raced, {
        runId: run.runId, rootCardId: card, scheduledRunId: schedId,
      });
    } finally {
      cap.stop();
    }
    expect(outcome.ok).toBe(false);
    expect(cardStatus(card)).toBe("queued");
    expect(promotionRows(card)).toHaveLength(0);
    expect(cap.events.filter((e) => e.event === "card:running" && e.cardId === card)).toHaveLength(0);
  });

  for (const sourceId of [null, ""] as const) {
    it(`a task-sourced root without a durable source id (${sourceId === null ? "NULL" : "empty"}) dispatches as non-scheduled`, () => {
      const card = seedQueuedCard({ source: "task", sourceId });
      const run = admitFor(card, "interactive");
      const acc = runner.acceptPlan(run.runId, workPlan());
      const nodeId = acc.nodeIds[0] as string;
      new Ports.WorkflowWorkerPort({ runner }).dispatch(claimDispatchRow(run.runId, nodeId));
      expect(cardStatus(card)).toBe("running");
      expect(childCards(card)).toHaveLength(1);
      expect(rootAttempts(card)).toHaveLength(1);
      expect(supervisionState(card)).toBe("executing");
    });
  }

  it("the Pi port promotes the root before publishing its child", () => {
    const piRunner = new RunnerType(store, ["general", "pi-coding"]);
    const card = seedQueuedCard();
    copSeq++;
    const run = piRunner.admit({
      rootKind: "interactive", rootCardId: card, clientOperationId: `port-pi-${copSeq}`,
    }).run;
    const piPlan: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "a", kind: "work", instructions: "research thoroughly", capability: "pi-coding", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] as string[] },
        { label: "s", kind: "synthesis", instructions: "draft it", capability: "general", outputs: ["report"], acceptance: ["complete"], dependsOn: ["a"] },
      ],
    };
    const acc = piRunner.acceptPlan(run.runId, piPlan);
    const nodeId = acc.nodeIds[0] as string;
    const claimed = store.claimCommand(
      { runId: run.runId, generation: 1, nodeId, action: "dispatch", ordinal: 0 }, "workflow-pi-worker",
    );
    expect(claimed).not.toBeNull();

    let rootStatusAtChildEvent: string | null = null;
    const probe = (childId: number) => {
      const child = store.db.prepare(`SELECT parent_id FROM kanban_board WHERE id = ?`).get(childId) as { parent_id: number | null } | undefined;
      if (child?.parent_id === card) rootStatusAtChildEvent = cardStatus(card);
    };
    nerve.on("card:queued", probe);
    try {
      new Ports.WorkflowPiPort({ runner: piRunner, workspaceAliasFor: () => "testalias" }).dispatch(claimed!.row);
    } finally {
      nerve.off("card:queued", probe);
    }
    expect(rootStatusAtChildEvent).toBe("running");
    expect(cardStatus(card)).toBe("running");
    expect(supervisionState(card)).toBe("executing");
    const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === nodeId);
    const childId = Number(node?.["worker_card_id"]);
    expect(childId).toBeGreaterThan(0);
    // The executor boundary is the only thing replaced: the child is Pi work.
    const attempt = store.db.prepare(`SELECT lifecycle, executor_kind FROM worker_attempts WHERE id = ?`)
      .get(node?.["attempt_id"] as string) as { lifecycle: string; executor_kind: string };
    expect(attempt.lifecycle).toBe("pending");
    expect(attempt.executor_kind).toBe("pi");
  });
});

describe("WorkflowPorts #1804 planner vocabulary and alias compatibility", () => {
  function writePiConfigWithDefaultAlias(wsPath: string): void {
    mkdirSync(join(TEST_HOME, "config"), { recursive: true });
    mkdirSync(wsPath, { recursive: true });
    writeFileSync(
      join(TEST_HOME, "config", "pi-executor.json"),
      JSON.stringify({
        enabled: true,
        command: "fake-pi",
        workspaceAliases: { default: { path: wsPath } },
      }),
      "utf-8",
    );
  }

  function cleanupPiConfig(wsPath: string): void {
    try { rmSync(wsPath, { recursive: true, force: true }); } catch {}
    try { rmSync(join(TEST_HOME, "config", "pi-executor.json"), { force: true }); } catch {}
  }

  it("separates the model vocabulary from runner compatibility with a configured default alias", () => {
    const wsPath = join(tmpdir(), `wf-1804-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writePiConfigWithDefaultAlias(wsPath);
    try {
      const compat = Ports.workflowCapabilities();
      expect(compat).toContain("general");
      expect(compat).toContain("pi-coding");
      expect(compat).toContain("pi");
      expect(compat).toContain("default");
      const vocab = Ports.plannerCapabilities();
      expect(vocab).toEqual(["general", "pi-coding", "pi"]);
      expect(vocab).not.toContain("default");
      expect(Ports.isPlannerCapability("general")).toBe(true);
      expect(Ports.isPlannerCapability("default")).toBe(false);
      // Runner compatibility still routes the stored alias to Pi.
      expect(Ports.isPiCapability("default")).toBe(true);
      expect(Ports.isPiCapability("general")).toBe(false);
      expect(Ports.resolvePiWorkspaceAlias("default")).toBe("default");
      expect(Ports.resolvePiWorkspaceAlias("pi-coding")).toBe("default");
    } finally {
      cleanupPiConfig(wsPath);
    }
  });

  it("rejects a bare alias proposal through correction and admits the general correction without silent rewrite", async () => {
    const store = new StoreType();
    const runner = new RunnerType(store, ["general", "pi-coding", "pi", "default"]);
    const res = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES (?, 'agent', 'O', 'running')`)
      .run(`wf-1804-${Date.now()}`);
    const card = Number(res.lastInsertRowid);
    copSeq++;
    const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `port-1804-${copSeq}` }).run;
    const prompts: string[] = [];
    let calls = 0;
    const backend = new Ports.SpinPlannerBackend({
      runner,
      callModel: async (prompt: string) => {
        prompts.push(prompt);
        calls++;
        if (calls === 1) {
          return JSON.stringify({
            nodes: [
              { label: "a", kind: "work", instructions: "research", capability: "default", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
            ],
            requiredOutputs: ["o"],
          });
        }
        return JSON.stringify({
          nodes: [
            { label: "a", kind: "work", instructions: "research", capability: "general", outputs: ["o"], acceptance: ["done"], dependsOn: [] },
          ],
          requiredOutputs: ["o"],
        });
      },
    });
    store.queueCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0, payloadJson: "{}" });
    store.claimCommand({ runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0 }, "spin-planner");
    backend.startPlanning({
      runId: run.runId, generation: 1, nodeId: "__plan__", action: "plan" as const, ordinal: 0,
      status: "claimed" as const, payloadJson: "{}",
      createdAt: "", claimedAt: "", doneAt: null, owner: "spin-planner", claimToken: "t",
      inspectGen: 0, consecutiveInconclusive: 0, nextInspectionAt: null,
    }, {
      runId: run.runId, revision: null, purpose: "initial", defects: [],
      requiredOutputs: ["o"], nodeId: "__plan__",
    });
    await new Promise((r) => setTimeout(r, 80));
    // The alias entered correction (two model turns) and the general
    // correction was admitted — never a silent rewrite inside one turn.
    expect(calls).toBe(2);
    expect(store.currentRevision(run.runId)).toBe(1);
    expect(prompts[0]).toContain("(one of: general, pi-coding, pi)");
    expect(prompts[0]).toContain("Never emit a bare workspace alias");
    expect(prompts[1]).toMatch(/unsupported planner capability default/);
    const proposal = JSON.parse(store.getPlanJson(run.runId, 1)) as Proposal;
    expect(proposal.nodes[0]?.capability).toBe("general");
  });

  it("keeps explicit alias admission compatible and routes durable contracts without Spin fallback", () => {
    const wsPath = join(tmpdir(), `wf-1804-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writePiConfigWithDefaultAlias(wsPath);
    try {
      const store = new StoreType();
      const runner = new RunnerType(store, Ports.workflowCapabilities());
      const res = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES (?, 'agent', 'O', 'running')`)
        .run(`wf-1804-route-${Date.now()}`);
      const card = Number(res.lastInsertRowid);
      copSeq++;
      const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `port-1804-r-${copSeq}` }).run;
      // Explicit programmatic alias admission stays compatible (not a model proposal).
      const acc = runner.acceptPlan(run.runId, {
        requiredOutputs: ["o1", "o2"],
        nodes: [
          { label: "a", kind: "work", instructions: "code it", capability: "default", outputs: ["o1"], acceptance: ["done"], dependsOn: [] },
          { label: "b", kind: "work", instructions: "collect it", capability: "general", outputs: ["o2"], acceptance: ["done"], dependsOn: [] },
        ],
      });
      const routing = new Ports.RoutingWorkflowWorkerPort({ runner });
      const dispatchNode = (nodeId: string): { attemptId: string; contract: WorkerAcceptanceContractV1; executorKind: string } => {
        const claimed = store.claimCommand(
          { runId: run.runId, generation: 1, nodeId, action: "dispatch", ordinal: 0 }, "workflow-worker-routing",
        );
        expect(claimed).not.toBeNull();
        routing.dispatch(claimed!.row);
        const node = store.listNodes(run.runId, 1).find((n) => n["node_id"] === nodeId);
        expect(Number(node?.["worker_card_id"])).toBeGreaterThan(0);
        const attemptId = node?.["attempt_id"] as string;
        const attempt = store.db.prepare(`SELECT contract_id, executor_kind FROM worker_attempts WHERE id = ?`)
          .get(attemptId) as { contract_id: string; executor_kind: string };
        const contractRow = store.db.prepare(`SELECT contract_json FROM worker_contracts WHERE id = ?`)
          .get(attempt.contract_id) as { contract_json: string };
        return {
          attemptId,
          contract: JSON.parse(contractRow.contract_json) as WorkerAcceptanceContractV1,
          executorKind: attempt.executor_kind,
        };
      };

      // The explicit alias contract carries its workspace and selects Pi;
      // a general node carries no alias and selects Spin — no fallback.
      const alias = dispatchNode(acc.nodeIds[0] as string);
      expect(alias.executorKind).toBe("pi");
      expect(alias.contract.workspace_alias).toBe("default");
      expect(resolveWorkerExecutorIntent(alias.contract)).toMatchObject({ kind: "pi", workspaceAlias: "default" });

      const general = dispatchNode(acc.nodeIds[1] as string);
      expect(general.executorKind).toBe("agent");
      expect(general.contract.workspace_alias).toBeUndefined();
      expect(resolveWorkerExecutorIntent(general.contract)).toMatchObject({ kind: "agent", id: "spin-local" });
    } finally {
      cleanupPiConfig(wsPath);
    }
  });
});
