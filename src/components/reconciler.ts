import { nerve } from "./nerve.js";
import {
  kanbanFail,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds, kanbanStrandedQueuedProjectIds,
  kanbanQueuedDispatchOrder, kanbanTransition, sqliteNow,
  isUnblocked, cascadeFail, type KanbanCard, type TaskDatabase,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn, logError, redactSecrets } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import {
  ReconcileQuarantineStore,
  reconcileErrorSignature,
} from "./reconcile-quarantine-store.js";
import { logSwarmTrace } from "./swarm-trace.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutionObservation } from "./swarm-executor-types.js";
import { resolveSchedulingPolicy, deriveDeadline } from "./swarm-dispatch-policy.js";
import { resolveAndValidateWorkspace } from "./pi-executor/config.js";
import { LeaseReconciliationService } from "./executor-lease-reconciler.js";
import type { LifecycleWakeScheduler } from "./lifecycle-wake-scheduler.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { AGENT_EXECUTOR_ID, type ExecutorKind } from "./worker-executor-identity.js";
import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";
import { isRunnerManagedCard } from "./orc-project/orc-workflow-settlement.js";
import { drainPeerCallbackOutbox } from "./peer-callback-outbox.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle, AttemptRow } from "./worker-supervision-store.js";
import { acceptancePassed } from "./worker-contract.js";
import { RetryService } from "./retry/retry-service.js";
import { LocalExecutorCatalog, providerForAdapter } from "./retry/local-executor-catalog.js";

const TAG = "reconciler";

// ── Public types (#1554) ─────────────────────────────────────────────────────

/** Complete, generation-owned Reconciler dependency set. */
export interface ReconcilerDeps {
  readonly generationId: string;
  readonly coordinator: OrcProjectCoordinator;
  readonly wakeScheduler: LifecycleWakeScheduler;
  readonly workerAdapter: SwarmExecutorAdapter;
  readonly piService: PiRunService | null;
  readonly createPiAdapter: (service: PiRunService) => SwarmExecutorAdapter;
  readonly getQuarantineStore: () => ReconcileQuarantineStore;
  readonly projectRunProgress: (cardId: number) => void;
  readonly failureCascade?: (event: import("./sha/sha-types.js").ScheduledFailureEvent) => void;
}

export type RecoveryAttemptResult =
  | {
      readonly kind: "process_bound";
      readonly attemptId: string;
      readonly cardId: number;
      readonly outcome: "settled" | "already_resolved";
    }
  | {
      readonly kind: "inspectable";
      readonly attemptId: string;
      readonly cardId: number;
      readonly executorKind: ExecutorKind;
      readonly executorId: string;
      readonly observation: ExecutionObservation;
    }
  | {
      readonly kind: "unresolved";
      readonly attemptId: string;
      readonly cardId: number;
      readonly executorKind: ExecutorKind;
      readonly executorId: string;
      readonly reason: "executor_unavailable" | "inspection_failed" | "observation_unknown";
      readonly detail?: string;
    };

export interface ReconcilerRecoveryReport {
  readonly generationId: string;
  readonly attempts: readonly RecoveryAttemptResult[];
  readonly recoveredProjectIds: readonly number[];
}

export interface ReconcilerHandle {
  readonly generationId: string;
  readonly recovery: ReconcilerRecoveryReport;
  stop(): Promise<void>;
}

// ── One explicit bridge-generation runtime (#1554) ──────────────────────────

type ReconcilerPhase = "starting" | "running" | "closing" | "stopped";

interface ReconcilerGeneration {
  readonly id: string;
  phase: ReconcilerPhase;
  readonly deps: ReconcilerDeps;
  readonly cardStates: Map<number, CardReconcilerState>;
  readonly dispatchPump: DispatchPumpState;
  readonly inFlight: Set<Promise<void>>;
  readonly pendingProjectWakes: Set<number>;
  readonly disposers: Array<() => void>;
  recovery: ReconcilerRecoveryReport | null;
  stopPromise: Promise<void> | null;
  onLeaseChanged: (() => void) | null;
}

let activeGeneration: ReconcilerGeneration | null = null;

/** #1554: a generation owns its work while it is the active, running one. */
function isActive(generation: ReconcilerGeneration): boolean {
  return activeGeneration?.id === generation.id && generation.phase === "running";
}

/** #1554: rate-limited fail-closed diagnostic for the request façade. */
const _lastFacadeWarnAt = new Map<string, number>();
function boundedFacadeLog(entry: string, detail: string): void {
  const now = Date.now();
  const last = _lastFacadeWarnAt.get(entry) ?? 0;
  if (now - last < 5000) return;
  _lastFacadeWarnAt.set(entry, now);
  logWarn(TAG, `${entry} unavailable — no running Reconciler generation (${detail})`);
}

/**
 * #1554: terminal work tracker. The handled promise never rejects: the work
 * rejection is contained by `containFailure` (quarantine for card passes,
 * logging for dispatch), and the cleanup chain is failure-safe. Never use a
 * floating `finally()` — it creates a second promise that rejects with the
 * original error.
 */
function track(
  generation: ReconcilerGeneration,
  work: () => Promise<void>,
  containFailure: (error: unknown) => void,
): void {
  const handled = Promise.resolve()
    .then(work)
    .catch((error: unknown) => safeContain(containFailure, error));
  generation.inFlight.add(handled);
  void handled.then(
    () => generation.inFlight.delete(handled),
    (error: unknown) => {
      generation.inFlight.delete(handled);
      emergencyContainmentLog(undefined, error);
    },
  );
}

/** Non-throwing containment wrapper — the boundary handler itself must never escape. */
function safeContain(containFailure: (error: unknown) => void, error: unknown): void {
  try {
    containFailure(error);
  } catch (containmentError) {
    emergencyContainmentLog(undefined, containmentError);
  }
}

function dispatchExecutor(generation: ReconcilerGeneration, executorKind: ExecutorKind, executorId: string): { kind: "agent" | "pi"; id: string; adapter: SwarmExecutorAdapter } | undefined {
  // #1637: one durable executor identity — the attempt column is the
  // canonical vocabulary (agent | pi | remote). Dispatch executes the stored
  // identity unchanged; it never substitutes a synonym.
  if (executorKind === "agent") {
    return { kind: "agent", id: executorId, adapter: generation.deps.workerAdapter };
  }
  if (executorKind === "pi" && generation.deps.piService) {
    return { kind: "pi", id: executorId, adapter: generation.deps.createPiAdapter(generation.deps.piService) };
  }
  return undefined;
}

