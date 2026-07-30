#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const abtarsHome = process.env["ABTARS_HOME"];
if (!abtarsHome || !abtarsHome.includes("/tmp/")) {
  console.error("LOCAL_SWARM_RESULT=" + JSON.stringify({
    schemaVersion: 1, ok: false, scenarioId: "validation", childCardIds: [],
    peakActiveWorkers: 0,
    counts: { workerContracts: 0, workerAttempts: 0, workerResults: 0, reviewCases: 0, reviewDecisions: 0, outboundDeliveries: 0 },
    terminal: {},
    failure: { stage: "validation", code: "INVALID_HOME", message: `ABTARS_HOME must be under /tmp/, got ${abtarsHome}` },
  }));
  process.exit(1);
}

const scenarioId = `swarm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const logsDir = join(abtarsHome, "logs");
mkdirSync(logsDir, { recursive: true });
mkdirSync(join(abtarsHome, "kanban"), { recursive: true });
mkdirSync(join(abtarsHome, "config"), { recursive: true });
writeFileSync(join(abtarsHome, "config", "users.json"), JSON.stringify({
  users: [{ userId: "test-master", role: "master", displayName: "Test Master" }],
}));

process.env["LOG_FORMAT"] = "json";
process.env["ABTARS_LOG_LEVEL"] = "trace";
// Production ESM modules still contain lazy CommonJS loads on infrequent
// paths. Resolve relative requests from the module that issued them, matching
// the per-module CommonJS wrapper used by the compiled/bundled runtime. The
// child owns this compatibility boundary; production code remains unchanged
// and the parent never shares its module cache or globals.
globalThis.require = ((specifier: string): unknown => {
  const caller = new Error().stack?.split("\n")
    .slice(2)
    .map(line => line.match(/\((.*:\d+:\d+)\)/)?.[1] ?? line.match(/at (.*:\d+:\d+)/)?.[1])
    .find((path): path is string => Boolean(path && !path.includes("local-swarm-runner")))
    ?.replace(/:\d+:\d+$/, "");
  return createRequire(caller ?? import.meta.url)(specifier);
}) as typeof globalThis.require;

let resolveResult: (result: LocalSwarmE2EResult) => void;
const resultPromise = new Promise<LocalSwarmE2EResult>(r => { resolveResult = r; });
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

interface LocalSwarmE2EResult {
  schemaVersion: 1;
  ok: boolean;
  scenarioId: string;
  projectCardId?: number;
  childCardIds: number[];
  peakActiveWorkers: number;
  counts: {
    workerContracts: number;
    workerAttempts: number;
    workerResults: number;
    reviewCases: number;
    reviewDecisions: number;
    outboundDeliveries: number;
  };
  terminal: {
    projectState?: string;
    cardStatus?: string;
    deliveryResult?: string;
  };
  failure?: {
    stage: string;
    code: string;
    message: string;
  };
  duplicateWakeStable?: boolean;
}

function fail(stage: string, code: string, message: string): never {
  throw new Error(`[${stage}/${code}] ${message.slice(0, 1_000)}`);
}

async function eventually<T>(
  label: string,
  readFn: () => T | null | undefined,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = readFn();
    if (result != null) return result;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`eventually(${label}) timed out after ${timeoutMs}ms`);
}

let _workerEntryCount = 0;
let _peakActiveWorkers = 0;
let _activeWorkerCount = 0;

const workerBarrier = (() => {
  let resolve: (() => void) | null = null;
  const promise = new Promise<void>(r => { resolve = r; });
  return {
    enter: () => {
      _workerEntryCount++;
      _activeWorkerCount++;
      _peakActiveWorkers = Math.max(_peakActiveWorkers, _activeWorkerCount);
      if (_workerEntryCount >= 3) resolve!();
      return promise;
    },
    release: () => {
      _activeWorkerCount = 0;
    },
  };
})();

const workerResponses = [
  `<summary>Worker A completed: analysis of criterion 1.</summary><claim criterion_id="c1">Analysis shows the system meets criterion 1 requirements.</claim>`,
  `<summary>Worker B completed: verification of criterion 2.</summary><claim criterion_id="c2">Verification confirms criterion 2 is satisfied.</claim>`,
  `<summary>Worker C completed: validation of criterion 3.</summary><claim criterion_id="c3">Validation demonstrates criterion 3 compliance.</claim>`,
];

let workerStoreCtor: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
let reviewStoreCtor: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
let activeProjectCardId: number | undefined;
const activeChildCardIds: number[] = [];
let cardReader: ((cardId: number) => { status: string; delivery_result?: string | null } | undefined) | undefined;
let supervisionReader: ((cardId: number) => { state: string } | undefined) | undefined;

async function main(): Promise<void> {
  const { spin } = await import("../../components/spin.js");
  const { requestReconcile, startReconciler } = await import("../../components/reconciler.js");
  const { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning } = await import("../../components/tasks/kanban-board.js");
  const { WorkerSupervisionStore } = await import("../../components/worker-supervision-store.js");
  const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
  workerStoreCtor = WorkerSupervisionStore;
  reviewStoreCtor = ProjectReviewStore;
  cardReader = kanbanGetCard;
  supervisionReader = cardId => new ProjectReviewStore().getSupervision(cardId);
  const { deliverCard } = await import("../../components/tasks/kanban-delivery.js");
  const { setLogLevel, setFileLogging } = await import("../../components/logger.js");
  setLogLevel("trace");
  setFileLogging(true);

  let nextResponseIndex = 0;

  const mockRuntime = {
    lastUsage: null,
    session: async () => ({
      sendPrompt: async () => "",
      destroy: async () => {},
      isReady: true,
      transport: {
        sendPrompt: async () => "",
        isReady: true,
        destroy: () => {},
      } as any,
    }),
    complete: async (_agent: string, _prompt: string, _opts?: any) => {
      await workerBarrier.enter();
      const response = workerResponses[nextResponseIndex % workerResponses.length];
      nextResponseIndex++;
      await new Promise(r => setTimeout(r, 50));
      workerBarrier.release();
      return response;
    },
    openExecution: async () => ({
      send: async (_prompt: string) => {
        await workerBarrier.enter();
        const response = workerResponses[nextResponseIndex % workerResponses.length];
        nextResponseIndex++;
        await new Promise(r => setTimeout(r, 50));
        workerBarrier.release();
        return response;
      },
      close: async () => {},
      transport: {} as any,
      sessionKey: "mock",
      ephemeral: true,
      lastUsage: () => null,
    }),
    shutdown: async () => {},
  };

  spin.setRuntime(mockRuntime as any);

  const projectCardId = kanbanEnqueue("E2E test project", "test", undefined, {
    type: "O",
    priority: "MEDIUM",
    deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;

  kanbanRunning(projectCardId);
  startReconciler();

  const { getOrcTools } = await import("../../components/transport/orc-tools.js");
  const orcTools = getOrcTools();
  const defineContractTool = orcTools.find(t => t.name === "define_project_contract")!;
  const spawnWorkerTool = orcTools.find(t => t.name === "spawn_worker")!;
  const reviewProjectTool = orcTools.find(t => t.name === "review_project")!;

  const contractResult = await defineContractTool.execute({
    goal: "Complete the E2E test scenario with three workers",
    project_card_id: String(projectCardId),
    criteria: JSON.stringify([
      { id: "c1", description: "Criterion 1 is met" },
      { id: "c2", description: "Criterion 2 is satisfied" },
      { id: "c3", description: "Criterion 3 is compliant" },
    ]),
    required_outputs: JSON.stringify([
      { id: "o1", description: "Summary report", kind: "report", required: true },
    ]),
    constraints: JSON.stringify(["None"]),
  });

  if (contractResult.startsWith("[err]")) {
    fail("define_contract", "CONTRACT_FAILED", contractResult);
  }

  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 200));

  const childCardIds: number[] = [];

  const orcContext = { projectCardId };

  for (let i = 0; i < 3; i++) {
    const spawnResult = await spawnWorkerTool.execute({
      goal: `Worker ${String.fromCharCode(65 + i)}: verify criterion ${i + 1}`,
      title: `Worker ${String.fromCharCode(65 + i)}`,
      project_card_id: String(projectCardId),
      criteria: JSON.stringify([
        { id: `c${i + 1}`, description: `Verify criterion ${i + 1}` },
      ]),
      verification_commands: JSON.stringify([{
        id: `check_c${i + 1}`,
        argv: ["node"],
        timeout_ms: 5_000,
        criterion_ids: [`c${i + 1}`],
      }]),
      supports_root_criteria: JSON.stringify([`c${i + 1}`]),
    }, { userId: "test", orcContext: orcContext as any });

    const childIdMatch = spawnResult.match(/card (\d+)/);
    if (childIdMatch) {
      const childId = Number(childIdMatch[1]);
      childCardIds.push(childId);
      activeChildCardIds.push(childId);
    } else {
      const children = kanbanGetChildren(projectCardId);
      if (children.length > 0) {
        const childId = children[children.length - 1]!.id;
        childCardIds.push(childId);
        activeChildCardIds.push(childId);
      }
    }
  }

  if (childCardIds.length !== 3) {
    fail("spawn_workers", "NOT_ENOUGH_CHILDREN", `Expected 3 children, got ${childCardIds.length}`);
  }

  for (const childId of childCardIds) {
    requestReconcile(childId);
  }

  await eventually("workers-terminal", () => {
    const children = kanbanGetChildren(projectCardId);
    const terminal = children.filter(c => ["done", "delivered", "failed"].includes(c.status));
    return terminal.length >= 3 ? terminal : null;
  }, 30000);

  assertWorkerInvariants(new WorkerSupervisionStore(), childCardIds);

  const reviewStore = new ProjectReviewStore();
  const supervision = await eventually("project-supervision", () => reviewStore.getSupervision(projectCardId) ?? null);
  const reviewCase = await eventually("review-case", () => reviewStore.getLatestOpenCase(projectCardId) ?? null);

  if (!reviewCase) throw new Error("No review case was created after workers completed");

  const snapshot = JSON.parse(reviewCase.case_json) as {
    root_contract?: { criteria?: unknown[] };
    criterion_inputs: Array<{ criterion_id: string; observed_evidence_ids: string[]; worker_claim_ids: string[] }>;
    child_summaries?: Array<{ result?: unknown }>;
  };
  if (snapshot.root_contract?.criteria?.length !== 3 || snapshot.criterion_inputs.length !== 3 ||
      snapshot.child_summaries?.length !== 3 || snapshot.child_summaries.some(child => !child.result)) {
    fail("review_case", "INCOMPLETE_SNAPSHOT", "Review case did not contain all three root criteria and child results");
  }
  const evidenceByCriterion = new Map(snapshot.criterion_inputs.map(input => [
    input.criterion_id,
    input.observed_evidence_ids.slice(0, 10),
  ]));

  const reviewResult = await reviewProjectTool.execute({
    action: "accept",
    project_card_id: String(projectCardId),
    project_generation: String(supervision.generation),
    review_case_id: reviewCase.id,
    criteria: JSON.stringify([
      { criterion_id: "c1", verdict: "satisfied", evidence_ids: evidenceByCriterion.get("c1") ?? [], rationale: "Worker A confirmed criterion 1" },
      { criterion_id: "c2", verdict: "satisfied", evidence_ids: evidenceByCriterion.get("c2") ?? [], rationale: "Worker B confirmed criterion 2" },
      { criterion_id: "c3", verdict: "satisfied", evidence_ids: evidenceByCriterion.get("c3") ?? [], rationale: "Worker C confirmed criterion 3" },
    ]),
    outputs: JSON.stringify([
      { output_id: "o1", disposition: "verified", evidence_ids: [...evidenceByCriterion.values()].flat().slice(0, 10) },
    ]),
    contradictions: JSON.stringify([]),
    residual_risks: JSON.stringify([]),
    synthesis: "All criteria satisfied. Project accepted.",
  });

  if (reviewResult.startsWith("[err]")) {
    fail("review_project", "REVIEW_FAILED", reviewResult);
  }

  await deliverCard(kanbanGetCard(projectCardId)!, testDeliverDeps);
  const beforeDuplicate = readCounts();

  for (const childId of childCardIds) {
    requestReconcile(childId);
  }
  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 500));

  await deliverCard(kanbanGetCard(projectCardId)!, testDeliverDeps);
  const afterDuplicate = readCounts();

  const finalCard = kanbanGetCard(projectCardId)!;
  resolveResult({
    schemaVersion: 1, ok: true, scenarioId, projectCardId, childCardIds,
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterDuplicate,
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    duplicateWakeStable: JSON.stringify(beforeDuplicate) === JSON.stringify(afterDuplicate),
  });
}

function readCounts(): LocalSwarmE2EResult["counts"] {
  const wss = new workerStoreCtor();
  const supStore = new reviewStoreCtor();
  const count = (db: { prepare(sql: string): { get(): unknown } }, table: string): number =>
    Number((db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c);
  return {
    workerContracts: count(wss.db, "worker_contracts"),
    workerAttempts: count(wss.db, "worker_attempts"),
    workerResults: count(wss.db, "worker_results"),
    reviewCases: count(supStore.db, "project_review_cases"),
    reviewDecisions: count(supStore.db, "project_review_decisions"),
    outboundDeliveries: sentCaptureCount,
  };
}

function assertWorkerInvariants(store: InstanceType<typeof workerStoreCtor>, childCardIds: number[]): void {
  for (const cardId of childCardIds) {
    const contracts = store.db.prepare("SELECT id FROM worker_contracts WHERE card_id = ?").all(cardId) as Array<{ id: string }>;
    if (contracts.length !== 1) fail("worker_invariants", "CONTRACT_COUNT", `Worker ${cardId} has ${contracts.length} contracts`);
    const attempts = store.getAttemptsForCard(cardId);
    if (attempts.length !== 1) fail("worker_invariants", "ATTEMPT_COUNT", `Worker ${cardId} has ${attempts.length} attempts`);
    const attempt = attempts[0]!;
    if (attempt.contract_id !== contracts[0]!.id || !attempt.claimed_at || attempt.generation < 1 || attempt.lifecycle !== "completed") {
      fail("worker_invariants", "ATTEMPT_OWNERSHIP", `Worker ${cardId} attempt did not complete through a claimed generation`);
    }
    if (!store.getResult(attempt.id)) fail("worker_invariants", "RESULT_COUNT", `Worker ${cardId} has no settled result`);
  }
}

function failureResult(stage: string, code: string, message: string): LocalSwarmE2EResult {
  let counts: LocalSwarmE2EResult["counts"] = {
    workerContracts: 0, workerAttempts: 0, workerResults: 0,
    reviewCases: 0, reviewDecisions: 0, outboundDeliveries: sentCaptureCount,
  };
  try { counts = readCounts(); } catch { /* failure occurred before stores initialized */ }
  const card = activeProjectCardId !== undefined ? cardReader?.(activeProjectCardId) : undefined;
  const supervision = activeProjectCardId !== undefined ? supervisionReader?.(activeProjectCardId) : undefined;
  return {
    schemaVersion: 1, ok: false, scenarioId,
    projectCardId: activeProjectCardId,
    childCardIds: [...activeChildCardIds],
    peakActiveWorkers: _peakActiveWorkers,
    counts,
    terminal: {
      projectState: supervision?.state,
      cardStatus: card?.status,
      deliveryResult: card?.delivery_result ?? undefined,
    },
    failure: { stage, code, message: message.slice(0, 1_000) },
  };
}

let sentCaptureCount = 0;

const testDeliverDeps = {
  sendMessage: async (_chatId: string, _text: string) => { sentCaptureCount++; },
  sendDocument: async (_chatId: string, _filePath: string, _caption: string) => { sentCaptureCount++; },
  announce: async (_prompt: string) => { sentCaptureCount++; },
  chatIdFor: () => "test_chat",
};

main().catch(err => {
  resolveResult(failureResult("main", "UNCAUGHT", String(err)));
});

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

timeoutHandle = setTimeout(() => {
  resolveResult(failureResult("timeout", "TIMEOUT", "Runner exceeded 60s timeout"));
}, 60000);

resultPromise.then(result => {
  if (timeoutHandle) clearTimeout(timeoutHandle);
  process.stdout.write("LOCAL_SWARM_RESULT=" + JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
});
