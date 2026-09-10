/**
 * swarm-acceptance.integration.test.ts — #1792 runner-composition acceptance.
 *
 * Disposition (design.md "Test disposition"): the end-user journeys are ported
 * to real runner composition, preserving cancellation, input, repair, artifact
 * and settlement assertions. Deleted vs the old suite (all pins of the retired
 * chain — the reconciler never dispatches and the coordinator schedule path is
 * gone):
 * - reconciler requestReconcile triggers + Spin dispatch counts (all Scenario A
 *   dispatch assertions become drain-claim assertions);
 * - coordinator scheduleContractAuthoring/scheduleProjectExecution/scheduleReview
 *   claims (coverage rounds, review claims, [COVERAGE GAP] dispatches);
 * - coverage_rounds/coverage_uncovered_ids supervision assertions (replaced by
 *   the runner's explicit optional/allowPartial policy);
 * - ReviewCaseAssembler snapshot-shape assertions where the reconciler owned
 *   the trigger (kept only for the peer-contribution inclusion journey, with
 *   the supervision transition seeded directly);
 * - review_project/get_project_review_case Orc-tool envelopes (getOrcTools()
 *   is now empty — verdicts go through runner.submitVerdict, reads through
 *   runner.assembleBrief);
 * - "Known gaps:" synthesis-string assertions (the review-service renderer
 *   path is retired — evidence preservation is asserted on run/node rows);
 * - acceptance-outbox mechanics on the receiver side (covered by
 *   peer-roundtrip; here the reducer ledger truths are kept).
 *
 * Composition mirrors orc-workflow.e2e (green): real WorkflowRunner/
 * WorkflowStore/task DB over a mocked home; only model planning/review turns,
 * worker execution, destination transport, and the clock are scripted.
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

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `swarm-accept-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  ARTIFACTS = join(TEST_HOME, "artifacts");
  mkdirSync(ARTIFACTS, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("../../components/orc-project/orc-workflow-runner.js");
  const storeMod = await import("../../components/orc-project/orc-workflow-store.js");
  RunnerType = runnerMod.WorkflowRunner;
  StoreType = storeMod.WorkflowStore;
});

afterAll(() => {
  if (existsSync(TEST_HOME)) {
    try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
  }
});

type Runner = import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
type Store = import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;
type Proposal = import("../../components/orc-project/orc-workflow-runner.js").PlanProposal;
type ReviewBrief = import("../../components/orc-project/orc-workflow-runner.js").ReviewBrief;

const WIPED = [
  "workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets",
  "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations",
  "workflow_runs", "kanban_board", "kanban_card_transitions", "project_supervision",
  "project_contracts", "project_review_cases", "project_review_decisions",
  "project_review_requests", "project_acceptance_outbox", "project_input_requests",
  "peer_contributions", "peer_contribution_events", "peer_help_requests",
  "worker_attempts", "worker_contracts", "worker_results",
  "attempt_lease_snapshots", "retry_budget_reservations",
];

let cardSeq = 100;
let attSeq = 0;

function makeRunner(): { runner: Runner; store: Store } {
  const store = new StoreType();
  const runner = new RunnerType(store, ["general", "research", "write"]);
  return { runner, store };
}

function wipe(store: Store): void {
  for (const t of WIPED) {
    try { store.db.exec(`DELETE FROM ${t}`); } catch {}
  }
}

function seedCard(store: Store, title: string): number {
  const id = cardSeq++;
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, type, status, goal) VALUES (?, ?, 'agent', 'O', 'running', ?)`)
    .run(id, title, `goal for ${title}`);
  return id;
}

function admit(runner: Runner, card: number, source = "agent"): string {
  const admitted = runner.admitSupervised({ rootCardId: card, source });
  expect(admitted.kind).not.toBe("conflict");
  return admitted.runId as string;
}

function scriptedPorts(dispatched?: string[], briefs?: ReviewBrief[]) {
  return {
    executor: {
      name: "swarm-exec",
      dispatch: (cmd: { nodeId: string }) => { dispatched?.push(cmd.nodeId); },
    },
    reviewer: {
      name: "swarm-reviewer",
      startReview: (_cmd: unknown, brief: ReviewBrief) => { briefs?.push(brief); },
    },
    planner: {
      name: "swarm-planner",
      startPlanning: (_cmd: unknown, _input: unknown) => {},
    },
  };
}

function ackSender() {
  return { name: "swarm-sender", send: (doc: { idempotenceKey: string }) => `receipt:${doc.idempotenceKey}` };
}

/** Three research lanes + sole-writer synthesis + review (Scenario A shape). */
const trioPlan = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "lane-1", kind: "work", instructions: "research 1", capability: "research", outputs: ["notes-1"], acceptance: ["thorough"], dependsOn: [] },
    { label: "lane-2", kind: "work", instructions: "research 2", capability: "research", outputs: ["notes-2"], acceptance: ["thorough"], dependsOn: [] },
    { label: "lane-3", kind: "work", instructions: "research 3", capability: "research", outputs: ["notes-3"], acceptance: ["thorough"], dependsOn: [] },
    { label: "writer", kind: "synthesis", instructions: "meld lanes", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["lane-1", "lane-2", "lane-3"] },
    { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
  ],
});