/** #1554: read-only access to the active generation's Orc coordinator. */
export function getActiveOrcCoordinator(): OrcProjectCoordinator | null {
  return activeGeneration?.deps.coordinator ?? null;
}

import { OrcProjectCoordinator } from "./orc-project/orc-project-coordinator.js";

function quarantineStore(generation: ReconcilerGeneration): ReconcileQuarantineStore {
  return generation.deps.getQuarantineStore();
}

type QuarantineStoreDiagnostic = "lookup" | "record" | "clear";
const quarantineStoreDiagnostics = new Set<QuarantineStoreDiagnostic>();

/**
 * Store failures are secondary containment failures. Keep the first one for
 * each operation visible with its card attribution, but do not let a broken
 * store turn every wake into another log line.
 */
function logQuarantineStoreDiagnosticOnce(
  kind: QuarantineStoreDiagnostic,
  cardId: number,
  message: string,
  err: unknown,
): void {
  if (quarantineStoreDiagnostics.has(kind)) return;
  quarantineStoreDiagnostics.add(kind);
  try {
    logError(TAG, message, err);
  } catch (loggingError) {
    emergencyContainmentLog(cardId, loggingError);
  }
}

function safeIsQuarantined(generation: ReconcilerGeneration, cardId: number): boolean {
  try {
    return quarantineStore(generation).isQuarantined(cardId);
  } catch (err) {
    logQuarantineStoreDiagnosticOnce(
      "lookup",
      cardId,
      `Quarantine lookup failed for card ${cardId} — failing open, bridge stays alive`,
      err,
    );
    return false;
  }
}

function safeRecordReconcileFailure(generation: ReconcilerGeneration, cardId: number, err: unknown): void {
  logError(TAG, `Card ${cardId}: reconcile pass failed — recording for quarantine`, err);
  try {
    const row = quarantineStore(generation).recordFailure(cardId, reconcileErrorSignature(err), new Date().toISOString());
    if (row.quarantinedAt) {
      logError(TAG, `Card ${cardId}: quarantined after ${row.failureCount} consecutive reconcile failures (${row.errorSignature})`);
    }
  } catch (storeErr) {
    logQuarantineStoreDiagnosticOnce(
      "record",
      cardId,
      `Card ${cardId}: failed to record reconcile failure — quarantine unavailable, bridge stays alive`,
      storeErr,
    );
  }
}

function safeClearFailures(generation: ReconcilerGeneration, cardId: number): void {
  try {
    quarantineStore(generation).clearFailures(cardId);
  } catch (err) {
    logQuarantineStoreDiagnosticOnce(
      "clear",
      cardId,
      `Card ${cardId}: failed to clear quarantine record after successful pass`,
      err,
    );
  }
}

function safeLogDispatchFailure(err: unknown): void {
  logError(TAG, "Worker dispatch pump failed", err);
}

/**
 * Terminal guard against a mistake in a safe helper. Must never touch the
 * quarantine store (a failure here could recurse into itself) and must be
 * best-effort and non-throwing.
 */
function emergencyContainmentLog(cardId: number | undefined, err: unknown): void {
  try {
    logError(TAG, cardId !== undefined
      ? `Card ${cardId}: containment failure — reconcile error boundary itself threw`
      : "Containment failure — dispatch pump error boundary itself threw", err);
  } catch { /* nothing left to do */ }
}

// ── Keyed scheduler (per-card reconciliation) ────────────────────────────────

interface CardReconcilerState {
  running: boolean;
  dirty: boolean;
}

function getState(generation: ReconcilerGeneration, cardId: number): CardReconcilerState {
  let s = generation.cardStates.get(cardId);
  if (!s) { s = { running: false, dirty: false }; generation.cardStates.set(cardId, s); }
  return s;
}

/**
 * #1664: single choke point for every reconcile wake. Returns whether the wake
 * was accepted: a coalesced wake is accepted, only a known quarantine returns
 * false. Store lookup failure logs a bounded infrastructure error and fails
 * open — the pass still runs behind the terminal boundary.
 *
 * #1554: starting-state wakes are queued by project id and flushed after the
 * generation reaches running; closing/stopped wakes are discarded.
 */
function wakeCard(generation: ReconcilerGeneration, cardId: number): boolean {
  if (generation.phase === "starting") {
    generation.pendingProjectWakes.add(cardId);
    return true;
  }
  if (generation.phase !== "running") return false;
  if (safeIsQuarantined(generation, cardId)) {
    logWarn(TAG, `Card ${cardId}: wake ignored — quarantined after repeated reconcile failures`);
    return false;
  }
  const s = getState(generation, cardId);
  if (s.running) { s.dirty = true; return true; }
  s.running = true;
  s.dirty = false;
  track(generation, () => runReconcileBehindBoundary(generation, cardId), (err: unknown) => safeRecordReconcileFailure(generation, cardId, err));
  return true;
}

/** #1664: terminal, non-throwing handler for a scheduled reconcile pass. */
function runReconcileBehindBoundary(generation: ReconcilerGeneration, cardId: number): Promise<void> {
  return reconcileCard(generation, cardId)
    .then(
      () => {
        // A normal return during the closing transition means the pass was
        // cancelled before deriveAction ran; it is not a successful pass.
        if (isActive(generation)) safeClearFailures(generation, cardId);
      },
      (err: unknown) => safeRecordReconcileFailure(generation, cardId, err),
    );
}

async function reconcileCard(generation: ReconcilerGeneration, cardId: number): Promise<void> {
  const s = getState(generation, cardId);
  try {
    do {
      s.dirty = false;
      if (!isActive(generation)) return;
      await deriveAction(generation, cardId);
    } while (s.dirty);
  } finally {
    s.running = false;
  }
}

// ── Derive action ─────────────────────────────────────────────────────────────
// (#1792: supervised-root inference deleted with the supervised brain —
// ownership lives in workflow runs, not card/supervision predicates.)

