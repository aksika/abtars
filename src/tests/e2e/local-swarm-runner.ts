#!/usr/bin/env node

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";

const abtarsHome = process.env["ABTARS_HOME"];
if (!abtarsHome || !abtarsHome.includes("/tmp/")) {
  console.error("LOCAL_SWARM_RESULT=" + JSON.stringify({
    schemaVersion: 2, ok: false, scenario: "validation",
    failure: { stage: "validation", code: "INVALID_HOME", message: `ABTARS_HOME must be under /tmp/, got ${abtarsHome}` },
  }));
  process.exit(1);
}
// Keep the validated value narrowed inside helper closures for the script
// compiler; process.env values are otherwise treated as possibly undefined.
const validatedAbtarsHome = abtarsHome;

/**
 * #1656: give a non-scheduled E2E project a real canonical workspace. Worker
 * verification executes against this root; without it, verification fails
 * closed (never the bridge cwd) and no lane can pass.
 */
function bindProjectWorkspace(projectCardId: number): string {
  const ws = join(validatedAbtarsHome, "workspace", `swarm-${projectCardId}`);
  mkdirSync(ws, { recursive: true });
  const { ProjectReviewStore } = require("../../components/project-acceptance/project-review-store.js") as typeof import("../../components/project-acceptance/project-review-store.js");
  const store = new ProjectReviewStore();
  // Same admission shape as the scheduled runner: durable supervision row
  // first, then the immutable workspace binding.
  store.ensureAwaitingContract(projectCardId);
  const bound = store.bindWorkspace(projectCardId, ws);
  if (!bound.ok) throw new Error(`workspace bind failed for project ${projectCardId}: ${bound.reason}`);
  return ws;
}

/**
 * #1644: the bound Orc invocation authority for scripted tool calls. Reads the
 * durable supervision generation so every spawn/authoring call carries the
 * exact project generation the fence checks against.
 */
function makeOrcContext(projectCardId: number): { projectCardId: number; projectGeneration: number } {
  try {
    const { ProjectReviewStore } = require("../../components/project-acceptance/project-review-store.js") as typeof import("../../components/project-acceptance/project-review-store.js");
    const sup = new ProjectReviewStore().getSupervision(projectCardId);
    return { projectCardId, projectGeneration: sup?.generation ?? 1 };
  } catch {
    return { projectCardId, projectGeneration: 1 };
  }
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
  startReconciler: (deps?: Partial<import("../../components/reconciler.js").ReconcilerDeps>) => Promise<void>;
  kanbanEnqueue: any;
  kanbanGetCard: any;
  kanbanGetChildren: any;
  kanbanRunning: any;
  kanbanComplete: any;
  WorkerSupervisionStore: any;
  ProjectReviewStore: any;
}> {
  const { spin } = await import("../../components/spin.js");
  const { setOrcToolsDeps } = await import("../../components/transport/orc-tools.js");
  setOrcToolsDeps(spin);
  const { requestReconcile, requestWorkerDispatch } = await import("../../components/reconciler.js");
  const startReconciler = startTestReconciler;
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


let _reconcilerGenerationCounter = 0;
/** #1554: Pi service installed by the Pi harness, consumed at generation start. */
let _harnessPiService: unknown = null;

/**
 * #1554: start a real Reconciler generation with production composition and
 * deterministic harness dependencies. The coordinator, wake scheduler, and
 * adapters are real; only external boundaries (model runtime, Pi process) are
 * doubled.
 */
async function startTestReconciler(
  deps: Partial<import("../../components/reconciler.js").ReconcilerDeps> = {},
): Promise<void> {
  const { startReconciler } = await import("../../components/reconciler.js");
  const { LifecycleWakeScheduler } = await import("../../components/lifecycle-wake-scheduler.js");
  const { OrcProjectCoordinator } = await import("../../components/orc-project/orc-project-coordinator.js");
  const { SpinWorkerAdapter } = await import("../../components/spin-worker-adapter.js");
  const { ReconcileQuarantineStore } = await import("../../components/reconcile-quarantine-store.js");
  const { WorkerSupervisionStore } = await import("../../components/worker-supervision-store.js");
  const { PiExecutorAdapter } = await import("../../components/pi-executor-adapter.js");

  // #1792: the coordinator retains only the release/supersede boundary — the
  // runner dispatches all work now, so no start port is injected.
  const coordinator = deps.coordinator ?? new OrcProjectCoordinator({});
  const scheduler = deps.wakeScheduler ?? new LifecycleWakeScheduler();
  await startReconciler({
    generationId: `local-swarm-${++_reconcilerGenerationCounter}`,
    coordinator,
    wakeScheduler: scheduler,
    workerAdapter: deps.workerAdapter ?? new SpinWorkerAdapter(),
    piService: (deps.piService ?? _harnessPiService) as never,
    createPiAdapter: (service) => new PiExecutorAdapter(service.executor, new WorkerSupervisionStore()),
    getQuarantineStore: () => new ReconcileQuarantineStore(),
    projectRunProgress: deps.projectRunProgress ?? (() => {}),
    failureCascade: deps.failureCascade,
  });
  await scheduler.start();
}

// ── #1792 runner-admission core ────────────────────────────────────────────
//
// Production admission (`WorkflowRunner.admitSupervised`, the same entry the
// scheduled runner uses) plus scripted external responses at the
// provider/executor boundary — the orc-workflow.e2e composition: a
// deterministic planner (proposal content), a deterministic reviewer (verdict
// content), worker execution through the real dispatch pump + mock runtime
// (or the FakePiExecutor for aliased lanes), and a counting delivery sender.
// Result commit, review, settlement, and terminal projections stay real.
// Uses the production routing executor (RoutingWorkflowWorkerPort) so Pi
// lanes exercise the Pi execution port (capability-based routing) and the
// joint commit + Pi W-card projection.

interface RunnerLaneSpec {
  label: string;
  instructions?: string;
  /** #1638: Pi workspace alias for this lane (absent routes to Spin). Carried
   * as the plan node's capability so production capability routing picks the
   * Pi port (plan schema has no alias field). */
  alias?: string;
  optional?: boolean;
}

interface RunnerProject {
  runner: any;
  store: any;
  rootCardId: number;
  runId: string;
  /** Drain workflow commands until quiet (guarded against nerve reentrancy). */
  pump(): void;
  /** Worker card ids in plan order (populated once dispatch converges). */
  laneCards(): number[];
  /** The open review node, if the revision's work settled and a verdict is due. */
  reviewNodeId(): string | undefined;
  /** Submit accept on the open review node and pump to terminal (idempotent). */
  acceptReview(): void;
  /** Current revision of the run. */
  revision(): number;
}

async function admitRunnerProject(
  env: {
    kanbanEnqueue: any; kanbanGetCard: any; kanbanGetChildren: any; kanbanRunning: any;
  },
  opts: {
    title: string;
    goal: string;
    lanes: RunnerLaneSpec[];
    maxAgents?: number;
    /** Scripted review behavior; "die" leaves the verdict pending. */
    reviewMode?: "accept" | "die";
  },
): Promise<RunnerProject> {
  const { WorkflowRunner } = await import("../../components/orc-project/orc-workflow-runner.js") as typeof import("../../components/orc-project/orc-workflow-runner.js");
  const { WorkflowStore } = await import("../../components/orc-project/orc-workflow-store.js") as typeof import("../../components/orc-project/orc-workflow-store.js");
  const { RoutingWorkflowWorkerPort, workflowCapabilities } = await import("../../components/orc-project/orc-workflow-ports.js") as typeof import("../../components/orc-project/orc-workflow-ports.js");
  const { ProjectReviewStore } = await import("../../components/project-acceptance/project-review-store.js") as typeof import("../../components/project-acceptance/project-review-store.js");
  const { nerve } = await import("../../components/nerve.js") as typeof import("../../components/nerve.js");
  type CommandKey = import("../../components/orc-project/orc-workflow-store.js").CommandKey;

  const store = new WorkflowStore();
  const runner = new WorkflowRunner(store, workflowCapabilities());
  const reviewMode = opts.reviewMode ?? "accept";
  const briefs: Array<{ nodeId: string }> = [];

  const projectCardId = env.kanbanEnqueue(opts.title, "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
    ...(opts.maxAgents !== undefined ? { maxAgents: opts.maxAgents } : {}),
  });
  activeProjectCardId = projectCardId;
  env.kanbanRunning(projectCardId);
  const ws = bindProjectWorkspace(projectCardId);

  // Production admission: interactive origin (no scheduled occurrence), with
  // the canonical workspace binding verified inside admission.
  const admitted = runner.admitSupervised({ rootCardId: projectCardId, source: "agent", cwd: ws });
  if (admitted.kind === "conflict") fail("admission", "ADMIT_CONFLICT", admitted.reason ?? "conflict");
  const runId = (admitted.runId ?? store.findLatestRunByCard(projectCardId)?.runId) as string;
  if (!runId) fail("admission", "NO_RUN", "admission produced no run");

  // #1792 harness: the retained executor dispatch fence
  // (claimAttemptWithinLimits) requires executing/repairing supervision.
  // The runner leaves awaiting_contract until its terminal projection; the
  // harness moves to executing so the real Spin/Pi dispatch pump can claim
  // (mirrors pre-cutover define_project_contract which initialized
  // executing). Terminal projections accept from executing.
  new ProjectReviewStore(store.db).stateTransition(projectCardId, ["awaiting_contract"], "executing");

  // Production routing executor: capability-based (Pi alias as capability for
  // Pi lanes, general for Spin). Exercises WorkflowPiPort + joint commit +
  // Pi W-card projection.
  const workerPort = new RoutingWorkflowWorkerPort({ runner });

  const completeClaim = (cmd: { runId: string; generation: number; nodeId: string; action: string; ordinal: number }, owner: string): void => {
    const key: CommandKey = { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action as CommandKey["action"], ordinal: cmd.ordinal };
    const live = store.getCommand(key);
    if (live && live.status === "claimed") {
      store.completeCommand(key, live.owner ?? owner, live.claimToken ?? "");
    }
  };

  const ports = {
    executor: {
      name: "swarm-worker-routing",
      dispatch: (cmd: { runId: string; nodeId: string; payloadJson: string }) => { workerPort.dispatch(cmd as never); },
    },
    reviewer: {
      name: "swarm-reviewer",
      startReview: (cmd: { runId: string; generation: number; nodeId: string; action: string; ordinal: number }) => {
        briefs.push({ nodeId: cmd.nodeId });
        if (reviewMode === "die") return;
        runner.submitVerdict(cmd.runId, cmd.nodeId, { verdict: "accept" });
        completeClaim(cmd, "swarm-reviewer");
      },
    },
    planner: {
      name: "swarm-planner",
      startPlanning: (cmd: { runId: string; generation: number; nodeId: string; action: string; ordinal: number }, input: { purpose: string; revision: number | null; opId?: string }) => {
        const lanes = opts.lanes.map((l, i) => ({
          label: l.label,
          kind: "work" as const,
          instructions: l.instructions ?? l.label,
          // Pi lanes carry their workspace alias as the capability so
          // production isPiCapability routing picks the Pi port (plan schema
          // has no alias field); Spin lanes stay general.
          capability: l.alias ?? "general",
          outputs: [`out/${l.label}-${i}.md`],
          acceptance: [`${l.label} delivers`],
          dependsOn: [] as string[],
          ...(l.optional ? { optional: true } : {}),
        }));
        const proposal = {
          requiredOutputs: lanes.map((_, i) => `out/${opts.lanes[i]!.label}-${i}.md`),
          nodes: [
            ...lanes,
            {
              label: "review", kind: "review" as const, instructions: "judge the candidate revision",
              capability: "general", outputs: [] as string[], acceptance: [] as string[],
              dependsOn: lanes.map(l => l.label),
            },
          ],
        };
        const current = store.currentRevision(cmd.runId);
        runner.submitPlanProposal(cmd.runId, proposal, {
          baseRevision: input.purpose === "initial" ? undefined : (input.revision ?? current),
          opId: input.opId,
        });
        completeClaim(cmd, "swarm-planner");
      },
    },
    delivery: {
      name: "swarm-delivery",
      send: () => `swarm-receipt:${Date.now()}`,
    },
  };

  let pumping = false;
  let repump = false;
  function pump(): void {
    if (pumping) {
      repump = true;
      return;
    }
    pumping = true;
    try {
      for (let pass = 0; pass < 25; pass++) {
        repump = false;
        let dispatched = 0;
        try {
          dispatched = runner.drain(50, ports);
        } catch (err) {
          try {
            process.stderr.write(`swarm-pump: contained ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}\n`);
          } catch { /* logging never breaks the pump */ }
        }
        if (!repump && dispatched === 0) break;
      }
    } finally {
      pumping = false;
    }
  }

  const onWake = (): void => { pump(); };
  nerve.on("card:queued", onWake);
  nerve.on("card:done", onWake);
  nerve.on("card:failed", onWake);

  pump();

  function laneCards(): number[] {
    pump();
    const rev = store.currentRevision(runId);
    const cards: number[] = [];
    for (const row of store.listNodes(runId, rev)) {
      if (row["kind"] !== "work" && row["kind"] !== "synthesis") continue;
      const cardId = row["worker_card_id"] as number | null;
      if (cardId == null) fail("admission", "NO_WORKER", `node ${row["node_id"]} has no worker`);
      cards.push(cardId);
    }
    return cards;
  }

  function reviewNodeId(): string | undefined {
    const rev = store.currentRevision(runId);
    const openWork = store.listNodes(runId, rev).some(
      (n) => (n["kind"] === "work" || n["kind"] === "synthesis")
        && (n["status"] === "queued" || n["status"] === "running"),
    );
    if (openWork) return undefined;
    for (let r = rev; r >= 1; r--) {
      const found = store.listNodes(runId, r).find(
        (n) => n["kind"] === "review" && (n["status"] === "queued" || n["status"] === "running"),
      );
      if (found) return found["node_id"] as string;
    }
    return undefined;
  }

  function acceptReview(): void {
    pump();
    const nodeId = reviewNodeId();
    if (!nodeId) {
      // Idempotent: the auto-reviewer may already have accepted during pump
      // (review succeeded) — nothing to do, never fail a terminal review.
      const rev = store.currentRevision(runId);
      const already = store.listNodes(runId, rev).some(
        (n) => n["kind"] === "review" && n["status"] === "succeeded",
      );
      if (already) return;
      fail("review", "NO_REVIEW_NODE", "no open review node to accept");
    }
    runner.submitVerdict(runId, nodeId as string, { verdict: "accept" });
    pump();
  }

  return {
    runner, store, rootCardId: projectCardId, runId,
    pump, laneCards, reviewNodeId, acceptReview,
    revision: () => store.currentRevision(runId),
  };
}