const reportPlan = (): Proposal => ({
  requiredOutputs: ["report"],
  nodes: [
    { label: "research", kind: "work", instructions: "gather", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
    { label: "write", kind: "synthesis", instructions: "draft report", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["research"] },
    { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["write"] },
  ],
});

describe("Swarm acceptance — Scenario A: three parallel workers (#927)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    wipe(store);
  });

  it("three work nodes dispatch concurrently in one drain", () => {
    const runId = admit(runner, seedCard(store, "three worker project"));
    const acc = runner.acceptPlan(runId, trioPlan());
    const dispatched: string[] = [];
    runner.drain(10, scriptedPorts(dispatched));
    // All three lanes claimed at once; the writer waits on its dependencies.
    expect([acc.nodeIds[0], acc.nodeIds[1], acc.nodeIds[2]].every((n) => dispatched.includes(n as string))).toBe(true);
    expect(dispatched).not.toContain(acc.nodeIds[3]);
    expect(new Set(dispatched.filter((d) => (acc.nodeIds as string[]).slice(0, 3).includes(d))).size).toBe(3);
  });

  it("W=3 concurrency: one drain claims all three, the next claims nothing new", () => {
    const runId = admit(runner, seedCard(store, "concurrency project"));
    const acc = runner.acceptPlan(runId, trioPlan());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    expect(runner.drain(10, ports)).toBeGreaterThanOrEqual(3);
    const lanes = dispatched.filter((d) => (acc.nodeIds as string[]).slice(0, 3).includes(d));
    expect(lanes).toHaveLength(3);
    // Not sequential: nothing is left to claim on a second pass.
    expect(runner.drain(10, ports)).toBe(0);
    expect(dispatched.filter((d) => (acc.nodeIds as string[]).slice(0, 3).includes(d))).toHaveLength(3);
  });

  it("all-terminal lanes trigger exactly one review turn carrying every node outcome", () => {
    const runId = admit(runner, seedCard(store, "review trigger project"));
    const acc = runner.acceptPlan(runId, trioPlan());
    const briefs: ReviewBrief[] = [];
    const ports = scriptedPorts([], briefs);
    runner.drain(10, ports);
    for (let i = 0; i < 3; i++) {
      runner.attemptSucceeded(runId, acc.nodeIds[i] as string, `att-a3-${attSeq++}`, "{}");
    }
    const reportPath = join(ARTIFACTS, `swarm-a3-${runId}.md`);
    writeFileSync(reportPath, "# Report\n\nThorough notes.\n");
    runner.attemptSucceeded(runId, acc.nodeIds[3] as string, `att-a3-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
    runner.drain(10, ports);

    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.nodes).toHaveLength(5);
    const writerOutcome = JSON.parse(
      (briefs[0]!.nodes.find((n) => n.nodeId === acc.nodeIds[3])?.outcome ?? "{}") as string,
    ) as { artifact?: string };
    expect(writerOutcome.artifact).toBe(reportPath);
    expect(readFileSync(writerOutcome.artifact as string, "utf8")).toMatch(/Thorough notes/);

    expect(runner.submitVerdict(runId, acc.nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
  });

  it("duplicate completion changes nothing (exactly-once)", () => {
    const runId = admit(runner, seedCard(store, "exactly once project"));
    const acc = runner.acceptPlan(runId, trioPlan());
    runner.drain(10, scriptedPorts());
    const before = store.countRunCommands(runId);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-dup", "{}");
    expect(() => runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-dup", "{}"))
      .toThrow(/conflicts with completion/);
    expect(store.countRunCommands(runId)).toBe(before);
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[0])?.["status"]).toBe("succeeded");
  });

  it("full lifecycle: run succeeds, card settles done, replay changes nothing", () => {
    const card = seedCard(store, "full lifecycle project");
    const runId = admit(runner, card);
    const acc = runner.acceptPlan(runId, trioPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    for (let i = 0; i < 3; i++) {
      runner.attemptSucceeded(runId, acc.nodeIds[i] as string, `att-a5-${attSeq++}`, "{}");
    }
    runner.drain(10, ports);
    const reportPath = join(ARTIFACTS, `swarm-a5-${runId}.md`);
    writeFileSync(reportPath, "# Report\n\nAll three workers completed.\n");
    runner.attemptSucceeded(runId, acc.nodeIds[3] as string, `att-a5-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
    runner.drain(10, ports);
    expect(runner.submitVerdict(runId, acc.nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, acc.nodeIds[4] as string, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");

    const cardRow = store.db.prepare(`SELECT status, result_summary FROM kanban_board WHERE id = ?`).get(card) as { status: string; result_summary: string | null };
    expect(cardRow.status).toBe("done");
    expect(cardRow.result_summary).toContain("succeeded");

    // Replay stability: recovery redrives nothing, late results are rejected,
    // and the terminal projection still agrees with the run.
    expect(runner.startupRecovery().redrivenIngress).toBe(0);
    expect(() => runner.attemptFailed(runId, acc.nodeIds[0] as string, "att-late", "x", false))
      .toThrow(/terminal.*late result rejected/);
    expect(store.getRun(runId)?.state).toBe("succeeded");
    expect(runner.auditTick(0).ownerless).not.toContain(runId);
  });

  it("#1626: stale retry markers do not survive acceptance", () => {
    const card = seedCard(store, "stale retry project");
    const runId = admit(runner, card);
    const acc = runner.acceptPlan(runId, reportPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-a6-${attSeq++}`, "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-a6-${attSeq++}`, "{}");
    runner.drain(10, ports);

    // Production-observed stale shape (#1389): the card sits queued with a
    // stale execution error and a future retry marker while durable review
    // state is live.
    const future = new Date(Date.now() + 60_000).toISOString().replace(/Z$/, "").replace("T", " ").slice(0, 19);
    store.db.prepare(`UPDATE kanban_board SET status = 'queued', error = 'stale failed-turn', next_retry_at = ?, retry_count = 2 WHERE id = ?`)
      .run(future, card);

    expect(runner.submitVerdict(runId, acc.nodeIds[2] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, acc.nodeIds[2] as string, ackSender())).toBe("acknowledged");

    // Terminal projection: done with a bounded synthesis and a completion
    // stamp — the stale queued state is gone.
    const row = store.db.prepare(`SELECT status, result_summary, completed_at FROM kanban_board WHERE id = ?`).get(card) as { status: string; result_summary: string | null; completed_at: string | null };
    expect(row.status).toBe("done");
    expect(row.result_summary).toContain("succeeded");
    expect(row.completed_at).toBeTruthy();
    expect(store.getRun(runId)?.state).toBe("succeeded");
  });
});

describe("Swarm acceptance — partial-evidence policy (#1604)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    wipe(store);
  });

  const gapPlan = (): Proposal => ({
    requiredOutputs: ["report"],
    nodes: [
      { label: "core", kind: "work", instructions: "core research", capability: "research", outputs: ["notes"], acceptance: ["thorough"], dependsOn: [] },
      { label: "extra", kind: "work", instructions: "optional scrape", capability: "research", outputs: ["scrape"], acceptance: ["fresh"], dependsOn: [], optional: true },
      { label: "writer", kind: "synthesis", instructions: "meld into report", capability: "write", outputs: ["report"], acceptance: ["complete"], dependsOn: ["core", "extra"] },
      { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
    ],
  });

  it("optional failure resolves once and the run stays executing and spawn-eligible", () => {
    const runId = admit(runner, seedCard(store, "gap project"));
    const acc = runner.acceptPlan(runId, gapPlan());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    runner.drain(10, ports);
    runner.attemptFailed(runId, acc.nodeIds[1] as string, `att-c1-${attSeq++}`, "source down", false);
    // Not failed: the optional failure released its dependents explicitly.
    expect(store.getRun(runId)?.state).not.toBe("failed");
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[1])?.["status"]).toBe("failed");
    // Exactly one dispatch ever for the optional node — no second round.
    expect(dispatched.filter((d) => d === acc.nodeIds[1])).toHaveLength(1);
    // Still spawn-eligible: the required lane and writer proceed normally.
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-c1-${attSeq++}`, "{}");
    runner.drain(10, ports);
    expect(dispatched).toContain(acc.nodeIds[2]);
  });

  it("duplicate failure ingress changes nothing (tight loop)", () => {
    const runId = admit(runner, seedCard(store, "tight loop project"));
    const acc = runner.acceptPlan(runId, gapPlan());
    runner.drain(10, scriptedPorts());
    runner.attemptFailed(runId, acc.nodeIds[1] as string, "att-tight", "source down", false);
    const before = store.countRunCommands(runId);
    expect(() => runner.attemptFailed(runId, acc.nodeIds[1] as string, "att-tight", "source down", false))
      .toThrow(/conflicts with completion/);
    expect(store.countRunCommands(runId)).toBe(before);
    expect(store.getRun(runId)?.state).not.toBe("failed");
  });

  it("an unhealed optional gap still reaches review and accepts", () => {
    const runId = admit(runner, seedCard(store, "grace project"));
    const acc = runner.acceptPlan(runId, gapPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptFailed(runId, acc.nodeIds[1] as string, `att-c3-${attSeq++}`, "source down", false);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-c3-${attSeq++}`, "{}");
    runner.drain(10, ports);
    const reportPath = join(ARTIFACTS, `swarm-c3-${runId}.md`);
    writeFileSync(reportPath, "# Report\n\nCore only.\n");
    runner.attemptSucceeded(runId, acc.nodeIds[2] as string, `att-c3-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
    runner.drain(10, ports);
    // The gap is review evidence, not a gate: review opens and accepts.
    expect(runner.submitVerdict(runId, acc.nodeIds[3] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, acc.nodeIds[3] as string, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");
    // The optional failure stays recorded — never hidden by the accept.
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[1])?.["status"]).toBe("failed");
  });

  it("required retry success proceeds to normal review", () => {
    const runId = admit(runner, seedCard(store, "retry project"));
    const acc = runner.acceptPlan(runId, gapPlan());
    const dispatched: string[] = [];
    const ports = scriptedPorts(dispatched);
    runner.drain(10, ports);
    // The required lane is retry-safe: failure re-queues instead of settling.
    runner.attemptFailed(runId, acc.nodeIds[0] as string, "att-flaky", "flaky lane", true);
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[0])?.["status"]).toBe("running");
    runner.drain(10, ports);
    expect(dispatched.filter((d) => d === acc.nodeIds[0])).toHaveLength(2);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, "att-retry-ok", "{}");
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[0])?.["status"]).toBe("succeeded");
    // Normal review follows once the gap is closed.
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-c4-${attSeq++}`, "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[2] as string, `att-c4-${attSeq++}`, "{}");
    runner.drain(10, ports);
    expect(runner.submitVerdict(runId, acc.nodeIds[3] as string, { verdict: "accept" })).toBe("accepted");
  });

  it("exhausted repair allowance fails explicitly instead of looping", () => {
    const card = seedCard(store, "allowance project");
    const admitted = runner.admit({ rootKind: "interactive", rootCardId: card, clientOperationId: `swarm-cap-${card}`, budgets: { review_repair: 0 } });
    const runId = admitted.run.runId;
    const acc = runner.acceptPlan(runId, reportPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-c5-${attSeq++}`, "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-c5-${attSeq++}`, "{}");
    runner.drain(10, ports);
    // The cap is a loop guard: defects with no allowance fail with their cause.
    expect(runner.submitVerdict(runId, acc.nodeIds[2] as string, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "no sources cited" }],
    })).toBe("failed");
    expect(store.getRun(runId)?.state).toBe("failed");
    expect(store.getRun(runId)?.failureReason).toMatch(/repair allowance exhausted/);
    expect(runner.auditTick(0).ownerless).not.toContain(runId);
  });

  it("duplicate admission claims exactly one run (CAS at the gate)", () => {
    const card = seedCard(store, "cas project");
    const first = runner.admitSupervised({ rootCardId: card, source: "agent" });
    const second = runner.admitSupervised({ rootCardId: card, source: "agent" });
    expect(first.kind).toBe("admitted");
    expect(second.kind).toBe("duplicate");
    expect(second.runId).toBe(first.runId);
    expect(store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE root_card_id = ?`).get(card) as { c: number }).toEqual({ c: 1 });
  });
});

describe("Swarm acceptance — writer contract shape (#1605)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    wipe(store);
  });

  /** Two required lanes + one optional lane + writer + review. */
  const shapePlan = (): Proposal => ({
    requiredOutputs: ["briefing"],
    nodes: [
      { label: "feeds", kind: "work", instructions: "feed research", capability: "research", outputs: ["feeds-notes"], acceptance: ["sourced"], dependsOn: [] },
      { label: "newsletters", kind: "work", instructions: "newsletter lane", capability: "research", outputs: ["news-notes"], acceptance: ["sourced"], dependsOn: [] },
      { label: "web", kind: "work", instructions: "web lane", capability: "research", outputs: ["web-notes"], acceptance: ["fresh"], dependsOn: [], optional: true },
      { label: "writer", kind: "synthesis", instructions: "meld briefing", capability: "write", outputs: ["briefing"], acceptance: ["complete"], dependsOn: ["feeds", "newsletters", "web"] },
      { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["writer"] },
    ],
  });

  function runShapeToReview(runner: Runner, runId: string): string[] {
    const acc = runner.acceptPlan(runId, shapePlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-p-${attSeq++}`, "{}");
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-p-${attSeq++}`, "{}");
    runner.attemptFailed(runId, acc.nodeIds[2] as string, `att-p-${attSeq++}`, "web lane down", false);
    runner.drain(10, ports);
    const reportPath = join(ARTIFACTS, `swarm-shape-${runId}.md`);
    writeFileSync(reportPath, "# Briefing\n\nRequired lanes melded.\n");
    runner.attemptSucceeded(runId, acc.nodeIds[3] as string, `att-p-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
    runner.drain(10, ports);
    return acc.nodeIds as string[];
  }

  it("reaches review with the failed optional lane in the brief and no extra planning", () => {
    const runId = admit(runner, seedCard(store, "shape project"));
    const nodeIds = runShapeToReview(runner, runId);
    const brief = runner.assembleBrief(runId, 1, nodeIds[4] as string);
    // The failed optional lane is durable evidence in the brief.
    const failed = brief.failures.map((f) => f.nodeId);
    expect(failed).toContain(nodeIds[2]);
    // No coverage turns, no repair waves: still on revision 1.
    expect(store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_plan_revisions WHERE run_id = ?`).get(runId) as { c: number }).toEqual({ c: 1 });
    expect(runner.submitVerdict(runId, nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
  });

  it("accepts with the failed optional lane preserved in run evidence", () => {
    const card = seedCard(store, "disclosure project");
    const runId = admit(runner, card);
    const nodeIds = runShapeToReview(runner, runId);
    expect(runner.submitVerdict(runId, nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, nodeIds[4] as string, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");
    // The optional gap stays recorded on the run — acceptance never rewrites it.
    expect(store.listNodes(runId, 1).find((n) => n["node_id"] === nodeIds[2])?.["status"]).toBe("failed");
    expect((store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(card) as { status: string }).status).toBe("done");
  });

  it("#1686: deficient output is repaired and only the repaired revision passes", () => {
    const runId = admit(runner, seedCard(store, "repair project"));
    const acc = runner.acceptPlan(runId, reportPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-r-${attSeq++}`, "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-r-${attSeq++}`, "{}");
    runner.drain(10, ports);
    expect(runner.submitVerdict(runId, acc.nodeIds[2] as string, {
      verdict: "changes_required", defects: [{ criterion: "thorough", detail: "no sources cited" }],
    })).toBe("repair_queued");
    const rev2 = runner.submitPlanProposal(runId, {
      requiredOutputs: ["report"],
      nodes: [
        { label: "fix", kind: "work", instructions: "cite sources", capability: "research", outputs: ["report"], acceptance: ["thorough"], dependsOn: [] },
      ],
    }, { baseRevision: 1 });
    expect(rev2.revision).toBe(2);
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, rev2.nodeIds[0] as string, `att-r-${attSeq++}`, "{}");
    expect(runner.submitVerdict(runId, acc.nodeIds[2] as string, { verdict: "accept" })).toBe("accepted");
    const outcome = JSON.parse(
      (store.listNodes(runId, 1).find((n) => n["node_id"] === acc.nodeIds[2])?.["outcome"] as string),
    ) as { judgedRevision: number };
    expect(outcome.judgedRevision).toBe(2);
  });

  it("#1686: required failure settles explicitly and acceptance cannot waive it", () => {
    const runId = admit(runner, seedCard(store, "required failure project"));
    const acc = runner.acceptPlan(runId, reportPlan());
    runner.drain(10, scriptedPorts());
    // The required lane exhausts with no retry allowance.
    runner.attemptFailed(runId, acc.nodeIds[0] as string, `att-req-${attSeq++}`, "feeds lane down", false);
    expect(store.getRun(runId)?.state).toBe("failed");
    expect(store.getRun(runId)?.failureCode).toBe("node_failed");
    // No waiver: verdicts on the terminal run are rejected loudly.
    expect(() => runner.submitVerdict(runId, acc.nodeIds[2] as string, { verdict: "accept" }))
      .toThrow(/terminal|no open review node/);
    // And malformed repair verdicts take the bounded correction path, never a
    // silent accept: unknown-criterion defects are corrected once, then fail.
    const runId2 = admit(runner, seedCard(store, "malformed verdict project"));
    const acc2 = runner.acceptPlan(runId2, reportPlan());
    const ports2 = scriptedPorts();
    runner.drain(10, ports2);
    runner.attemptSucceeded(runId2, acc2.nodeIds[0] as string, `att-mv-${attSeq++}`, "{}");
    runner.drain(10, ports2);
    runner.attemptSucceeded(runId2, acc2.nodeIds[1] as string, `att-mv-${attSeq++}`, "{}");
    runner.drain(10, ports2);
    expect(runner.submitVerdict(runId2, acc2.nodeIds[2] as string, {
      verdict: "changes_required", defects: [{ criterion: "nope", detail: "x" }],
    })).toBe("correction_queued");
    expect(runner.submitVerdict(runId2, acc2.nodeIds[2] as string, {
      verdict: "changes_required", defects: [{ criterion: "nope", detail: "x" }],
    })).toBe("failed");
  });
});

