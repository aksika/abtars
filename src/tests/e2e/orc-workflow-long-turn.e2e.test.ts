/**
 * orc-workflow-long-turn.e2e.test.ts — #1793 Task 1: composed diagnosis harness.
 *
 * Composes the production boundaries for scheduled supervised runs end to end:
 * real scheduled occurrence (reserveRun) + real ScheduledRunCoordinator with
 * the real scheduledProjectRunner and the real card-to-occurrence projection
 * wiring; real WorkflowRunner/WorkflowStore via startWorkflowDriver; real
 * reconciler generation with the real executor-lease store, lease due source,
 * and onLeaseChanged hook; real run-deadline source on a real
 * LifecycleWakeScheduler.
 *
 * Replaced boundaries only: planner/reviewer model turns (scripted proposal /
 * scripted accept), worker execution processes (a scripted adapter that emits
 * REAL lease facts through ExecutorProgressEmitter and reports inspect), and
 * the delivery transport (scripted receipt).
 *
 * Time is fake (vitest). Deadline assertions additionally drive the run-deadline
 * source with explicit instants where a deterministic emission instant matters.
 * Neither the heartbeat safety scan nor any polling stands in for production
 * paths: the wake scheduler arms real due items and nerve wakes drive real
 * drains.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

let TEST_HOME: string;
const TEST_HOMES: string[] = [];

let kanban: typeof import("../../components/tasks/kanban-board.js");
let taskStore: typeof import("../../components/tasks/task-store.js");
let stateStore: typeof import("../../components/tasks/task-state-store.js");
let taskTypes: typeof import("../../components/tasks/task-types.js");
let dueSources: typeof import("../../components/tasks/due-sources.js");
let wakeSchedMod: typeof import("../../components/lifecycle-wake-scheduler.js");
let historyStore: typeof import("../../components/tasks/task-history-store.js");
let CoordinatorClass: typeof import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;
let wireProgress: typeof import("../../components/tasks/scheduled-run-coordinator.js").wireCardProgressProjection;
let realProjectRunner: typeof import("../../components/tasks/scheduled-project-runner.js").scheduledProjectRunner;
let reconcilerModule: typeof import("../../components/reconciler.js");
let driverMod: typeof import("../../components/orc-project/orc-workflow-driver.js");
let runnerMod: typeof import("../../components/orc-project/orc-workflow-runner.js");
let storeMod: typeof import("../../components/orc-project/orc-workflow-store.js");
let OrWorkPortMod: typeof import("../../components/orc-project/orc-workflow-ports.js");
let OrcCoordMod: typeof import("../../components/orc-project/orc-project-coordinator.js");
let ReviewStoreMod: typeof import("../../components/project-acceptance/project-review-store.js");
let SupSvcMod: typeof import("../../components/worker-supervision-service.js");
let SupStoreMod: typeof import("../../components/worker-supervision-store.js");
let LeaseStoreMod: typeof import("../../components/executor-lease-store.js");
let EmitterMod: typeof import("../../components/executor-progress-emitter.js");
let nerveMod: typeof import("../../components/nerve.js");
let QuarantineMod: typeof import("../../components/reconcile-quarantine-store.js");
let ExecControlMod: typeof import("../../components/execution-control.js");
let WorkspacePathsMod: typeof import("../../components/workspace-paths.js");

type Runner = import("../../components/orc-project/orc-workflow-runner.js").WorkflowRunner;
type Store = import("../../components/orc-project/orc-workflow-store.js").WorkflowStore;
type Proposal = import("../../components/orc-project/orc-workflow-runner.js").PlanProposal;
type CommandRow = import("../../components/orc-project/orc-workflow-store.js").CommandRow;
type Coordinator = import("../../components/tasks/scheduled-run-coordinator.js").ScheduledRunCoordinator;
type ActiveRun = import("../../components/tasks/task-state-store.js").ActiveTaskRun;
type ScheduledTask = import("../../components/tasks/task-types.js").ScheduledTask;
type ExecutorCapacity = import("../../components/swarm-executor-types.js").ExecutorCapacity;
type ExecutionClaim = import("../../components/swarm-executor-types.js").ExecutionClaim;
type StartObservation = import("../../components/swarm-executor-types.js").StartObservation;
type CancelObservation = import("../../components/swarm-executor-types.js").CancelObservation;
type ExecutionObservation = import("../../components/swarm-executor-types.js").ExecutionObservation;
type CancelReason = import("../../components/swarm-executor-types.js").CancelReason;

/**
 * Full per-test isolation: fresh module registry and home directory every
 * test, so no pump, hook, scheduler, or database row leaks across scenarios
 * (a pending lane from one scenario must never be claimed by another's pump).
 */