async function deriveAction(generation: ReconcilerGeneration, cardId: number): Promise<void> {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  if (card.type === "O") {
    // #1792: supervised roots are runner-owned. The workflow driver (nerve
    // wakes + bounded audit) advances them; the reconciler never infers
    // supervised ownership, continuation, salvage, repair, or review.
    return;
  }

  await reconcileChildCard(generation, card);
}

function reconcilePiCard(generation: ReconcilerGeneration, card: KanbanCard): void {
  const svc = generation.deps.piService;
  if (!svc) {
    logWarn(TAG, `Pi card ${card.id} queued but Pi service not available`);
    return;
  }
  if (card.status !== "queued") return;
  if (!isUnblocked(card)) return;

  if (svc.executor.activeCount >= svc.executor.maxConcurrent) {
    logInfo(TAG, `Pi card ${card.id} queued but Pi capacity full (${svc.executor.activeCount}/${svc.executor.maxConcurrent})`);
    return;
  }

  const run = svc.store.getByCardId(card.id);
  if (!run) {
    logWarn(TAG, `Pi card ${card.id} has no associated Pi run`);
    return;
  }
  if (run.status !== "queued") {
    logWarn(TAG, `Pi card ${card.id} run ${run.id} status is ${run.status} not queued`);
    return;
  }

  // #1638: the canonical workspace path is the shared admission key. An
  // unresolvable alias cannot start; a busy path keeps run+card queued.
  const ws = resolveAndValidateWorkspace(run.workspaceAlias, svc.config);
  if (ws.error) {
    logWarn(TAG, `Pi card ${card.id}: workspace alias invalid — ${ws.error}`);
    return;
  }

  const claim = svc.store.claimQueuedGeneration(card.id, ws.canonicalPath);
  if (!claim.claimed) {
    if (claim.reason === "busy" || claim.reason === "not_startable") {
      // #1638/#1648: paired waiting state — run and card stay queued, no
      // process or workspace claim held. A release wake starts it later.
      logInfo(TAG, `Pi card ${card.id} waiting: ${claim.reason} (${run.workspaceAlias} busy)`);
      return;
    }
    logWarn(TAG, `Failed to claim Pi card ${card.id}: ${claim.reason}`);
    return;
  }

  logInfo(TAG, `Starting Pi run ${claim.runId} (card ${card.id}, gen ${claim.generation})`);
  svc.executor.startWithClaim(claim.runId, claim.generation, run.currentSessionId ?? `${Date.now()}_C_pi_${claim.runId}`).catch((err) => {
    logWarn(TAG, `Pi start failed for ${claim.runId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function reconcileChildCard(generation: ReconcilerGeneration, card: KanbanCard): Promise<void> {
  if (card.type === "pi") {
    reconcilePiCard(generation, card);
    return;
  }

  const svc = new WorkerSupervisionService();
  const hasContract = svc.cardHasContract(card.id);
  if (!hasContract) return;

  const latestAttempt = getLatestAttemptInfo(card.id);

  if (card.status === "queued") {
    if (!isUnblocked(card)) return;
    if (latestAttempt && latestAttempt.lifecycle === "pending") {
      requestWorkerDispatchFor(generation);
    }
    return;
  }

  if (card.status === "failed" && latestAttempt) {
    handleSupervisedRetry(generation, card, latestAttempt.lifecycle);
    return;
  }

  if (latestAttempt && !isTerminal(latestAttempt.lifecycle)) {
    evaluateLease(generation, card);
    return;
  }

  if (latestAttempt && latestAttempt.lifecycle === "cancel_requested") {
    return;
  }
}

/** #1554: internal pump entry for a captured generation. */
function requestWorkerDispatchFor(generation: ReconcilerGeneration): void {
  // A card pass can resume after shutdown has entered `closing`. Do not let
  // that continuation create a new tracked pump; the generation token check
  // inside the pump is too late because stop() may already have snapshotted
  // the in-flight set.
  if (!isActive(generation)) return;
  const pump = generation.dispatchPump;
  pump.dirty = true;
  if (!pump.running) {
    pump.running = true;
    // #1664: logged terminal handler, not a silent swallow. The pump is
    // re-entered by the next requestWorkerDispatch() and a persistent failure
    // stays visible in the log. No quarantine here: the pass spans all projects,
    // so a throw cannot be attributed to one card.
    track(generation, () => runWorkerDispatch(generation), (err: unknown) => safeLogDispatchFailure(err));
  }
}

export function requestWorkerDispatch(): void {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("requestWorkerDispatch", "no work scheduled");
    return;
  }
  requestWorkerDispatchFor(generation);
}

interface DispatchPumpState {
  running: boolean;
  dirty: boolean;
}

async function runWorkerDispatch(generation: ReconcilerGeneration): Promise<void> {
  try {
    do {
      generation.dispatchPump.dirty = false;
      if (!isActive(generation)) return;
      await dispatchOnePass(generation);
    } while (generation.dispatchPump.dirty);
  } finally {
    generation.dispatchPump.running = false;
  }
}

/**
 * #1778: attempt-correlated card projection. A worker card terminalizes from
 * its attempt owner's durable verdict; the journal row carries the deciding
 * attempt identity and generation (the budget_enforcement pattern), so a late
 * projection is auditable to its owner instead of posing as an unattributed
 * card write. Field and from-set parity with kanbanComplete/kanbanFail is
 * deliberate — only the correlation is new.
 */
function projectAttemptCard(
  db: TaskDatabase,
  cardId: number,
  to: "done" | "failed",
  attempt: { id: string; generation: number },
  summary: string,
): void {
  if (to === "done") {
    kanbanTransition({
      cardId,
      from: ["running", "queued"],
      to: "done",
      actor: "settle_done",
      reason: "worker settlement complete",
      attemptId: attempt.id,
      claimGeneration: attempt.generation,
      fields: {
        result_path: null,
        result_summary: summary.slice(0, 4000),
        completed_at: sqliteNow(),
      },
    }, db);
  } else {
    kanbanTransition({
      cardId,
      from: ["queued", "running", "done"],
      to: "failed",
      actor: "settle_failed",
      reason: "worker settlement failed",
      attemptId: attempt.id,
      claimGeneration: attempt.generation,
      fields: { error: summary.slice(0, 1000), completed_at: sqliteNow() },
    }, db);
  }
}

async function dispatchOnePass(generation: ReconcilerGeneration): Promise<void> {
  const store = new WorkerSupervisionStore();
  const capacities = new Map<string, { adapter: SwarmExecutorAdapter; max: number }>();
  const rootDeadlines = new Map<number, string | undefined>();

  const queued = kanbanQueuedDispatchOrder();
  for (const card of queued) {
    if (!isActive(generation)) return;

    if (!isUnblocked(card)) continue;
    if (card.parent_id == null) continue;
    const projectId = card.parent_id;

    const project = kanbanGetCard(projectId);
    if (!project || project.status !== "running") continue;

    const supSvc = new WorkerSupervisionService();
    const hasContract = supSvc.cardHasContract(card.id);
    if (!hasContract) continue;

    const latestAttempt = store.getLatestAttempt(card.id);
    // #1644: a terminal attempt whose card was never transitioned (executor-
    // settled lanes such as Pi settle the attempt but never touch the W card)
    // is completed/failed here from the durable attempt state. The card must
    // never lag the attempt — a project cannot reach review otherwise.
    // #1656: a `completed` lifecycle means the executor finished, not that
    // acceptance passed. The exact-contract predicate decides the W card:
    // a completed envelope whose criteria did not all pass fails the card.
    if (!latestAttempt) continue;
    if (store.isAttemptTerminal(latestAttempt.lifecycle)) {
      if (card.status === "queued" || card.status === "running") {
        if (latestAttempt.lifecycle === "completed") {
          const resultData = store.getResultByAttempt(latestAttempt.id);
          const completedContract = resultData ? supSvc.getContractForCard(card.id) : undefined;
          if (completedContract && resultData && acceptancePassed(completedContract, resultData.envelope)) {
            projectAttemptCard(store.db, card.id, "done", { id: latestAttempt.id, generation: latestAttempt.generation || 1 }, "worker completed");
          } else {
            projectAttemptCard(store.db, card.id, "failed", { id: latestAttempt.id, generation: latestAttempt.generation || 1 }, "worker completed without passing acceptance");
          }
        } else {
          projectAttemptCard(store.db, card.id, "failed", { id: latestAttempt.id, generation: latestAttempt.generation || 1 }, `worker ${latestAttempt.lifecycle}`);
        }
        generation.dispatchPump.dirty = true;
      }
      continue;
    }
    if (latestAttempt.lifecycle !== "pending") continue;

    const executor = dispatchExecutor(generation, latestAttempt.executor_kind, latestAttempt.executor_id);
    if (!executor) {
      // #1638: a coding (Pi) attempt with no live Pi service is a runtime
      // eligibility failure — settle through the normal Worker start-failure
      // path with bounded evidence. Never leave the attempt pending because
      // no adapter was constructed, and never fall back to Spin.
      if (latestAttempt.executor_kind === "pi") {
        const eligibilityClaim = store.claimAttempt(
          card.id,
          latestAttempt.contract_id,
          latestAttempt.executor_kind,
          latestAttempt.executor_id,
          latestAttempt.generation || 1,
        );
        if (eligibilityClaim && store.markAttemptStartObservable(eligibilityClaim.attemptId)) {
          store.terminalSettlement({
            attemptId: eligibilityClaim.attemptId,
            expectedGeneration: eligibilityClaim.generation,
            desiredState: "failed",
            stableReason: "pi_executor_unavailable",
          });
          projectAttemptCard(store.db, card.id, "failed", { id: eligibilityClaim.attemptId, generation: eligibilityClaim.generation }, "Pi executor unavailable for coding child");
        } else {
          // No eligibility claim could be recorded — the card cannot stay
          // queued forever. Fail it unattributed exactly as before: no
          // attempt decided this verdict, so there is nothing to correlate.
          kanbanFail(card.id, "Pi executor unavailable for coding child");
        }
      }
      continue;
    }
    const capacityKey = `${executor.kind}:${executor.id}`;
    let capacity = capacities.get(capacityKey);
    if (!capacity) {
      const snapshot = await executor.adapter.capacity();
      capacity = { adapter: executor.adapter, max: snapshot.max };
      capacities.set(capacityKey, capacity);
    }
    if (capacity.max <= 0) continue;
    if (store.getActiveAttemptCountForExecutor(executor.kind, executor.id) >= capacity.max) continue;

    if (latestAttempt.source_attempt_id) {
      if (latestAttempt.earliest_claim_at && new Date(latestAttempt.earliest_claim_at).getTime() > Date.now()) {
        continue;
      }
    }

    const contract = supSvc.getContractForCard(card.id);
    if (!contract) continue;

    const rootHardDeadline = rootDeadlines.get(projectId) ?? (() => {
      const row = new ProjectReviewStore().getContractByProjectCardId(projectId);
      let deadline: string | undefined;
      if (row) {
        try {
          const root = JSON.parse(row.contract_json) as { limits?: { hard_deadline_at?: string } };
          deadline = root.limits?.hard_deadline_at;
        } catch (err) {
          logWarn(TAG, `Invalid root contract for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      rootDeadlines.set(projectId, deadline);
      return deadline;
    })();
    const executorMax = capacity.max;
    const policy = resolveSchedulingPolicy(executor.kind);
    const workerMaxDurationMs = contract.limits?.max_duration_ms;
    const claimedAt = new Date().toISOString();
    const hardDeadlineAt = deriveDeadline(claimedAt, policy, rootHardDeadline, workerMaxDurationMs);

    const reservedTokens = (project.max_tokens != null && contract.limits?.max_tokens != null)
      ? Number(contract.limits.max_tokens)
      : 0;

    const result = store.claimAttemptWithinLimits({
      cardId: card.id,
      attemptId: latestAttempt.id,
      contractId: contract.id,
      executorKind: executor.kind,
      executorId: executor.id,
      generation: latestAttempt.generation || 1,
      executorMax,
      hardDeadlineAt,
      reservedTokens,
      projectId,
      sourceAttemptId: latestAttempt.source_attempt_id ?? undefined,
    });

    logSwarmTrace({
      event: "dispatch_selected",
      card: card.id,
      attempt: latestAttempt.id,
      reason: result.kind,
    });

    if (result.kind === "budget_exhausted") {
      store.terminalSettlement({
        attemptId: latestAttempt.id,
        expectedGeneration: latestAttempt.generation || 1,
        desiredState: "cancelled",
        stableReason: "budget_exhausted",
      });
      // #1590: the transition owns error + completed_at + the card:failed
      // event the old kanbanFail call emitted. attemptId/generation correlate
      // the journal row to the worker_attempt that was refused. The store's
      // own TaskDatabase is passed explicitly — never the module singleton,
      // so out-of-process or mocked contexts stay on the right connection.
      kanbanTransition({
        cardId: card.id,
        from: ["queued", "running"],
        to: "failed",
        actor: "budget_enforcement",
        reason: "budget_exhausted",
        attemptId: latestAttempt.id,
        claimGeneration: latestAttempt.generation || 1,
        fields: { error: "budget_exhausted", completed_at: sqliteNow() },
      }, store.db);
      continue;
    }

    if (result.kind !== "claimed") continue;
    const claim = (result as { kind: "claimed"; claim: ExecutionClaim }).claim;
    if (!store.markAttemptStartObservable(claim.attemptId)) {
      store.terminalSettlement({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        desiredState: "failed",
        stableReason: "could not enter starting state",
      });
      projectAttemptCard(store.db, card.id, "failed", { id: claim.attemptId, generation: claim.generation }, "could not enter starting state");
      continue;
    }

    logSwarmTrace({ event: "worker_claim", card: card.id, attempt: claim.attemptId, generation: claim.generation, executor: claim.executorId });

    let observation;
    try {
      observation = await executor.adapter.start(claim);
    } catch (err) {
      observation = { kind: "start_failed" as const, reason: String(err), retryable: true };
    }

    if (observation.kind === "started" || observation.kind === "already_started") {
      store.markAttemptRunning(claim.attemptId);
      logSwarmTrace({ event: "worker_started", card: card.id, attempt: claim.attemptId, generation: claim.generation, executor: claim.executorId });
      // #1644: an executor that settles the attempt synchronously inside start
      // (Pi lanes) leaves the W card untransitioned — complete it from the
      // durable attempt state and re-run the pump.
      // #1656: a `completed` lifecycle means the executor finished, not that
      // acceptance passed — the exact-contract envelope predicate decides.
      const afterStart = store.getLatestAttempt(card.id);
      if (afterStart && store.isAttemptTerminal(afterStart.lifecycle) && (card.status === "queued" || card.status === "running")) {
        if (afterStart.lifecycle === "completed") {
          const afterResult = store.getResultByAttempt(afterStart.id);
          const afterContract = afterResult ? supSvc.getContractForCard(card.id) : undefined;
          if (afterContract && afterResult && acceptancePassed(afterContract, afterResult.envelope)) {
            projectAttemptCard(store.db, card.id, "done", { id: afterStart.id, generation: afterStart.generation || 1 }, "worker completed");
          } else {
            projectAttemptCard(store.db, card.id, "failed", { id: afterStart.id, generation: afterStart.generation || 1 }, "worker completed without passing acceptance");
          }
        } else {
          projectAttemptCard(store.db, card.id, "failed", { id: afterStart.id, generation: afterStart.generation || 1 }, `worker ${afterStart.lifecycle}`);
        }
        generation.dispatchPump.dirty = true;
      }
    } else if (observation.kind === "deferred" && observation.provesNoStart === true) {
      // #1638: proven-no-start contention (Pi capacity/workspace busy). The
      // attempt returns to pending without settling or consuming retry; a
      // later shared release wake re-dispatches it. Executor-neutral branch —
      // only Pi emits deferred today. No dispatch dirty flag: the wake (or
      // periodic reconciliation) is the recovery floor.
      const deferOutcome = store.deferClaimAfterProvenNoStart({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        reason: observation.reason,
      });
      logSwarmTrace({
        event: "worker_deferred",
        card: card.id,
        attempt: claim.attemptId,
        generation: claim.generation,
        reason: `${observation.reason} (defer=${deferOutcome})`,
      });
      if (deferOutcome !== "deferred") {
        logWarn(TAG, `defer failed (${deferOutcome}) for ${claim.attemptId} — settling as start failure`);
        store.terminalSettlement({
          attemptId: claim.attemptId,
          expectedGeneration: claim.generation,
          desiredState: "failed",
          stableReason: `start_failed: deferred_${observation.reason}`,
        });
        projectAttemptCard(store.db, card.id, "failed", { id: claim.attemptId, generation: claim.generation }, `worker start deferred but could not requeue: ${observation.reason}`);
      }
    } else {
      logSwarmTrace({ event: "worker_start_failed", card: card.id, attempt: claim.attemptId, reason: "start_failed" });
      store.terminalSettlement({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        desiredState: "failed",
        stableReason: `start_failed: ${observation.reason}`,
      });
      projectAttemptCard(store.db, card.id, "failed", { id: claim.attemptId, generation: claim.generation }, `worker start failed: ${observation.reason}`);
    }

  }
}