describe("Swarm acceptance — Scenario B: one remote contribution (#927)", () => {
  let runner: Runner;
  let store: Store;
  let ContributionStore: typeof import("../../components/peer-help/contribution-store.js").ContributionStore;
  let PeerHelpService: typeof import("../../components/peer-help/service.js").PeerHelpService;
  let ProjectReviewStore: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
  let hasLiveContributionForProject: typeof import("../../components/peer-help/contribution-store.js").hasLiveContributionForProject;

  beforeEach(async () => {
    ({ runner, store } = makeRunner());
    wipe(store);
    ContributionStore = (await import("../../components/peer-help/contribution-store.js")).ContributionStore;
    PeerHelpService = (await import("../../components/peer-help/service.js")).PeerHelpService;
    ProjectReviewStore = (await import("../../components/project-acceptance/project-review-store.js")).ProjectReviewStore;
    hasLiveContributionForProject = (await import("../../components/peer-help/contribution-store.js")).hasLiveContributionForProject;
  });

  function kanbanFns() {
    return {
      kanbanGetCard: (id: number) => store.db.prepare(`SELECT * FROM kanban_board WHERE id = ?`).get(id) as never ?? undefined,
      kanbanUpdate: (id: number, updates: Record<string, unknown>) => {
        const sets = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
        store.db.prepare(`UPDATE kanban_board SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), id);
      },
      kanbanComplete: (id: number, _result: string | null, summary: string) => {
        store.db.prepare(`UPDATE kanban_board SET status = 'done', result_summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(summary.slice(0, 4000), id);
      },
      kanbanFail: (id: number, error: string) => {
        store.db.prepare(`UPDATE kanban_board SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(error.slice(0, 1000), id);
      },
    };
  }

  function makeContributionStore() {
    return new ContributionStore(store.db as never, kanbanFns() as never);
  }

  function makeReducer(contributionStore: InstanceType<typeof ContributionStore>) {
    const svc = new PeerHelpService({} as never, () => []);
    svc.setContributionStore(contributionStore);
    return svc;
  }

  function createScenarioProject(): number {
    const card = seedCard(store, "remote contribution project");
    const reviewStore = new ProjectReviewStore();
    const rootContractId = `pc_${card}`;
    reviewStore.insertContract({
      schema_version: 1, id: rootContractId, project_card_id: card, digest: `d_${rootContractId}`,
      goal: "Contribution project",
      criteria: [{ id: "c1", description: "Remote contribution received and reviewed", required: true, evidence_expectation: "observed" }],
      required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
      constraints: [], limits: { max_tokens: 100000, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    reviewStore.stateTransition(card, ["awaiting_contract"], "executing");
    return card;
  }

  function makeContributionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = new Date().toISOString();
    return {
      version: 1,
      event_id: `evt_molty_completed_${Date.now()}_${attSeq++}`,
      sequence: 0,
      request_id: "req-scenario-b",
      contribution_ref: "help_molty_ref",
      kind: "completed",
      occurred_at: now,
      summary: "Molty completed the analysis",
      projection: {
        schema_version: 1,
        outcome: "completed",
        summary: "Molty completed the analysis",
        evidence: [{ id: "check_1", kind: "check", summary: "analysis ok", observed_by: "molty" }],
        artifacts: [{ name: "report.md", content_type: "text/markdown", size_bytes: 1024, ref: "report.md" }],
        provenance: { receiver_peer: "molty", receiver_project_ref: "proj_molty_1", acceptance_id: "accept_molty_1", accepted_at: now },
      },
      ...overrides,
    };
  }

  function setupContribution(projectId: number, contributionStore: InstanceType<typeof ContributionStore>): number {
    const result = contributionStore.reserveProxy({
      peer: "molty",
      requestId: "req-scenario-b",
      requestHash: "hash_scenario_b",
      projectCardId: projectId,
      title: "[help:molty] analysis",
      goal: "analyze data",
      priority: "MEDIUM",
      sourcePeer: "molty",
      notes: { peer: "molty", root_criteria: ["c1"], request_id: "req-scenario-b", outcome: "pending" },
    });
    expect(result.status).toBe("new");
    expect(result.proxyCardId).toBeGreaterThan(0);
    contributionStore.adoptContributionRef("molty", "req-scenario-b", "help_molty_ref");
    contributionStore.transitionToAccepted("molty", "req-scenario-b");
    return result.proxyCardId as number;
  }

  it("project-linked contribution is reserved with root_criteria and project_card_id", () => {
    const projectId = createScenarioProject();
    const contributionStore = makeContributionStore();
    const proxyCardId = setupContribution(projectId, contributionStore);

    const contrib = contributionStore.getContribution("molty", "req-scenario-b");
    expect(contrib).toBeDefined();
    expect(contrib!.project_card_id).toBe(projectId);
    expect(contrib!.state).toBe("accepted");
    expect(contrib!.root_criteria_json).toBe('["c1"]');

    const proxyCard = store.db.prepare(`SELECT * FROM kanban_board WHERE id = ?`).get(proxyCardId) as Record<string, unknown>;
    expect(proxyCard).toBeDefined();
    expect(proxyCard!["type"]).toBe("contribution");
    expect(proxyCard!["status"]).toBe("running");
    expect(proxyCard!["parent_id"]).toBe(projectId);
  });

  it("terminal event completes the proxy and the peer root admits a supervised run", async () => {
    const projectId = createScenarioProject();
    const contributionStore = makeContributionStore();
    setupContribution(projectId, contributionStore);
    const reducer = makeReducer(contributionStore);

    // While the contribution is live, the durable predicate owns the root.
    expect(hasLiveContributionForProject(store.db as never, projectId)).toBe(true);

    const event = makeContributionEvent();
    expect((await reducer.handleContributionEvent("molty", event)).ok).toBe(true);

    const contrib = contributionStore.getContribution("molty", "req-scenario-b");
    expect(contrib!.state).toBe("completed");
    expect(contrib!.projection_json).toBeTruthy();
    expect(Number((store.db.prepare(`SELECT COUNT(*) as cnt FROM peer_contribution_events WHERE peer = ? AND request_id = ?`).get("molty", "req-scenario-b") as { cnt: number }).cnt)).toBe(1);
    // The terminal event released the predicate.
    expect(hasLiveContributionForProject(store.db as never, projectId)).toBe(false);

    // #1792: the supervised peer root admits through the runner (peer
    // rootKind) instead of the retired coordinator claim.
    const admitted = runner.admitSupervised({ rootCardId: projectId, source: "peer", sourcePeer: "molty", sourceId: "req-scenario-b" });
    expect(admitted.kind).toBe("admitted");
    expect(admitted.rootKind).toBe("peer");
  });

  it("duplicate terminal event is idempotent and admits nothing more", async () => {
    const projectId = createScenarioProject();
    const contributionStore = makeContributionStore();
    setupContribution(projectId, contributionStore);
    const reducer = makeReducer(contributionStore);

    const event = makeContributionEvent();
    expect((await reducer.handleContributionEvent("molty", event)).ok).toBe(true);
    expect((await reducer.handleContributionEvent("molty", event)).ok).toBe(true);

    expect(Number((store.db.prepare(`SELECT COUNT(*) as cnt FROM peer_contribution_events WHERE peer = ? AND request_id = ?`).get("molty", "req-scenario-b") as { cnt: number }).cnt)).toBe(1);
    const ledger = contributionStore.getContribution("molty", "req-scenario-b");
    expect(ledger!.state).toBe("completed");
    // The duplicate event never starts supervision on its own.
    expect(store.findRunByCard(projectId)).toBeNull();
  });

  it("declined contribution fails the proxy cleanly and admits no run", () => {
    const projectId = createScenarioProject();
    const contributionStore = makeContributionStore();
    const result = contributionStore.reserveProxy({
      peer: "molty",
      requestId: "req-scenario-b-declined",
      requestHash: "hash_decline",
      projectCardId: projectId,
      title: "[help:molty] analysis",
      goal: "analyze data",
      priority: "MEDIUM",
      sourcePeer: "molty",
      notes: { peer: "molty", root_criteria: ["c1"], request_id: "req-scenario-b-declined", outcome: "pending" },
    });
    expect(result.status).toBe("new");
    contributionStore.transitionToNonStarted("molty", "req-scenario-b-declined", "declined");

    const contrib = contributionStore.getContribution("molty", "req-scenario-b-declined");
    expect(contrib!.state).toBe("declined");
    store.db.prepare(`UPDATE kanban_board SET status = 'failed' WHERE id = ?`).run(result.proxyCardId);
    expect((store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(result.proxyCardId) as { status: string }).status).toBe("failed");
    expect(store.findRunByCard(projectId)).toBeNull();
  });

  it("a second terminal event with a different id is a conflict, no mutation", async () => {
    const projectId = createScenarioProject();
    const contributionStore = makeContributionStore();
    setupContribution(projectId, contributionStore);
    const reducer = makeReducer(contributionStore);
    void projectId;

    const first = makeContributionEvent({ request_id: "req-conflict", contribution_ref: "help_conflict_ref" });
    contributionStore.reserveProxy({
      peer: "molty", requestId: "req-conflict", requestHash: "hash_conflict",
      projectCardId: projectId, title: "[help:molty] conflict", goal: "g", priority: "MEDIUM",
      sourcePeer: "molty", notes: { peer: "molty", root_criteria: ["c1"], request_id: "req-conflict", outcome: "pending" },
    });
    contributionStore.adoptContributionRef("molty", "req-conflict", "help_conflict_ref");
    contributionStore.transitionToAccepted("molty", "req-conflict");
    expect((await reducer.handleContributionEvent("molty", first)).ok).toBe(true);

    const conflicting = makeContributionEvent({
      request_id: "req-conflict", contribution_ref: "help_conflict_ref",
      event_id: "evt_conflict_different", summary: "different result",
      projection: {
        schema_version: 1, outcome: "completed", summary: "different result",
        evidence: [], artifacts: [],
        provenance: { receiver_peer: "molty", receiver_project_ref: "proj_molty_1", acceptance_id: "accept_conflict", accepted_at: new Date().toISOString() },
      },
    });
    expect((await reducer.handleContributionEvent("molty", conflicting)).ok).toBe(false);
    const ledgerAfter = contributionStore.getContribution("molty", "req-conflict");
    expect(ledgerAfter!.terminal_event_id).not.toContain("conflict");
    expect(Number((store.db.prepare(`SELECT COUNT(*) as cnt FROM peer_contribution_events WHERE peer = ? AND request_id = ?`).get("molty", "req-conflict") as { cnt: number }).cnt)).toBe(1);
  });
});

describe("Swarm acceptance — runner review journeys (#1620)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    ({ runner, store } = makeRunner());
    wipe(store);
  });

  it("Molty 54 shape: Orc-only root reads its brief and submits one typed accept", () => {
    const card = seedCard(store, "orc-only analysis");
    const runId = admit(runner, card);
    // Orc-owned work only: a synthesis node judged by a review node, no
    // delegated lanes and no coverage turns.
    const acc = runner.acceptPlan(runId, {
      requiredOutputs: ["analysis"],
      nodes: [
        { label: "synth", kind: "synthesis", instructions: "synthesize findings", capability: "write", outputs: ["analysis"], acceptance: ["sound", "gated"], dependsOn: [] },
        { label: "judge", kind: "review", instructions: "assess", capability: "general", outputs: [], acceptance: [], dependsOn: ["synth"] },
      ],
    });
    runner.drain(10, scriptedPorts());
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-e1-${attSeq++}`, "{}");
    runner.drain(10, scriptedPorts());

    // The Orc-equivalent reads the immutable brief first — no private SQL.
    const brief = runner.assembleBrief(runId, 1, acc.nodeIds[1] as string);
    expect(brief.runId).toBe(runId);
    expect(brief.requiredOutputs).toContain("analysis");
    expect(brief.nodes).toHaveLength(2);
    expect(brief.nodes.every((n) => n.status === "succeeded" || n.kind === "review")).toBe(true);

    expect(runner.submitVerdict(runId, acc.nodeIds[1] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, acc.nodeIds[1] as string, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");
    expect((store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(card) as { status: string }).status).toBe("done");
  });

  it("KP 24 shape: failed delegation blocks for the authored reason, never generic exhaustion", () => {
    const runId = admit(runner, seedCard(store, "requester analysis"));
    const acc = runner.acceptPlan(runId, reportPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[0] as string, `att-e2-${attSeq++}`, "{}");
    runner.drain(10, ports);
    runner.attemptSucceeded(runId, acc.nodeIds[1] as string, `att-e2-${attSeq++}`, "{}");
    runner.drain(10, ports);
    // The authored block reason travels with the verdict and settles the run —
    // a failed peer contribution is named, not folded into exhaustion.
    const reason = "peer_contribution_failed: waited for molty contribution for c2";
    expect(runner.submitVerdict(runId, acc.nodeIds[2] as string, { verdict: "cannot_assess", reason })).toBe("unassessable");
    expect(store.getRun(runId)?.state).toBe("failed");
    expect(store.getRun(runId)?.failureReason).toContain("peer_contribution_failed");
    expect(store.getRun(runId)?.failureReason).not.toContain("review_protocol_exhausted");
  });

  it("ordinary non-peer project settles through the same runner with no peer footprint", () => {
    const card = seedCard(store, "ordinary project");
    const runId = admit(runner, card);
    const run = store.getRun(runId);
    expect(run?.rootKind).toBe("interactive");
    const acc = runner.acceptPlan(runId, trioPlan());
    const ports = scriptedPorts();
    runner.drain(10, ports);
    for (let i = 0; i < 3; i++) {
      runner.attemptSucceeded(runId, acc.nodeIds[i] as string, `att-e3-${attSeq++}`, "{}");
    }
    runner.drain(10, ports);
    const reportPath = join(ARTIFACTS, `swarm-e3-${runId}.md`);
    writeFileSync(reportPath, "# Report\n\nAll workers completed.\n");
    runner.attemptSucceeded(runId, acc.nodeIds[3] as string, `att-e3-${attSeq++}`, JSON.stringify({ artifact: reportPath }));
    runner.drain(10, ports);
    expect(runner.submitVerdict(runId, acc.nodeIds[4] as string, { verdict: "accept" })).toBe("accepted");
    expect(runner.executeDelivery(runId, acc.nodeIds[4] as string, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");
    expect((store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(card) as { status: string }).status).toBe("done");
    // No peer footprint anywhere on this run.
    expect(store.db.prepare(`SELECT COUNT(*) AS c FROM workflow_runs WHERE run_id = ? AND root_kind = 'peer'`).get(runId) as { c: number }).toEqual({ c: 0 });
  });
});
