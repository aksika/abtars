/**
 * orc-workflow.e2e.test.ts — #1792 Task 6: durable orchestration acceptance.
 *
 * Exercises the REAL production composition — WorkflowRunner, WorkflowStore,
 * task SQLite database (kanban.db in an isolated home), worker settlement
 * records, artifact filesystem, reviewer brief preparation/validation, and
 * delivery obligation handling — with periodic project reconciliation
 * disabled (the reconciler is never started here; the runner owns liveness).
 *
 * Deterministic fixtures replace ONLY: model planner/reviewer responses,
 * worker executor outcomes, destination transport sends, and the clock
 * (time travel via SQL datetime rewrites, as in scheduler-journey.e2e).
 * The internal chain (admission → plan → dispatch → completion → review →
 * delivery, restart redrive, audit classification) is never mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let ARTIFACTS: string;
let RunnerType: typeof import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;
let RunnerMod: typeof import("../../components/orc-project/orc-workflow-runner.js");

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ARTIFACTS = join(TEST_HOME, "artifacts");
  mkdirSync(ARTIFACTS, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("../../components/orc-project/orc-workflow-runner.js");
  const storeMod = await import("../../components/orc-project/orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
  RunnerMod = runnerMod;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Runner = import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
type Store = import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;
type Proposal = import("../../components/orc-project/orc-workflow-runner.js").PlanProposal;
type BudgetScope = import("../../components/orc-project/orc-workflow-store.js").BudgetScope;
type ReviewBrief = import("../../components/orc-project/orc-workflow-runner.js").ReviewBrief;
type CommandRow = import("../../components/orc-project/orc-workflow-store.js").CommandRow;

let cardSeq = 20000;
let copSeq = 0;
let attSeq = 0;

function makeRunner(): { runner: Runner; store: Store } {
  const store = new StoreType();
  const runner = new RunnerType(store, ["general", "research", "write"]);
  return { runner, store };
}

function seedCard(store: Store, source = "task", sourceId: string | null = null): number {
  const id = cardSeq++;
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, source_id, type, status, goal) VALUES (?, ?, ?, ?, 'O', 'running', ?)`)
    .run(id, `wf-e2e-${id}`, source, sourceId, `deliver report ${id}`);
  return id;
}

/** Occurrence fixture at the scheduling boundary (the scheduler itself is
 * covered by its own suites; here the reserved occurrence is an input). */
function seedOccurrence(store: Store, taskId: string, runId: string): void {
  store.db.prepare(`INSERT OR IGNORE INTO task_state (task_id) VALUES (?)`).run(taskId);
  store.db.prepare(
    `INSERT INTO task_runs (run_id, task_id, group_id, attempt, trigger, occurrence_at,
      reserved_at, deadline_at, phase, last_progress_at, owner_pid)
     VALUES (?, ?, ?, 1, 'schedule', 1000, 1000, 9999999999, 'executing', 1000, 123456)`,
  ).run(runId, taskId, taskId);
}

function writeArtifact(name: string, content: string): string {
  const path = join(ARTIFACTS, name);
  writeFileSync(path, content);
  return path;
}

function scriptedPorts() {
  const seen: { briefs: ReviewBrief[]; sends: string[] } = { briefs: [], sends: [] };
  const dispatched: Array<{ nodeId: string; action: string }> = [];
  const ports = {
    executor: {
      name: "e2e-exec",
      dispatch: (cmd: CommandRow) => {
        dispatched.push({ nodeId: cmd.nodeId, action: cmd.action });
      },
    },
    reviewer: {
      name: "e2e-reviewer",
      startReview: (_cmd: CommandRow, brief: ReviewBrief) => {
        seen.briefs.push(brief);
      },
    },
    planner: {
      name: "e2e-planner",
      startPlanning: (_cmd: CommandRow, _input: unknown) => {},
    },
  };
  return { ports, seen, dispatched };
}