/** #1365 inlined: the retired review_worker_failure tool body — record the
 *  review packet, then decide through the intact RetryService. */
async function reviewFailureWithAnswer(opts: {
  projectCardId: number;
  attemptId: string;
  inputAnswer?: string;
  rationale?: string;
}): Promise<string> {
  const { RetryService } = await import("../../components/retry/retry-service.js") as typeof import("../../components/retry/retry-service.js");
  const { LocalExecutorCatalog, providerForAdapter } = await import("../../components/retry/local-executor-catalog.js") as typeof import("../../components/retry/local-executor-catalog.js");
  const { SpinWorkerAdapter } = await import("../../components/spin-worker-adapter.js") as typeof import("../../components/spin-worker-adapter.js");
  const { AGENT_EXECUTOR_ID } = await import("../../components/worker-executor-identity.js") as typeof import("../../components/worker-executor-identity.js");
  const { WorkerSupervisionStore } = await import("../../components/worker-supervision-store.js") as typeof import("../../components/worker-supervision-store.js");
  const { kanbanGetCard } = await import("../../components/tasks/kanban-board.js") as typeof import("../../components/tasks/kanban-board.js");
  const catalog = new LocalExecutorCatalog({
    spinProvider: providerForAdapter(new SpinWorkerAdapter(), AGENT_EXECUTOR_ID),
  });
  const service = new RetryService({ executorCatalog: catalog });
  const attempt = new WorkerSupervisionStore().getAttempt(opts.attemptId);
  if (!attempt) return `[err] attempt ${opts.attemptId} not found`;
  const workerCard = kanbanGetCard(attempt.card_id);
  if (!workerCard || workerCard.parent_id !== opts.projectCardId || workerCard.type !== "W") {
    return `[err] attempt ${opts.attemptId} is not a child of project ${opts.projectCardId}`;
  }
  const authority = makeOrcContext(opts.projectCardId);
  // #1792: runner-managed cards stand reconciler retry down
  // (isRunnerManagedCard), so no classification/decision exists yet. Reduce
  // explicitly so the review packet is complete (same pure classifier the
  // reconciler used pre-cutover).
  try { service.reduceTerminalAttempt(opts.attemptId, attempt.card_id); } catch {}
  const packet = service.getReviewPacket(opts.attemptId, attempt.card_id);
  if ("error" in packet) return `[err] ${packet.error}`;
  const result = service.reviewFailure({
    attemptId: opts.attemptId, cardId: attempt.card_id,
    response: {
      action: "retry",
      rationale: opts.rationale ?? "The worker asked a legitimate question.",
      ...(opts.inputAnswer ? { inputAnswer: opts.inputAnswer.slice(0, 4000) } : {}),
    },
    authority: authority as never,
  });
  if (result.kind === "created") {
    return `✓ Retry directive created for attempt ${opts.attemptId}. Target attempt: ${result.targetAttemptId}.`;
  }
  return `[err] ${result.kind}: ${"message" in result ? result.message : "retry allocation failed"}`;
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

/**
 * Stage a runner plan's required outputs as workspace files before dispatch.
 * The mock runtime returns text only, so scripted workers cannot produce
 * files; staging stands in for worker-produced output so settlement observes
 * the artifacts the plan promised (the retired spawn path proved the same
 * journey with no-op `node` verification checks).
 */
function precreateLaneOutputs(projectCardId: number, lanes: Array<{ label: string }>): void {
  const outDir = join(validatedAbtarsHome, "workspace", `swarm-${projectCardId}`, "out");
  mkdirSync(outDir, { recursive: true });
  lanes.forEach((l, i) => {
    writeFileSync(join(outDir, `${l.label}-${i}.md`), `# ${l.label}\n\nScripted worker output for ${l.label}.\n`);
  });
}

/**
 * Wait for a lane card's attempt to leave pending (tight 25ms poll — a
 * claimed Spin execution settles in ~500ms, so the 100ms `eventually`
 * cadence is too coarse to reliably catch the claim before completion).
 * Rejects terminal attempts: backdating a deadline onto an already-settled
 * attempt can never time it out, so fail loud at the catch site instead.
 */
async function awaitLiveClaim(store: { getLatestAttempt(cardId: number): any; isAttemptTerminal(lc: string): boolean }, cardId: number, timeoutMs = 30000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = store.getLatestAttempt(cardId);
    if (a && a.lifecycle !== "pending" && !store.isAttemptTerminal(a.lifecycle) && a.hard_deadline_at) return a;
    if (Date.now() > deadline) throw new Error(`awaitLiveClaim(${cardId}) timed out`);
    await new Promise(r => setTimeout(r, 25));
  }
}

async function runHappyPath(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  const { deliverCard } = await import("../../components/tasks/kanban-delivery.js");

  spin.setRuntime(createMockRuntime(100, createWorkerStartBarrier(3)) as any);

  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools. Three work lanes (one per
  // worker) plus the review node the planner always appends; the scripted
  // reviewer accepts.
  const lanes = [
    { label: "worker-a", instructions: "Worker A: verify criterion 1" },
    { label: "worker-b", instructions: "Worker B: verify criterion 2" },
    { label: "worker-c", instructions: "Worker C: verify criterion 3" },
  ];
  const proj = await admitRunnerProject(
    { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning },
    {
      title: "E2E test project",
      goal: "Complete the E2E test scenario with three workers",
      lanes,
    },
  );
  const projectCardId = proj.rootCardId;
  await startReconciler();
  emitCheckpoint("project_admitted");

  const childCardIds = proj.laneCards();
  if (childCardIds.length !== 3) fail("admission", "NOT_ENOUGH_CHILDREN", `Expected 3 lanes, got ${childCardIds.length}`);
  for (const id of childCardIds) activeChildCardIds.push(id);

  precreateLaneOutputs(projectCardId, lanes);

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);

  await eventually("workers-terminal", () => {
    const children = kanbanGetChildren(projectCardId);
    const terminal = children.filter((c: any) => ["done", "delivered", "failed"].includes(c.status));
    return terminal.length >= 3 ? terminal : null;
  }, 30000);

  assertWorkerInvariants(new WorkerSupervisionStore(), childCardIds);

  const reviewStore = new ProjectReviewStore();
  // The scripted reviewer may already have accepted during the pump; accept
  // is idempotent. Pump until the terminal projection lands (supervision
  // accepted, root done, delivery ready) before the real delivery.
  proj.acceptReview();
  await eventually("project-accepted", () => {
    try { proj.pump(); } catch {}
    const sup = reviewStore.getSupervision(projectCardId);
    return sup?.state === "accepted" ? sup : null;
  }, 30000);

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
    criteria: [{ id: "c1", description: "Criterion 1", required: true, evidence_expectation: "observed" }],
    required_outputs: [{ id: "o1", description: "Report", kind: "report", required: true }],
    constraints: [], limits: { max_tokens: 50000, max_review_rounds: 1, max_repair_rounds: 0 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
  } as any);
  reviewStore.stateTransition(projectCardId, ["awaiting_contract"], "executing");
  await startReconciler();

  const childCardId = kanbanEnqueue("Restart worker", "agent", undefined, {
    type: "W", priority: "MEDIUM", deliveryMode: "deliver", parent_id: projectCardId,
  });
  activeChildCardIds.push(childCardId);

  const svc = new WorkerSupervisionSvc();
  const createResult = svc.createChild("Restart work", projectCardId, "orc", {
    cardId: childCardId,
    criteria: [{ id: "c1", description: "Restart criterion" }],
    expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/restart.md", required: true, criterion_ids: ["c1"] }], verificationCommands: [], requiredCapabilities: [],
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
  // The settlement chain (session finalize -> criteria verdict -> attempt
  // transition) is async; wait for the terminal lifecycle instead of racing
  // it with a fixed sleep.
  const finalAttempt = await eventually("worker-terminal", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && (a.lifecycle === "completed" || a.lifecycle === "failed" || a.lifecycle === "cancelled" || a.lifecycle === "timed_out") ? a : null;
  }, 20000);

  const afterSettle = readCounts();

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
  const { spin, requestReconcile, requestWorkerDispatch, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore } = await setupEnvironment();
  // Hold the first three executions long enough for the durable capacity
  // assertion to observe the occupancy before any completion frees a slot.
  spin.setRuntime(createMockRuntime(500) as any);

  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools. Plan nodes carry no deadline
  // field and the worker port passes no limits, so short hard deadlines are
  // set on the attempts post-claim (UPDATE worker_attempts — the claim
  // overwrites hard_deadline_at and refuses already-past deadlines, so
  // pre-claim writes cannot work) and driven through the production
  // lease/timeout machinery from there.
  const lanes = [1, 2, 3, 4, 5].map(i => ({ label: `worker-${i}`, instructions: `Worker ${i}` }));
  const proj = await admitRunnerProject(
    { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning },
    {
      title: "Capacity deadline E2E",
      goal: "Capacity deadline test",
      lanes,
    },
  );
  const projectCardId = proj.rootCardId;
  await startReconciler();

  const childCardIds = proj.laneCards();
  if (childCardIds.length !== 5) fail("admission", "NOT_ENOUGH_CHILDREN", `Expected 5 lanes, got ${childCardIds.length}`);
  for (const id of childCardIds) activeChildCardIds.push(id);

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);
  // Later lanes only dispatch on repump: lane completions do not redrive the
  // executor pump by themselves (same interval shape as acceptAndDeliver).
  const repump = setInterval(() => {
    try { proj.pump(); } catch {}
    try { requestWorkerDispatch(); } catch {}
  }, 200);
  try {
    const store = new WorkerSupervisionStore();
    await eventually("three-active", () => {
      const active = store.getActiveAttemptCountForExecutor("agent", "spin-local");
      return active >= 3 ? active : null;
    }, 30000);

    const peakActive = store.getActiveAttemptCountForExecutor("agent", "spin-local");

    // Short hard deadlines on lanes 4-5 (the retired max_duration_ms=2000
    // spawns): catch each claim, backdate the claim-derived deadline, then
    // poke the lease evaluation so the running execution times out mid-flight
    // and its late settlement is rejected as stale.
    const shortIds = childCardIds.slice(3);
    const past = new Date(Date.now() - 5_000).toISOString();
    for (const id of shortIds) {
      const claimed = await awaitLiveClaim(store, id);
      store.db.prepare("UPDATE worker_attempts SET hard_deadline_at = ? WHERE id = ?").run(past, claimed.id);
    }

    await eventually("deadline-settled", () => {
      for (const id of shortIds) requestReconcile(id);
      return shortIds.every(id => store.getLatestAttempt(id)?.lifecycle === "timed_out") || null;
    }, 30000);

    emitCheckpoint("deadline_processed");

    await eventually("all-terminal", () => {
      const all = childCardIds.every(id => {
        const a = store.getLatestAttempt(id);
        return a && store.isAttemptTerminal(a.lifecycle);
      });
      return all || null;
    }, 30000);

    const svc = new (await import("../../components/worker-supervision-service.js")).WorkerSupervisionService();
    const deadlineAttempt = shortIds
      .map(id => store.getLatestAttempt(id))
      .find(attempt => attempt?.hard_deadline_at != null && new Date(attempt.hard_deadline_at).getTime() < Date.now());
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
  } finally {
    clearInterval(repump);
  }
}