async function setupTest(): Promise<void> {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `lt-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  TEST_HOMES.push(TEST_HOME);
  mkdirSync(join(TEST_HOME, "tasks"), { recursive: true });
  mkdirSync(join(TEST_HOME, "workspace"), { recursive: true });
  vi.doMock("../../paths.js", () => ({
    abtarsHome: () => TEST_HOME,
    abmindHome: () => join(TEST_HOME, "..", "abmind-test"),
    abtarsRoot: () => join(TEST_HOME, "live-checkout"),
  }));
  kanban = await import("../../components/tasks/kanban-board.js");
  taskStore = await import("../../components/tasks/task-store.js");
  stateStore = await import("../../components/tasks/task-state-store.js");
  taskTypes = await import("../../components/tasks/task-types.js");
  dueSources = await import("../../components/tasks/due-sources.js");
  wakeSchedMod = await import("../../components/lifecycle-wake-scheduler.js");
  historyStore = await import("../../components/tasks/task-history-store.js");
  const coordMod = await import("../../components/tasks/scheduled-run-coordinator.js");
  CoordinatorClass = coordMod.ScheduledRunCoordinator;
  wireProgress = coordMod.wireCardProgressProjection;
  realProjectRunner = (await import("../../components/tasks/scheduled-project-runner.js")).scheduledProjectRunner;
  reconcilerModule = await import("../../components/reconciler.js");
  driverMod = await import("../../components/orc-project/orc-workflow-driver.js");
  runnerMod = await import("../../components/orc-project/orc-workflow-runner.js");
  storeMod = await import("../../components/orc-project/orc-workflow-store.js");
  OrWorkPortMod = await import("../../components/orc-project/orc-workflow-ports.js");
  OrcCoordMod = await import("../../components/orc-project/orc-project-coordinator.js");
  ReviewStoreMod = await import("../../components/project-acceptance/project-review-store.js");
  SupSvcMod = await import("../../components/worker-supervision-service.js");
  SupStoreMod = await import("../../components/worker-supervision-store.js");
  LeaseStoreMod = await import("../../components/executor-lease-store.js");
  EmitterMod = await import("../../components/executor-progress-emitter.js");
  nerveMod = await import("../../components/nerve.js");
  QuarantineMod = await import("../../components/reconcile-quarantine-store.js");
  ExecControlMod = await import("../../components/execution-control.js");
  WorkspacePathsMod = await import("../../components/workspace-paths.js");
  // Pre-import every module the composed agent path loads lazily: a first
  // dynamic import under fake timers never resolves, so these must be
  // evaluated here under real timers.
  await import("../../components/transport/tool-registry.js");
  await import("../../components/transport/bridge-lock-transport.js");
}

afterAll(() => {
  for (const home of TEST_HOMES) {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── scripted executor: lease facts are REAL, the model turn is not ──────────

interface TurnLedger {
  attemptId: string;
  generation: number;
  cardId: number;
  executorId: string;
  facts: number;
}

/**
 * Mirrors SpinWorkerAdapter's lease contract (alive at start, capacity head)
 * with a test-controllable model turn: facts are emitted on demand through
 * the real ExecutorProgressEmitter; inspect reports running until the turn is
 * ended through the real settlement paths.
 */
class LongTurnAdapter {
  readonly kind = "agent" as const;
  readonly schedulingPolicy = { recovery: "process_bound" as const, defaultMaxDurationMs: 1_800_000 };
  turns = new Map<string, TurnLedger>();
  starts: Array<{ cardId: number; attemptId: string }> = [];
  cancels: Array<{ attemptId: string; reason: string }> = [];
  /** "silent" starts turns with no lease emission: the attempt never gains a
   *  lease snapshot, so no producer or evaluator can observe it. */
  silentStart = false;
  /** Executor head for the pump capacity fence. */
  head = 3;

  async capacity(): Promise<ExecutorCapacity> {
    return { available: this.head, max: this.head };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    const card = kanban.kanbanGetCard(claim.cardId);
    if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };
    if (!this.silentStart) {
      const res = new EmitterMod.ExecutorProgressEmitter().emitAlive(
        claim.attemptId, claim.generation, claim.executorId,
      );
      if (res.kind === "rejected") {
        return { kind: "start_failed", reason: `lease:${res.reason}`, retryable: true };
      }
    }
    this.turns.set(claim.attemptId, {
      attemptId: claim.attemptId, generation: claim.generation, cardId: claim.cardId,
      executorId: claim.executorId, facts: 0,
    });
    this.starts.push({ cardId: claim.cardId, attemptId: claim.attemptId });
    // Mirror spin.dispatch: the W card runs with the turn.
    kanban.kanbanRunning(claim.cardId);
    return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
  }

  /**
   * Emit one round of real turn evidence. Output flows every round (liveness);
   * tool start/end pairs and durable milestones rotate in so the executor
   * policy keeps crediting meaningful progress — pure token output alone goes
   * output-only-stale after outputOnlyProgressCapMs by design.
   */
  heartbeat(attemptId: string, tick: number): void {
    const turn = this.turns.get(attemptId);
    if (!turn) throw new Error(`e2e: no live turn ${attemptId}`);
    const emitter = new EmitterMod.ExecutorProgressEmitter();
    turn.facts += 1;
    const out = emitter.emitOutput(
      turn.attemptId, turn.generation, turn.executorId, turn.facts,
      `long-turn:${attemptId}:${turn.facts}`,
    );
    if (out.kind === "rejected") throw new Error(`e2e: output rejected for ${attemptId}: ${out.reason}`);
    if (tick % 2 === 0) {
      const opId = `op:${attemptId}:${tick}`;
      const started = emitter.emitToolStart(turn.attemptId, turn.generation, turn.executorId, opId, `tool ${tick}`);
      if (started.kind === "rejected") throw new Error(`e2e: tool start rejected for ${attemptId}: ${started.reason}`);
      const ended = emitter.emitToolEnd(turn.attemptId, turn.generation, turn.executorId, opId, `obs:${attemptId}:${tick}`);
      if (ended.kind === "rejected") throw new Error(`e2e: tool end rejected for ${attemptId}: ${ended.reason}`);
    }
    if (tick % 4 === 0) {
      const ms = emitter.emitMilestone(turn.attemptId, turn.generation, turn.executorId, `ms:${attemptId}:${tick}`);
      if (ms.kind === "rejected") throw new Error(`e2e: milestone rejected for ${attemptId}: ${ms.reason}`);
    }
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    if (!this.turns.has(claim.attemptId)) {
      const store = new SupStoreMod.WorkerSupervisionStore();
      const attempt = store.getAttempt(claim.attemptId);
      if (attempt && store.isAttemptTerminal(attempt.lifecycle)) {
        return { kind: "terminal", lifecycle: attempt.lifecycle };
      }
      return { kind: "unknown", message: "no live turn" };
    }
    return { kind: "running", lifecycle: "running" };
  }

  async cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation> {
    const store = new SupStoreMod.WorkerSupervisionStore();
    this.cancels.push({ attemptId: claim.attemptId, reason });
    const settlement = store.terminalSettlement({
      attemptId: claim.attemptId,
      expectedGeneration: claim.generation,
      desiredState: "cancelled",
      stableReason: `e2e:${reason}`,
    });
    new LeaseStoreMod.ExecutorLeaseStore().closeLease(claim.attemptId, claim.generation, `e2e:${reason}`);
    this.turns.delete(claim.attemptId);
    if (settlement.kind === "settled" || settlement.kind === "replayed" || settlement.kind === "budget_violation") {
      return { kind: "cancelled", attemptId: claim.attemptId };
    }
    const attempt = store.getAttempt(claim.attemptId);
    return { kind: "already_terminal", lifecycle: attempt?.lifecycle ?? "cancelled" };
  }
}

// ── scripted plan boundary (proposal text only) ─────────────────────────────

const LANE_ACCEPTANCE = "lane delivers its committed output";

function fourLaneProposal(): Proposal {
  const lanes = [0, 1, 2, 3].map((i) => ({
    label: `lane-${i}`,
    kind: "work" as const,
    instructions: `Work lane ${i}`,
    capability: "general",
    outputs: [`out/lane-${i}.md`],
    acceptance: [LANE_ACCEPTANCE],
    dependsOn: [] as string[],
  }));
  return {
    requiredOutputs: lanes.map((l) => l.outputs[0] as string),
    nodes: [
      ...lanes,
      {
        label: "review", kind: "review" as const,
        instructions: "judge the candidate revision", capability: "general",
        outputs: [] as string[], acceptance: [] as string[],
        dependsOn: lanes.map((l) => l.label),
      },
    ],
  };
}

// ── composed stack ──────────────────────────────────────────────────────────

interface Stack {
  entry: ScheduledTask;
  runId: string;
  coordinator: Coordinator;
  store: Store;
  runner: Runner;
  driver: import("../../components/orc-project/orc-workflow-driver.js").WorkflowDriver;
  adapter: LongTurnAdapter;
  deadlineSource: { wakeDue: (now: number) => void; listDueItems: () => Array<{ key: string; dueAt: number }> };
  deadlineSpy: ReturnType<typeof vi.spyOn>;
  hookLog: Array<{ cardId: number; at: number }>;
  cardLog: Array<{ event: string; cardId: number }>;
  /** Root cards whose projection must throw (containment probe). */
  breakerRoots: Set<number>;
  teardown: () => Promise<void>;
}

function entryFor(id: string): ScheduledTask {
  return {
    id, kind: "agent",
    prompt: `Long-turn workload ${id}. Produce per-lane outputs.`,
    agent: "task",
    interaction: { mode: "oneshot" },
    orchestration: { maxAgents: 3 },
    schedule: "0 9 * * *",
    enabled: true,
    priority: "medium",
    delivery: "announce",
    chatId: "1",
  };
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Pump drains + audit until cond holds or the fake-time budget elapses. */
async function settleStep(stack: Stack): Promise<void> {
  stack.driver.drainWake("e2e:settle");
  stack.driver.auditOnce();
  await flush();
}

async function converge(stack: Stack, label: string, cond: () => boolean, maxMs = 120_000): Promise<void> {
  let spent = 0;
  for (;;) {
    await settleStep(stack);
    if (cond()) return;
    if (spent >= maxMs) {
      const state = stateStore.readState(stack.entry.id);
      const hist = historyStore.getRun(stack.runId);
      const root = rootCardOf(stack);
      const rootCard = root !== undefined ? kanban.kanbanGetCard(root) : undefined;
      const wf = tryWfRun(stack);
      const nodes = wf ? stack.store.listNodes(wf, stack.store.currentRevision(wf))
        .map((n) => `${n["node_id"] as string}:${n["kind"] as string}:${n["status"] as string}:card=${n["worker_card_id"] as number | null}`) : [];
      const sup = new SupStoreMod.WorkerSupervisionStore();
      const attempts = wf
        ? workNodes(stack)
          .map((n) => {
            const all = sup.getAttemptsForCard(n.cardId).map((a) => `${a.id.slice(0, 8)}:${a.lifecycle}`).join("|");
            return `${n.nodeId}:[${all}]`;
          })
        : [];
      throw new Error(
        `e2e did not converge: ${label} | occ=${state?.activeRun?.phase ?? "none"} hist=${hist?.outcome ?? "none"} `
        + `root=${rootCard?.status ?? "none"} wf=${wf ? stack.store.getRun(wf)?.state : "none"} `
        + `nodes=[${nodes.join(",")}] attempts=[${attempts.join(",")}] starts=${JSON.stringify(stack.adapter.starts)} `
        + `deadlineCalls=${JSON.stringify((stack.deadlineSpy as unknown as { mock: { calls: unknown[][] } }).mock.calls)} `
        + `hooks=${stack.hookLog.length} cards=${JSON.stringify(stack.cardLog.slice(-8))}`,
      );
    }
    await vi.advanceTimersByTimeAsync(1000);
    spent += 1000;
  }
}

function rootCardOf(stack: Stack): number | undefined {
  return stateStore.readState(stack.entry.id)?.activeRun?.cardId;
}

function tryWfRun(stack: Stack): string | undefined {
  const root = rootCardOf(stack);
  if (root === undefined) return undefined;
  return stack.store.findLatestRunByCard(root)?.runId;
}

function wfRunOf(stack: Stack): string {
  const wf = tryWfRun(stack);
  if (!wf) throw new Error("e2e: no workflow run for the root card");
  return wf;
}

interface WorkLane {
  nodeId: string;
  cardId: number;
  attemptId: string | null;
}

function workNodes(stack: Stack): WorkLane[] {
  const wf = tryWfRun(stack);
  if (!wf) return [];
  return stack.store.listNodes(wf, stack.store.currentRevision(wf))
    .filter((n) => n["kind"] === "work")
    .map((n) => ({
      nodeId: n["node_id"] as string,
      cardId: n["worker_card_id"] as number | null,
      attemptId: (n["attempt_id"] as string | null) ?? null,
    }))
    .filter((n): n is { nodeId: string; cardId: number; attemptId: string | null } => n.cardId !== null);
}

function liveWorkTurns(stack: Stack): Array<{ nodeId: string; cardId: number; attemptId: string }> {
  const sup = new SupStoreMod.WorkerSupervisionStore();
  const out: Array<{ nodeId: string; cardId: number; attemptId: string }> = [];
  for (const n of workNodes(stack)) {
    const attempt = sup.getLatestAttempt(n.cardId);
    if (attempt && (attempt.lifecycle === "claimed" || attempt.lifecycle === "starting" || attempt.lifecycle === "running")) {
      out.push({ nodeId: n.nodeId, cardId: n.cardId, attemptId: attempt.id });
    }
  }
  return out;
}

function occurrenceProgress(stack: Stack): number {
  const run = stateStore.readState(stack.entry.id)?.activeRun;
  if (!run) throw new Error("e2e: occurrence row vanished");
  return run.lastProgressAt;
}

function occurrenceProgressOf(entryId: string): number {
  const run = stateStore.readState(entryId)?.activeRun;
  if (!run) throw new Error(`e2e: occurrence row vanished for ${entryId}`);
  return run.lastProgressAt;
}

/** Live turns grouped by their scheduled root (multi-occurrence stacks). */
function liveTurnsByRoot(stack: Stack): Map<number, Array<{ nodeId: string; cardId: number; attemptId: string }>> {
  const sup = new SupStoreMod.WorkerSupervisionStore();
  const out = new Map<number, Array<{ nodeId: string; cardId: number; attemptId: string }>>();
  const wfIds = new Set<string>();
  for (const entry of taskStore.readEntries()) {
    const root = stateStore.readState(entry.id)?.activeRun?.cardId;
    if (root === undefined) continue;
    const wf = stack.store.findLatestRunByCard(root)?.runId;
    if (wf) wfIds.add(wf);
  }
  for (const wf of wfIds) {
    for (const n of stack.store.listNodes(wf, stack.store.currentRevision(wf))) {
      if (n["kind"] !== "work") continue;
      const cardId = n["worker_card_id"] as number | null;
      if (cardId == null) continue;
      const attempt = sup.getLatestAttempt(cardId);
      if (!attempt || (attempt.lifecycle !== "claimed" && attempt.lifecycle !== "starting" && attempt.lifecycle !== "running")) continue;
      const root = attempt.root_project_card_id;
      if (root == null) continue;
      const list = out.get(root) ?? [];
      list.push({ nodeId: n["node_id"] as string, cardId, attemptId: attempt.id });
      out.set(root, list);
    }
  }
  return out;
}

/**
 * Admit a second scheduled occurrence onto a live stack (shared coordinator,
 * scheduler, reconciler, driver, and executor pool — the production shape for
 * concurrent runs).
 */
async function beginSecondRun(stack: Stack, entryId: string, ceilingMs: number): Promise<{ entry: ScheduledTask; runId: string }> {
  const entry = entryFor(entryId);
  const entries = [...taskStore.readEntries().map((e) => ({ ...e })), entry];
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify(entries, null, 2));
  stateStore.initializeState(taskStore.readEntries());
  const t0 = Date.now();
  const res = stateStore.reserveRun(entry.id, {
    runId: `${entryId}-run`, groupId: "g", attempt: 1, trigger: "schedule",
    occurrenceAt: t0, deadlineAt: t0 + ceilingMs,
  });
  if (!res.ok) throw new Error(`e2e: reserveRun failed for ${entryId}`);
  const started = stack.coordinator.start(entry, res.run, "scheduled");
  if (started !== "started") throw new Error(`e2e: coordinator.start returned ${started}`);
  await flush();
  return { entry, runId: res.run.runId };
}

/** Materialize the lane's declared file outputs, then settle lane + card. */
function endLaneTurn(stack: Stack, nodeId: string, cardId: number): void {
  const root = rootCardOf(stack);
  if (root === undefined) throw new Error("e2e: no root card");
  const cwd = new ReviewStoreMod.ProjectReviewStore().getWorkspaceScope(root)?.cwd;
  if (!cwd) throw new Error("e2e: no workspace scope for the root card");
  const sup = new SupStoreMod.WorkerSupervisionStore();
  const svc = new SupSvcMod.WorkerSupervisionService();
  const attempt = sup.getLatestAttempt(cardId);
  if (!attempt) throw new Error(`e2e: no attempt for lane card ${cardId}`);
  const contractRow = sup.getContractByCardId(cardId);
  if (!contractRow) throw new Error(`e2e: no contract for lane card ${cardId}`);
  let parsed: { expected_artifacts?: Array<{ ref?: string }> } = {};
  try {
    parsed = JSON.parse(contractRow.contract_json) as typeof parsed;
  } catch {
    throw new Error(`e2e: unreadable contract for lane card ${cardId}`);
  }
  for (const artifact of parsed.expected_artifacts ?? []) {
    if (typeof artifact.ref !== "string" || artifact.ref.length === 0) continue;
    const target = resolve(cwd, artifact.ref);
    if (!WorkspacePathsMod.isPathWithinRoot(cwd, target)) continue;
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `scripted lane output: ${artifact.ref}\n`, "utf-8");
  }
  const outcome = svc.collectAndSettle(cardId, `<summary>lane ${nodeId} finished</summary>`, cwd, attempt.id, attempt.generation || 1);
  if (!outcome.settled) {
    const cur = sup.getAttempt(attempt.id);
    const resRow = sup.getResultByAttempt(attempt.id);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      dbg: "settle-refused", nodeId, cardId, attemptId: attempt.id,
      lifecycle: cur?.lifecycle ?? null, cancelReason: cur?.cancel_reason ?? null,
      settledAt: cur?.settled_at ?? null, hasResult: resRow !== undefined,
      summary: outcome.summary,
    }));
    throw new Error(`e2e: lane ${nodeId} refused settlement (${outcome.summary})`);
  }
  kanban.kanbanComplete(cardId, null, `lane ${nodeId} finished`);
}

async function startStack(entryId: string, opts: { ceilingMs: number; silentStart?: boolean; executorHead?: number; expectLive?: number }): Promise<Stack> {
  const entry = entryFor(entryId);
  writeFileSync(join(TEST_HOME, "tasks", "tasks.json"), JSON.stringify([entry], null, 2));
  stateStore.initializeState(taskStore.readEntries());

  const t0 = Date.now();
  const res = stateStore.reserveRun(entry.id, {
    runId: `${entryId}-run`, groupId: "g", attempt: 1, trigger: "schedule",
    occurrenceAt: t0, deadlineAt: t0 + opts.ceilingMs,
  });
  if (!res.ok) throw new Error(`e2e: reserveRun failed for ${entryId}`);
  const run: ActiveRun = res.run;

  const coordinator = new CoordinatorClass({
    projectRunner: realProjectRunner,
    agentRunner: (async () => { throw new Error("e2e: project path must not call the T-session runner"); }) as never,
    executions: ExecControlMod.createExecutionSupervisor({ maxConcurrent: {} }),
  });
  const unsubProgress = wireProgress(coordinator);

  const scheduler = new wakeSchedMod.LifecycleWakeScheduler();
  const deadlineSource = dueSources.createRunDeadlineSource(coordinator);
  scheduler.register(dueSources.createTaskAdmissionSource(() => {}));
  scheduler.register(deadlineSource);
  stateStore.setTaskDueChangedHook(() => {
    scheduler.sourceChanged("task-admission");
    scheduler.sourceChanged("run-deadline");
  });
  await scheduler.start();

  const adapter = new LongTurnAdapter();
  if (opts.silentStart) adapter.silentStart = true;
  if (opts.executorHead !== undefined) adapter.head = opts.executorHead;

  const store = new storeMod.WorkflowStore();
  const runner = new runnerMod.WorkflowRunner(store);

  const completeClaim = (cmd: CommandRow, owner: string): void => {
    const live = store.getCommand({
      runId: cmd.runId, generation: cmd.generation,
      nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal,
    });
    if (live && live.status === "claimed") {
      store.completeCommand(
        { runId: cmd.runId, generation: cmd.generation, nodeId: cmd.nodeId, action: cmd.action, ordinal: cmd.ordinal },
        live.owner ?? owner,
        live.claimToken ?? "",
      );
    }
  };

  const ports = {
    executor: new OrWorkPortMod.WorkflowWorkerPort({
      runner,
      wakePump: () => reconcilerModule.requestWorkerDispatch(),
    }),
    reviewer: {
      name: "long-turn-reviewer",
      startReview: (cmd: CommandRow) => {
        runner.submitVerdict(cmd.runId, cmd.nodeId, { verdict: "accept" });
        completeClaim(cmd, "long-turn-reviewer");
      },
    },
    planner: {
      name: "long-turn-planner",
      startPlanning: (cmd: CommandRow, input: { purpose?: string; revision?: number; opId?: string }) => {
        if (input.purpose === "initial") {
          runner.submitPlanProposal(cmd.runId, fourLaneProposal(), { baseRevision: undefined, opId: input.opId });
        }
        completeClaim(cmd, "long-turn-planner");
      },
    },
    delivery: { name: "long-turn-delivery", send: () => "long-turn-receipt" },
  };

  const breakerRoots = new Set<number>();
  const handle = await reconcilerModule.startReconciler({
    generationId: `long-turn-${entryId}-${Date.now()}`,
    coordinator: new OrcCoordMod.OrcProjectCoordinator({}),
    wakeScheduler: scheduler,
    workerAdapter: adapter as never,
    piService: null,
    createPiAdapter: (() => { throw new Error("e2e: no pi service"); }) as never,
    getQuarantineStore: () => new QuarantineMod.ReconcileQuarantineStore(),
    projectRunProgress: (cardId: number) => {
      const root = kanban.resolveRootId(cardId);
      if (root !== undefined && breakerRoots.has(root)) throw new Error("e2e: projection fault");
      return coordinator.projectCardProgress(cardId);
    },
    failureCascade: coordinator.failureCallback,
    subscribeCapacityReleased: () => () => {},
  } as never);

  const driver = driverMod.startWorkflowDriver({
    callModel: (async () => { throw new Error("e2e: planner/reviewer replaced by scripted ports"); }) as never,
    ports: ports as never,
  });

  // Count real hook firings with their card and time (the diagnosis evidence).
  const hookLog: Array<{ cardId: number; at: number }> = [];
  const installed = LeaseStoreMod.ExecutorLeaseStore.onLeaseChanged;
  LeaseStoreMod.ExecutorLeaseStore.onLeaseChanged = () => {
    const c = LeaseStoreMod.ExecutorLeaseStore.lastChangedCardId;
    if (c !== undefined) hookLog.push({ cardId: c, at: Date.now() });
    installed?.();
  };

  const cardLog: Array<{ event: string; cardId: number }> = [];
  const nerve = nerveMod.nerve;
  const onDone = (cardId: number): void => { cardLog.push({ event: "done", cardId }); };
  const onFailed = (cardId: number): void => { cardLog.push({ event: "failed", cardId }); };
  nerve.on("card:done", onDone);
  nerve.on("card:failed", onFailed);

  let tornDown = false;
  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    nerve.off("card:done", onDone);
    nerve.off("card:failed", onFailed);
    unsubProgress();
    LeaseStoreMod.ExecutorLeaseStore.onLeaseChanged = undefined;
    try { await handle.stop(); } catch { /* best effort */ }
    try { driver.stop(); } catch { /* best effort */ }
    try { scheduler.stop(); } catch { /* best effort */ }
    stateStore.setTaskDueChangedHook(null);
  };

  try {
    const stack: Stack = {
      entry, runId: run.runId, coordinator, store, runner, driver, adapter,
      deadlineSource, deadlineSpy: vi.spyOn(coordinator, "deadlineExpired"),
      hookLog, cardLog, breakerRoots, teardown,
    };

    const started = coordinator.start(entry, run, "scheduled");
    if (started !== "started") throw new Error(`e2e: coordinator.start returned ${started}`);
    await flush();

    // Converge planning + dispatch: every work lane owns a worker card.
    await converge(stack, "plan-dispatched", () => workNodes(stack).length === 4, 300_000);
    // Converge turns: the expected lanes hold the executor head.
    const expectLive = opts.expectLive ?? 3;
    await converge(stack, "turns-open", () => liveWorkTurns(stack).length === expectLive, 300_000);

    cardLog.length = 0;
    hookLog.length = 0;
    return stack;
  } catch (err) {
    await teardown();
    throw err;
  }
}

async function advanceTurn(stack: Stack, ms: number, facts?: () => void): Promise<void> {
  if (facts) facts();
  stack.driver.drainWake("e2e:advance");
  stack.driver.auditOnce();
  await vi.advanceTimersByTimeAsync(ms);
}

describe("orc-workflow long turns under the run-idle budget (#1793)", () => {
  it("a healthy long turn with valid executor facts survives the idle budget and completes", async () => {
    await setupTest();
    vi.useFakeTimers();
    const stack = await startStack("lt-healthy", { ceilingMs: taskTypes.runCeilingMs() });
    try {
      const live = liveWorkTurns(stack);
      // Cap three holds: exactly three lanes run, the fourth waits pending.
      expect(live, "three lanes must hold the executor cap").toHaveLength(3);
      const laneCards = workNodes(stack).map((n) => n.cardId);
      const pending = laneCards.filter((c) => !live.some((t) => t.cardId === c));
      expect(pending, "the fourth lane must wait pending behind the cap").toHaveLength(1);
      const pendingCard = pending[0] as number;

      const t0 = occurrenceProgress(stack);
      // Sixteen minutes of valid facts, no card transitions: the budget is 15.
      for (let minute = 1; minute <= 16; minute += 1) {
        for (const turn of liveWorkTurns(stack)) stack.adapter.heartbeat(turn.attemptId, minute);
        stack.deadlineSource.wakeDue(Date.now());
        expect(stack.deadlineSpy, `idle budget must not fire at +${minute}min`).not.toHaveBeenCalled();
        await advanceTurn(stack, 60_000);
      }
      expect(occurrenceProgress(stack), "occurrence progress must advance during the turn").toBeGreaterThan(t0);
      // Level-triggered proof: an explicit wake with fresh progress settles nothing.
      stack.deadlineSource.wakeDue(Date.now());
      expect(stack.deadlineSpy, "explicit wake with fresh progress settles nothing").not.toHaveBeenCalled();
      const idleItems = stack.deadlineSource.listDueItems().filter((i) => i.key === `idle:${stack.runId}`);
      expect(idleItems, "the idle item must be armed").toHaveLength(1);
      expect(idleItems[0]!.dueAt, "the idle instant must have rolled forward").toBeGreaterThan(Date.now());
      const hookCards = new Set(stack.hookLog.map((h) => h.cardId));
      expect(hookCards.size, "lease hooks must fire for the live lane cards").toBeGreaterThanOrEqual(3);
      expect(stack.cardLog.filter((e) => e.event === "done" || e.event === "failed"),
        "no card terminal transitions during the turn phase").toHaveLength(0);
      const progressAfterTurns = occurrenceProgress(stack);

      // Release lanes 1-3 through the real settlement path; the waiting lane starts.
      const wfId = wfRunOf(stack);
      for (const turn of live) endLaneTurn(stack, turn.nodeId, turn.cardId);
      await converge(stack, "lane-four-starts", () => liveWorkTurns(stack).some((t) => t.cardId === pendingCard), 300_000);
      const fourth = liveWorkTurns(stack).find((t) => t.cardId === pendingCard);
      expect(fourth, "the fourth lane must start after capacity frees").toBeDefined();
      const startsForFourth = stack.adapter.starts.filter((s) => s.cardId === pendingCard);
      expect(startsForFourth, "the fourth lane must dispatch exactly once").toHaveLength(1);
      stack.adapter.heartbeat(fourth!.attemptId, 1);
      endLaneTurn(stack, fourth!.nodeId, fourth!.cardId);

      // Review accepts, delivery receipts: the run succeeds with no duplicate dispatch.
      await converge(stack, "occurrence-settles", () => historyStore.getRun(stack.runId) !== undefined, 600_000);
      const hist = historyStore.getRun(stack.runId);
      expect(hist?.outcome, "the occurrence must settle success").toBe("success");
      expect(stack.store.getRun(wfId)?.state, "the workflow run must succeed").toBe("succeeded");
      const perCard = new Map<number, number>();
      for (const s of stack.adapter.starts) perCard.set(s.cardId, (perCard.get(s.cardId) ?? 0) + 1);
      expect([...perCard.values()], "no lane may dispatch twice").toEqual([1, 1, 1, 1]);
      expect(stack.deadlineSpy, "the idle budget must never fire for a healthy run").not.toHaveBeenCalled();
      // Evidence record for the Task 2 diagnosis.
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        scenario: "healthy",
        hooks: stack.hookLog.length,
        hookCards: [...hookCards],
        progressDeltaMs: progressAfterTurns - t0,
        starts: stack.adapter.starts.length,
      }));
    } finally {
      vi.useRealTimers();
      await stack.teardown();
    }
  }, 300_000);

  it("total silence trips the idle backstop and cancels the supervised run", async () => {
    await setupTest();
    vi.useFakeTimers();
    const stack = await startStack("lt-silent", { ceilingMs: taskTypes.runCeilingMs(), silentStart: true });
    try {
      const live = liveWorkTurns(stack);
      expect(live, "three lanes must hold the executor cap").toHaveLength(3);
      const wfId = wfRunOf(stack);
      // No lease rows at all: no producer and no evaluator can observe these turns.
      const lease = new LeaseStoreMod.ExecutorLeaseStore();
      for (const turn of live) expect(lease.getSnapshot(turn.attemptId), "silent turns have no lease").toBeUndefined();
      const idleAt = occurrenceProgress(stack) + taskTypes.runIdleBudgetMs();
      // One instant before the budget: nothing fires, despite stale rows present.
      stack.deadlineSource.wakeDue(idleAt - 1);
      expect(stack.deadlineSpy, "no early firing").not.toHaveBeenCalled();
      // At the budget: the backstop requests cancellation.
      stack.deadlineSource.wakeDue(idleAt);
      expect(stack.deadlineSpy, "idle backstop must fire").toHaveBeenCalledTimes(1);
      expect(stack.deadlineSpy).toHaveBeenCalledWith(stack.entry.id, stack.runId, expect.stringContaining("no progress for"));
      expect(stateStore.readState(stack.entry.id)?.activeRun?.phase, "run must enter cancelling").toBe("cancelling");
      // Past the cancellation grace: the occurrence settles and the runner run is cancelled.
      stack.deadlineSource.wakeDue(idleAt + 30_001);
      const hist = historyStore.getRun(stack.runId);
      expect(hist?.outcome, "silent run must settle failed").toBe("failed");
      expect(hist?.diagnostic?.code, "idle backstop diagnostic").toBe("deadline_exceeded");
      expect(stack.store.getRun(wfId)?.state, "supervised run cancelled").toBe("cancelled");
      const sup = new SupStoreMod.WorkerSupervisionStore();
      for (const turn of live) {
        const lc = sup.getAttempt(turn.attemptId)?.lifecycle;
        expect(["cancel_requested", "cancelled", "timed_out", "failed"].includes(lc ?? ""), `lane fenced (${lc})`).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ scenario: "backstop", outcome: hist?.outcome, diagnostic: hist?.diagnostic?.code ?? null }));
    } finally {
      vi.useRealTimers();
      await stack.teardown();
    }
  }, 300_000);

  it("the absolute ceiling binds independent of progress, and late events cannot credit a replacement", async () => {
    await setupTest();
    vi.useFakeTimers();
    const ceilingMs = 20 * 60_000;
    const stack = await startStack("lt-ceiling", { ceilingMs });
    try {
      const live = liveWorkTurns(stack);
      expect(live, "three lanes must hold the executor cap").toHaveLength(3);
      const wfId = wfRunOf(stack);
      const ceilingAt = stateStore.readState(stack.entry.id)?.activeRun?.deadlineAt;
      if (ceilingAt === undefined) throw new Error("e2e: no ceiling on the occurrence");
      // Facts keep flowing; progress keeps advancing.
      for (const turn of liveWorkTurns(stack)) stack.adapter.heartbeat(turn.attemptId, 1);
      // Past the ceiling with fresh progress: the ceiling still wins.
      stack.deadlineSource.wakeDue(ceilingAt + 1);
      expect(stack.deadlineSpy, "ceiling must fire").toHaveBeenCalledTimes(1);
      expect(stack.deadlineSpy).toHaveBeenCalledWith(stack.entry.id, stack.runId, "absolute ceiling exceeded");
      const run = stateStore.readState(stack.entry.id)?.activeRun;
      expect(run?.phase, "run must enter cancelling").toBe("cancelling");
      expect(run?.deadlineAt, "activity must not extend the ceiling").toBe(ceilingAt);
      stack.deadlineSource.wakeDue(ceilingAt + 31_000);
      const hist = historyStore.getRun(stack.runId);
      expect(hist?.outcome, "ceiling run must settle failed").toBe("failed");
      expect(stack.store.getRun(wfId)?.state, "supervised run cancelled").toBe("cancelled");
      const sup = new SupStoreMod.WorkerSupervisionStore();
      for (const turn of live) {
        const lc = sup.getAttempt(turn.attemptId)?.lifecycle;
        expect(["cancel_requested", "cancelled", "timed_out", "failed"].includes(lc ?? ""), `lane fenced (${lc})`).toBe(true);
      }
      // Late events from a retired attempt are fenced at both layers.
      const retired = sup.getAttempt(live[0]!.attemptId);
      const late = new EmitterMod.ExecutorProgressEmitter().emitOutput(
        live[0]!.attemptId, retired?.generation || 1, "spin-local", 9999, "late-turn",
      );
      expect(late.kind, "late fact rejected").toBe("rejected");
      const rep = stateStore.reserveRun(stack.entry.id, {
        runId: `${stack.entry.id}-run-2`, groupId: "g", attempt: 1, trigger: "schedule",
        occurrenceAt: Date.now(), deadlineAt: Date.now() + taskTypes.runCeilingMs(),
      });
      if (!rep.ok) throw new Error("e2e: replacement reserve failed");
      const repBefore = stateStore.readState(stack.entry.id)?.activeRun?.lastProgressAt;
      stack.coordinator.projectCardProgress(live[0]!.cardId);
      const repAfter = stateStore.readState(stack.entry.id)?.activeRun?.lastProgressAt;
      expect(repAfter, "replacement run untouched by retired attempt").toBe(repBefore);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ scenario: "ceiling", outcome: hist?.outcome, wf: stack.store.getRun(wfId)?.state ?? null }));
    } finally {
      vi.useRealTimers();
      await stack.teardown();
    }
  }, 300_000);

  it("a failing projection for one run is contained and the other run survives", async () => {
    await setupTest();
    vi.useFakeTimers();
    const stack = await startStack("lt-iso-a", { ceilingMs: taskTypes.runCeilingMs(), executorHead: 8, expectLive: 4 });
    let secondRunId = "";
    try {
      const first = await beginSecondRun(stack, "lt-iso-b", taskTypes.runCeilingMs());
      secondRunId = first.runId;
      await converge(stack, "both-live", () => {
        const byRoot = liveTurnsByRoot(stack);
        return byRoot.size === 2 && [...byRoot.values()].every((t) => t.length >= 1);
      }, 300_000);
      const rootA = stateStore.readState("lt-iso-a")?.activeRun?.cardId;
      if (rootA === undefined) throw new Error("e2e: run A has no root card");
      const aBefore = occurrenceProgressOf("lt-iso-a");
      const bBefore = occurrenceProgressOf("lt-iso-b");
      stack.breakerRoots.add(rootA);
      // Fourteen minutes of valid facts for every live lane of both runs.
      // Run A stays inside its idle budget the whole time, so any progress
      // write for it would be visible here rather than after settlement.
      for (let minute = 1; minute <= 14; minute += 1) {
        let tick = minute;
        for (const turns of liveTurnsByRoot(stack).values()) {
          for (const turn of turns) stack.adapter.heartbeat(turn.attemptId, tick++);
        }
        stack.deadlineSource.wakeDue(Date.now());
        await advanceTurn(stack, 60_000);
      }
      // Run B advanced on genuine projections; run A never did.
      expect(occurrenceProgressOf("lt-iso-b"), "run B must advance").toBeGreaterThan(bBefore);
      expect(occurrenceProgressOf("lt-iso-a"), "run A must not advance on failed projections").toBe(aBefore);
      const hookRoots = new Set(stack.hookLog.map((h) => kanban.resolveRootId(h.cardId)));
      expect([...hookRoots].filter((r) => r !== undefined).length, "hooks must fire for both runs").toBeGreaterThanOrEqual(2);
      expect(stack.adapter.cancels, "no executor kill while facts flow").toHaveLength(0);
      // Two more minutes of facts for B only: the real scheduler fires A's
      // idle budget while B keeps advancing past it.
      for (let minute = 15; minute <= 16; minute += 1) {
        let tick = minute;
        const byRoot = liveTurnsByRoot(stack);
        for (const [root, turns] of byRoot) {
          if (root === rootA) continue;
          for (const turn of turns) stack.adapter.heartbeat(turn.attemptId, tick++);
        }
        await advanceTurn(stack, 60_000);
      }
      // The idle backstop settles only the unprojected run.
      const callsA = (stack.deadlineSpy as unknown as { mock: { calls: string[][] } }).mock.calls
        .filter((c) => c[1] === `${"lt-iso-a"}-run`);
      const callsB = (stack.deadlineSpy as unknown as { mock: { calls: string[][] } }).mock.calls
        .filter((c) => c[1] === `${"lt-iso-b"}-run`);
      expect(callsA.length, "run A must hit the idle budget").toBeGreaterThanOrEqual(1);
      expect(callsA[0]![2], "run A idle reason").toContain("no progress for");
      expect(callsB, "run B must never hit the budget").toHaveLength(0);
      await converge(stack, "run-a-settles", () => historyStore.getRun(`${"lt-iso-a"}-run`) !== undefined, 300_000);
      expect(historyStore.getRun(`${"lt-iso-a"}-run`)?.outcome, "run A settles failed").toBe("failed");
      expect(stateStore.readState("lt-iso-b")?.activeRun, "run B stays alive").toBeDefined();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ scenario: "isolation", a: "failed-idle", b: "alive" }));
    } finally {
      try {
        if (secondRunId) stack.coordinator.cancel(secondRunId, "e2e teardown");
      } catch { /* best effort */ }
      vi.useRealTimers();
      await stack.teardown();
    }
  }, 300_000);

  it("loss of progress terminates through the existing executor policy", async () => {
    await setupTest();
    vi.useFakeTimers();
    const stack = await startStack("lt-loss", { ceilingMs: taskTypes.runCeilingMs() });
    try {
      const live = liveWorkTurns(stack);
      expect(live, "three lanes must hold the executor cap").toHaveLength(3);
      const lossWfId = wfRunOf(stack);
      const lossRootCard = rootCardOf(stack);
      for (const turn of live) stack.adapter.heartbeat(turn.attemptId, 1);
      for (const turn of live) stack.adapter.heartbeat(turn.attemptId, 2);
      await advanceTurn(stack, 60_000);
      await advanceTurn(stack, 60_000);
      // Facts stop here with the inspection handles still live.
      const factStopAt = Date.now();
      const lease = new LeaseStoreMod.ExecutorLeaseStore();
      const firstSnap = lease.getSnapshot(live[0]!.attemptId);
      if (!firstSnap) throw new Error("e2e: no lease snapshot for lane 1");
      const progressDeadline = new Date(firstSnap.progressDeadlineAt).getTime();
      expect(progressDeadline, "progress deadline must sit at last fact + policy").toBeLessThanOrEqual(factStopAt + 300_000 + 60_000);

      // Advance to warning then inspection: renewals must not mask expiry.
      await advanceTurn(stack, Math.max(1000, progressDeadline - Date.now() - 30_000));
      const warnSnap = lease.getSnapshot(live[0]!.attemptId);
      expect(["warning", "healthy", "inspecting"].includes(warnSnap?.evaluation.phase ?? ""),
        `evaluation must approach expiry (saw ${warnSnap?.evaluation.phase})`).toBe(true);
      await advanceTurn(stack, 60_000);
      await advanceTurn(stack, 60_000);
      const sup = new SupStoreMod.WorkerSupervisionStore();
      const attempt1 = sup.getAttempt(live[0]!.attemptId);
      expect(["cancel_requested", "cancelled", "timed_out", "failed"].includes(attempt1?.lifecycle ?? ""),
        `executor policy must terminate the silent attempt (saw ${attempt1?.lifecycle})`).toBe(true);

      // #1801: terminal attempt ⇒ terminal card + dispatch redrive. The
      // cancelled lanes' W cards must fail (not linger running), the pending
      // fourth lane must dispatch without the idle budget firing, and the run
      // must reach a reasoned node failure — never deadline_exceeded.
      const laneCards = workNodes(stack).map((n) => n.cardId);
      const liveCardIds = new Set(live.map((t) => t.cardId));
      const pendingCards = laneCards.filter((c) => !liveCardIds.has(c));
      expect(pendingCards, "the fourth lane must wait pending behind the cap").toHaveLength(1);
      const pendingCard = pendingCards[0] as number;
      // Cancelled lanes project to failed W cards.
      await converge(stack, "cancelled-cards-failed", () =>
        live.every((t) => kanban.kanbanGetCard(t.cardId)?.status === "failed"),
      );
      // The pending lane starts from the card-failure redrive alone — the
      // occurrence idle budget must never fire to produce this progress.
      await converge(stack, "pending-lane-redriven", () =>
        liveWorkTurns(stack).some((t) => t.cardId === pendingCard),
      );
      expect(stack.deadlineSpy, "the idle budget must not fire to start the pending lane").not.toHaveBeenCalled();
      expect(stack.adapter.starts.some((s) => s.cardId === pendingCard),
        "the pending lane must dispatch exactly via the redrive").toBe(true);

      // The occurrence settles through the composed runner/settler path.
      let guard = 0;
      while (historyStore.getRun(stack.runId) === undefined && guard < 90) {
        await advanceTurn(stack, 60_000);
        guard += 1;
      }
      const hist = historyStore.getRun(stack.runId);
      expect(hist, "a run with no meaningful facts must settle").toBeDefined();
      expect(hist?.outcome, "a run with no meaningful facts must not succeed").not.toBe("success");
      expect(hist?.diagnostic?.code, "loss must settle by node failure, never the idle deadline").not.toBe("deadline_exceeded");
      expect(stack.deadlineSpy, "the idle budget must never fire for the loss scenario").not.toHaveBeenCalled();
      expect(stack.store.getRun(lossWfId)?.state, "workflow run must reach its reasoned failure verdict").toBe("failed");
      expect(stack.adapter.starts.length, "bounded attempts across retries").toBeLessThanOrEqual(8);
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        scenario: "loss",
        outcome: hist?.outcome,
        diagnostic: hist?.diagnostic?.code ?? null,
        detail: hist?.detail ?? null,
        starts: stack.adapter.starts.length,
        cancels: stack.adapter.cancels.length,
        wfState: stack.store.getRun(lossWfId)?.state ?? null,
        rootStatus: lossRootCard !== undefined ? kanban.kanbanGetCard(lossRootCard)?.status ?? null : null,
        nodes: stack.store.listNodes(lossWfId, stack.store.currentRevision(lossWfId))
          .map((n) => `${n["node_id"] as string}:${n["status"] as string}`),
        attempts: liveWorkTurns(stack).map((t) => `${t.nodeId}:${new SupStoreMod.WorkerSupervisionStore().getAttempt(t.attemptId)?.lifecycle ?? "gone"}`),
      }));
    } finally {
      vi.useRealTimers();
      await stack.teardown();
    }
  }, 300_000);
});
