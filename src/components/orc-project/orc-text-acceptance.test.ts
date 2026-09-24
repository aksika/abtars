import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let RunnerType: typeof import("./orc-workflow-runner.js").WorkflowRunner;
let StoreType: typeof import("./orc-workflow-store.js").WorkflowStore;
let Ports: typeof import("./orc-workflow-ports.js");
let WorkerSvc: typeof import("../worker-supervision-service.js").WorkerSupervisionService;
let WorkerStoreType: typeof import("../worker-supervision-store.js").WorkerSupervisionStore;
let ReviewStoreType: typeof import("../project-acceptance/project-review-store.js").ProjectReviewStore;

beforeAll(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `wf-text-1844-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const runnerMod = await import("./orc-workflow-runner.js");
  const storeMod = await import("./orc-workflow-store.js");
  Ports = await import("./orc-workflow-ports.js");
  WorkerSvc = (await import("../worker-supervision-service.js")).WorkerSupervisionService;
  WorkerStoreType = (await import("../worker-supervision-store.js")).WorkerSupervisionStore;
  ReviewStoreType = (await import("../project-acceptance/project-review-store.js")).ProjectReviewStore;
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

const WIPED = [
  "workflow_ingress", "workflow_deliveries", "workflow_commands", "workflow_budgets",
  "workflow_node_deps", "workflow_nodes", "workflow_plan_revisions", "workflow_operations",
  "workflow_runs", "kanban_board", "kanban_card_transitions", "project_supervision",
  "project_contracts", "project_review_cases", "project_review_decisions",
  "project_review_requests", "worker_attempts", "worker_contracts", "worker_results",
  "attempt_lease_snapshots", "retry_budget_reservations",
];

function seedCard(store: Store): number {
  const res = store.db.prepare(`INSERT INTO kanban_board (title, source, type, status) VALUES (?, 'agent', 'O', 'running')`)
    .run(`wf-text-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return Number(res.lastInsertRowid);
}

/** One work node with a named text deliverable plus the mandatory review node. */
function textPlan(outputs: string[]): Proposal {
  return {
    requiredOutputs: [outputs[0] as string],
    nodes: [
      { label: "ask", kind: "work", instructions: "reply ok", capability: "general", outputs, acceptance: ["reply ok"], dependsOn: [] },
      { label: "judge", kind: "review", instructions: "judge the answer", capability: "general", outputs: [], acceptance: [], dependsOn: ["ask"] },
    ],
  };
}

function claimPending(store: Store, runId: string, generation: number, nodeId: string, owner: string) {
  const row = store.db.prepare(
    `SELECT action, ordinal FROM workflow_commands WHERE run_id = ? AND node_id = ? AND status = 'pending' ORDER BY ordinal LIMIT 1`,
  ).get(runId, nodeId) as { action: string; ordinal: number } | undefined;
  expect(row).toBeDefined();
  const claimed = store.claimCommand(
    { runId, generation, nodeId, action: row!.action as "dispatch" | "review", ordinal: row!.ordinal }, owner,
  );
  expect(claimed).not.toBeNull();
  return claimed!.row;
}

function dispatchWork(runner: Runner, store: Store, runId: string, nodeId: string): { cardId: number; attemptId: string } {
  const generation = store.getRun(runId)!.generation;
  const cmd = claimPending(store, runId, generation, nodeId, "workflow-worker");
  new Ports.WorkflowWorkerPort({ runner }).dispatch(cmd);
  const node = store.listNodes(runId, 1).find((n) => n["node_id"] === nodeId);
  const cardId = Number(node?.["worker_card_id"]);
  const attemptId = String(node?.["attempt_id"]);
  expect(cardId).toBeGreaterThan(0);
  return { cardId, attemptId };
}

function settleText(store: Store, cardId: number, attemptId: string, text: string, workspace: string | undefined) {
  // Mirror the reconciler pump + executor start: claim the pending attempt,
  // mark it running, then settle — settlement only accepts claimed-or-later.
  const wstore = new WorkerStoreType(store.db as never);
  const attempt = wstore.getAttempt(attemptId)!;
  const claimed = wstore.claimAttempt(cardId, attempt.contract_id, attempt.executor_kind, attempt.executor_id, attempt.generation);
  expect(claimed).not.toBeNull();
  expect(wstore.markAttemptRunning(attemptId)).toBe(true);
  const svc = new WorkerSvc(store.db as never);
  return svc.collectAndSettle(cardId, text, workspace, attemptId, attempt.generation);
}

function nodeStatus(store: Store, runId: string, nodeId: string): string {
  return String(store.listNodes(runId, 1).find((n) => n["node_id"] === nodeId)?.["status"]);
}

function nodeOutcome(store: Store, runId: string, nodeId: string): string {
  return String(store.listNodes(runId, 1).find((n) => n["node_id"] === nodeId)?.["outcome"] ?? "");
}

function ackSender() {
  return { name: "text-sender", send: (doc: { idempotenceKey: string }) => `receipt:${doc.idempotenceKey}` };
}

