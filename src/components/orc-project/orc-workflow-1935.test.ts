/**
 * #1935 acceptance regressions: owned model jobs, live inspection and the
 * startup interruption barrier. These exercise the real runner/store/backends
 * with only the external model boundary replaced.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let PortsMod: typeof import("./orc-workflow-ports.js");
let JobsMod: typeof import("./orc-workflow-model-jobs.js");
let StartupMod: typeof import("./orc-workflow-startup.js");
let DriverMod: typeof import("./orc-workflow-driver.js");
let RunnerMod: typeof import("./orc-workflow-runner.js");

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-1935-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  RunnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  PortsMod = await import("./orc-workflow-ports.js");
  JobsMod = await import("./orc-workflow-model-jobs.js");
  StartupMod = await import("./orc-workflow-startup.js");
  DriverMod = await import("./orc-workflow-driver.js");
  RunnerType = RunnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch { /* test residue */ }
  }
});

type Runner = import("./orc-workflow-runner.js").WorkflowRunner;
type Store = import("./orc-workflow-store.js").WorkflowStore;
type Claim = import("./orc-workflow-model-jobs.js").ClaimAuthority;

let runner: Runner;
let store: Store;
let cardSeq = 90_000;
let copSeq = 0;

const plan = (): import("./orc-workflow-runner.js").PlanProposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "a", kind: "work", instructions: "do", capability: "general", outputs: ["report"], acceptance: ["done"], dependsOn: [] },
    { label: "r", kind: "review", instructions: "judge", capability: "general", outputs: [], acceptance: [], dependsOn: ["a"] },
  ],
});

function seedCard(target: Store = store): number {
  const id = cardSeq++;
  target.db.prepare(`INSERT INTO kanban_board (id, title, source, type, status) VALUES (?, ?, 'task', 'O', 'running')`).run(id, `wf-1935-${id}`);
  return id;
}

function admitInitial(targetRunner: Runner, targetStore: Store) {
  copSeq++;
  const card = seedCard(targetStore);
  const admitted = targetRunner.admitSupervised({ rootCardId: card, source: "interactive" });
  if (admitted.kind === "conflict") throw new Error(admitted.reason);
  const runId = admitted.runId as string;
  return { runId, card, run: targetRunner.store.getRun(runId)! };
}

function commandOf(claim: Claim): import("./orc-workflow-store.js").CommandRow {
  const cmd = store.getCommand(claim.key);
  if (!cmd) throw new Error(`command missing for ${claim.key.runId}/${claim.key.nodeId}`);
  return cmd;
}

function claimJob(targetStore: Store, runId: string, nodeId: string, action: "plan" | "review"): Claim {
  const pending = targetStore.findPendingCommand(runId, nodeId, action);
  if (!pending) throw new Error(`no pending ${action} command for ${runId}/${nodeId}`);
  const claimed = targetStore.claimCommand({
    runId, generation: pending.generation, nodeId, action, ordinal: pending.ordinal,
  }, action === "plan" ? "spin-planner" : "spin-reviewer");
  if (!claimed) throw new Error(`claim lost for ${runId}/${nodeId}`);
  return {
    key: { runId, generation: pending.generation, nodeId, action, ordinal: pending.ordinal },
    owner: action === "plan" ? "spin-planner" : "spin-reviewer",
    token: claimed.token,
  };
}

