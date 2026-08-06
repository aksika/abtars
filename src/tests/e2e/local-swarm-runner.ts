#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const abtarsHome = process.env["ABTARS_HOME"];
if (!abtarsHome || !abtarsHome.includes("/tmp/")) {
  console.error("LOCAL_SWARM_RESULT=" + JSON.stringify({
    schemaVersion: 2, ok: false, scenario: "validation",
    failure: { stage: "validation", code: "INVALID_HOME", message: `ABTARS_HOME must be under /tmp/, got ${abtarsHome}` },
  }));
  process.exit(1);
}

const scenario: string = process.env["SCENARIO"] ?? "happy_path";
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

globalThis.require = ((specifier: string): unknown => {
  const caller = new Error().stack?.split("\n")
    .slice(2)
    .map(line => line.match(/\((.*:\d+:\d+)\)/)?.[1] ?? line.match(/at (.*:\d+:\d+)/)?.[1])
    .find((path): path is string => Boolean(path && !path.includes("local-swarm-runner")))
    ?.replace(/:\d+:\d+$/, "");
  return createRequire(caller ?? import.meta.url)(specifier);
}) as typeof globalThis.require;

function emitCheckpoint(stage: string, meta?: Record<string, unknown>): void {
  const event = { schemaVersion: 2, scenario, event: "checkpoint", stage, ...meta };
  process.stdout.write("LOCAL_SWARM_EVENT=" + JSON.stringify(event) + "\n");
}

interface LocalSwarmResult {
  schemaVersion: number;
  ok: boolean;
  scenario: string;
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
  duplicateWakeStable?: boolean;
  failure?: {
    stage: string;
    code: string;
    message: string;
  };
  scenarioSpecific?: Record<string, unknown>;
}

let resolveResult: (result: LocalSwarmResult) => void;
const resultPromise = new Promise<LocalSwarmResult>(r => { resolveResult = r; });
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

function fail(stage: string, code: string, message: string): never {
  throw new Error(`[${stage}/${code}] ${message.slice(0, 1_000)}`);
}