describe("supervised text acceptance (#1844)", () => {
  let runner: Runner;
  let store: Store;

  beforeEach(() => {
    store = new StoreType();
    runner = new RunnerType(store, ["general"]);
    for (const t of WIPED) {
      try { store.db.exec(`DELETE FROM ${t}`); } catch {}
    }
  });

  it("workspaceless root text journey: admission binds, text passes, review judges, run succeeds", () => {
    const card = seedCard(store);
    // Admission with no workspace: the root heals to its deterministic binding.
    const admitted = runner.admitSupervised({ rootCardId: card, source: "agent" });
    expect(admitted.kind).not.toBe("conflict");
    const runId = admitted.runId as string;
    const bound = new ReviewStoreType(store.db).getSupervision(card)?.workspace_cwd;
    // The binding is canonical (realpath); TEST_HOME itself may be symlinked.
    expect(bound).toBe(join(realpathSync(TEST_HOME), "workspace", "projects", String(card)));
    expect(existsSync(bound as string)).toBe(true);

    const acc = runner.acceptPlan(runId, textPlan(["answer"]));
    const workNode = acc.nodeIds[0] as string;
    const judgeNode = acc.nodeIds[1] as string;
    const { cardId, attemptId } = dispatchWork(runner, store, runId, workNode);

    // The worker answers in text; the settled envelope passes acceptance.
    const settled = settleText(store, cardId, attemptId, "ok", bound ?? undefined);
    expect(settled.settled).toBe(true);
    expect(settled.envelope?.criteria).toEqual([{ criterion_id: `${workNode}-c0`, status: "passed", evidence_ids: [`${workNode}-o0`] }]);
    expect(nodeStatus(store, runId, workNode)).toBe("succeeded");

    // The review brief carries the deliverable text for judgment.
    const generation = store.getRun(runId)!.generation;
    claimPending(store, runId, generation, judgeNode, "spin-reviewer");
    const brief = runner.assembleBrief(runId, 1, judgeNode);
    expect(brief.deliverableTextByNode[workNode]).toMatch(/ok/);

    // The review verdict — not the worker gate — decides the run outcome.
    expect(runner.submitVerdict(runId, judgeNode, { verdict: "accept" })).toBe("accepted");
    expect(store.getRun(runId)?.state).not.toBe("succeeded");
    expect(runner.executeDelivery(runId, judgeNode, ackSender())).toBe("acknowledged");
    expect(store.getRun(runId)?.state).toBe("succeeded");
    const cardRow = store.db.prepare(`SELECT status FROM kanban_board WHERE id = ?`).get(card) as { status: string };
    expect(cardRow.status).toBe("done");
  });

  it("a reviewer can demand changes against a text deliverable on its content", () => {
    const card = seedCard(store);
    const admitted = runner.admitSupervised({ rootCardId: card, source: "agent" });
    const runId = admitted.runId as string;
    const acc = runner.acceptPlan(runId, textPlan(["answer"]));
    const workNode = acc.nodeIds[0] as string;
    const judgeNode = acc.nodeIds[1] as string;
    const { cardId, attemptId } = dispatchWork(runner, store, runId, workNode);
    const bound = new ReviewStoreType(store.db).getSupervision(card)?.workspace_cwd ?? undefined;

    expect(settleText(store, cardId, attemptId, "ok", bound).settled).toBe(true);
    expect(nodeStatus(store, runId, workNode)).toBe("succeeded");

    const generation = store.getRun(runId)!.generation;
    claimPending(store, runId, generation, judgeNode, "spin-reviewer");
    const brief = runner.assembleBrief(runId, 1, judgeNode);
    expect(brief.deliverableTextByNode[workNode]).toMatch(/ok/);
    expect(brief.criteriaByNode).toMatchObject({ ask: ["reply ok"] });
    // The defect links the text node's acceptance condition by its content.
    expect(runner.submitVerdict(runId, judgeNode, {
      verdict: "changes_required", defects: [{ criterion: "reply ok", detail: "the answer is too terse" }],
    })).toBe("repair_queued");
  });

  it("silent worker: empty text fails naming the deliverable, never workspace unavailable", () => {
    const card = seedCard(store);
    const admitted = runner.admitSupervised({ rootCardId: card, source: "agent" });
    const runId = admitted.runId as string;
    const acc = runner.acceptPlan(runId, textPlan(["answer"]));
    const workNode = acc.nodeIds[0] as string;
    const { cardId, attemptId } = dispatchWork(runner, store, runId, workNode);
    const bound = new ReviewStoreType(store.db).getSupervision(card)?.workspace_cwd ?? undefined;

    const settled = settleText(store, cardId, attemptId, "   ", bound);
    expect(settled.settled).toBe(true);
    expect(nodeStatus(store, runId, workNode)).toBe("failed");
    const outcome = nodeOutcome(store, runId, workNode);
    expect(outcome).toMatch(/not-passed/);
    expect(outcome).not.toMatch(/workspace unavailable/);
    const envelope = settled.envelope!;
    expect(envelope.artifacts[0]).toMatchObject({ exists: false });
    expect(String(envelope.artifacts[0]!.error)).toMatch(/answer/);
  });

  it("promised file never written still fails with a bound workspace", () => {
    const card = seedCard(store);
    const admitted = runner.admitSupervised({ rootCardId: card, source: "agent" });
    const runId = admitted.runId as string;
    const acc = runner.acceptPlan(runId, textPlan(["out/done.txt"]));
    const workNode = acc.nodeIds[0] as string;
    const { cardId, attemptId } = dispatchWork(runner, store, runId, workNode);
    const bound = new ReviewStoreType(store.db).getSupervision(card)?.workspace_cwd ?? undefined;
    expect(bound).toBeDefined();

    // Text is present but the promised file was never created: file acceptance holds.
    const settled = settleText(store, cardId, attemptId, "ok", bound);
    expect(settled.settled).toBe(true);
    expect(nodeStatus(store, runId, workNode)).toBe("failed");
    expect(nodeOutcome(store, runId, workNode)).toMatch(/not-passed/);
    expect(settled.envelope!.artifacts[0]).toMatchObject({ exists: false, error: "not found" });
  });
});