beforeEach(() => {
  ({ runner, store } = (() => {
    const s = new StoreType();
    return { runner: new RunnerType(s, ["general", "research", "write"]), store: s };
  })());
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
      context TEXT, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, answered_at TEXT, response_text TEXT
    );
  `);
  for (const t of ["workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets", "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations", "workflow_runs"]) {
    store.db.exec(`DELETE FROM ${t}`);
  }
});

describe("#1935 owned model jobs", () => {
  it("initial ownerless planning fails observation_unknown and closes the actual operation", () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    const outcome = runner.submitModelJobInspection(runId, claim.token, 1, "ownerless");
    expect(outcome).toBe("ownerless:applied");
    const run = store.getRun(runId);
    expect(run?.state).toBe("failed");
    expect(run?.failureCode).toBe("observation_unknown");
    expect(run?.failureReason).toContain("execution ownership");
    const cmd = store.getCommand(claim.key);
    expect(cmd?.status).toBe("cancelled");
    const op = store.db.prepare(`SELECT status FROM workflow_operations WHERE run_id = ? AND kind = 'planning'`).get(runId) as { status: string };
    expect(op.status).toBe("failed");
    // Never the empty-admitted-plan classification.
    expect(run?.failureCode).not.toBe("no_workers");
    // Duplicate inspection is inert and consumes nothing.
    expect(runner.submitModelJobInspection(runId, claim.token, 1, "ownerless")).toBe("terminal:noop");
    expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
  });

  it("expired initial planning fails observation_unknown without a blind retry", () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    expect(runner.submitModelJobInspection(runId, claim.token, 1, "expired")).toBe("expired:applied");
    const run = store.getRun(runId);
    expect(run?.state).toBe("failed");
    expect(run?.failureCode).toBe("observation_unknown");
    expect(run?.failureReason).toContain("termination unconfirmed");
    expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
    expect(store.getCommand(claim.key)?.status).toBe("cancelled");
    // No retry round is published on unconfirmed termination.
    expect(store.findPendingCommand(runId, "__plan__", "plan")).toBeNull();
    // The same inspection generation cannot spend a second allowance.
    expect(runner.submitModelJobInspection(runId, claim.token, 1, "expired")).toBe("terminal:noop");
  });

  it("active planning ownership extends its claim without counting", () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    expect(runner.submitModelJobInspection(runId, claim.token, 1, "active")).toBe("active:extended");
    const cmd = store.getCommand(claim.key);
    expect(cmd?.status).toBe("claimed");
    expect(cmd?.inspectGen).toBe(1);
    expect(cmd?.consecutiveInconclusive).toBe(0);
    expect(store.getRun(runId)?.state).toBe("admitted");
  });

  it("stale claim authority cannot admit a revision or consume an allowance", () => {
    const { runId } = admitInitial(runner, store);
    const stale = claimJob(store, runId, "__plan__", "plan");
    // Successor round: the original claim is superseded and re-claimed.
    store.supersedeCommand(stale.key);
    store.queueCommand({
      runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 1,
      payloadJson: JSON.stringify({ nodeId: "__plan__", revision: null, purpose: "initial", defects: [], opId: `op-${runId}-initial-plan` }),
    });
    expect(() => runner.submitPlanProposal(runId, plan(), {
      claim: stale, baseRevision: 0,
      planRound: { nodeId: "__plan__", ordinal: 0, payloadJson: "{}" },
    })).toThrow(/stale model-job claim/);
    expect(store.currentRevision(runId)).toBe(0);
    expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
    expect(store.getRun(runId)?.state).toBe("admitted");
  });

  it("duplicate proposal handoff cannot admit a second revision", () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    const accepted = runner.submitPlanProposal(runId, plan(), { claim, baseRevision: 0 });
    expect(accepted.revision).toBe(1);
    expect(store.getCommand(claim.key)?.status).toBe("done");
    expect(() => runner.submitPlanProposal(runId, plan(), { claim, baseRevision: 0 })).toThrow(/stale model-job claim/);
    expect(store.currentRevision(runId)).toBe(1);
  });

  it("stale reviewer verdict cannot affect a successor review round", () => {
    const { runId } = admitInitial(runner, store);
    const initial = claimJob(store, runId, "__plan__", "plan");
    runner.submitPlanProposal(runId, plan(), { claim: initial, baseRevision: 0 });
    // Work succeeds and queues the host review; claim it once.
    const work = store.listNodes(runId, 1).find((n) => n["kind"] === "work")!["node_id"] as string;
    runner.attemptSucceeded(runId, work, "att-1", "{}");
    const review = store.listNodes(runId, 1).find((n) => n["kind"] === "review")!["node_id"] as string;
    const verdictClaim = claimJob(store, runId, review, "review");
    expect(runner.submitVerdict(runId, review, { verdict: "accept" }, { claim: verdictClaim })).toBe("accepted");
    const deliveries = store.db.prepare(`SELECT COUNT(*) AS n FROM workflow_commands WHERE run_id = ? AND action = 'deliver'`).get(runId) as { n: number };
    expect(Number(deliveries.n)).toBe(1);
    // Replaying the same verdict is inert: no second delivery obligation.
    expect(() => runner.submitVerdict(runId, review, { verdict: "accept" }, { claim: verdictClaim })).toThrow(/stale model-job claim/);
    const after = store.db.prepare(`SELECT COUNT(*) AS n FROM workflow_commands WHERE run_id = ? AND action = 'deliver'`).get(runId) as { n: number };
    expect(Number(after.n)).toBe(1);
  });
});

describe("#1935 startup interruption barrier", () => {
  function addActiveState(runId: string, state: string): void {
    store.db.prepare(`UPDATE workflow_runs SET state = ? WHERE run_id = ?`).run(state, runId);
    let pending = store.findPendingCommand(runId, "__plan__", "plan");
    if (!pending) {
      store.queueCommand({
        runId, generation: 1, nodeId: "__plan__", action: "plan", ordinal: 0,
        payloadJson: JSON.stringify({ nodeId: "__plan__", revision: null, purpose: "initial", defects: [] }),
      });
      pending = store.findPendingCommand(runId, "__plan__", "plan");
    }
    if (!pending) throw new Error("planning command missing");
    const claimed = store.claimCommand({
      runId, generation: pending.generation, nodeId: "__plan__", action: "plan", ordinal: pending.ordinal,
    }, "spin-planner");
    if (!claimed) throw new Error("claim failed");
    store.upsertOperation({ opId: `op-${runId}-initial-plan`, runId, kind: "planning", status: "running" });
    const card = store.getRun(runId)!.rootCardId;
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES (?, ?, 'ctr', 1, 'agent', 'spin-local', 'running', datetime('now'), 'running', ?, 1)`,
    ).run(`att-${runId}`, card + 10_000, card);
    store.insertDelivery(runId, "__deliver__", JSON.stringify({ revision: 1 }));
  }

  it("fails every pre-generation nonterminal state and preserves new admissions", () => {
    const admitted = admitInitial(runner, store).runId;
    const planning = admitInitial(runner, store).runId;
    addActiveState(planning, "planning");
    const dispatched = admitInitial(runner, store).runId;
    addActiveState(dispatched, "dispatched");
    const awaiting = admitInitial(runner, store).runId;
    runner.requestInput(awaiting, "which output?", ["report"]);
    addActiveState(awaiting, "awaiting_input");
    const delivering = admitInitial(runner, store).runId;
    addActiveState(delivering, "delivering");

    const watermark = StartupMod.readWorkflowRowWatermark(store.db);
    // Ingress admitted during boot, after the generation cutoff, is not old work.
    const duringBoot = admitInitial(runner, store).runId;

    const interrupted = StartupMod.failInterruptedWorkflows(store.db, watermark);
    expect(interrupted).toBe(5);
    for (const id of [admitted, planning, dispatched, awaiting, delivering]) {
      const run = store.getRun(id);
      expect(run?.state).toBe("failed");
      expect(run?.failureCode).toBe("observation_unknown");
      expect(run?.failureReason).toBe(RunnerMod.INTERRUPTED_BY_RESTART);
      expect(store.readBudgets(id)["plan_revision"].consumed).toBe(0);
      const pending = store.db.prepare(`SELECT COUNT(*) AS n FROM workflow_commands WHERE run_id = ? AND status IN ('pending','claimed')`).get(id) as { n: number };
      expect(Number(pending.n)).toBe(0);
      const openNodes = store.db.prepare(`SELECT COUNT(*) AS n FROM workflow_nodes WHERE run_id = ? AND status IN ('queued','running')`).get(id) as { n: number };
      expect(Number(openNodes.n)).toBe(0);
      const openOps = store.db.prepare(`SELECT COUNT(*) AS n FROM workflow_operations WHERE run_id = ? AND status IN ('pending','claimed','running')`).get(id) as { n: number };
      expect(Number(openOps.n)).toBe(0);
    }
    const fenced = store.db.prepare(`SELECT COUNT(*) AS n FROM worker_attempts WHERE root_project_card_id = ? AND lifecycle = 'cancel_requested'`)
      .get(store.getRun(planning)!.rootCardId) as { n: number };
    expect(Number(fenced.n)).toBe(1);
    const delivery = store.getDelivery(planning, "__deliver__");
    expect(delivery?.["outcome"]).toBe("unknown");
    const input = store.db.prepare(`SELECT status FROM project_input_requests WHERE project_card_id = ?`).get(store.getRun(awaiting)!.rootCardId) as { status: string };
    expect(input.status).toBe("expired");
    expect(store.getRun(duringBoot)?.state).not.toBe("failed");
    // Idempotent: no second pass, no rewritten terminal fact.
    expect(StartupMod.failInterruptedWorkflows(store.db, watermark)).toBe(0);
  });

  it("converges after a partial-cleanup crash", () => {
    const first = admitInitial(runner, store).runId;
    const second = admitInitial(runner, store).runId;
    const watermark = StartupMod.readWorkflowRowWatermark(store.db);
    // Simulate a crash after one workflow committed but before the pass ended.
    expect(runner.interruptRun(first)).toBe(true);
    expect(StartupMod.failInterruptedWorkflows(store.db, watermark)).toBe(1);
    expect(store.getRun(first)?.state).toBe("failed");
    expect(store.getRun(second)?.state).toBe("failed");
    expect(StartupMod.failInterruptedWorkflows(store.db, watermark)).toBe(0);
  });

  it("in-process driver replacement leaves old work to the barrier and never retries", async () => {
    let resolveModel: ((text: string) => void) | undefined;
    const driver1 = DriverMod.startWorkflowDriver({
      callModel: () => new Promise<string>((resolve) => { resolveModel = resolve; }),
    });
    let driver2: ReturnType<typeof DriverMod.startWorkflowDriver> | null = null;
    try {
      const card = seedCard(driver1.runner.store);
      const admitted = driver1.runner.admitSupervised({ rootCardId: card, source: "interactive" });
      const runId = admitted.runId as string;
      expect(driver1.drainWake("boot")).toBe(1);
      expect(driver1.modelJobs.size).toBe(1);
      const watermark = StartupMod.readWorkflowRowWatermark(driver1.runner.store.db);
      // Generation replacement: shutdown aborts the call without settling the
      // run; the startup barrier owns the interrupted terminal fact.
      driver1.stop();
      expect(StartupMod.failInterruptedWorkflows(driver1.runner.store.db, watermark)).toBe(1);
      driver2 = DriverMod.startWorkflowDriver({ callModel: async () => "{}" });
      expect(driver2.auditOnce(0).ownerless).not.toContain(runId);
      resolveModel?.(JSON.stringify(plan()));
      await new Promise((r) => setTimeout(r, 30));
      const run = driver1.runner.store.getRun(runId);
      expect(run?.state).toBe("failed");
      expect(run?.failureReason).toBe(RunnerMod.INTERRUPTED_BY_RESTART);
      expect(driver1.runner.store.currentRevision(runId)).toBe(0);
      expect(driver1.runner.store.findPendingCommand(runId, "__plan__", "plan")).toBeNull();
      expect(driver1.runner.store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
    } finally {
      driver2?.stop();
      driver1.stop();
    }
  });

  it("does not replay committed terminal receipts or deliveries", () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    runner.submitPlanProposal(runId, plan(), { claim, baseRevision: 0 });
    const work = store.listNodes(runId, 1).find((n) => n["kind"] === "work")!["node_id"] as string;
    runner.attemptSucceeded(runId, work, "att-1", "{}");
    const review = store.listNodes(runId, 1).find((n) => n["kind"] === "review")!["node_id"] as string;
    const verdict = claimJob(store, runId, review, "review");
    runner.submitVerdict(runId, review, { verdict: "accept" }, { claim: verdict });
    const sender = { name: "s", send: () => JSON.stringify({ receipt: "kept" }) };
    expect(runner.executeDelivery(runId, review, sender)).toBe("acknowledged");
    const receipt = store.getDelivery(runId, review)?.["receipt_json"];
    const watermark = StartupMod.readWorkflowRowWatermark(store.db);
    expect(StartupMod.failInterruptedWorkflows(store.db, watermark)).toBe(0);
    expect(store.getRun(runId)?.state).toBe("succeeded");
    expect(store.getDelivery(runId, review)?.["receipt_json"]).toBe(receipt);
  });
});