function isTerminal(lc: AttemptLifecycle): boolean {
  return lc === "completed" || lc === "failed" || lc === "cancelled" || lc === "timed_out";
}

function evaluateLease(generation: ReconcilerGeneration, card: KanbanCard): void {
  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) return;

    const adapterResolver = (executorKind: ExecutorKind, _executorId: string) => {
      if (executorKind === "agent") return generation.deps.workerAdapter;
      if (executorKind === "pi") {
        const svc = generation.deps.piService;
        if (!svc) return undefined;
        return generation.deps.createPiAdapter(svc);
      }
      return undefined;
    };

    const service = new LeaseReconciliationService(adapterResolver);
    service.evaluateAndAct(latestAttempt.id, card.id);
    scheduleLeaseEvaluations(generation);
  } catch (err) {
    logWarn(TAG, `lease evaluation failed for card ${card.id}: ${err}`);
  }
}
function handleSupervisedRetry(generation: ReconcilerGeneration, card: KanbanCard, lifecycle: AttemptLifecycle): void {
  if (lifecycle !== "failed" && lifecycle !== "cancelled" && lifecycle !== "timed_out") return;

  // #1792: attempts bound to a live workflow run are runner-owned — the runner
  // decides retries from its bounded budgets, never a second inference here
  // (no unbounded nested retry multiplication).
  try {
    if (isRunnerManagedCard(card.id)) return;
  } catch {
    // Runner lookup unavailable: fall through to the legacy path rather than
    // dropping retry handling entirely.
  }

  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) {
      logWarn(TAG, `handleSupervisedRetry: no attempt for ${card.id} — leaving card failed for Orc review`);
      return;
    }

    const retryService = buildRetryService(generation);

    const result = retryService.reduceTerminalAttempt(latestAttempt.id, card.id);
    if ("error" in result) {
      logWarn(TAG, `retry classification failed for ${card.id}: ${result.error} — leaving card failed for Orc review`);
      return;
    }

    const { classification, decision } = result;

    switch (decision.disposition) {
      case "automatic_retry": {
        const acceptResult = retryService.acceptAutomaticRetry(latestAttempt.id, card.id);
        if (acceptResult.kind === "created") {
          logInfo(TAG, `Auto-retry card ${card.id}: attempt ${latestAttempt.ordinal} -> ${acceptResult.targetAttemptId} (${classification.primary})`);
          wakeCard(generation, card.id);
        } else if (acceptResult.kind === "idempotent") {
          logInfo(TAG, `Auto-retry already scheduled for card ${card.id}: target ${acceptResult.targetAttemptId}`);
          wakeCard(generation, card.id);
        } else {
          logWarn(TAG, `Auto-retry failed for card ${card.id}: ${acceptResult.kind} — leaving card failed`);
        }
        break;
      }
      case "orc_review": {
        logInfo(TAG, `Orc review required for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        break;
      }
      case "needs_input": {
        logInfo(TAG, `Needs input for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        break;
      }
      case "stop": {
        logInfo(TAG, `Stopping retry for card ${card.id}: ${decision.reasonCode}`);
        cascadeFail(card.id, kanbanGetChildren(card.parent_id ?? 0));
        break;
      }
    }
  } catch (err) {
    logWarn(TAG, `handleSupervisedRetry error for ${card.id}: ${err} — leaving card failed for Orc review`);
  }
}