async function eventually<T>(
  label: string,
  readFn: () => T | null | undefined,
  timeoutMs = 20000,
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
let _nextResponseIndex = 0;

const workerResponses = [
  `<summary>Worker completed criterion 1.</summary><claim criterion_id="c1">Criterion 1 verified.</claim>`,
  `<summary>Worker completed criterion 2.</summary><claim criterion_id="c2">Criterion 2 verified.</claim>`,
  `<summary>Worker completed criterion 3.</summary><claim criterion_id="c3">Criterion 3 verified.</claim>`,
  `<summary>Worker completed criterion 4.</summary><claim criterion_id="c4">Criterion 4 verified.</claim>`,
  `<summary>Worker completed criterion 5.</summary><claim criterion_id="c5">Criterion 5 verified.</claim>`,
];

function nextWorkerResponse(): string {
  const resp = workerResponses[_nextResponseIndex % workerResponses.length]!;
  _nextResponseIndex++;
  return resp;
}

interface WorkerStartBarrier {
  enter(): Promise<void>;
}

/** Hold the mock execution open until the expected Worker entries are visible. */
function createWorkerStartBarrier(expected: number, timeoutMs = 10_000): WorkerStartBarrier {
  let entered = 0;
  let release!: () => void;
  const allEntered = new Promise<void>(resolve => { release = resolve; });

  return {
    enter: () => {
      entered++;
      if (entered >= expected) release();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Worker start barrier timed out: ${entered}/${expected} entered`)), timeoutMs);
        void allEntered.then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

let workerStoreCtor: typeof import("../../components/worker-supervision-store.js").WorkerSupervisionStore;
let reviewStoreCtor: typeof import("../../components/project-acceptance/project-review-store.js").ProjectReviewStore;
let activeProjectCardId: number | undefined;
const activeChildCardIds: number[] = [];
let cardReader: ((cardId: number) => { status: string; delivery_result?: string | null } | undefined) | undefined;
let supervisionReader: ((cardId: number) => { state: string } | undefined) | undefined;

let _dispatchPump: (() => void) | undefined = undefined;

async function setupEnvironment(): Promise<{
  spin: any;
  requestReconcile: (id: number) => void;
  requestWorkerDispatch: () => void;
  startReconciler: () => void;
  kanbanEnqueue: any;
  kanbanGetCard: any;
  kanbanGetChildren: any;
  kanbanRunning: any;
  kanbanComplete: any;
  WorkerSupervisionStore: any;
  ProjectReviewStore: any;
}> {
  const { spin } = await import("../../components/spin.js");
  const { requestReconcile, startReconciler, requestWorkerDispatch } = await import("../../components/reconciler.js");
  const { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, kanbanComplete } = await import("../../components/tasks/kanban-board.js");
  const { WorkerSupervisionStore } = await import("../../components/worker-supervision-store.js");
  const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js");
  const { setLogLevel, setFileLogging } = await import("../../components/logger.js");
  setLogLevel("trace");
  setFileLogging(true);

  workerStoreCtor = WorkerSupervisionStore;
  reviewStoreCtor = ProjectReviewStore;
  cardReader = kanbanGetCard;
  supervisionReader = cardId => new ProjectReviewStore().getSupervision(cardId);
  _dispatchPump = requestWorkerDispatch;

  return { spin, requestReconcile, requestWorkerDispatch, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, kanbanComplete, WorkerSupervisionStore, ProjectReviewStore };
}

function createMockRuntime(durationMs = 30, startBarrier?: WorkerStartBarrier) {
  return {
    lastUsage: null,
    session: async () => ({
      sendPrompt: async () => {
        const resp = nextWorkerResponse();
        await new Promise(r => setTimeout(r, durationMs));
        return resp;
      },
      destroy: async () => {},
      isReady: true,
      transport: { sendPrompt: async () => "", isReady: true, destroy: () => {} } as any,
    }),
    complete: async (_agent: string, _prompt: string, _opts?: any) => {
      _workerEntryCount++;
      _activeWorkerCount++;
      _peakActiveWorkers = Math.max(_peakActiveWorkers, _activeWorkerCount);
      if (startBarrier) await startBarrier.enter();
      const resp = nextWorkerResponse();
      await new Promise(r => setTimeout(r, durationMs));
      _activeWorkerCount--;
      return resp;
    },
    openExecution: async () => ({
      send: async (_prompt: string) => {
        _workerEntryCount++;
        _activeWorkerCount++;
        _peakActiveWorkers = Math.max(_peakActiveWorkers, _activeWorkerCount);
        if (startBarrier) await startBarrier.enter();
        const resp = nextWorkerResponse();
        await new Promise(r => setTimeout(r, durationMs));
        _activeWorkerCount--;
        return resp;
      },
      close: async () => {},
      transport: {} as any,
      sessionKey: "mock",
      ephemeral: true,
      lastUsage: () => ({ input: 500, output: 200 }),
    }),
    shutdown: async () => {},
  };
}

let sentCaptureCount = 0;
const testDeliverDeps = {
  sendMessage: async (_chatId: string, _text: string): Promise<"sent"> => { sentCaptureCount++; return "sent"; },
  sendDocument: async (_chatId: string, _filePath: string, _caption: string): Promise<"sent"> => { sentCaptureCount++; return "sent"; },
  announce: async (_prompt: string) => { sentCaptureCount++; },
  chatIdFor: () => "test_chat",
};

function readCounts(): LocalSwarmResult["counts"] {
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

function failureResult(stage: string, code: string, message: string): LocalSwarmResult {
  let counts: LocalSwarmResult["counts"] = {
    workerContracts: 0, workerAttempts: 0, workerResults: 0,
    reviewCases: 0, reviewDecisions: 0, outboundDeliveries: sentCaptureCount,
  };
  try { counts = readCounts(); } catch {}
  const card = activeProjectCardId !== undefined ? cardReader?.(activeProjectCardId) : undefined;
  const supervision = activeProjectCardId !== undefined ? supervisionReader?.(activeProjectCardId) : undefined;
  return {
    schemaVersion: 2, ok: false, scenario, scenarioId,
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

// ── Scenario implementations ────────────────────────────────────────────────

async function runHappyPath(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  const { deliverCard } = await import("../../components/tasks/kanban-delivery.js");

  spin.setRuntime(createMockRuntime(100, createWorkerStartBarrier(3)) as any);

  const projectCardId = kanbanEnqueue("E2E test project", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
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
  if (contractResult.startsWith("[err]")) fail("define_contract", "CONTRACT_FAILED", contractResult);

  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 200));
  emitCheckpoint("contract_defined");

  const childCardIds: number[] = [];
  const orcContext = { projectCardId };

  for (let i = 0; i < 3; i++) {
    const spawnResult = await spawnWorkerTool.execute({
      goal: `Worker ${String.fromCharCode(65 + i)}: verify criterion ${i + 1}`,
      title: `Worker ${String.fromCharCode(65 + i)}`,
      project_card_id: String(projectCardId),
      criteria: JSON.stringify([{ id: `c${i + 1}`, description: `Verify criterion ${i + 1}` }]),
      verification_commands: JSON.stringify([{ id: `check_c${i + 1}`, argv: ["node"], timeout_ms: 5_000, criterion_ids: [`c${i + 1}`] }]),
      supports_root_criteria: JSON.stringify([`c${i + 1}`]),
    }, { userId: "test", orcContext: orcContext as any });
  const childIdMatch = spawnResult.match(/card #?(\d+)/);
    if (childIdMatch) {
      const childId = Number(childIdMatch[1]);
      childCardIds.push(childId);
      activeChildCardIds.push(childId);
    } else {
      const children = kanbanGetChildren(projectCardId);
      if (children.length > 0) {
        const lastChild = children[children.length - 1]!;
        childCardIds.push(lastChild.id);
        activeChildCardIds.push(lastChild.id);
      }
    }
  }
  if (childCardIds.length !== 3) fail("spawn_workers", "NOT_ENOUGH_CHILDREN", `Expected 3 children, got ${childCardIds.length}`);

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);

  await eventually("workers-terminal", () => {
    const children = kanbanGetChildren(projectCardId);
    const terminal = children.filter((c: any) => ["done", "delivered", "failed"].includes(c.status));
    return terminal.length >= 3 ? terminal : null;
  }, 30000);

  assertWorkerInvariants(new WorkerSupervisionStore(), childCardIds);

  const reviewStore = new ProjectReviewStore();
  const supervision = await eventually("project-supervision", () => reviewStore.getSupervision(projectCardId) ?? null);
  const reviewCase = await eventually("review-case", () => reviewStore.getLatestOpenCase(projectCardId) ?? null);
  if (!reviewCase) fail("review_case", "NO_CASE", "No review case was created after workers completed");

  const snapshot = JSON.parse(reviewCase.case_json) as {
    root_contract?: { criteria?: unknown[] };
    criterion_inputs: Array<{ criterion_id: string; observed_evidence_ids: string[]; worker_claim_ids: string[] }>;
    child_summaries?: Array<{ result?: unknown }>;
  };
  if (snapshot.root_contract?.criteria?.length !== 3 || snapshot.criterion_inputs.length !== 3 ||
      snapshot.child_summaries?.length !== 3 || snapshot.child_summaries.some(child => !child.result)) {
    fail("review_case", "INCOMPLETE_SNAPSHOT", "Review case did not contain all three root criteria and child results");
  }
  const evidenceByCriterion = new Map(snapshot.criterion_inputs.map(input => [input.criterion_id, input.observed_evidence_ids.slice(0, 10)]));

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
    outputs: JSON.stringify([{ output_id: "o1", disposition: "verified", evidence_ids: [...evidenceByCriterion.values()].flat().slice(0, 10) }]),
    contradictions: JSON.stringify([]),
    residual_risks: JSON.stringify([]),
    synthesis: "All criteria satisfied. Project accepted.",
  });
  if (reviewResult.startsWith("[err]")) fail("review_project", "REVIEW_FAILED", reviewResult);

  emitCheckpoint("project_accepted");
  await deliverCard(kanbanGetCard(projectCardId)!, testDeliverDeps);

  const beforeDuplicate = readCounts();
  for (const childId of childCardIds) { requestReconcile(childId); }
  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 500));
  await deliverCard(kanbanGetCard(projectCardId)!, testDeliverDeps);
  const afterDuplicate = readCounts();

  const finalCard = kanbanGetCard(projectCardId)!;
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId, childCardIds,
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterDuplicate,
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    duplicateWakeStable: JSON.stringify(beforeDuplicate) === JSON.stringify(afterDuplicate),
  };
}

async function runRestartRecovery(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  const WorkerSupervisionSvc = (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService;

  let completeBarrierResolve: (() => void) | undefined = undefined;
  const completeBarrier = new Promise<void>(r => { completeBarrierResolve = r as (() => void); });
  const barrierRuntime = {
    lastUsage: null,
    session: async () => ({ sendPrompt: async () => { await completeBarrier; return ""; }, destroy: async () => {}, isReady: true, transport: { sendPrompt: async () => "", isReady: true, destroy: () => {} } as any }),
    complete: async (_agent: string, _prompt: string, _opts?: any) => { await completeBarrier; return ""; },
    openExecution: async () => ({ send: async (_p: string) => { await completeBarrier; return ""; }, close: async () => {}, transport: {} as any, sessionKey: "mock", ephemeral: true, lastUsage: () => null }),
    shutdown: async () => {},
  };
  spin.setRuntime(barrierRuntime as any);

  const reviewStore = new ProjectReviewStore();
  const projectCardId = kanbanEnqueue("Restart recovery E2E", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);

  const rootContractId = `rc_restart_${projectCardId}`;
  reviewStore.ensureAwaitingContract(projectCardId);
  reviewStore.insertContract({
    schema_version: 1, id: rootContractId, project_card_id: projectCardId, digest: `d_${rootContractId}`,
    goal: "Restart recovery test",
    criteria: [{ id: "c1", description: "Criterion 1", evidence_expectation: "observed" }],
    required_outputs: [{ id: "o1", description: "Report", kind: "report", required: true }],
    constraints: [], limits: { max_tokens: 50000, max_review_rounds: 1, max_repair_rounds: 0 },
    provenance: { root_card_id: projectCardId, authored_by: "orc", created_at: new Date().toISOString() },
  } as any);
  reviewStore.stateTransition(projectCardId, ["awaiting_contract"], "executing");
  startReconciler();

  const childCardId = kanbanEnqueue("Restart worker", "agent", undefined, {
    type: "W", priority: "MEDIUM", deliveryMode: "deliver", parent_id: projectCardId,
  });
  activeChildCardIds.push(childCardId);

  const svc = new WorkerSupervisionSvc();
  const createResult = svc.createChild("Restart work", childCardId, projectCardId, "orc", {
    criteria: [{ id: "c1", description: "Restart criterion" }],
    expectedArtifacts: [], verificationCommands: [], requiredCapabilities: [],
    supportsRootCriteria: ["c1"],
    limits: { max_tokens: 5000 },
  });
  if ("error" in createResult) fail("create_child", "CREATE_FAILED", createResult.error);

  await new Promise(r => setTimeout(r, 200));
  requestReconcile(projectCardId);
  requestReconcile(childCardId);
  if (_dispatchPump) _dispatchPump();

  const store = new WorkerSupervisionStore();
  await eventually("worker-running", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && (a.lifecycle === "running" || a.lifecycle === "claimed" || a.lifecycle === "starting") ? a : null;
  }, 20000);

  emitCheckpoint("worker_running");

  (completeBarrierResolve as (() => void) | undefined)?.();
  await new Promise(r => setTimeout(r, 200));

  const afterSettle = readCounts();
  const finalAttempt = store.getLatestAttempt(childCardId);

  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds: [childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterSettle,
    terminal: { cardStatus: kanbanGetCard(childCardId)?.status },
    scenarioSpecific: {
      finalLifecycle: finalAttempt?.lifecycle,
      workerCompleted: finalAttempt?.lifecycle === "completed",
      workerExists: finalAttempt != null,
    },
  };
}

async function runCapacityDeadline(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanRunning, WorkerSupervisionStore } = await setupEnvironment();
  // Hold the first three executions long enough for the durable capacity
  // assertion to observe the occupancy before any completion frees a slot.
  spin.setRuntime(createMockRuntime(500) as any);

  const projectCardId = kanbanEnqueue("Capacity deadline E2E", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);
  startReconciler();

  const { getOrcTools } = await import("../../components/transport/orc-tools.js");
  const orcTools = getOrcTools();
  const defineContractTool = orcTools.find(t => t.name === "define_project_contract")!;
  const spawnWorkerTool = orcTools.find(t => t.name === "spawn_worker")!;

  await defineContractTool.execute({
    goal: "Capacity deadline test",
    project_card_id: String(projectCardId),
    criteria: JSON.stringify(
      [1, 2, 3, 4, 5].map(i => ({ id: `c${i}`, description: `Criterion ${i}` }))
    ),
    required_outputs: JSON.stringify([{ id: "o1", description: "Report", kind: "report", required: true }]),
    constraints: JSON.stringify([]),
  });

  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 200));
  const orcContext = { projectCardId };
  const childCardIds: number[] = [];

  for (let i = 0; i < 5; i++) {
    const sr = await spawnWorkerTool.execute({
      goal: `Worker ${i + 1}`,
      title: `Worker ${i + 1}`,
      project_card_id: String(projectCardId),
      criteria: JSON.stringify([{ id: `c${i + 1}`, description: `Criterion ${i + 1}` }]),
      verification_commands: JSON.stringify([{ id: `check_c${i + 1}`, argv: ["node"], timeout_ms: 5_000, criterion_ids: [`c${i + 1}`] }]),
      supports_root_criteria: JSON.stringify([`c${i + 1}`]),
      max_duration_ms: i < 3 ? "300000" : "1",
    }, { userId: "test", orcContext: orcContext as any });
    const m = sr.match(/card #?(\d+)/);
    if (m) { childCardIds.push(Number(m[1])); activeChildCardIds.push(Number(m[1])); }
  }

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);

  const store = new WorkerSupervisionStore();
  await eventually("three-active", () => {
    const active = store.getActiveAttemptCountForExecutor("agent", "spin-local");
    return active >= 3 ? active : null;
  }, 10000);

  const peakActive = store.getActiveAttemptCountForExecutor("agent", "spin-local");

  const deadlines: string[] = [];
  for (const id of childCardIds) {
    const a = store.getLatestAttempt(id);
    if (a?.hard_deadline_at && new Date(a.hard_deadline_at).getTime() < Date.now() + 60000) {
      deadlines.push(a.id);
    }
  }

  if (deadlines.length > 0) {
    const firstDeadlineId = deadlines[0]!;
    await eventually("deadline-settled", () => {
      const a = store.getAttempt(firstDeadlineId);
      return a && a.lifecycle === "timed_out" ? a : null;
    }, 30000);
  }

  emitCheckpoint("deadline_processed");

  await eventually("all-terminal", () => {
    const all = childCardIds.every(id => {
      const a = store.getLatestAttempt(id);
      return a && store.isAttemptTerminal(a.lifecycle);
    });
    return all || null;
  }, 30000);

  const svc = new (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService();
  const deadlineAttempt = childCardIds
    .map(id => store.getLatestAttempt(id))
    .find(attempt => attempt?.hard_deadline_at != null);
  let lateResultRejected = false;
  if (deadlineAttempt) {
    const late = svc.collectAndSettle(
      deadlineAttempt.card_id,
      "<summary>late result</summary>",
      undefined,
      deadlineAttempt.id,
      deadlineAttempt.generation,
    );
    lateResultRejected = late.settled === false;
  }

  const afterCounts = readCounts();
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds,
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterCounts,
    terminal: {},
    scenarioSpecific: {
      peakDurableActive: peakActive,
      attemptedDeadlines: childCardIds.filter(id => store.getLatestAttempt(id)?.hard_deadline_at != null).length,
      lateResultRejected,
    },
  };
}

async function runPriorityAge(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanRunning, WorkerSupervisionStore } = await setupEnvironment();
  const WorkerSupervisionSvc = (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService;
  spin.setRuntime(createMockRuntime() as any);

  const projectCardId = kanbanEnqueue("Priority age E2E", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);
  startReconciler();

  const { getOrcTools } = await import("../../components/transport/orc-tools.js");
  const orcTools = getOrcTools();
  const defineContractTool = orcTools.find(t => t.name === "define_project_contract")!;
  const spawnWorkerTool = orcTools.find(t => t.name === "spawn_worker")!;

  await defineContractTool.execute({
    goal: "Priority age test",
    project_card_id: String(projectCardId),
    criteria: JSON.stringify(
      [1, 2, 3, 4].map(i => ({ id: `c${i}`, description: `Criterion ${i}` }))
    ),
    required_outputs: JSON.stringify([{ id: "o1", description: "Report", kind: "report", required: true }]),
    constraints: JSON.stringify([]),
  });

  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 200));

  const orcContext = { projectCardId };

  const past = new Date(Date.now() - 180_000).toISOString();
  const backdatedCardId = kanbanEnqueue("Aged LOW worker", "test", undefined, {
    type: "W", priority: "LOW", deliveryMode: "deliver", parent_id: projectCardId,
  });
  const db = new WorkerSupervisionStore().db;
  db.prepare("UPDATE kanban_board SET created_at = ? WHERE id = ?").run(past, backdatedCardId);
  activeChildCardIds.push(backdatedCardId);
  const svc = new WorkerSupervisionSvc();
  svc.createChild("Aged low priority work", backdatedCardId, projectCardId, "orc", {
    criteria: [{ id: "c_aged", description: "Aged criterion" }],
    expectedArtifacts: [], verificationCommands: [], requiredCapabilities: [],
    supportsRootCriteria: ["c1"],
    limits: { max_tokens: 5000 },
  });

  const criteria = JSON.stringify([{ id: "c_aged", description: "Aged criterion" }]);
  const commands = JSON.stringify([{ id: "check_aged", argv: ["node"], timeout_ms: 5_000, criterion_ids: ["c_aged"] }]);

  for (let i = 0; i < 4; i++) {
    const sr = await spawnWorkerTool.execute({
      goal: `High prio worker ${i}`,
      title: `High ${i}`,
      project_card_id: String(projectCardId),
      priority: i < 2 ? "CRITICAL" : "HIGH",
      criteria,
      verification_commands: commands,
      supports_root_criteria: JSON.stringify(["c1"]),
    }, { userId: "test", orcContext: orcContext as any });
    const m = sr.match(/card #?(\d+)/);
    if (m) activeChildCardIds.push(Number(m[1]));
  }

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);

  const store = new WorkerSupervisionStore();
  await eventually("backdated-card-started", () => {
    const a = store.getLatestAttempt(backdatedCardId);
    if (a && (a.lifecycle === "running" || a.lifecycle === "claimed" || a.lifecycle === "starting" || a.lifecycle === "completed")) return a;
    return null;
  }, 30000);

  const agedAttempt = store.getLatestAttempt(backdatedCardId);

  const afterCounts = readCounts();
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds: activeChildCardIds,
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterCounts,
    terminal: {},
    scenarioSpecific: {
      agedCardStarted: agedAttempt && (agedAttempt.lifecycle === "running" || agedAttempt.lifecycle === "completed"),
      agedAttemptLifecycle: agedAttempt?.lifecycle,
    },
  };
}

async function runTokenBudget(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  spin.setRuntime(createMockRuntime() as any);

  const projectCardId = kanbanEnqueue("Token budget E2E", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);

  const db = new WorkerSupervisionStore().db;
  db.prepare("UPDATE kanban_board SET max_tokens = 20000 WHERE id = ?").run(projectCardId);

  startReconciler();

  const reviewStore = new ProjectReviewStore();
  const rootContractId = `rc_budget_${projectCardId}`;
  reviewStore.ensureAwaitingContract(projectCardId);
  reviewStore.insertContract({
    schema_version: 1, id: rootContractId, project_card_id: projectCardId, digest: `d_${rootContractId}`,
    goal: "Budget capped project",
    criteria: [{ id: "c1", description: "Budget criterion", evidence_expectation: "observed" }],
    required_outputs: [{ id: "o1", description: "Report", kind: "report", required: true }],
    constraints: [], limits: { max_tokens: 20000, max_review_rounds: 1, max_repair_rounds: 0 },
    provenance: { root_card_id: projectCardId, authored_by: "orc", created_at: new Date().toISOString() },
  } as any);
  reviewStore.stateTransition(projectCardId, ["awaiting_contract"], "executing");

  requestReconcile(projectCardId);
  await new Promise(r => setTimeout(r, 200));

  const svc = new (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService();
  const childCardIds: number[] = [];

  for (let i = 0; i < 5; i++) {
    const cardId = kanbanEnqueue(`Budget worker ${i}`, "agent", undefined, {
      type: "W", priority: "MEDIUM", deliveryMode: "deliver", parent_id: projectCardId,
    });
    activeChildCardIds.push(cardId);
    childCardIds.push(cardId);

    const result = svc.createChild(
      `Budget work ${i}`, cardId, projectCardId, "orc",
      {
        criteria: [{ id: `c_b${i}`, description: `Budget criterion ${i}` }],
        expectedArtifacts: [],
        verificationCommands: [],
        requiredCapabilities: [],
        limits: { max_tokens: 5000 },
      },
    );
    if ("error" in result) fail("create_child", "CREATE_FAILED", result.error);
  }

  emitCheckpoint("workers_created");
  requestWorkerDispatchFrom(requestReconcile);

  const store = new WorkerSupervisionStore();
  await eventually("some-workers-settled", () => {
    const terminal = childCardIds.filter(id => {
      const a = store.getLatestAttempt(id);
      return a && store.isAttemptTerminal(a.lifecycle);
    });
    return terminal.length > 0 ? terminal : null;
  }, 30000);

  const afterCounts = readCounts();
  const projectCard = kanbanGetCard(projectCardId);

  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds,
    peakActiveWorkers: _peakActiveWorkers,
    counts: afterCounts,
    terminal: {},
    scenarioSpecific: {
      totalTokensUsed: projectCard?.tokens_used ?? 0,
      projectMaxTokens: projectCard?.max_tokens,
      projectStatus: projectCard?.status,
      terminalChildren: childCardIds.filter(id => {
        const a = store.getLatestAttempt(id);
        return a && store.isAttemptTerminal(a.lifecycle);
      }).length,
    },
  };
}

function requestWorkerDispatchFrom(_requestReconcileFn: (id: number) => void): void {
  if (_dispatchPump) {
    for (const id of activeChildCardIds) {
      _requestReconcileFn(id);
    }
    _dispatchPump();
  }
}

/**
 * #1516: scheduled project with a durable agent cap (maxAgents=4) through the
 * real spawnChild admission boundary. Exactly three Workers are admitted; a
 * fourth is refused with no card created; a terminal Worker releases capacity.
 */
async function runScheduledCap(): Promise<LocalSwarmResult> {
  const { spin, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, kanbanComplete } = await setupEnvironment();

  const projectCardId = kanbanEnqueue("Capped scheduled project", "task", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver", maxAgents: 4,
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);
  if (kanbanGetCard(projectCardId)?.max_agents !== 4) fail("max_agents", "CAP_NOT_PERSISTED", "max_agents not durably stored");

  const admitted: number[] = [];
  let refusal: string | null = null;
  let admittedAfterRelease: number | null = null;

  const spawnLane = (i: number): number => {
    const contract = {
      schema_version: 1 as const,
      id: `lane_${projectCardId}_${i}`,
      digest: "",
      goal: `Research lane ${i + 1}`,
      criteria: [{ id: `c${i}`, description: `Lane ${i + 1} criterion` }],
      expected_artifacts: [],
      verification_commands: [],
      required_capabilities: [],
      limits: { max_duration_ms: 60_000 },
      provenance: { root_card_id: projectCardId, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
    };
    return spin.spawnChild(projectCardId, {
      goal: `Research lane ${i + 1}`,
      title: `Lane ${i + 1}`,
      source: "agent",
      contract,
      settlementOwner: "spin",
    });
  };

  for (let i = 0; i < 4; i++) {
    try {
      const id = spawnLane(i);
      admitted.push(id);
      activeChildCardIds.push(id);
    } catch (err) {
      refusal = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  if (admitted.length !== 3) fail("cap", "WRONG_ADMITTED", `admitted=${admitted.length} expected=3`);
  if (!refusal || !refusal.includes("agent_cap_reached")) fail("cap", "REFUSAL_MISSING", `refusal=${refusal}`);

  const childrenBefore = kanbanGetChildren(projectCardId);
  if (childrenBefore.length !== 3) fail("cap", "WRONG_CHILDREN", `children=${childrenBefore.length} expected=3`);

  // A terminal Worker releases capacity: the next admission succeeds.
  const first = childrenBefore[0]!;
  kanbanComplete(first.id, null, "lane done");
  try {
    admittedAfterRelease = spawnLane(4);
    activeChildCardIds.push(admittedAfterRelease);
  } catch (err) {
    fail("cap", "RELEASE_FAILED", err instanceof Error ? err.message : String(err));
  }

  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds: admitted,
    peakActiveWorkers: 0,
    counts: readCounts(),
    terminal: {},
    scenarioSpecific: {
      admitted: admitted.length,
      childrenBeforeRelease: childrenBefore.length,
      refusal: refusal ?? "",
      admittedAfterRelease,
    },
  };
}

// ── Main dispatch ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let result: LocalSwarmResult;

  try {
    switch (scenario) {
      case "restart_recovery":
        result = await runRestartRecovery();
        break;
      case "capacity_deadline":
        result = await runCapacityDeadline();
        break;
      case "priority_age":
        result = await runPriorityAge();
        break;
      case "token_budget":
        result = await runTokenBudget();
        break;
      case "scheduled_cap":
        result = await runScheduledCap();
        break;
      default:
        result = await runHappyPath();
    }
  } catch (err) {
    result = failureResult("main", "UNCAUGHT", String(err));
  }

  resolveResult(result);
}

main();

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