describe("#1935 generation-owned model call lifetimes", () => {
  it("registry classifies, aborts and settles exactly once", () => {
    const registry = new JobsMod.ModelJobRegistry();
    const claim: Claim = {
      key: { runId: "wf_x", generation: 1, nodeId: "n", action: "plan", ordinal: 0 },
      owner: "spin-planner", token: "tok-1",
    };
    const job = registry.begin({ claim, kind: "planning", opId: "op", revision: null, timeoutMs: 60_000 });
    expect(registry.classify("tok-1", job.deadlineAt - 1)).toBe("active");
    expect(registry.classify("tok-1", job.deadlineAt)).toBe("expired");
    expect(registry.classify("tok-missing")).toBe("ownerless");
    expect(registry.claimSettlement("tok-1")).toBe(true);
    expect(registry.claimSettlement("tok-1")).toBe(false);
    expect(registry.classify("tok-1")).toBe("ownerless");
    expect(registry.abortRun("wf_x")).toBe(0);
    registry.finish("tok-1");
    expect(registry.size).toBe(0);
  });

  it("call entry deadline fails a non-settling planning call as observation_unknown", async () => {
    vi.useFakeTimers();
    try {
      const { runId } = admitInitial(runner, store);
      const claim = claimJob(store, runId, "__plan__", "plan");
      const registry = new JobsMod.ModelJobRegistry();
      const backend = new PortsMod.SpinPlannerBackend({
        runner, modelJobs: registry,
        callModel: () => new Promise<string>(() => { /* never settles */ }),
      });
      backend.startPlanning(commandOf(claim), {
        runId, revision: null, purpose: "initial", defects: [], requiredOutputs: [], nodeId: "__plan__",
        opId: `op-${runId}-initial-plan`,
      }, claim);
      expect(registry.size).toBe(1);
      await vi.advanceTimersByTimeAsync(300_001);
      expect(registry.size).toBe(0);
      const run = store.getRun(runId);
      expect(run?.state).toBe("failed");
      expect(run?.failureCode).toBe("observation_unknown");
      expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
      expect(store.getCommand(claim.key)?.status).toBe("cancelled");
      expect(store.findPendingCommand(runId, "__plan__", "plan")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("planner rejection settles its own claim and leaves no running operation", async () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    store.upsertOperation({ opId: `op-${runId}-initial-plan`, runId, kind: "planning", status: "running" });
    const registry = new JobsMod.ModelJobRegistry();
    const backend = new PortsMod.SpinPlannerBackend({
      runner, modelJobs: registry,
      callModel: async () => { throw new Error("provider rejected"); },
    });
    backend.startPlanning(commandOf(claim), {
      runId, revision: null, purpose: "initial", defects: [], requiredOutputs: [], nodeId: "__plan__",
      opId: `op-${runId}-initial-plan`,
    }, claim);
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.size).toBe(0);
    expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(1);
    expect(store.getCommand(claim.key)?.status).toBe("cancelled");
    const op = store.db.prepare(`SELECT status FROM workflow_operations WHERE run_id = ? AND kind = 'planning'`).get(runId) as { status: string };
    expect(op.status).not.toBe("running");
  });

  it("reviewer execution failure resolves through cannot_assess", async () => {
    const { runId } = admitInitial(runner, store);
    const initial = claimJob(store, runId, "__plan__", "plan");
    runner.submitPlanProposal(runId, plan(), { claim: initial, baseRevision: 0 });
    const work = store.listNodes(runId, 1).find((n) => n["kind"] === "work")!["node_id"] as string;
    runner.attemptSucceeded(runId, work, "att-1", "{}");
    const review = store.listNodes(runId, 1).find((n) => n["kind"] === "review")!["node_id"] as string;
    const claim = claimJob(store, runId, review, "review");
    store.upsertOperation({ opId: `op-${runId}-r1-${review}`, runId, kind: "review", revision: 1, status: "running" });
    const registry = new JobsMod.ModelJobRegistry();
    const backend = new PortsMod.SpinReviewerBackend({
      runner, modelJobs: registry,
      callModel: async () => { throw new Error("provider rejected"); },
    });
    backend.startReview(commandOf(claim), runner.assembleBrief(runId, 1, review), claim);
    await new Promise((r) => setTimeout(r, 30));
    expect(registry.size).toBe(0);
    expect(store.getCommand(claim.key)?.status).toBe("done");
    const node = store.listNodes(runId, 1).find((n) => n["node_id"] === review);
    expect(node?.["status"]).toBe("failed");
    expect(store.getRun(runId)?.state).toBe("failed");
  });

  it("a late model result cannot publish after interruption settled the claim", async () => {
    const { runId } = admitInitial(runner, store);
    const claim = claimJob(store, runId, "__plan__", "plan");
    let resolveModel: ((text: string) => void) | undefined;
    const registry = new JobsMod.ModelJobRegistry();
    const backend = new PortsMod.SpinPlannerBackend({
      runner, modelJobs: registry,
      callModel: () => new Promise<string>((resolve) => { resolveModel = resolve; }),
    });
    backend.startPlanning(commandOf(claim), {
      runId, revision: null, purpose: "initial", defects: [], requiredOutputs: [], nodeId: "__plan__",
      opId: `op-${runId}-initial-plan`,
    }, claim);
    const watermark = StartupMod.readWorkflowRowWatermark(store.db);
    expect(StartupMod.failInterruptedWorkflows(store.db, watermark)).toBe(1);
    registry.abortAll(JobsMod.MODEL_JOB_SHUTDOWN_REASON);
    resolveModel?.(JSON.stringify(plan()));
    await new Promise((r) => setTimeout(r, 30));
    expect(store.getRun(runId)?.state).toBe("failed");
    expect(store.currentRevision(runId)).toBe(0);
    expect(runner.recoverUnconsumedCompletions(10)).toBe(0);
    expect(store.readBudgets(runId)["plan_revision"].consumed).toBe(0);
    expect(registry.size).toBe(0);
  });
});