async function runPriorityAge(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, requestWorkerDispatch, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore } = await setupEnvironment();
  spin.setRuntime(createMockRuntime() as any);

  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools. Priorities ride the kanban
  // card (the executor pump orders queued workers by effective priority, then
  // age); the aged LOW lane wins its ties by earliest created_at.
  const lanes = [
    { label: "aged-worker", instructions: "Aged low priority work" },
    { label: "high-0", instructions: "High prio worker 0" },
    { label: "high-1", instructions: "High prio worker 1" },
    { label: "high-2", instructions: "High prio worker 2" },
    { label: "high-3", instructions: "High prio worker 3" },
  ];
  const proj = await admitRunnerProject(
    { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning },
    {
      title: "Priority age E2E",
      goal: "Priority age test",
      lanes,
    },
  );
  const projectCardId = proj.rootCardId;
  await startReconciler();

  const childCardIds = proj.laneCards();
  if (childCardIds.length !== 5) fail("admission", "NOT_ENOUGH_CHILDREN", `Expected 5 lanes, got ${childCardIds.length}`);
  for (const id of childCardIds) activeChildCardIds.push(id);

  // The retired aged-LOW shape ported to admitted runner lanes: the first
  // lane is backdated three minutes at LOW so age compensates priority, with
  // two CRITICAL and two HIGH lanes arriving behind it.
  const past = new Date(Date.now() - 180_000).toISOString();
  const db = new WorkerSupervisionStore().db;
  db.prepare("UPDATE kanban_board SET priority = ?, created_at = ? WHERE id = ?").run("LOW", past, childCardIds[0]!);
  const setPriority = db.prepare("UPDATE kanban_board SET priority = ? WHERE id = ?");
  setPriority.run("CRITICAL", childCardIds[1]!);
  setPriority.run("CRITICAL", childCardIds[2]!);
  setPriority.run("HIGH", childCardIds[3]!);
  setPriority.run("HIGH", childCardIds[4]!);
  const backdatedCardId = childCardIds[0]!;

  emitCheckpoint("workers_spawned");
  requestWorkerDispatchFrom(requestReconcile);
  // Later lanes only dispatch on repump: lane completions do not redrive the
  // executor pump by themselves (same interval shape as acceptAndDeliver).
  const repump = setInterval(() => {
    try { proj.pump(); } catch {}
    try { requestWorkerDispatch(); } catch {}
  }, 200);
  try {
    const store = new WorkerSupervisionStore();
    await eventually("backdated-card-started", () => {
      const a = store.getLatestAttempt(backdatedCardId);
      if (a && (a.lifecycle === "running" || a.lifecycle === "claimed" || a.lifecycle === "starting" || a.lifecycle === "completed")) return a;
      return null;
    }, 30000);

    // Settle on a stable started-or-done state for the assertion (claimed and
    // starting are transient on the way to running).
    const agedAttempt = await eventually("backdated-card-running", () => {
      const a = store.getLatestAttempt(backdatedCardId);
      if (a && (a.lifecycle === "running" || a.lifecycle === "completed")) return a;
      return null;
    }, 30000);

    const afterCounts = readCounts();
    return {
      schemaVersion: 2, ok: true, scenario, scenarioId,
      projectCardId, childCardIds,
      peakActiveWorkers: _peakActiveWorkers,
      counts: afterCounts,
      terminal: {},
      scenarioSpecific: {
        agedCardStarted: agedAttempt && (agedAttempt.lifecycle === "running" || agedAttempt.lifecycle === "completed"),
        agedAttemptLifecycle: agedAttempt?.lifecycle,
      },
    };
  } finally {
    clearInterval(repump);
  }
}