function buildRetryService(generation: ReconcilerGeneration): RetryService {
  const catalog = new LocalExecutorCatalog({
    spinProvider: providerForAdapter(generation.deps.workerAdapter, AGENT_EXECUTOR_ID),
  });
  return new RetryService({ executorCatalog: catalog });
}

function getLatestAttemptInfo(cardId: number): AttemptRow | undefined {
  const store = new WorkerSupervisionStore();
  return store.getLatestAttempt(cardId);
}

// ── Public API (#1554: generation-captured request façade) ──────────────────

/**
 * #1554: request entry points capture the active generation synchronously and
 * fail closed without scheduling side effects when no running generation
 * exists. Starting-state wakes are queued; closing/stopped wakes are dropped.
 */
export function requestReconcile(cardId: number): void {
  const generation = activeGeneration;
  if (!generation) { boundedFacadeLog("requestReconcile", `card ${cardId}`); return; }
  if (generation.phase === "starting") { generation.pendingProjectWakes.add(cardId); return; }
  if (generation.phase !== "running") { boundedFacadeLog("requestReconcile", `card ${cardId}`); return; }
  wakeCard(generation, cardId);
}

export function requestReconcileForProject(cardId: number): void {
  const generation = activeGeneration;
  if (!generation) { boundedFacadeLog("requestReconcileForProject", `card ${cardId}`); return; }
  if (generation.phase === "starting") { generation.pendingProjectWakes.add(cardId); return; }
  if (generation.phase !== "running") { boundedFacadeLog("requestReconcileForProject", `card ${cardId}`); return; }
  const card = kanbanGetCard(cardId);
  if (card?.parent_id) {
    wakeCard(generation, card.parent_id);
  }
  wakeCard(generation, cardId);
}