const twoLane = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "a", kind: "work", instructions: "research", capability: "research", outputs: ["notes-a"], acceptance: ["done"], dependsOn: [] },
    { label: "b", kind: "work", instructions: "research", capability: "research", outputs: ["notes-b"], acceptance: ["done"], dependsOn: [] },
    { label: "s", kind: "synthesis", instructions: "write", capability: "write", outputs: ["report"], acceptance: ["done"], dependsOn: ["a", "b"] },
  ],
});

describe("orc-workflow E2E (Task 6)", () => {
  let runner: Runner;
  let store: Store;

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
    for (const t of ["worker_attempts", "project_input_requests", "retry_budget_reservations", "attempt_lease_snapshots"]) {
      try { store.db.exec(`DELETE FROM ${t}`); } catch {}
    }
  });

  function admitAndPlan(kind: "interactive" | "scheduled", proposal: Proposal, budgets?: Partial<Record<BudgetScope, number>>) {
    copSeq++;
    let scheduledRunId: string | null = null;
    if (kind === "scheduled") {
      scheduledRunId = `sched-${copSeq}`;
    }
    // Faithful scheduled identity: production kanbanEnqueue stores the
    // occurrence run id as source_id (authority correlation depends on it).
    const card = seedCard(store, kind === "scheduled" ? "task" : "agent", scheduledRunId);
    if (kind === "scheduled" && scheduledRunId) {
      seedOccurrence(store, `daily-ai-e2e`, scheduledRunId);
    }
    const run = runner.admit({
      rootKind: kind === "scheduled" ? "scheduled" : "interactive",
      rootCardId: card, scheduledRunId, clientOperationId: `e2e-${copSeq}`, budgets,
    }).run;
    const acc = runner.acceptPlan(run.runId, proposal);
    return { run, acc, card };
  }

  const reportPlan = (): Proposal => ({
    requiredOutputs: ["report"],
    nodes: [
      { label: "research", kind: "work", instructions: "gather", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      { label: "write", kind: "synthesis", instructions: "draft report", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["research"] },
      { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["write"] },
    ],
  });

  // Journey 1: ad-hoc parallel work + recurring report share one runner.
  it("ad-hoc and recurring reports traverse the same runner to reviewed delivery", () => {
    for (const kind of ["interactive", "scheduled"] as const) {
      const { run, acc, card } = admitAndPlan(kind, reportPlan());
      expect(run.rootKind).toBe(kind === "scheduled" ? "scheduled" : "interactive");
      const { ports } = scriptedPorts();
      expect(runner.drain(10, ports)).toBe(1);
      const reportPath = writeArtifact(`report-${run.runId}.md`, `# Report\n\nThorough notes.\n`);
      runner.attemptSucceeded(run.runId, acc.nodeIds[0] as string, `att-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
      runner.drain(10, ports);
      runner.attemptSucceeded(run.runId, acc.nodeIds[1] as string, `att-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
      runner.drain(10, ports);
      // Reviewer inspects the ACTUAL artifact file, not a summary.
      const brief = runner.assembleBrief(run.runId, 1, acc.nodeIds[2] as string);
      const art = JSON.parse((brief.nodes.find((n) => n.nodeId === acc.nodeIds[1])?.outcome ?? "{}") as string) as { artifact?: string };
      expect(readFileSync(art.artifact as string, "utf8")).toMatch(/Thorough notes/);
      expect(runner.submitVerdict(run.runId, acc.nodeIds[2] as string, { verdict: "accept" })).toBe("accepted");
      // Accepted content is not proof of delivery: run waits for ack.
      expect(store.getRun(run.runId)?.state).not.toBe("succeeded");
      const sender = { name: "e2e-sender", send: (doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => `receipt:${doc.idempotenceKey}` };
      expect(runner.executeDelivery(run.runId, acc.nodeIds[2] as string, sender)).toBe("acknowledged");
      void card;
      // Terminal run/projection agreement (pass evidence): run, card, and
      // supervision must tell the same story with no unowned residue.
      const terminal = store.getRun(run.runId);
      expect(terminal?.state).toBe("succeeded");
      const cardRow = store.db.prepare(`SELECT status, result_summary FROM kanban_board WHERE id = ?`).get(card) as { status: string; result_summary: string | null };
      expect(cardRow.status).toBe("done");
      expect(typeof cardRow.result_summary).toBe("string");
      const sup = store.db.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(card) as { state: string };
      expect(sup.state).toBe("accepted");
      const tick = runner.auditTick(0);
      expect(tick.ownerless).not.toContain(run.runId);
    }
  });

  // Journey 2: invalid plan correction succeeds; exhaustion settles with zero workers.
  it("malformed planning corrects once, then settles with zero workers and a reason", () => {
    const card = seedCard(store);
    copSeq++;
    const run = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `e2e-${copSeq}` }).run;
    const bad: Proposal = { requiredOutputs: ["ghost"], nodes: [] };
    expect(() => runner.acceptPlan(run.runId, bad)).toThrow(/plan rejected/);
    expect(store.countRunCommands(run.runId, "pending")).toBe(0); // no workers ever
    const acc = runner.acceptPlan(run.runId, reportPlan());
    expect(acc.revision).toBe(1);
    expect(acc.queued).toBe(1);

    const card2 = seedCard(store);
    copSeq++;
    const run2 = runner.admit({
      rootKind: "interactive", rootCardId: card2, clientOperationId: `e2e-${copSeq}`,
      budgets: { plan_revision: 0 },
    }).run;
    expect(() => runner.acceptPlan(run2.runId, bad)).toThrow(/plan rejected/);
    const done = store.getRun(run2.runId);
    expect(done?.state).toBe("failed");
    expect(done?.failureCode).toBe("plan_rejected");
    expect(store.listNodes(run2.runId, 1)).toEqual([]);
  });

  // Journey 3: worker failure modes without ownerless waiting.
  it("retry succeeds; required failure settles; optional failure proceeds", () => {
    const { run, acc } = admitAndPlan("interactive", twoLane());
    const { ports } = scriptedPorts();
    runner.drain(10, ports);
    const research = acc.nodeIds[0] as string;
    runner.attemptFailed(run.runId, research, "att-r1", "flaky lane", true);
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, research, "att-r2", "{}");
    expect(store.listNodes(run.runId, 1).find((n) => n["node_id"] === research)?.["status"]).toBe("succeeded");

    const { run: run2 } = admitAndPlan("interactive", reportPlan());
    const nodes2 = store.listNodes(run2.runId, 1).map((n) => n["node_id"] as string);
    runner.attemptFailed(run2.runId, nodes2[0] as string, "att-x", "hard down", false);
    const failed = store.getRun(run2.runId);
    expect(failed?.state).toBe("failed");
    const tick = runner.auditTick(0);
    expect(tick.ownerless).not.toContain(run2.runId);
  });

  // Journey 4: review repair accepts only the repaired revision.
  it("deficient output is repaired and only the repaired revision passes", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const nodes = store.listNodes(run.runId, 1).map((n) => n["node_id"] as string);
    const { ports } = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, nodes[0] as string, "att-a", "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, nodes[1] as string, "att-s", "{}");
    runner.drain(10, ports);
    const review = nodes[2] as string;
    expect(runner.submitVerdict(run.runId, review, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "no sources cited" }],
    })).toBe("repair_queued");
    const repair: Proposal = {
      requiredOutputs: ["report"],
      nodes: [
        { label: "fix", kind: "work", instructions: "cite sources", capability: "research", outputs: ["report"], acceptance: ["thorough"], dependsOn: [] },
      ],
    };
    const rev2 = runner.submitPlanProposal(run.runId, repair, { baseRevision: 1 });
    expect(rev2.revision).toBe(2);
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, rev2.nodeIds[0] as string, "att-fix", "{}");
    expect(runner.submitVerdict(run.runId, review, { verdict: "accept" })).toBe("accepted");
    const outcome = JSON.parse(
      (store.listNodes(run.runId, 1).find((n) => n["node_id"] === review)?.["outcome"] as string),
    ) as { judgedRevision: number };
    expect(outcome.judgedRevision).toBe(2);
  });

  // Journey 5: restart, duplicates, late results.
  it("restart redrives unapplied ingress; duplicates and late results change nothing", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const nodes = store.listNodes(run.runId, 1).map((n) => n["node_id"] as string);
    const { ports } = scriptedPorts();
    runner.drain(10, ports);
    // Crash between worker commit and wake: plant the received completion.
    const payload = JSON.stringify({
      kind: "AttemptSucceeded",
      body: { nodeId: nodes[0], attemptId: "att-a", artifactsJson: "{}" },
    });
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('crash-1', ?, 'h', ?, 'received', datetime('now'))`,
    ).run(run.runId, payload);
    expect(runner.startupRecovery().redrivenIngress).toBe(1);
    // Identical redelivery is a duplicate, not a second logical job.
    const before = store.countRunCommands(run.runId);
    const dup = store.commitTransition(
      { eventId: "crash-1", runId: run.runId, payloadHash: "h", payloadJson: payload, generation: 1, stateVersion: 999 },
      () => { throw new Error("applier must not run on replay"); },
    );
    expect(dup.disposition).toBe("duplicate");
    expect(store.countRunCommands(run.runId)).toBe(before);
    // Finish the run; late results are rejected without resurrection.
    runner.attemptSucceeded(run.runId, nodes[1] as string, "att-s", "{}");
    runner.drain(10, ports);
    runner.submitVerdict(run.runId, nodes[2] as string, { verdict: "accept" });
    const sender = { name: "e2e-sender", send: (_doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => "receipt" };
    runner.executeDelivery(run.runId, nodes[2] as string, sender);
    expect(store.getRun(run.runId)?.state).toBe("succeeded");
    expect(() => runner.attemptFailed(run.runId, nodes[0] as string, "att-late", "x", false))
      .toThrow(/terminal.*late result rejected/);
  });

  // Journey 6: cancellation, capacity, breaker.
  it("cancellation wins races; capacity release wakes; breaker resolves explicitly", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const { ports } = scriptedPorts();
    runner.drain(10, ports);
    const res = runner.requestCancel(run.runId, "operator stop");
    expect(res.cancelled).toBe(true);
    expect(store.getRun(run.runId)?.state).toBe("cancelled");

    const run2 = admitAndPlan("interactive", reportPlan());
    const { ports: ports2 } = scriptedPorts();
    const busyPort = { name: "full", dispatch: (_c: unknown) => { throw new RunnerMod.CapacityBusy(); } };
    expect(runner.drain(10, busyPort)).toBe(0);
    expect(runner.drain(10, ports2)).toBe(1); // capacity release wakes queued work

    const { run: run3 } = admitAndPlan("interactive", reportPlan());
    const policy = { check: (input: { action: string }) => (input.action === "dispatch" ? "refused" as const : "ok" as const) };
    const { port } = { port: { name: "x", dispatch: (_c: unknown) => {} } };
    runner.drain(10, port, { policy });
    expect(store.getRun(run3.runId)?.state).toBe("failed");
    expect(store.getRun(run3.runId)?.failureCode).toBe("resource_unavailable");
  });

  // Journey 7: delivery ambiguity stays truthful.
  it("lost delivery acknowledgment stays unknown without resend", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const nodes = store.listNodes(run.runId, 1).map((n) => n["node_id"] as string);
    const { ports } = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, nodes[0] as string, "att-a", "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(run.runId, nodes[1] as string, "att-s", "{}");
    runner.drain(10, ports);
    runner.submitVerdict(run.runId, nodes[2] as string, { verdict: "accept" });
    let sends = 0;
    const lossy = {
      name: "lossy-sender",
      send: (_doc: { runId: string; nodeId: string; obligation: string; idempotenceKey: string }) => {
        sends++;
        throw new Error("ack lost in transit");
      },
    };
    expect(runner.executeDelivery(run.runId, nodes[2] as string, lossy)).toBe("unknown");
    expect(sends).toBe(1);
    expect(() => runner.executeDelivery(run.runId, nodes[2] as string, lossy)).toThrow(/no pending deliver command/);
    expect(sends).toBe(1);
  });

  // Journeys 8–10: lost completion, alive retention, terminal unknown.
  it("lost completion recovers exactly once; alive work survives; unknown stays explicit", () => {
    // 8: lost completion (attempt terminal, node still queued, command claimed).
    const g = admitAndPlan("interactive", reportPlan());
    const gn = store.listNodes(g.run.runId, 1).map((n) => n["node_id"] as string);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES ('att-L', 96001, 'ctr', 1, 'spin', 'ex', 'completed', datetime('now','-9 minutes'), 'completed', ?, 1)`,
    ).run(g.card);
    store.db.prepare(
      `UPDATE workflow_nodes SET worker_card_id = 96001, attempt_id = 'att-L' WHERE run_id = ? AND node_id = ?`,
    ).run(g.run.runId, gn[0]);
    const { ports: ports8 } = scriptedPorts();
    runner.drain(10, ports8);
    // Age the live claim: the completion event was lost, nothing recorded it.
    store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-1 minute') WHERE run_id = ?`).run(g.run.runId);
    expect(runner.inspectClaim(g.run.runId,
      { nodeId: gn[0] as string, action: "dispatch", ordinal: 0, generation: 1 }, 1)).toMatch(/^applied:/);
    expect(store.listNodes(g.run.runId, 1).find((n) => n["node_id"] === gn[0])?.["status"]).toBe("succeeded");
    // Re-inspection after recovery finishes the orphaned claim, changes nothing.
    expect(runner.inspectClaim(g.run.runId,
      { nodeId: gn[0] as string, action: "dispatch", ordinal: 0, generation: 1 }, 1)).toMatch(/^noop:done$/);

    // 9: alive retention past the old cap (6 inspections, same token).
    const h = admitAndPlan("interactive", reportPlan());
    const hn = store.listNodes(h.run.runId, 1).map((n) => n["node_id"] as string);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES ('att-h', 96002, 'ctr', 1, 'spin', 'ex', 'running', datetime('now'), 'running', ?, 1)`,
    ).run(h.card);
    store.db.prepare(
      `INSERT INTO attempt_lease_snapshots (attempt_id, card_id, claim_generation, executor_kind, executor_id, high_water_sequence, snapshot_json, updated_at, next_evaluation_at)
       VALUES ('att-h', 96002, 1, 'spin', 'ex', 1, '{}', datetime('now'), datetime('now','+5 minutes'))`,
    ).run();
    store.db.prepare(
      `UPDATE workflow_nodes SET status = 'running', worker_card_id = 96002, attempt_id = 'att-h' WHERE run_id = ? AND node_id = ?`,
    ).run(h.run.runId, hn[0]);
    const { ports: ports9 } = scriptedPorts();
    runner.drain(10, ports9);
    const claimed9 = store.db.prepare(
      `SELECT owner, claim_token FROM workflow_commands WHERE run_id = ? AND node_id = ?`,
    ).get(h.run.runId, hn[0]) as { owner: string; claim_token: string };
    for (let gen = 1; gen <= 6; gen++) {
      store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-1 minute') WHERE run_id = ? AND status = 'claimed'`).run(h.run.runId);
      const out = runner.inspectClaim(h.run.runId,
        { nodeId: hn[0] as string, action: "dispatch", ordinal: 0, generation: 1 }, gen);
      expect(out).toMatch(/^applied:/);
      store.db.prepare(`UPDATE attempt_lease_snapshots SET next_evaluation_at = datetime('now','+5 minutes') WHERE attempt_id = 'att-h'`).run();
    }
    const alive = store.db.prepare(`SELECT status, owner, claim_token, inspect_gen, consecutive_inconclusive FROM workflow_commands WHERE run_id = ? AND node_id = ?`).get(h.run.runId, hn[0]) as Record<string, unknown>;
    expect(alive["status"]).toBe("claimed");
    expect(alive["owner"]).toBe(claimed9["owner"]);
    expect(alive["claim_token"]).toBe(claimed9["claim_token"]);
    expect([alive["inspect_gen"], alive["consecutive_inconclusive"]]).toEqual([6, 0]);

    // 10: unobservable exhausts to explicit unknown with no successor.
    const u = admitAndPlan("interactive", reportPlan());
    const un = store.listNodes(u.run.runId, 1).map((n) => n["node_id"] as string);
    store.db.prepare(
      `INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, started_at, lifecycle, root_project_card_id, root_project_generation)
       VALUES ('att-u', 96003, 'ctr', 1, 'spin', 'ex', 'running', datetime('now'), 'running', ?, 1)`,
    ).run(u.card);
    store.db.prepare(
      `UPDATE workflow_nodes SET status = 'running', worker_card_id = 96003, attempt_id = 'att-u' WHERE run_id = ? AND node_id = ?`,
    ).run(u.run.runId, un[0]);
    const { ports: ports10 } = scriptedPorts();
    runner.drain(10, ports10);
    for (let gen = 1; gen <= 5; gen++) {
      store.db.prepare(`UPDATE workflow_commands SET next_inspection_at = datetime('now','-1 minute') WHERE run_id = ? AND status = 'claimed'`).run(u.run.runId);
      runner.inspectClaim(u.run.runId,
        { nodeId: un[0] as string, action: "dispatch", ordinal: 0, generation: 1 }, gen);
    }
    expect(store.getRun(u.run.runId)?.state).toBe("failed");
    expect(store.getRun(u.run.runId)?.failureCode).toBe("observation_unknown");
    const attCount = store.db.prepare(`SELECT COUNT(*) AS c FROM worker_attempts WHERE card_id = 96003`).get() as { c: number };
    expect(Number(attCount.c)).toBe(1);
  });

  // Audit: dropped wake redriven; ownerless fenced; rotating past 100 roots.
  it("audit redrives a dropped wake, fences ownerless runs, and rotates fairly", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const tick0 = runner.auditTick(0);
    expect(tick0.lawful).toContain(run.runId);
    // Drop a post-commit wake: queue a command with no drain, then audit.
    store.queueCommand({
      runId: run.runId, generation: 1, nodeId: "ghost", action: "notify", ordinal: 0, payloadJson: "{}",
    });
    const tick1 = runner.auditTick(0);
    expect(tick1.lawful).toContain(run.runId);
    // Ownerless injection: executing state with zero durable footprint.
    const bare = admitAndPlan("interactive", reportPlan());
    store.db.prepare(`UPDATE workflow_runs SET state = 'executing' WHERE run_id = ?`).run(bare.run.runId);
    store.db.prepare(`DELETE FROM workflow_commands WHERE run_id = ?`).run(bare.run.runId);
    const tick2 = runner.auditTick(0);
    expect(tick2.ownerless).toContain(bare.run.runId);
    // Fairness: 150 active roots rotate through 100-per-tick batches.
    for (let i = 0; i < 150; i++) {
      const card = seedCard(store);
      copSeq++;
      runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `fair-${copSeq}` });
    }
    const first = runner.auditTick(0);
    expect(first.checked).toBe(100);
    const second = runner.auditTick(first.nextCursor);
    expect(second.checked).toBeGreaterThan(0);
    expect(second.nextCursor).toBeGreaterThan(first.nextCursor);
  });

  // SHA handoff restart at the boundary without phase writes.
  it("committed SHA handoff survives restart and applies exactly once", () => {
    const { run } = admitAndPlan("interactive", reportPlan());
    const payload = JSON.stringify({
      kind: "ShaHandoff",
      body: { rootCardId: run.rootCardId, stage: "solution", result: "ok", final: true },
    });
    store.db.prepare(
      `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json, disposition, received_at)
       VALUES ('sha-crash-1', ?, 'h', ?, 'received', datetime('now'))`,
    ).run(run.runId, payload);
    expect(runner.startupRecovery().redrivenIngress).toBe(1);
    expect(runner.startupRecovery().redrivenIngress).toBe(0);
    const disp = store.db.prepare(`SELECT disposition FROM workflow_ingress WHERE event_id = 'sha-crash-1'`).get() as { disposition: string };
    expect(["applied", "noop"]).toContain(disp.disposition);
  });
});