async function runTokenBudget(): Promise<LocalSwarmResult> {
  const { spin, requestReconcile, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  spin.setRuntime(createMockRuntime() as any);

  const projectCardId = kanbanEnqueue("Token budget E2E", "test", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver",
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);
  bindProjectWorkspace(projectCardId);

  const db = new WorkerSupervisionStore().db;
  db.prepare("UPDATE kanban_board SET max_tokens = 20000 WHERE id = ?").run(projectCardId);

  await startReconciler();

  const reviewStore = new ProjectReviewStore();
  const rootContractId = `rc_budget_${projectCardId}`;
  reviewStore.ensureAwaitingContract(projectCardId);
  reviewStore.insertContract({
    schema_version: 1, id: rootContractId, project_card_id: projectCardId, digest: `d_${rootContractId}`,
    goal: "Budget capped project",
    criteria: [{ id: "c1", description: "Budget criterion", required: true, evidence_expectation: "observed" }],
    required_outputs: [{ id: "o1", description: "Report", kind: "report", required: true }],
    constraints: [], limits: { max_tokens: 20000, max_review_rounds: 1, max_repair_rounds: 0 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
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
      `Budget work ${i}`, projectCardId, "orc",
      {
        cardId,
        criteria: [{ id: `c_b${i}`, description: `Budget criterion ${i}` }],
        expectedArtifacts: [{ id: `a_b${i}`, kind: "file", ref: `out/budget-${i}.md`, required: true, criterion_ids: [`c_b${i}`] }],
        verificationCommands: [],
        requiredCapabilities: [],
        // #1604: the root contract declares c1 — every supervised child must
        // map at least one root criterion.
        supportsRootCriteria: ["c1"],
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
  const { spin, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, kanbanComplete, ProjectReviewStore } = await setupEnvironment();

  const projectCardId = kanbanEnqueue("Capped scheduled project", "task", undefined, {
    type: "O", priority: "MEDIUM", deliveryMode: "deliver", maxAgents: 4,
  });
  activeProjectCardId = projectCardId;
  kanbanRunning(projectCardId);
  if (kanbanGetCard(projectCardId)?.max_agents !== 4) fail("max_agents", "CAP_NOT_PERSISTED", "max_agents not durably stored");
  // #1644: supervised child creation requires durable project supervision —
  // initialize the root before the cap scenario spawns lanes.
  new ProjectReviewStore().initializeSupervision(projectCardId, `pc_cap_${projectCardId}`, "executing");

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
      expected_artifacts: [{ id: `a${i}`, kind: "file", ref: `out/lane-${i}.md`, required: true, criterion_ids: [`c${i}`] }],
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

// ── #1638 Task 9: Epic 27 Gate A — shared Pi harness ────────────────────────

type PiBehavior = "complete" | "input_request" | "ask_orc_request";

interface PiHarness {
  spin: any;
  requestReconcile: (id: number) => void;
  requestWorkerDispatch: () => void;
  startReconciler: () => void;
  kanbanEnqueue: any;
  kanbanGetCard: any;
  kanbanGetChildren: any;
  kanbanRunning: any;
  WorkerSupervisionStore: any;
  ProjectReviewStore: any;
  piStore: any;
  workerStore: any;
  coordinator: any;
  piConfig: any;
  fakeExecutor: FakePiExecutor;
  service: { store: any; executor: FakePiExecutor; config: any };
  deliverCard: (card: any, deps: any) => Promise<unknown>;
  workspaceAliases: Record<string, string>;
}

/** Shared Fake Pi executor on the REAL PiRunStore: the Pi binary/RPC probe
 * and time are faked; the durable store, binding, workspace claims,
 * settlement coordinator, Worker attempt lifecycle, and review gate stay
 * real. Starts a run (running + durable session file), then after a configurable
 * hold either settles completed through the coordinator or suspends the run
 * for input — the same routes a real Pi binary terminal uses. */
class FakePiExecutor {
  readonly piStore: any;
  readonly config: any;
  readonly maxConcurrent: number;
  activeCount = 0;
  behavior: PiBehavior;
  holdMs: number;
  peakConcurrentByPath = new Map<string, number>();
  private readonly activeByPath = new Map<string, number>();
  private readonly runs = new Map<string, { generation: number; cardId: number }>();
  private readonly askedForInput = new Set<number>();
  private readonly coordinator: any;
  private readonly workerStore: any;
  private onCapacityReleasedCb: (() => void) | null = null;
  private readonly transitionSubs = new Set<(runId: string, from: string | undefined, to: string) => void>();
  private readonly progressSubs = new Set<(runId: string, payload: string, type?: string) => void>();

  constructor(coordinator: any, workerStore: any, piStore: any, config: any, opts: { behavior?: PiBehavior; holdMs?: number }) {
    this.coordinator = coordinator;
    this.workerStore = workerStore;
    this.piStore = piStore;
    this.config = config;
    this.behavior = opts.behavior ?? "complete";
    this.holdMs = opts.holdMs ?? 30;
    this.maxConcurrent = config.maxConcurrent;
  }

  onTransition(cb: (runId: string, from: string | undefined, to: string) => void): () => void {
    this.transitionSubs.add(cb);
    return () => { this.transitionSubs.delete(cb); };
  }

  onProgress(cb: (runId: string, payload: string, type?: string) => void): () => void {
    this.progressSubs.add(cb);
    return () => { this.progressSubs.delete(cb); };
  }

  onCapacityReleased(cb: () => void): void {
    this.onCapacityReleasedCb = cb;
  }

  notifyCapacityReleased(): void {
    this.onCapacityReleasedCb?.();
  }

  setSettlementRouter(): void {}
  // #1643: the production-shaped input-suspension hook (wired per scenario,
  // exactly like boot phase-pi-executor). ask_orc_request behavior delivers
  // the real ask_orc extension_ui_request frame through it.
  inputSuspendHook: ((runId: string, generation: number, request: any) => Promise<boolean>) | null = null;
  setInputSuspendHook(hook: (runId: string, generation: number, request: any) => Promise<boolean>): void {
    this.inputSuspendHook = hook;
  }
  setInterruptRouter(): void {}
  setExternalSessionCloser(): void {}
  cancel: () => Promise<boolean> = async () => true;

  private canonicalPathFor(workspaceAlias: string): string | undefined {
    // Same canonical semantics as resolveAndValidateWorkspace, without the
    // runner's patched globalThis.require (which mis-resolves relative to
    // imported component frames).
    const mapping = this.config.workspaceAliases[workspaceAlias];
    if (!mapping) return undefined;
    try { return realpathSync(mapping.path); } catch { return undefined; }
  }

  async startWithClaim(runId: string, generation: number, sessionId: string): Promise<"started" | "error"> {
    const run = this.piStore.get(runId);
    if (!run || run.executionGeneration !== generation) return "error";
    // Durable session identity for the resumed-retry path: a JSONL session
    // file whose header record matches the persisted session ID (the same
    // bounded header the production validator proves before resuming).
    const sessionFile = join(this.config.sessionStorageRoot, `fake-${runId}-g${generation}.json`);
    try { writeFileSync(sessionFile, `{"type":"session","id":"${sessionId}"}\n`, { flag: "wx" }); } catch { /* already durable */ }
    const started = this.piStore.casTransition(runId, ["starting"], "running", {
      piSessionId: sessionId,
      piSessionFile: sessionFile,
      resumeCapability: "available",
    }, generation);
    if (!started) return "error";
    this.runs.set(runId, { generation, cardId: run.cardId });
    this.activeCount++;
    const canonical = this.canonicalPathFor(run.workspaceAlias);
    if (canonical) {
      const active = (this.activeByPath.get(canonical) ?? 0) + 1;
      this.activeByPath.set(canonical, active);
      this.peakConcurrentByPath.set(canonical, Math.max(this.peakConcurrentByPath.get(canonical) ?? 0, active));
    }
    for (const sub of this.transitionSubs) sub(runId, "starting", "running");
    setTimeout(() => { void this.finishRun(runId, generation); }, this.holdMs);
    return "started";
  }

  private async finishRun(runId: string, generation: number): Promise<void> {
    const run = this.piStore.get(runId);
    if (!run) return this.releaseSlot(runId);
    // #1643: the ask_orc extension emits exactly this frame — method input,
    // title "Ask Orc", the question in placeholder, no timeout. It flows
    // through the production-shaped input-suspension hook exactly like the
    // real executor's _onUiRequest does; the hook owns settlement.
    if (this.behavior === "ask_orc_request" && !this.askedForInput.has(run.cardId) && run.status === "running" && this.inputSuspendHook) {
      this.askedForInput.add(run.cardId);
      const suspended = await this.inputSuspendHook(runId, generation, {
        type: "extension_ui_request",
        id: `ask_${runId}`,
        method: "input",
        title: "Ask Orc",
        placeholder: "Which target branch should this change be based on?",
      });
      if (suspended) this.releaseSlot(runId);
      return;
    }
    if (this.behavior === "input_request" && !this.askedForInput.has(run.cardId) && run.status === "running") {
      this.askedForInput.add(run.cardId);
      this.coordinator.suspendForInput({
        runId, generation,
        question: "Which target branch should this change be based on?",
        requestId: `e2e_req_${runId}`,
        sessionFile: run.piSessionFile,
      });
    } else {
      const boundAttempt = this.workerStore.getAttemptForExecutorResource("pi", runId, generation);
      this.coordinator.settlePiExecution({
        runId, generation, outcome: "completed",
        metadata: { resultSummary: `fake pi completed g${generation}` },
        envelope: boundAttempt ? buildPiEnvelope(this.workerStore, boundAttempt) : undefined,
      });
    }
    this.releaseSlot(runId);
  }

  private releaseSlot(runId: string): void {
    const meta = this.runs.get(runId);
    this.runs.delete(runId);
    this.activeCount = Math.max(0, this.activeCount - 1);
    if (meta) {
      const run = this.piStore.get(runId);
      const canonical = run ? this.canonicalPathFor(run.workspaceAlias) : undefined;
      if (canonical) this.activeByPath.set(canonical, Math.max(0, (this.activeByPath.get(canonical) ?? 1) - 1));
    }
    this.notifyCapacityReleased();
  }
}

/** #1637 Worker result envelope with Pi provenance and real check evidence. */
function buildPiEnvelope(workerStore: any, boundAttempt: any): any {
  // The attempt's OWN contract (not the first row of the card lineage) so a
  // retried attempt names the revised contract id + digest it actually ran.
  const contractRow = workerStore.getContract(boundAttempt.contract_id);
  // #1792: runner-dispatched lanes carry plan-derived criterion ids
  // (`<nodeId>-c<i>`); the envelope must name the contract's own criteria or
  // acceptance fails closed and the W card settles failed instead of done.
  let criterionIds: string[] = ["c1"];
  try {
    const parsed = JSON.parse(contractRow?.contract_json ?? "{}") as { criteria?: Array<{ id?: string }> };
    const ids = (parsed.criteria ?? []).map(c => c?.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length > 0) criterionIds = ids;
  } catch {}
  return {
    schema_version: 1,
    attempt: {
      id: boundAttempt.id, ordinal: boundAttempt.ordinal,
      contract_id: boundAttempt.contract_id,
      contract_digest: contractRow?.contract_digest ?? "d",
      executor_kind: "pi", executor_id: "pi-coding",
      started_at: boundAttempt.started_at, finished_at: new Date().toISOString(),
    },
    outcome: "completed" as const,
    criteria: criterionIds.map(id => ({ criterion_id: id, status: "passed" as const, evidence_ids: ["check_c1"] })),
    checks: [{ check_id: "check_c1", argv: ["node"], started_at: new Date().toISOString(), finished_at: new Date().toISOString(), timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "", stderr_excerpt: "" }],
    artifacts: [],
    worker_report: { summary: "pi coding done", claims: criterionIds.map(id => ({ criterion_id: id, text: "implemented" })), unresolved_risks: [] },
  };
}

/** Install the real production composition with a fake Pi process boundary. */
async function installPiHarness(opts: {
  behavior?: PiBehavior;
  holdMs?: number;
  maxConcurrent?: number;
  aliases?: Record<string, string>;
} = {}): Promise<PiHarness> {
  const { spin, requestReconcile, requestWorkerDispatch, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore, ProjectReviewStore } = await setupEnvironment();
  const { requireTaskDatabase } = await import("../../components/tasks/kanban-board.js");
  const { PiRunStore } = await import("../../components/pi-executor/pi-run-store.js");
  const { SupervisedPiSettlement } = await import("../../components/pi-executor/supervised-pi-settlement.js");
  const { deliverCard } = await import("../../components/tasks/kanban-delivery.js");

  const db = requireTaskDatabase();
  const sessionRoot = join(validatedAbtarsHome, "state", "pi-sessions");
  mkdirSync(sessionRoot, { recursive: true });
  const piStore = new PiRunStore({ db, sessionStorageRoot: sessionRoot });
  const workerStore = new WorkerSupervisionStore(db);

  // Real canonical workspaces under the isolated home; aliases may share a
  // canonical path (scenario 4 uses a symlink alias).
  const wsRoot = join(validatedAbtarsHome, "pi-workspaces");
  mkdirSync(wsRoot, { recursive: true });
  const aliases: Record<string, string> = opts.aliases ?? { "repo-a": join(wsRoot, "ws-a") };
  for (const target of Object.values(aliases)) {
    try { mkdirSync(target, { recursive: true }); } catch { /* already present */ }
  }
  const workspaceAliases: Record<string, { path: string }> = {};
  for (const [alias, target] of Object.entries(aliases)) {
    workspaceAliases[alias] = { path: target };
  }

  const piConfig = {
    enabled: true, command: "fake-pi", fixedArgs: [],
    workspaceAliases,
    allowedEnv: [], maxConcurrent: opts.maxConcurrent ?? 3, maxWallClockMs: 60000, abortGraceMs: 5000,
    projectTrust: "never" as const, sessionStorageRoot: sessionRoot,
  };
  // Mirror the config so contract creation validates the alias against the
  // same configured surface the live service uses.
  writeFileSync(join(validatedAbtarsHome, "config", "pi-executor.json"), JSON.stringify(piConfig));

  const coordinator = new SupervisedPiSettlement(piStore, workerStore, piConfig);
  const fakeExecutor = new FakePiExecutor(coordinator, workerStore, piStore, piConfig, {
    behavior: opts.behavior,
    holdMs: opts.holdMs,
  });
  // #1638 shared post-release wake — same fan-out as boot phase-pi-executor:
  // supervised Worker dispatch plus every queued standalone Pi card.
  fakeExecutor.onCapacityReleased(() => {
    try {
      requestWorkerDispatch();
      for (const cardId of piStore.findQueuedPiCardIds()) requestReconcile(cardId);
    } catch { /* best effort */ }
  });

  const service = { store: piStore, executor: fakeExecutor, config: piConfig };
  // #1554: the Pi service enters the generation through deps.createPiAdapter
  // at start (the scenario's startReconciler call); no global worker-adapter
  // or service override — the Spin lane keeps its own adapter in mixed
  // scenarios.
  _harnessPiService = service;

  return {
    spin, requestReconcile, requestWorkerDispatch, startReconciler,
    kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning,
    WorkerSupervisionStore, ProjectReviewStore,
    piStore, workerStore, coordinator, piConfig, fakeExecutor, service, deliverCard,
    workspaceAliases: Object.fromEntries(Object.entries(aliases).map(([a, p]) => [a, p])),
  };
}

/** #1792: lane cards are plan-driven now — resolve a lane by index. */
function laneCardByIndex(proj: RunnerProject, index: number): number {
  const cards = proj.laneCards();
  const id = cards[index];
  if (id === undefined) fail("spawn_worker", "NO_CHILD", `no lane at index ${index}`);
  activeChildCardIds.push(id as number);
  return id as number;
}

/** Accept on the open review node and deliver the project exactly once. */
async function acceptAndDeliver(h: PiHarness, proj: RunnerProject, _orcContext: { projectCardId: number; projectGeneration: number }): Promise<void> {
  const projectCardId = proj.rootCardId;
  const reviewStore = new h.ProjectReviewStore();
  // #1792: Pi settlement is async outside the dispatch pump (W-card projection
  // fires nerve, joint commit queues review) — re-pump both runner drain and
  // the executor pump until the run is terminal or review is due. The auto-
  // reviewer may already have accepted during pump (review succeeded) — the
  // wait below accepts both queued (needs manual accept) and succeeded
  // (already accepted) as reviewable, and acceptReview is idempotent.
  const repump = setInterval(() => {
    try { proj.pump(); } catch {}
    try { h.requestWorkerDispatch(); } catch {}
  }, 200);
  try {
    await eventually("pi-project-reviewable", () => {
      try { proj.pump(); } catch {}
      // Reviewable when work is done and review is either open (needs accept)
      // or already accepted (auto-reviewer won the race).
      const rev = proj.revision();
      const nodes = proj.store.listNodes(proj.runId, rev);
      const openWork = nodes.some((n: any) => (n["kind"] === "work" || n["kind"] === "synthesis") && (n["status"] === "queued" || n["status"] === "running"));
      if (openWork) return null;
      const openReview = nodes.some((n: any) => n["kind"] === "review" && (n["status"] === "queued" || n["status"] === "running"));
      const doneReview = nodes.some((n: any) => n["kind"] === "review" && n["status"] === "succeeded");
      if (openReview || doneReview) return true;
      // Fallback: run terminal also means reviewable (review may have been
      // superseded or the run failed fast with a useful reason).
      const run = proj.store.getRun(proj.runId);
      if (run && (run.state === "succeeded" || run.state === "failed" || run.state === "cancelled")) return true;
      return null;
    }, 30000);
  } finally {
    clearInterval(repump);
  }
  const childCards = h.kanbanGetChildren(projectCardId);
  if (childCards.length === 0) fail("review_case", "EMPTY_SNAPSHOT", "review has no child lanes");
  proj.acceptReview();
  emitCheckpoint("pi_project_accepted");
  await h.deliverCard(h.kanbanGetCard(projectCardId)!, testDeliverDeps);
  void reviewStore;
}

interface PiProjectCtx {
  h: PiHarness;
  proj: RunnerProject;
  projectCardId: number;
  childCardId: number;
  attempt: any;
  orcContext: { projectCardId: number; projectGeneration: number };
  reviewStore: any;
}

/** Full supervised Pi project flow used by Gate A scenarios 1 and 5. */
async function runSupervisedPiProject(
  opts: { behavior?: PiBehavior; holdMs?: number; maxConcurrent?: number; workspaceAlias?: string },
  afterTerminal?: (ctx: PiProjectCtx) => Promise<void>,
): Promise<LocalSwarmResult> {
  const h = await installPiHarness(opts);
  h.spin.setRuntime(createMockRuntime(100) as any);
  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract tool; the alias routes the lane to Pi via
  // production capability routing (alias as capability).
  const proj = await admitRunnerProject(
    { kanbanEnqueue: h.kanbanEnqueue, kanbanGetCard: h.kanbanGetCard, kanbanGetChildren: h.kanbanGetChildren, kanbanRunning: h.kanbanRunning },
    {
      title: "E2E Pi coding project",
      goal: "Complete the E2E Pi coding scenario",
      lanes: [{ label: "pi-lane", instructions: "Implement the coding task", alias: opts.workspaceAlias ?? "repo-a" }],
    },
  );
  const projectCardId = proj.rootCardId;
  await h.startReconciler();

  const orcContext = makeOrcContext(projectCardId);
  const childCardId = laneCardByIndex(proj, 0);

  const attempts = h.workerStore.getAttemptsForCard(childCardId);
  if (attempts.length !== 1) fail("pi_attempt", "ATTEMPT_COUNT", `attempts=${attempts.length}`);
  const attempt = attempts[0]!;
  if (attempt.executor_kind !== "pi" || attempt.executor_id !== "pi-coding") {
    fail("pi_attempt", "WRONG_EXECUTOR", `${attempt.executor_kind}/${attempt.executor_id}`);
  }

  emitCheckpoint("pi_worker_spawned");
  // #1792: runner drain + executor pump; O-root reconciler wakes are no-ops.
  proj.pump();
  h.requestWorkerDispatch();

  await eventually("pi-attempt-terminal", () => {
    const a = h.workerStore.getAttempt(attempt.id);
    return a && h.workerStore.isAttemptTerminal(a.lifecycle) ? a : null;
  }, 30000);
  // Drive the W-card terminal projection (Pi settlement now owns the W-card
  // transition atomically, but pump once more for the nerve-driven drain) and
  // the runner drain before afterTerminal assertions that expect done.
  try { h.requestWorkerDispatch(); } catch {}
  await new Promise(r => setTimeout(r, 300));
  try { h.requestWorkerDispatch(); } catch {}
  try { proj.pump(); } catch {}

  const reviewStore = new h.ProjectReviewStore();
  const ctx: PiProjectCtx = { h, proj, projectCardId, childCardId, attempt, orcContext, reviewStore };
  if (afterTerminal) await afterTerminal(ctx);

  await acceptAndDeliver(h, proj, orcContext);
  const finalCard = h.kanbanGetCard(projectCardId)!;
  const resultRow = h.workerStore.getResultByAttempt(attempt.id);
  const piRun = h.piStore.getByCardId(childCardId);
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId,
    childCardIds: [childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    scenarioSpecific: {
      piAttemptExecutor: `${attempt.executor_kind}/${attempt.executor_id}`,
      piRunStatus: piRun?.status ?? "missing",
      piProvenance: resultRow?.envelope.attempt.executor_kind ?? "none",
      workspaceClaimsReleased: h.piStore.listWorkspaceClaims().length === 0,
    },
  };
}

// ── Gate A Scenario 1: alias contract → Pi → evidence → exactly-once delivery

async function runPiCoding(): Promise<LocalSwarmResult> {
  const result = await runSupervisedPiProject({ behavior: "complete" });
  return result;
}

// ── Gate A Scenario 2: no-alias contract → existing Spin path unchanged ─────

async function runPiSpinRouting(): Promise<LocalSwarmResult> {
  const h = await installPiHarness({ behavior: "complete" });
  h.spin.setRuntime(createMockRuntime(100) as any);
  // Pi is live and configured, but the lane carries NO workspace_alias:
  // routing is a field read, not a judgment — this must be the existing Spin
  // path with no Pi run, no claim, and no Pi process.
  const proj = await admitRunnerProject(
    { kanbanEnqueue: h.kanbanEnqueue, kanbanGetCard: h.kanbanGetCard, kanbanGetChildren: h.kanbanGetChildren, kanbanRunning: h.kanbanRunning },
    {
      title: "E2E Spin routing project",
      goal: "Complete the E2E Spin routing scenario",
      lanes: [{ label: "spin-lane", instructions: "Implement the coding task" }],
    },
  );
  const projectCardId = proj.rootCardId;
  await h.startReconciler();

  const orcContext = makeOrcContext(projectCardId);
  const childCardId = laneCardByIndex(proj, 0);
  // #1792: runner drain + executor pump; O-root reconciler wakes are no-ops.
  proj.pump();
  h.requestWorkerDispatch();

  const store = new h.WorkerSupervisionStore();
  await eventually("spin-attempt-terminal", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && store.isAttemptTerminal(a.lifecycle) ? a : null;
  }, 30000);
  const attempt = store.getLatestAttempt(childCardId)!;
  const resultRow = store.getResultByAttempt(attempt.id);
  const spinProvenance = resultRow?.envelope.attempt.executor_kind ?? "none";
  if (attempt.executor_kind !== "agent" || attempt.executor_id !== "spin-local") {
    fail("spin_route", "WRONG_EXECUTOR", `${attempt.executor_kind}/${attempt.executor_id}`);
  }
  if (spinProvenance !== "agent") fail("spin_route", "NO_SPIN_PROVENANCE", spinProvenance);
  if (h.piStore.list().length !== 0) fail("spin_route", "PI_RUN_CREATED", "a no-alias contract created a Pi run");
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("spin_route", "CLAIM_CREATED", "a no-alias contract claimed a workspace");
  if (h.fakeExecutor.activeCount !== 0) fail("spin_route", "PI_STARTED", "a no-alias contract started a Pi process");

  await acceptAndDeliver(h, proj, orcContext);
  const reviewStore = new h.ProjectReviewStore();
  const finalCard = h.kanbanGetCard(projectCardId)!;
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId,
    childCardIds: [childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    scenarioSpecific: {
      spinAttemptExecutor: `${attempt.executor_kind}/${attempt.executor_id}`,
      spinProvenance,
      piRunsCreated: h.piStore.list().length,
      workspaceClaims: h.piStore.listWorkspaceClaims().length,
    },
  };
}

// ── Gate A Scenario 3: Pi unavailable → stated failure, no orphans ──────────

async function runPiUnavailable(): Promise<LocalSwarmResult> {
  const { spin, startReconciler, kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning, WorkerSupervisionStore } = await setupEnvironment();
  // Configured aliases exist (contract creation validates them), but no live
  // Pi service is installed — dispatch must settle the coding child as a
  // runtime eligibility failure, never fall back to Spin, never spawn a
  // process, run, claim, or Pi card.
  const wsRoot = join(validatedAbtarsHome, "pi-workspaces");
  mkdirSync(wsRoot, { recursive: true });
  mkdirSync(join(wsRoot, "ws-a"), { recursive: true });
  writeFileSync(join(validatedAbtarsHome, "config", "pi-executor.json"), JSON.stringify({
    enabled: true, command: "fake-pi", fixedArgs: [],
    workspaceAliases: { "repo-a": { path: join(wsRoot, "ws-a") } },
    allowedEnv: [], maxConcurrent: 3, maxWallClockMs: 60000, abortGraceMs: 5000,
    projectTrust: "never", sessionStorageRoot: join(validatedAbtarsHome, "state", "pi-sessions"),
  }));

  spin.setRuntime(createMockRuntime(100) as any);
  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract tool.
  const proj = await admitRunnerProject(
    { kanbanEnqueue, kanbanGetCard, kanbanGetChildren, kanbanRunning },
    {
      title: "E2E Pi unavailable project",
      goal: "Complete the E2E Pi unavailable scenario",
      lanes: [{ label: "pi-lane", instructions: "Implement the coding task", alias: "repo-a" }],
    },
  );
  const projectCardId = proj.rootCardId;
  await startReconciler();

  const childCardId = laneCardByIndex(proj, 0);
  // #1792: runner drain + executor pump settles the Pi eligibility failure;
  // O-root reconciler wakes are no-ops post-cutover.
  proj.pump();
  if (_dispatchPump) _dispatchPump();

  const store = new WorkerSupervisionStore();
  await eventually("pi-eligibility-settled", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && store.isAttemptTerminal(a.lifecycle) ? a : null;
  }, 30000);
  const attempt = store.getLatestAttempt(childCardId)!;

  // No Pi store exists in this composition — assert through the DB directly.
  // The pi_runs / pi_workspace_claims tables may not even exist (their schema
  // is created by PiRunStore); a missing table is itself proof of no orphans.
  const db = store.db;
  const tableCount = (table: string): number => {
    try { return Number((db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c); } catch { return 0; }
  };
  const piRuns = tableCount("pi_runs");
  const claims = tableCount("pi_workspace_claims");
  const piCards = tableCount("kanban_board") === 0
    ? 0
    : Number((db.prepare(`SELECT COUNT(*) as c FROM kanban_board WHERE type = 'pi'`).get() as { c: number }).c);

  if (attempt.lifecycle !== "failed") fail("pi_unavailable", "NOT_FAILED", attempt.lifecycle);
  if (!String(attempt.cancel_reason ?? "").includes("pi_executor_unavailable")) {
    fail("pi_unavailable", "WRONG_REASON", `cancel_reason=${attempt.cancel_reason}`);
  }
  if (attempt.executor_kind !== "pi") fail("pi_unavailable", "SPIN_FALLBACK", `executor=${attempt.executor_kind}/${attempt.executor_id}`);
  if (attempt.executor_resource_id != null) fail("pi_unavailable", "RESOURCE_BOUND", `attempt bound a resource ${attempt.executor_resource_id}`);
  if (piRuns !== 0) fail("pi_unavailable", "RUN_ORPHAN", `pi_runs=${piRuns}`);
  if (claims !== 0) fail("pi_unavailable", "CLAIM_ORPHAN", `claims=${claims}`);
  if (piCards !== 0) fail("pi_unavailable", "CARD_ORPHAN", `pi_cards=${piCards}`);
  const card = kanbanGetCard(childCardId);
  if (card?.status !== "failed") fail("pi_unavailable", "CARD_NOT_FAILED", card?.status ?? "missing");

  const resultRow = store.getResultByAttempt(attempt.id);
  if (!resultRow) fail("pi_unavailable", "NO_RESULT", "no failure evidence persisted");

  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId, childCardIds: [childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: { cardStatus: card?.status },
    scenarioSpecific: {
      attemptLifecycle: attempt.lifecycle,
      failureReason: attempt.cancel_reason,
      executor: `${attempt.executor_kind}/${attempt.executor_id}`,
      piRuns, claims, piCards,
      cardStatus: card?.status,
    },
  };
}

// ── Gate A Scenario 4: same canonical workspace → waiter defers, then starts ─

async function runPiWorkspaceContention(): Promise<LocalSwarmResult> {
  const wsRoot = join(validatedAbtarsHome, "pi-workspaces");
  mkdirSync(wsRoot, { recursive: true });
  const wsA = join(wsRoot, "ws-a");
  mkdirSync(wsA, { recursive: true });
  // Alias synonym: repo-b resolves to the SAME canonical path as repo-a.
  const wsB = join(wsRoot, "ws-b");
  try { symlinkSync(wsA, wsB); } catch { /* already linked */ }

  const h = await installPiHarness({
    behavior: "complete",
    holdMs: 250,
    maxConcurrent: 2,
    aliases: { "repo-a": wsA, "repo-b": wsB },
  });
  h.spin.setRuntime(createMockRuntime(100) as any);
  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools; aliases route both lanes.
  const proj = await admitRunnerProject(
    { kanbanEnqueue: h.kanbanEnqueue, kanbanGetCard: h.kanbanGetCard, kanbanGetChildren: h.kanbanGetChildren, kanbanRunning: h.kanbanRunning },
    {
      title: "E2E workspace contention project",
      goal: "Complete the E2E workspace contention scenario",
      lanes: [
        { label: "coder-a", instructions: "Coder A", alias: "repo-a" },
        { label: "coder-b", instructions: "Coder B", alias: "repo-b" },
      ],
    },
  );
  const projectCardId = proj.rootCardId;
  await h.startReconciler();

  const orcContext = makeOrcContext(projectCardId);
  const childA = laneCardByIndex(proj, 0);
  const childB = laneCardByIndex(proj, 1);
  // #1792: runner drain + executor pump; O-root reconciler wakes are no-ops.
  proj.pump();
  h.requestWorkerDispatch();

  const store = new h.WorkerSupervisionStore();
  // While the first run holds the canonical workspace, the second attempt must
  // return to pending (deferred) without settling or spending a retry.
  await eventually("first-run-running", () => {
    const a = store.getLatestAttempt(childA);
    return a && a.lifecycle === "running" ? a : null;
  }, 10000);
  const attemptBWhileBusy = store.getLatestAttempt(childB);
  if (!attemptBWhileBusy || attemptBWhileBusy.lifecycle !== "pending") {
    fail("contention", "NOT_DEFERRED", `B lifecycle while A held workspace: ${attemptBWhileBusy?.lifecycle ?? "missing"}`);
  }
  if (store.getAttemptsForCard(childB).length !== 1) {
    fail("contention", "RETRY_SPENT", `B consumed a retry (${store.getAttemptsForCard(childB).length} attempts)`);
  }

  // After A releases, B starts and both complete; peak concurrency on the
  // shared canonical path never exceeded one.
  await eventually("both-terminal", () => {
    const all = [childA, childB].every(id => {
      const a = store.getLatestAttempt(id);
      return a && store.isAttemptTerminal(a.lifecycle);
    });
    return all || null;
  }, 30000);
  for (const childId of [childA, childB]) {
    const a = store.getLatestAttempt(childId);
    if (a?.lifecycle !== "completed") fail("contention", "NOT_COMPLETED", `child ${childId}: ${a?.lifecycle ?? "missing"}`);
  }
  const peakForPath = Math.max(...h.fakeExecutor.peakConcurrentByPath.values(), 0);
  if (peakForPath > 1) fail("contention", "OVERLAP", `peak concurrent runs on one canonical path: ${peakForPath}`);
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("contention", "CLAIM_LEAK", "workspace claims not released");

  await acceptAndDeliver(h, proj, orcContext);
  const reviewStore = new h.ProjectReviewStore();
  const finalCard = h.kanbanGetCard(projectCardId)!;
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId,
    childCardIds: [childA, childB],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    scenarioSpecific: {
      attemptBWhileBusy: attemptBWhileBusy.lifecycle,
      attemptsForB: store.getAttemptsForCard(childB).length,
      peakConcurrentPerPath: peakForPath,
      claimsReleased: h.piStore.listWorkspaceClaims().length === 0,
    },
  };
}

// ── Gate A Scenario 4b (#1648): shared capacity one, standalone survives drain

async function runPiStandaloneCapacity(): Promise<LocalSwarmResult> {
  const h = await installPiHarness({ behavior: "complete", holdMs: 250, maxConcurrent: 1 });
  h.spin.setRuntime(createMockRuntime(100) as any);
  await h.startReconciler();

  const first = h.piStore.createPiCardAndRun({
    runId: `e2e_standalone_${Date.now()}_a`, sessionId: "s1", title: "Standalone pi 1",
    goal: "Complete standalone task one", workspaceAlias: "repo-a",
    ownerPrincipalId: "user:test", origin: "user", priority: "MEDIUM",
  });
  const second = h.piStore.createPiCardAndRun({
    runId: `e2e_standalone_${Date.now()}_b`, sessionId: "s2", title: "Standalone pi 2",
    goal: "Complete standalone task two", workspaceAlias: "repo-a",
    ownerPrincipalId: "user:test", origin: "user", priority: "MEDIUM",
  });
  activeChildCardIds.push(first.cardId, second.cardId);

  h.requestReconcile(first.cardId);
  h.requestReconcile(second.cardId);

  // First starts; the second must keep run AND card paired in queued while the
  // shared process cap is held — no process, no claim.
  await eventually("first-running", () => {
    const run = h.piStore.get(first.runId);
    return run && run.status === "running" ? run : null;
  }, 10000);
  const secondRunWhileBusy = h.piStore.get(second.runId);
  const secondCardWhileBusy = h.kanbanGetCard(second.cardId);
  if (secondRunWhileBusy?.status !== "queued") {
    fail("standalone_cap", "RUN_NOT_QUEUED", `run status=${secondRunWhileBusy?.status}`);
  }
  if (secondCardWhileBusy?.status !== "queued") {
    fail("standalone_cap", "CARD_NOT_QUEUED", `card status=${secondCardWhileBusy?.status}`);
  }

  // The Spin legacy drain must neither dispatch nor fail the queued Pi card.
  const { createExecutionSupervisor } = await import("../../components/execution-control.js");
  const sup = createExecutionSupervisor({ maxConcurrent: {} });
  sup.drainLegacyQueued(() => {});
  const afterDrain = h.piStore.get(second.runId);
  const afterDrainCard = h.kanbanGetCard(second.cardId);
  if (afterDrain?.status !== "queued" || afterDrainCard?.status !== "queued") {
    fail("standalone_cap", "DRAIN_TOUCHED", `after drain run=${afterDrain?.status} card=${afterDrainCard?.status}`);
  }

  // First settles → release wake starts the second without restart or an
  // unrelated card event.
  await eventually("second-terminal", () => {
    const run = h.piStore.get(second.runId);
    return run && run.status === "completed" ? run : null;
  }, 30000);
  const firstFinal = h.piStore.get(first.runId);
  if (firstFinal?.status !== "completed") fail("standalone_cap", "FIRST_NOT_DONE", firstFinal?.status ?? "missing");
  if (h.kanbanGetCard(first.cardId)?.status !== "done") fail("standalone_cap", "FIRST_CARD_NOT_DONE", h.kanbanGetCard(first.cardId)?.status ?? "missing");
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("standalone_cap", "CLAIM_LEAK", "workspace claim leaked");

  return {
    schemaVersion: 2, ok: true, scenario, scenarioId,
    projectCardId: first.cardId,
    childCardIds: [first.cardId, second.cardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {},
    scenarioSpecific: {
      secondRunWhileBusy: secondRunWhileBusy?.status,
      secondCardWhileBusy: secondCardWhileBusy?.status,
      survivedDrain: afterDrain?.status === "queued" && afterDrainCard?.status === "queued",
      secondFinalStatus: h.piStore.get(second.runId)?.status,
      secondCardFinalStatus: h.kanbanGetCard(second.cardId)?.status,
      firstFinalStatus: firstFinal?.status,
    },
  };
}

// ── Gate A Scenario 5: terminal replay + stale generation settle exactly once

async function runPiReplayStale(): Promise<LocalSwarmResult> {
  const result = await runSupervisedPiProject({ behavior: "complete" }, async (ctx) => {
    const { h, childCardId, attempt } = ctx;
    const run = h.piStore.getByCardId(childCardId)!;
    const terminalInput = {
      runId: run.id,
      generation: run.executionGeneration,
      outcome: "completed" as const,
      metadata: { resultSummary: "fake pi completed" },
      envelope: buildPiEnvelope(h.workerStore, h.workerStore.getAttemptForExecutorResource("pi", run.id, run.executionGeneration)),
    };
    const before = readCounts();

    // Exact replay of the terminal observation: replayed, no second result,
    // no second charge, no card re-transition.
    const replay = h.coordinator.settlePiExecution(terminalInput);
    if (replay.kind !== "replayed") fail("replay", "NOT_REPLAYED", JSON.stringify(replay));
    const afterReplay = readCounts();
    if (JSON.stringify(before) !== JSON.stringify(afterReplay)) {
      fail("replay", "DOUBLE_SETTLE", `counts changed on replay: ${JSON.stringify(before)} -> ${JSON.stringify(afterReplay)}`);
    }
    const replayedAttempt = h.workerStore.getAttempt(attempt.id);
    if (replayedAttempt && replayedAttempt.charged_tokens !== attempt.charged_tokens) {
      fail("replay", "DOUBLE_CHARGE", `charged ${attempt.charged_tokens} -> ${replayedAttempt.charged_tokens}`);
    }

    // Stale generation (a superseded Pi generation that never existed): the
    // binding lookup fails and a supervised run must fail closed — stale.
    const stale = h.coordinator.settlePiExecution({ ...terminalInput, generation: run.executionGeneration + 1 });
    if (stale.kind !== "stale") fail("replay", "NOT_STALE", JSON.stringify(stale));
    const afterStale = readCounts();
    if (JSON.stringify(afterReplay) !== JSON.stringify(afterStale)) {
      fail("replay", "STALE_MUTATED", `counts changed on stale observation: ${JSON.stringify(afterReplay)} -> ${JSON.stringify(afterStale)}`);
    }

    // The run row stayed terminal at the ORIGINAL generation — no re-write.
    const runAfter = h.piStore.get(run.id);
    if (runAfter?.status !== "completed" || runAfter.executionGeneration !== run.executionGeneration) {
      fail("replay", "RUN_MUTATED", `status=${runAfter?.status} gen=${runAfter?.executionGeneration}`);
    }
    const cardAfter = h.kanbanGetCard(childCardId);
    if (cardAfter?.status !== "done") fail("replay", "CARD_RE_TRANSITIONED", cardAfter?.status ?? "missing");

    // A supervised Pi run must never settle through the standalone card path.
    const standaloneSettle = h.piStore.settleTerminal({
      runId: run.id,
      generation: run.executionGeneration,
      expectedStatuses: ["completed"],
      outcome: "completed",
      metadata: { resultSummary: "x" },
    });
    if (standaloneSettle.committed) fail("replay", "STANDALONE_SETTLE", "supervised run settled through standalone path");
  });
  return result;
}

// ── Gate A Scenario 6: input request → zero charge → Orc answer → resumed ───

async function runPiInputAnswer(): Promise<LocalSwarmResult> {
  const h = await installPiHarness({ behavior: "input_request", holdMs: 150 });
  // The sibling lane runs long enough that the question is asked, answered,
  // and the retry completes while the project is still executing — the real
  // "a worker asks Orc for help while other lanes run" flow. The review case
  // only opens once ALL children are terminal.
  h.spin.setRuntime(createMockRuntime(4000) as any);
  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools.
  const proj = await admitRunnerProject(
    { kanbanEnqueue: h.kanbanEnqueue, kanbanGetCard: h.kanbanGetCard, kanbanGetChildren: h.kanbanGetChildren, kanbanRunning: h.kanbanRunning },
    {
      title: "E2E Pi input answer project",
      goal: "Complete the E2E Pi input answer scenario",
      lanes: [
        { label: "sibling-researcher", instructions: "Sibling Researcher" },
        { label: "pi-coder", instructions: "Pi Coder", alias: "repo-a" },
      ],
    },
  );
  const projectCardId = proj.rootCardId;
  await h.startReconciler();

  const orcContext = makeOrcContext(projectCardId);
  // Sibling spin lane first (still running while the question is answered);
  // then the coding worker that stops to ask.
  const siblingCardId = laneCardByIndex(proj, 0);
  const childCardId = laneCardByIndex(proj, 1);
  // #1792: runner drain + executor pump; O-root reconciler wakes are no-ops.
  proj.pump();
  h.requestWorkerDispatch();

  const store = new h.WorkerSupervisionStore();
  const reviewStore = new h.ProjectReviewStore();
  // The live question settles the attempt as failed/input_requested: structured
  // evidence, zero charge, no held slot, no consumed retry reservation.
  await eventually("input-requested", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && a.lifecycle === "failed" ? a : null;
  }, 30000);
  const attempt1 = store.getLatestAttempt(childCardId)!;
  if (!String(attempt1.cancel_reason ?? "").includes("pi_input_requested")) {
    fail("input_answer", "WRONG_REASON", `cancel_reason=${attempt1.cancel_reason}`);
  }
  if (attempt1.charged_tokens !== 0) fail("input_answer", "CHARGED", `charged ${attempt1.charged_tokens} tokens for a question`);
  const result1 = store.getResultByAttempt(attempt1.id);
  if (result1?.envelope?.error?.code !== "INPUT_REQUESTED") {
    fail("input_answer", "NO_QUESTION", JSON.stringify(result1?.envelope ?? null));
  }
  const runAfterQuestion = h.piStore.getByCardId(childCardId)!;
  if (runAfterQuestion.status !== "interrupted") fail("input_answer", "NOT_INTERRUPTED", runAfterQuestion.status);
  if (runAfterQuestion.resumeCapability !== "available") fail("input_answer", "NOT_RESUMABLE", runAfterQuestion.resumeCapability);
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("input_answer", "SLOT_HELD", "workspace claim still held after suspension");
  if (store.getAttemptsForCard(childCardId).length !== 1) fail("input_answer", "AUTO_RETRY", "input_requested was auto-retried instead of reviewed");
  // The sibling is still running: the project must NOT have parked in review
  // (its answer-retry stays dispatchable at the same project generation).
  // #1792: review cases are gone with the driver — the equivalent is that no
  // review verdict is due while a lane still runs.
  if (proj.reviewNodeId() !== undefined) fail("input_answer", "EARLY_REVIEW", "review verdict due while a lane still ran");

  // Orc reviews the failure and answers; the retry must allocate (not
  // stale_source) and the card returns to queued for re-dispatch.
  const reviewResult = await reviewFailureWithAnswer({
    projectCardId,
    attemptId: attempt1.id,
    inputAnswer: "Target branch is main.",
    rationale: "The worker asked a legitimate question.",
  });
  if (!reviewResult.includes("Retry directive created")) fail("input_answer", "RETRY_REJECTED", reviewResult);

  // #1792: runner drain + executor pump for the resumed retry.
  proj.pump();
  h.requestWorkerDispatch();

  // The retry binds the SAME run row at generation 2 with visible resumed
  // continuity, runs, and completes.
  await eventually("answer-completed", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && store.isAttemptTerminal(a.lifecycle) ? a : null;
  }, 30000);
  const attempt2 = store.getLatestAttempt(childCardId)!;
  if (attempt2.id === attempt1.id || attempt2.ordinal !== 2) fail("input_answer", "NO_RETRY", `latest=${attempt2.id} ordinal=${attempt2.ordinal}`);
  if (attempt2.lifecycle !== "completed") fail("input_answer", "RETRY_NOT_COMPLETED", attempt2.lifecycle);
  const binding = store.getExecutorResourceBinding(attempt2.id);
  if (!binding || binding.continuity !== "resumed") {
    fail("input_answer", "NOT_RESUMED", `continuity=${binding?.continuity}`);
  }
  const runFinal = h.piStore.getByCardId(childCardId)!;
  if (runFinal.executionGeneration !== 2 || runFinal.status !== "completed") {
    fail("input_answer", "RUN_NOT_RESUMED", `gen=${runFinal.executionGeneration} status=${runFinal.status}`);
  }
  const result2 = store.getResultByAttempt(attempt2.id);
  if (result2?.envelope?.attempt?.executor_kind !== "pi") fail("input_answer", "NO_PI_PROVENANCE", "retry result lost Pi provenance");
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("input_answer", "CLAIM_LEAK", "workspace claim leaked after retry");

  // Once the sibling finishes too, the project reviews normally and delivers.
  await acceptAndDeliver(h, proj, orcContext);
  const finalCard = h.kanbanGetCard(projectCardId)!;
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId,
    childCardIds: [siblingCardId, childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    scenarioSpecific: {
      firstLifecycle: attempt1.lifecycle,
      chargedTokens: attempt1.charged_tokens,
      questionEvidenceCode: result1?.envelope?.error?.code,
      runStatusAfterQuestion: runAfterQuestion.status,
      resumeCapability: runAfterQuestion.resumeCapability,
      attempts: store.getAttemptsForCard(childCardId).length,
      retryContinuity: binding?.continuity,
      retryGeneration: runFinal.executionGeneration,
      retryRunStatus: runFinal.status,
    },
  };
}

// ── #1643: ask_orc frame → #1638 suspension → Orc answer → resumed retry ────

async function runPiAskOrc(): Promise<LocalSwarmResult> {
  const h = await installPiHarness({ behavior: "ask_orc_request", holdMs: 150 });
  h.spin.setRuntime(createMockRuntime(4000) as any);
  // #1643: wire the production-shaped input-suspension hook exactly like boot
  // phase-pi-executor — placeholder carries the question for input dialogs.
  h.fakeExecutor.setInputSuspendHook(async (runId: string, generation: number, request: any) => {
    const run = h.piStore.get(runId);
    if (!run) return false;
    const binding = h.workerStore.getAttemptForExecutorResource("pi", runId, generation);
    if (!binding) return false;
    const req = request as { method?: string; message?: unknown; title?: unknown; placeholder?: unknown };
    const primary = req.method === "input" ? req.placeholder : req.message;
    const question = String(primary ?? req.title ?? "input requested");
    const outcome = h.coordinator.suspendForInput({
      runId, generation, question,
      requestId: request.id ?? `req_${Date.now()}`,
      sessionFile: run.piSessionFile ?? undefined,
    });
    if (outcome.suspended) {
      try { h.requestWorkerDispatch(); } catch { /* best effort */ }
    }
    return outcome.suspended;
  });

  // #1792: production admission + scripted plan instead of the retired
  // define_project_contract/spawn_worker tools.
  const proj = await admitRunnerProject(
    { kanbanEnqueue: h.kanbanEnqueue, kanbanGetCard: h.kanbanGetCard, kanbanGetChildren: h.kanbanGetChildren, kanbanRunning: h.kanbanRunning },
    {
      title: "E2E Pi ask-orc project",
      goal: "Complete the E2E Pi ask-orc scenario",
      lanes: [
        { label: "sibling-researcher", instructions: "Sibling Researcher" },
        { label: "pi-coder", instructions: "Pi Coder", alias: "repo-a" },
      ],
    },
  );
  const projectCardId = proj.rootCardId;
  await h.startReconciler();

  const orcContext = makeOrcContext(projectCardId);
  const siblingCardId = laneCardByIndex(proj, 0);
  const childCardId = laneCardByIndex(proj, 1);
  // #1792: runner drain + executor pump; O-root reconciler wakes are no-ops.
  proj.pump();
  h.requestWorkerDispatch();

  const store = new h.WorkerSupervisionStore();
  const reviewStore = new h.ProjectReviewStore();
  // The real ask_orc frame settles the attempt once as zero-charge
  // input_requested with the PLACEHOLDER question in failure evidence.
  await eventually("ask-orc-requested", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && a.lifecycle === "failed" ? a : null;
  }, 30000);
  const attempt1 = store.getLatestAttempt(childCardId)!;
  if (!String(attempt1.cancel_reason ?? "").includes("pi_input_requested")) {
    fail("ask_orc", "WRONG_REASON", `cancel_reason=${attempt1.cancel_reason}`);
  }
  if (attempt1.charged_tokens !== 0) fail("ask_orc", "CHARGED", `charged ${attempt1.charged_tokens} tokens for a question`);
  const result1 = store.getResultByAttempt(attempt1.id);
  if (result1?.envelope?.error?.code !== "INPUT_REQUESTED") {
    fail("ask_orc", "NO_QUESTION", JSON.stringify(result1?.envelope ?? null));
  }
  const questionEvidence = String(result1?.envelope?.error?.message ?? "");
  if (!questionEvidence.includes("Which target branch should this change be based on?")) {
    fail("ask_orc", "WRONG_QUESTION", `evidence carried title instead of placeholder: ${questionEvidence.slice(0, 200)}`);
  }
  const runAfterQuestion = h.piStore.getByCardId(childCardId)!;
  if (runAfterQuestion.status !== "interrupted") fail("ask_orc", "NOT_INTERRUPTED", runAfterQuestion.status);
  if (runAfterQuestion.resumeCapability !== "available") fail("ask_orc", "NOT_RESUMABLE", runAfterQuestion.resumeCapability);
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("ask_orc", "SLOT_HELD", "workspace claim still held after suspension");
  if (store.getAttemptsForCard(childCardId).length !== 1) fail("ask_orc", "AUTO_RETRY", "input_requested was auto-retried instead of reviewed");
  // #1792: review cases are gone with the driver — the equivalent is that no
  // review verdict is due while a lane still runs.
  if (proj.reviewNodeId() !== undefined) fail("ask_orc", "EARLY_REVIEW", "review verdict due while a lane still ran");

  // Orc answers through the intact retry-service path; the retry
  // resumes the durable session at generation 2.
  const reviewResult = await reviewFailureWithAnswer({
    projectCardId,
    attemptId: attempt1.id,
    inputAnswer: "Target branch is main.",
    rationale: "The worker asked a legitimate question.",
  });
  if (!reviewResult.includes("Retry directive created")) fail("ask_orc", "RETRY_REJECTED", reviewResult);

  // #1792: runner drain + executor pump for the resumed retry.
  proj.pump();
  h.requestWorkerDispatch();

  await eventually("ask-orc-answered", () => {
    const a = store.getLatestAttempt(childCardId);
    return a && store.isAttemptTerminal(a.lifecycle) ? a : null;
  }, 30000);
  const attempt2 = store.getLatestAttempt(childCardId)!;
  if (attempt2.id === attempt1.id || attempt2.ordinal !== 2) fail("ask_orc", "NO_RETRY", `latest=${attempt2.id} ordinal=${attempt2.ordinal}`);
  if (attempt2.lifecycle !== "completed") fail("ask_orc", "RETRY_NOT_COMPLETED", attempt2.lifecycle);
  const binding = store.getExecutorResourceBinding(attempt2.id);
  if (!binding || binding.continuity !== "resumed") {
    fail("ask_orc", "NOT_RESUMED", `continuity=${binding?.continuity}`);
  }
  const runFinal = h.piStore.getByCardId(childCardId)!;
  if (runFinal.executionGeneration !== 2 || runFinal.status !== "completed") {
    fail("ask_orc", "RUN_NOT_RESUMED", `gen=${runFinal.executionGeneration} status=${runFinal.status}`);
  }
  const result2 = store.getResultByAttempt(attempt2.id);
  if (result2?.envelope?.attempt?.executor_kind !== "pi") fail("ask_orc", "NO_PI_PROVENANCE", "retry result lost Pi provenance");
  if (h.piStore.listWorkspaceClaims().length !== 0) fail("ask_orc", "CLAIM_LEAK", "workspace claim leaked after retry");

  await acceptAndDeliver(h, proj, orcContext);
  const finalCard = h.kanbanGetCard(projectCardId)!;
  return {
    schemaVersion: 2, ok: true, scenario, scenarioId, projectCardId,
    childCardIds: [siblingCardId, childCardId],
    peakActiveWorkers: _peakActiveWorkers,
    counts: readCounts(),
    terminal: {
      projectState: reviewStore.getSupervision(projectCardId)?.state ?? "unknown",
      cardStatus: finalCard?.status ?? "unknown",
      deliveryResult: finalCard?.delivery_result ?? "unknown",
    },
    scenarioSpecific: {
      firstLifecycle: attempt1.lifecycle,
      chargedTokens: attempt1.charged_tokens,
      questionEvidenceCode: result1?.envelope?.error?.code,
      questionFromPlaceholder: questionEvidence.includes("Which target branch should this change be based on?"),
      runStatusAfterQuestion: runAfterQuestion.status,
      resumeCapability: runAfterQuestion.resumeCapability,
      attempts: store.getAttemptsForCard(childCardId).length,
      retryContinuity: binding?.continuity,
      retryGeneration: runFinal.executionGeneration,
      retryRunStatus: runFinal.status,
    },
  };
}

// ── Emergency Gate B (#1468) ─────────────────────────────────────────────────

/**
 * Proves the shipped emergency fast path at its production boundary: normal
 * response transport unavailable (transportless boot), Pi runtime packages
 * unavailable (pi-load-guard makes any load throw and fail the child), and a
 * deterministic fake ACP CLI as the only external fixture. Real: degraded
 * recovery routing, emergency service lifecycle, schema-v3 config loading,
 * dedicated ACP client, and platform delivery.
 */
async function runEmergencyGateB(): Promise<LocalSwarmResult> {
  const { mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { createBootCtx } = await import("../../boot/context.js");
  const { createRecoveryHandler } = await import("../../boot/phase-platforms-connect.js");
  const { createEmergencyExecutionService } = await import("../../components/emergency-execution-service.js");

  const home = validatedAbtarsHome;
  const workingDir = join(home, "workspace", "emergency");
  mkdirSync(workingDir, { recursive: true });

  // Deterministic fake — the ACP CLI/protocol boundary. Production config
  // loading, recovery dispatch, service lifecycle, and delivery stay real.
  const fakeCli = join(process.cwd(), "src/tests/e2e/fake-kiro-cli.js");
  if (!existsSync(fakeCli)) fail("emergency_gate_b", "FAKE_CLI_MISSING", fakeCli);

  writeFileSync(join(home, "config", "transport.json"), JSON.stringify({
    schemaVersion: 3,
    activeRoute: "acp",
    routes: { acp: { agents: { main: { model: "fake-main-model", provider: "fake-acp" } } } },
    providers: { "fake-acp": { transport: "acp", cli: fakeCli } },
    hailMary: { route: "acp", model: "fake-emergency-model", provider: "fake-acp" },
  }, null, 2));

  // Transportless boot: ctx.transport stays null, pipelineDeps never runs —
  // the recovery handler is the only inbound boundary, exactly like a degraded
  // boot after normal transport initialization failed.
  const ctx = createBootCtx({
    config: { transport: { workingDir } } as never,
    phaseHealth: new Map([["transport", { status: "failed", error: "test fixture: no normal transport" }]]),
  });
  ctx.emergencyExecution = createEmergencyExecutionService(workingDir);
  const emergencyService = ctx.emergencyExecution;

  const recovery = createRecoveryHandler(ctx);

  const deliveries: string[] = [];
  const adapter = {
    sendMessage: async (_channelId: string, text: string) => { deliveries.push(text); return "sent"; },
    sendDocument: async () => "sent",
    chunkResponse: (text: string) => (text.length <= 120 ? [text] : [text.slice(0, 120), text.slice(120)]),
    sendTyping: async () => {},
  } as unknown as import("../../types/platform.js").PlatformAdapter;

  const msg = (text: string): import("../../types/platform.js").InboundMessage => ({
    platform: "telegram",
    channelId: "200",
    userId: "test-master",
    senderId: "test-master",
    senderName: "Test Master",
    text,
    timestamp: Date.now(),
    isGroup: false,
    isVoice: false,
  });

  // 1. Activate through the production recovery routing.
  await recovery.handle(msg("/emergency"), adapter);
  if (emergencyService.status().kind !== "ready") {
    fail("emergency_gate_b", "ACTIVATION_FAILED", deliveries.join(" | "));
  }
  emitCheckpoint("emergency_activated", { model: emergencyService.describeForOperator() ?? "" });

  // 2. One plain-text turn → exactly one deterministic ACP response. A second
  //    concurrent turn must be rejected busy (fake CLI delays 300ms).
  const firstTurn = recovery.handle(msg("hello emergency"), adapter);
  await eventually("emergency-running", () => (emergencyService.status().kind === "running" ? true : null), 5000);
  const secondTurn = recovery.handle(msg("second turn while running"), adapter);
  await firstTurn;
  await secondTurn;
  const ackDeliveries = deliveries.filter(d => d.startsWith("EMERGENCY_ACK"));
  if (ackDeliveries.length !== 1) {
    fail("emergency_gate_b", "NOT_EXACTLY_ONE_RESPONSE", `acks=${ackDeliveries.length} all=${deliveries.join("|")}`);
  }
  const busyRejected = deliveries.some(d => d.includes("already running"));
  emitCheckpoint("emergency_turn_delivered", { acks: ackDeliveries.length, busyRejected });

  // 3. No Spin session was ever created; no memory files were ever written.
  const { spin } = await import("../../components/spin.js");
  if (spin.listAllSessions().length !== 0) {
    fail("emergency_gate_b", "SPIN_SESSION_CREATED", `${spin.listAllSessions().length} session(s)`);
  }
  if (existsSync(join(home, "memory", "memory.db"))) {
    fail("emergency_gate_b", "MEMORY_WRITE", "memory.db exists after emergency turn");
  }

  // 4. Interrupt and restore through the recovery routing.
  await recovery.handle(msg("/stop"), adapter);
  if (emergencyService.status().kind !== "ready") {
    fail("emergency_gate_b", "INTERRUPT_FAILED", emergencyService.status().kind);
  }
  await recovery.handle(msg("/model restore"), adapter);
  if (emergencyService.status().kind !== "inactive") {
    fail("emergency_gate_b", "RESTORE_FAILED", emergencyService.status().kind);
  }

  // 5. Shutdown cleanup — no orphan ACP child may survive. SIGTERM delivery
  //    is asynchronous, so poll: a live child after 5s is an orphan.
  await emergencyService.shutdown();
  const pidFile = join(home, "run", "fake-kiro-cli.pid");
  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf8"), 10);
    await eventually("acp-child-gone", () => {
      try { process.kill(pid, 0); return null; } catch { return true; }
    }, 5000);
  }

  // 6. After restore, ordinary traffic keeps the unchanged degraded behavior
  //    (queued by the recovery handler — never sent to ACP).
  const queuedBefore = (recovery as { messageQueue: unknown[] }).messageQueue.length;
  await recovery.handle(msg("after restore"), adapter);
  const queuedAfter = (recovery as { messageQueue: unknown[] }).messageQueue.length;
  if (queuedAfter !== queuedBefore + 1) {
    fail("emergency_gate_b", "RESTORE_ROUTING_CHANGED", `queued ${queuedBefore} → ${queuedAfter}`);
  }

  return {
    schemaVersion: 2,
    ok: true,
    scenario,
    scenarioId,
    childCardIds: [],
    peakActiveWorkers: 0,
    counts: {
      workerContracts: 0, workerAttempts: 0, workerResults: 0,
      reviewCases: 0, reviewDecisions: 0, outboundDeliveries: 0,
    },
    terminal: {},
    scenarioSpecific: {
      deliveries: deliveries.length,
      acks: ackDeliveries.length,
      busyRejected,
      sessionsCreated: 0,
      memoryWrites: 0,
      orphanAcpChild: false,
      restoredQueuing: true,
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
      case "pi_coding":
        result = await runPiCoding();
        break;
      case "pi_spin_route":
        result = await runPiSpinRouting();
        break;
      case "pi_unavailable":
        result = await runPiUnavailable();
        break;
      case "pi_workspace_contention":
        result = await runPiWorkspaceContention();
        break;
      case "pi_standalone_capacity":
        result = await runPiStandaloneCapacity();
        break;
      case "pi_replay_stale":
        result = await runPiReplayStale();
        break;
      case "pi_input_answer":
        result = await runPiInputAnswer();
        break;
      case "pi_ask_orc":
        result = await runPiAskOrc();
        break;
      case "emergency_gate_b":
        result = await runEmergencyGateB();
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
  // When stdout is a pipe (as it is from the Vitest parent), an immediate
  // process.exit can discard this final acceptance record before the pipe has
  // flushed. Keep the marker observable, then force-exit with the intended
  // status once the write callback confirms the pipe accepted it.
  process.stdout.write("LOCAL_SWARM_RESULT=" + JSON.stringify(result) + "\n", () => {
    process.exit(result.ok ? 0 : 1);
  });
});