/**
 * #1792: the Orc-run wake helpers (scheduled-owner promotion on slot release)
 * are deleted with the Orc-run world. Supervised wakes are nerve events
 * (driver drain) plus the bounded audit; executor wakes use the dispatch pump.
 */

function scheduleLeaseEvaluations(generation: ReconcilerGeneration): void {
  generation.deps.wakeScheduler.sourceChanged("executor-lease");
}

/**
 * #1554: start one bridge-generation Reconciler runtime.
 *
 * Transactional startup: on any unexpected throw, the disposers/close path
 * runs, the active slot is cleared if owned, and the failure is rethrown so
 * BootGraph attributes it to the reconciler phase.
 */
export async function startReconciler(deps: ReconcilerDeps): Promise<ReconcilerHandle> {
  if (activeGeneration) {
    throw new Error(`Reconciler already active (generation ${activeGeneration.id}) — duplicate start rejected`);
  }
  if (!deps.coordinator || !deps.wakeScheduler || !deps.workerAdapter || !deps.createPiAdapter || !deps.getQuarantineStore || !deps.projectRunProgress) {
    throw new Error("Reconciler start rejected: incomplete dependency set");
  }

  const generation: ReconcilerGeneration = {
    id: deps.generationId,
    phase: "starting",
    deps,
    cardStates: new Map(),
    dispatchPump: { running: false, dirty: false },
    inFlight: new Set(),
    pendingProjectWakes: new Set(),
    disposers: [],
    recovery: null,
    stopPromise: null,
    onLeaseChanged: null,
  };
  activeGeneration = generation;

  try {
    // 3. Named Nerve listeners with exact removal functions.
    const onQueued = (cardId: number) => requestReconcileForProject(cardId);
    const onDone = (cardId: number) => {
      requestReconcileForProject(cardId);
      // #1778: event-driven redrive of peer delivery left pending by a
      // failed same-tick send (any card's, not just this one's). Bounded
      // (one indexed scan, ≤100 sends), emits no nerve events itself, so it
      // cannot re-arm the pump.
      drainPeerCallbackOutbox().catch(err => logAndSwallow(TAG, "peer callback redrive", err));
    };
    const onFailed = (cardId: number) => {
      requestReconcileForProject(cardId);
      // #1778: same redrive as onDone — a failed terminal may carry the
      // queued peer obligation.
      drainPeerCallbackOutbox().catch(err => logAndSwallow(TAG, "peer callback redrive", err));
    };
    nerve.on("card:queued", onQueued);
    nerve.on("card:done", onDone);
    nerve.on("card:failed", onFailed);
    generation.disposers.push(() => {
      nerve.off("card:queued", onQueued);
      nerve.off("card:done", onDone);
      nerve.off("card:failed", onFailed);
    });

    // 4. Coordinator boot recovery exactly once. Events received while
    // starting only queue project ids; wakes flush after running.
    // (#1792: the Orc ownership-release subscription is deleted with the
    // supervised brain — no post-cutover producer emits those intents.)

    // 5. Executor-lease due source (returns its scheduler disposer).
    generation.disposers.push(registerExecutorLeaseSource(generation));

    // 6. Static lease-changed hook — retain the exact callback identity so
    // stop can clear it only when still owned by this generation.
    const onLeaseChanged = (): void => {
      deps.wakeScheduler.sourceChanged("executor-lease");
      const cardId = ExecutorLeaseStore.lastChangedCardId;
      if (cardId !== undefined) projectRunProgress(generation, cardId);
    };
    generation.onLeaseChanged = onLeaseChanged;
    ExecutorLeaseStore.onLeaseChanged = onLeaseChanged;

    // 7. Coordinator boot recovery exactly once. Events received while
    // starting only queue project ids; wakes flush after running.
    const coordinatorRecovered = deps.coordinator.bootRecovery();

    // 8. Supervised-attempt recovery — exhaustive, awaited, per-attempt
    // isolated. Builds the immutable report.
    const report = await runAttemptRecovery(generation, coordinatorRecovered);
    generation.recovery = report;

    // #1778: one-shot recovery drain of the peer-callback outbox. A crash
    // between a card-terminal commit and its peer send leaves the intent
    // queued; this converges it without a new timer or heartbeat job. A
    // failed send stays pending for the event-driven redrive above. Never
    // throws (drain is total), but a defensive catch keeps boot independent
    // of delivery health.
    try {
      const redriven = await drainPeerCallbackOutbox();
      if (redriven > 0) logInfo(TAG, `Boot recovery: redrove ${redriven} pending peer callback(s)`);
    } catch (err) {
      logWarn(TAG, `Boot peer-callback drain failed — intents stay queued: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 9. Active-project scan queues into pendingProjectWakes while starting;
    // the flush below runs the quarantine-aware wake path after running.
    const activeIds = [...new Set([...kanbanRunningProjectIds(), ...kanbanStrandedQueuedProjectIds()])];

    // 10. Running — then flush the deduplicated/sorted union of coordinator
    // recovery ids, queued startup wakes, and the active-project scan.
    // (#1792: scheduled-Orc-owner wakes deleted with the Orc-run world.)
    generation.phase = "running";
    const wakeIds = [...new Set([...coordinatorRecovered, ...generation.pendingProjectWakes, ...activeIds])].sort((a, b) => a - b);
    generation.pendingProjectWakes.clear();
    let count = 0;
    const skipped: number[] = [];
    for (const projectId of wakeIds) {
      if (wakeCard(generation, projectId)) count += 1;
      else skipped.push(projectId);
    }
    if (skipped.length > 0) logWarn(TAG, `Skipped ${skipped.length} quarantined project(s): ${skipped.join(", ")}`);
    logInfo(TAG, `Reconciler started — recovered ${count} running project(s)`);

    // 11. Freeze/expose the report.
    return {
      generationId: generation.id,
      recovery: Object.freeze({
        generationId: report.generationId,
        attempts: Object.freeze([...report.attempts]),
        recoveredProjectIds: Object.freeze([...report.recoveredProjectIds]),
      }),
      stop: () => stopGeneration(generation),
    };
  } catch (err) {
    // Roll back: dispose listeners/source/hook, clear the slot if owned,
    // mark stopped, rethrow so BootGraph attributes failure to "reconciler".
    try { await stopGeneration(generation); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * #1554: idempotent, generation-fenced stop. Synchronous transition to
 * `closing` blocks new work; disposers run exactly once; the static lease hook
 * is cleared only when reference-equal to this generation's callback; then the
 * tracked in-flight set is awaited until empty before local state is cleared.
 */
function stopGeneration(generation: ReconcilerGeneration): Promise<void> {
  if (generation.stopPromise) return generation.stopPromise;
  generation.stopPromise = (async () => {
    if (generation.phase === "stopped") return;
    generation.phase = "closing";
    for (const dispose of generation.disposers.splice(0)) {
      try { dispose(); } catch (err) { logWarn(TAG, `disposer failed during Reconciler stop: ${err instanceof Error ? err.message : String(err)}`); }
    }
    generation.disposers.length = 0;
    if (generation.onLeaseChanged && ExecutorLeaseStore.onLeaseChanged === generation.onLeaseChanged) {
      ExecutorLeaseStore.onLeaseChanged = undefined;
    }
    generation.onLeaseChanged = null;
    // New work cannot enter after the closing transition; wait for the work
    // already scheduled to quiesce (including #1664 failure recording and
    // success cleanup).
    await Promise.allSettled([...generation.inFlight]);
    generation.cardStates.clear();
    generation.dispatchPump.running = false;
    generation.dispatchPump.dirty = false;
    generation.pendingProjectWakes.clear();
    generation.recovery = null;
    if (activeGeneration === generation) activeGeneration = null;
    generation.phase = "stopped";
  })();
  return generation.stopPromise;
}

function leaseWake(generation: ReconcilerGeneration, cardId: number): void {
  const card = kanbanGetCard(cardId) as { parent_id?: number } | undefined;
  if (card?.parent_id) wakeCard(generation, card.parent_id);
  requestReconcile(cardId);
}

/** #1539: register the executor-lease due source; returns the scheduler disposer. */
function registerExecutorLeaseSource(generation: ReconcilerGeneration): () => void {
  const scheduler = generation.deps.wakeScheduler;
  const disposer = scheduler.register({
    id: "executor-lease",
    listDueItems: () => new ExecutorLeaseStore().getEvaluationSchedule()
      .map(s => ({ key: `lease:${s.attemptId}`, dueAt: new Date(s.nextEvaluationAt).getTime() })),
    wakeDue: (_now: number) => {
      for (const s of new ExecutorLeaseStore().getDueSnapshots()) {
        leaseWake(generation, s.cardId);
      }
    },
  });
  // Registration is a source mutation: immediate scan + re-arm.
  try {
    scheduler.sourceChanged("executor-lease");
  } catch (err) {
    // A source must not remain installed when its initial re-scan fails; the
    // caller's startup rollback can then return the scheduler to its prior
    // ownership state.
    try { disposer(); } catch (disposeErr) {
      logWarn(TAG, `executor-lease source rollback failed: ${disposeErr instanceof Error ? disposeErr.message : String(disposeErr)}`);
    }
    throw err;
  }
  return disposer;
}

/** #1539: project lease milestones into the owning scheduled run's progress. */
function projectRunProgress(generation: ReconcilerGeneration, cardId: number): void {
  try {
    generation.deps.projectRunProgress(cardId);
  } catch (err) {
    logWarn(TAG, `run progress bridge failed for card ${cardId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * #1554: exhaustive, truthful boot recovery. Every active supervised attempt
 * read at the snapshot is accounted for in the returned report; per-attempt
 * inspection errors are isolated and represented, never propagated.
 */
async function runAttemptRecovery(generation: ReconcilerGeneration, coordinatorRecovered: number[]): Promise<ReconcilerRecoveryReport> {
  const store = new WorkerSupervisionStore();
  const active = store.getActiveSupervisedAttempts()
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (active.length === 0) {
    logInfo(TAG, "Boot recovery: no active attempts to recover");
  }

  const results: RecoveryAttemptResult[] = [];
  let recovered = 0;
  for (const attempt of active) {
    const policy = resolveSchedulingPolicy(attempt.executor_kind);
    if (policy.recovery === "process_bound") {
      const bootResult = store.terminalSettlement({
        attemptId: attempt.id,
        expectedGeneration: attempt.generation || 1,
        desiredState: "timed_out",
        stableReason: "bridge_restart",
      });
      if (bootResult.kind === "settled" || bootResult.kind === "budget_violation") {
        logSwarmTrace({ event: "recovery_settled", card: attempt.card_id, attempt: attempt.id, generation: attempt.generation, reason: "bridge_restart" });
        try {
          const card = kanbanGetCard(attempt.card_id);
          // The attempt just settled at a known generation — project the
          // card from that owner verdict, correlated for audit.
          if (card) projectAttemptCard(store.db, card.id, "failed", { id: attempt.id, generation: attempt.generation || 1 }, "bridge_restart");
        } catch (err) {
          // The durable attempt settlement is authoritative; a projection
          // failure must not make an unrelated active attempt disappear from
          // the recovery report or abort the entire bridge boot.
          logWarn(TAG, `Boot recovery card projection failed for ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
        recovered++;
      }
      results.push({
        kind: "process_bound",
        attemptId: attempt.id,
        cardId: attempt.card_id,
        outcome: bootResult.kind === "settled" || bootResult.kind === "budget_violation" ? "settled" : "already_resolved",
      });
      continue;
    }
    if (policy.recovery === "inspectable") {
      let adapter: SwarmExecutorAdapter | undefined;
      try {
        adapter = resolveAdapterForRecovery(generation, attempt.executor_kind, attempt.executor_id);
      } catch (err) {
        const bounded = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
        logWarn(TAG, `Boot recovery adapter construction failed for ${attempt.id}: ${bounded}`);
        results.push({
          kind: "unresolved",
          attemptId: attempt.id,
          cardId: attempt.card_id,
          executorKind: attempt.executor_kind,
          executorId: attempt.executor_id,
          reason: "inspection_failed",
          detail: bounded,
        });
        continue;
      }
      if (!adapter) {
        results.push({
          kind: "unresolved",
          attemptId: attempt.id,
          cardId: attempt.card_id,
          executorKind: attempt.executor_kind,
          executorId: attempt.executor_id,
          reason: "executor_unavailable",
        });
        continue;
      }
      const claim: ExecutionClaim = {
        attemptId: attempt.id,
        cardId: attempt.card_id,
        contractId: attempt.contract_id,
        executorKind: attempt.executor_kind as "agent" | "pi",
        executorId: attempt.executor_id,
        generation: attempt.generation || 1,
        claimedAt: attempt.claimed_at ?? attempt.started_at,
        hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
      };
      try {
        const observation = await adapter.inspect(claim);
        if (observation.kind === "terminal") {
          store.terminalSettlement({
            attemptId: attempt.id,
            expectedGeneration: attempt.generation || 1,
            desiredState: observation.lifecycle as "completed" | "failed" | "cancelled" | "timed_out",
            stableReason: "recovery_inspection_terminal",
          });
        } else if (observation.kind === "unknown") {
          results.push({
            kind: "unresolved",
            attemptId: attempt.id,
            cardId: attempt.card_id,
            executorKind: attempt.executor_kind,
            executorId: attempt.executor_id,
            reason: "observation_unknown",
            detail: redactSecrets(String(observation.message ?? "")).slice(0, 200),
          });
          continue;
        }
        results.push({
          kind: "inspectable",
          attemptId: attempt.id,
          cardId: attempt.card_id,
          executorKind: attempt.executor_kind,
          executorId: attempt.executor_id,
          observation,
        });
        logSwarmTrace({ event: "recovery_inspect", card: attempt.card_id, attempt: attempt.id, reason: "inspectable_attempt" });
      } catch (err) {
        const bounded = redactSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200);
        logWarn(TAG, `Boot recovery inspection failed for ${attempt.id}: ${bounded}`);
        results.push({
          kind: "unresolved",
          attemptId: attempt.id,
          cardId: attempt.card_id,
          executorKind: attempt.executor_kind,
          executorId: attempt.executor_id,
          reason: "inspection_failed",
          detail: bounded,
        });
      }
    }
  }
  if (recovered > 0) {
    logInfo(TAG, `Boot recovery: settled ${recovered} process-bound attempt(s)`);
  }
  return {
    generationId: generation.id,
    attempts: results,
    recoveredProjectIds: [...new Set(coordinatorRecovered)].sort((a, b) => a - b),
  };
}

function resolveAdapterForRecovery(generation: ReconcilerGeneration, executorKind: ExecutorKind, _executorId: string): SwarmExecutorAdapter | undefined {
  if (executorKind === "agent") return generation.deps.workerAdapter;
  if (executorKind === "pi") {
    const svc = generation.deps.piService;
    if (!svc) return undefined;
    return generation.deps.createPiAdapter(svc);
  }
  return undefined;
}
