import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanComplete,
  kanbanFail,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds, kanbanStrandedQueuedProjectIds,
  kanbanQueuedDispatchOrder, kanbanPromoteDueRetry, kanbanTransition, sqliteNow, KANBAN_TERMINAL_STATUSES,
  isUnblocked, cascadeFail, resolveRootId, type KanbanCard,
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
import { ProjectReviewStore, type ProjectMutationAuthority, type ProjectState, type ProjectSupervisionRow } from "./project-acceptance/project-review-store.js";
import { ReviewCaseAssembler } from "./project-acceptance/project-review-case.js";
import { readProjectCriterionCoverage, coverageSignature } from "./project-acceptance/project-criterion-coverage.js";
import { delegatedCriterionIds } from "./project-acceptance/project-contract.js";
import { OrcProjectRunStore } from "./orc-project/orc-project-run-store.js";
import { REVIEW_REQUEST_ABANDONED } from "./project-acceptance/project-review-contract.js";
import { readEntries } from "./tasks/task-store.js";
import { readState } from "./tasks/task-state-store.js";
import { settleRunOnce } from "./tasks/task-run-settler.js";
import { makeTaskFailure } from "./tasks/task-failure.js";
import type { TaskFailureDiagnosticV1 } from "./tasks/task-failure.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle, AttemptRow } from "./worker-supervision-store.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";
import { acceptancePassed } from "./worker-contract.js";
import { RetryService } from "./retry/retry-service.js";
import { LocalExecutorCatalog, providerForAdapter } from "./retry/local-executor-catalog.js";
import type { OrcOwnershipReleasedV1 } from "./orc-project/orc-project-contracts.js";

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
  readonly failureCascade?: (entryId: string, diagnostic: TaskFailureDiagnosticV1) => void;
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

function projectMutationAuthority(projectCardId: number, projectGeneration: number): ProjectMutationAuthority {
  const root = kanbanGetCard(projectCardId);
  return {
    projectCardId,
    projectGeneration,
    // Scheduled identity requires a durable source_id (isScheduledRootIdentity);
    // a 'task' source string alone is not scheduled and carries no run fence.
    ...(root?.source === "task" && root.source_id ? { scheduledRunId: root.source_id } : {}),
  };
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

import {
  MAX_STARTED_CONTRACT_AUTHORING_TURNS,
  MAX_CONSECUTIVE_UNSTARTABLE_AUTHORING_TURNS,
  MIN_AUTHORING_CLAIM_INTERVAL_MS,
} from "./orc-project/orc-project-contracts.js";

// #1604 R2: coverage-round bounds. MAX_COVERAGE_ROUNDS is the absolute ceiling
// on coverage turns; COVERAGE_ROUND_GRACE_MS bounds only the non-scheduled
// legacy dispatch path, whose claim is not durably observable.
const MAX_COVERAGE_ROUNDS = 3;
const COVERAGE_ROUND_GRACE_MS = 60_000;

/**
 * #1516: Public project-abort boundary. Terminalizes all non-terminal Worker
 * children and the root idempotently. A terminal root (accepted/delivered/
 * failed) is never touched — late cancellation cannot clobber settled state.
 */
export async function abortProjectById(projectId: number, reason: string): Promise<void> {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("abortProjectById", `project ${projectId}`);
    return;
  }
  const card = kanbanGetCard(projectId);
  if (!card) return;
  if (card.status === "done" || card.status === "delivered" || card.status === "failed") {
    logInfo(TAG, `Project ${projectId}: already terminal (${card.status}) — abort skipped`);
    return;
  }
  const children = kanbanGetChildren(projectId);
  await abortProject(generation, projectId, children, reason);
}

function scheduleOrcReview(generation: ReconcilerGeneration, projectId: number, projectGeneration: number, caseId: string, requestId: string): void {
  const result = generation.deps.coordinator.scheduleReview(projectId, projectGeneration, caseId);
  // #1678: count real dispatch attempts only. A successful claim clears any
  // previous failure; a rejected dispatch records its typed reason. An
  // `idempotent` (run already live) or `busy` (another intent owns the
  // project) claim is an observation, not an attempt.
  if (result.kind === "claimed") {
    try { new ProjectReviewStore().recordReviewRequestDispatchAttempt(requestId, null); } catch (err) { logAndSwallow(TAG, "record review request dispatch attempt", err); }
  } else if (result.kind === "conflict" || result.kind === "not_actionable") {
    try { new ProjectReviewStore().recordReviewRequestDispatchAttempt(requestId, result.reason); } catch (err) { logAndSwallow(TAG, "record review request dispatch attempt", err); }
  }
}

function legacyOrcDispatch(goal: string, cardId: number): void {
  try {
    spin.dispatch({ type: "O", goal, source: "agent", cardId, settlementOwner: "spin" });
  } catch (err) {
    logWarn(TAG, `Failed to dispatch Orc — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// #1628: discriminated scheduling result — the boolean collapse was exactly
// how the original dropped (busy) claim went unobserved.
type AuthoringScheduleResult =
  | { kind: "claimed" }
  | { kind: "idempotent" }
  | { kind: "deferred"; reason: "busy" | "claim_interval"; activeRunId?: string }
  | { kind: "settled"; blockerClass: string }
  | { kind: "unavailable" };

const CONTRACT_AUTHORING_EXHAUSTED = "contract_authoring_exhausted";
const CONTRACT_AUTHORING_UNSTARTABLE = "contract_authoring_unstartable";

/**
 * #1628: schedule a contract-authoring turn or settle the project terminally.
 * Decision order: unavailable coordinator → started-turn ceiling →
 * consecutive-unstartable ceiling → minimum claim interval → claim.
 * Returns a discriminated result so callers can distinguish a deferred
 * (busy) claim from an owned one.
 */
function scheduleContractAuthoringOrSettle(generation: ReconcilerGeneration, projectId: number): AuthoringScheduleResult {
  const reviewStore = new ProjectReviewStore();
  const runStore = generation.deps.coordinator.getStore();
  const supervision = reviewStore.getSupervision(projectId);
  if (!supervision) {
    logWarn(TAG, `Project ${projectId}: no supervision while authoring contract — settling as last resort`);
    settleProjectLastResortFor(generation, projectId);
    return { kind: "unavailable" };
  }
  const projectGeneration = supervision.generation;

  const startedTurns = runStore.countStartedAuthoringTurns(projectId, projectGeneration);
  if (startedTurns >= MAX_STARTED_CONTRACT_AUTHORING_TURNS) {
    logWarn(TAG, `Project ${projectId}: ${startedTurns} started authoring turns — settling ${CONTRACT_AUTHORING_EXHAUSTED}`);
    settleAuthoringExhausted(projectId, reviewStore, runStore, CONTRACT_AUTHORING_EXHAUSTED);
    return { kind: "settled", blockerClass: CONTRACT_AUTHORING_EXHAUSTED };
  }

  const unstartableTurns = runStore.countConsecutiveUnstartableAuthoringTurns(projectId, projectGeneration);
  if (unstartableTurns >= MAX_CONSECUTIVE_UNSTARTABLE_AUTHORING_TURNS) {
    logWarn(TAG, `Project ${projectId}: ${unstartableTurns} consecutive pre-start failures — settling ${CONTRACT_AUTHORING_UNSTARTABLE}`);
    settleAuthoringExhausted(projectId, reviewStore, runStore, CONTRACT_AUTHORING_UNSTARTABLE);
    return { kind: "settled", blockerClass: CONTRACT_AUTHORING_UNSTARTABLE };
  }

  const lastClaimAt = runStore.lastAuthoringClaimAt(projectId, projectGeneration);
  if (lastClaimAt && Date.now() - Date.parse(lastClaimAt) < MIN_AUTHORING_CLAIM_INTERVAL_MS) {
    logWarn(TAG, `Project ${projectId}: authoring claim within interval — deferring (last claim ${lastClaimAt})`);
    return { kind: "deferred", reason: "claim_interval" };
  }

  const result = generation.deps.coordinator.scheduleContractAuthoring(projectId);
  if (result.kind === "not_actionable") {
    logWarn(TAG, `Project ${projectId}: contract-authoring claim not actionable (${result.reason}) — settling as last resort`);
    settleProjectLastResortFor(generation, projectId);
    return { kind: "unavailable" };
  }
  if (result.kind === "busy") {
    logWarn(TAG, `Project ${projectId}: authoring claim busy (run ${result.activeRunId}) — deferring; the ownership-released event will re-wake`);
    return { kind: "deferred", reason: "busy", activeRunId: result.activeRunId };
  }
  if (result.kind === "conflict") {
    // #1546 R3: a conflict is never a direct settle signal. Nothing owns the
    // project and nothing was claimed — report unavailable so no promotion
    // happens; the next wake (or the boot sweep) re-reads durable state.
    logWarn(TAG, `Project ${projectId}: authoring claim conflicted (${result.reason}) — no promotion, no settlement`);
    return { kind: "unavailable" };
  }
  return result.kind === "claimed" ? { kind: "claimed" } : { kind: "idempotent" };
}

/**
 * #1628: terminal settlement for authoring exhaustion. Passes NO peerEvent —
 * #1630's auto-derivation inside settleBlockedInTransaction builds the
 * requester-valid failed terminal event for peer-origin roots.
 */
function settleAuthoringExhausted(
  projectId: number,
  reviewStore: ProjectReviewStore,
  runStore: OrcProjectRunStore,
  blockerClass: string,
): void {
  const supervision = reviewStore.getSupervision(projectId);
  const generation = supervision?.generation ?? 1;
  const failureReason = runStore.lastAuthoringFailureCode(projectId, generation);
  const authority = supervision ? projectMutationAuthority(projectId, generation) : undefined;
  // The authoring-exhaustion settle has no real review case; scope the case
  // id per project so settlements never collide across projects (#1664).
  reviewStore.settleBlocked(
    projectId,
    `contract_authoring_${projectId}`,
    { action: "blocked", reason: `${blockerClass}: ${failureReason ?? "no contract produced"}` },
    blockerClass,
    undefined,
    undefined,
    authority,
  );
  try { nerve.fire("card:failed", projectId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
}

// ── Keyed scheduler (per-card reconciliation) ────────────────────────────────

interface CardReconcilerState {
  running: boolean;
  dirty: boolean;
}

// ── #1664: reconcile error boundary / poison quarantine ─────────────────────

/**
 * #1554: generation-owned quarantine accessor. The accessor is only ever
 * called inside a safe helper: construction executes DDL and can throw, and a
 * throwing construction must fail open, never become a second unhandled
 * rejection.
 */
function quarantineStore(generation: ReconcilerGeneration): ReconcileQuarantineStore {
  return generation.deps.getQuarantineStore();
}

function safeIsQuarantined(generation: ReconcilerGeneration, cardId: number): boolean {
  try {
    return quarantineStore(generation).isQuarantined(cardId);
  } catch (err) {
    logError(TAG, `Quarantine lookup failed for card ${cardId} — failing open, bridge stays alive`, err);
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
    logError(TAG, `Card ${cardId}: failed to record reconcile failure — quarantine unavailable, bridge stays alive`, storeErr);
  }
}

function safeClearFailures(generation: ReconcilerGeneration, cardId: number): void {
  try {
    quarantineStore(generation).clearFailures(cardId);
  } catch (err) {
    logError(TAG, `Card ${cardId}: failed to clear quarantine record after successful pass`, err);
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
      () => safeClearFailures(generation, cardId),
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

/**
 * #1546 R1: scheduled-root identity — a root card with all durable identity
 * facts: type O, no parent, task source, non-empty source_id (the scheduled
 * runId), and a non-terminal `project_supervision` row. Unsupervised
 * parentless cards and Worker children are never classified here.
 */
function isScheduledRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  if (card.source !== "task" || !card.source_id || card.source_id.length === 0) return false;
  return true;
}

function isScheduledProjectRoot(card: KanbanCard): boolean {
  if (!isScheduledRootIdentity(card)) return false;
  try {
    return new ProjectReviewStore().hasActiveProjectSupervision(card.id);
  } catch {
    return false;
  }
}

/**
 * #1618: source-neutral supervised-root identity — any root card (type O, no
 * parent) with a non-terminal `project_supervision` row. This is the ownership
 * gate for the Orc/Reconciler supervised lifecycle, independent of how the
 * root was admitted (scheduled task, peer contribution, CLI project). Source
 * alone is not supervision; scheduled-task behavior remains gated by
 * `isScheduledRootIdentity`.
 */
function isSupervisedRootIdentity(card: KanbanCard): boolean {
  if (card.type !== "O" || card.parent_id !== null) return false;
  try {
    return new ProjectReviewStore().hasActiveProjectSupervision(card.id);
  } catch {
    return false;
  }
}

/** #1546 R2: the queued due check uses the durable retry marker, never card age. */
function isRetryDue(card: KanbanCard, now?: number): boolean {
  if (!card.next_retry_at) return false;
  const t = Date.parse(card.next_retry_at);
  const nowVal = now ?? Date.now();
  return Number.isFinite(t) && t <= nowVal;
}

/**
 * #1618: the reconcile driver's entry gate. Running roots always reconcile;
 * queued roots reconcile when they are a scheduled project whose durable retry
 * is due, or a peer/CLI supervised root that was event-woken at admission.
 */
function isProjectReconcileEligible(project: KanbanCard): boolean {
  if (project.status === "running") return true;
  if (project.status !== "queued") return false;
  if (isScheduledProjectRoot(project) && isRetryDue(project)) return true;
  if (isSupervisedRootIdentity(project) && !isScheduledRootIdentity(project)) return true;
  return false;
}

async function deriveAction(generation: ReconcilerGeneration, cardId: number): Promise<void> {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  if (card.type === "O") {
    // #1546: running roots always reconcile; queued roots reconcile only when
    // they are a scheduled project whose retry is due. Queued+future and
    // unrelated roots remain no-ops or on their existing path.
    if (card.status === "running") {
      await reconcileProject(generation, cardId);
      return;
    }
    if (card.status === "queued" && isScheduledProjectRoot(card) && isRetryDue(card)) {
      await reconcileProject(generation, cardId);
      return;
    }
    // #1618: peer/CLI supervised roots are event-woken (admission fires
    // card:queued after commit) and reconcile without a scheduled retry gate.
    if (card.status === "queued" && isSupervisedRootIdentity(card) && !isScheduledRootIdentity(card)) {
      await reconcileProject(generation, cardId);
      return;
    }
  }

  await reconcileChildCard(generation, card);
}

const RESUMPTIVE_ATTEMPT_LIFECYCLES = new Set<AttemptLifecycle>(["pending", "claimed", "starting", "running", "cancel_requested"]);

type OwnerInspection =
  | "terminal"
  | "worker_resume"
  | "review"
  | "input"
  | "repair"
  | "executing_terminal_children"
  | "orc_claim"
  | "none";

type BranchResult = "transitioned" | "owned" | "none";

/**
 * #1605: true when the root contract exists and has NO delegated criteria
 * (an Orc-only project — the Orc satisfies every criterion itself). Fail-open
 * to false when the contract is missing, unparseable, or an unknown schema
 * version: such a project must not be classified as this owner (the coverage
 * gate blocks it anyway). v1 contracts are always delegated.
 */
function hasNoDelegatedCriteria(projectId: number, reviewStore: ProjectReviewStore): boolean {
  try {
    const row = reviewStore.getContractByProjectCardId(projectId);
    if (!row) return false;
    const parsed = JSON.parse(row.contract_json) as { schema_version?: unknown; criteria?: unknown[] };
    if (parsed.schema_version !== 2) return false;
    if (!Array.isArray(parsed.criteria)) return false;
    return delegatedCriterionIds(parsed as never).length === 0;
  } catch {
    return false;
  }
}

/**
 * #1546 R3: the exact durable owner predicate. Evaluates durable rows only —
 * in-memory handles, unsettled promises, or merely expected processes never
 * count as custody. The Reconciler's own case creation owns an executing
 * project whose direct children are all terminal (the Orc's `review_project`
 * requires an open case that only the Reconciler can assemble).
 */
function inspectProjectOwnership(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): OwnerInspection {
  if (supervision.state === "accepted" || supervision.state === "blocked") return "terminal";

  const children = kanbanGetChildren(projectId);
  const workerStore = new WorkerSupervisionStore();

  // R2: repair_planned with a valid durable decision and repair items is the
  // Reconciler worker-creation owner. Checked before worker_resume so a
  // repair round already carrying running worker rows still transitions to
  // repairing instead of being stuck re-dispatching the same round.
  if (supervision.state === "repair_planned") {
    const decision = reviewStore.getLatestDecisionForProject(projectId);
    if (decision) {
      try {
        const parsed = JSON.parse(decision.decision_json) as { repair?: { items?: unknown[] } };
        if ((parsed.repair?.items?.length ?? 0) > 0) return "repair";
      } catch { /* fall through — no durable repair items */ }
    }
  }

  // R3.1: resumable direct-child work — a non-terminal latest attempt on an
  // exact direct child. `pending` is resumable without a lease; missing or
  // expired leases stay owned by the existing lease reconciliation path.
  for (const child of children) {
    let hasContract = false;
    try { hasContract = workerStore.contractExists(child.id); } catch { hasContract = false; }
    if (!hasContract) continue;
    let attempt: AttemptRow | undefined;
    try { attempt = workerStore.getLatestAttempt(child.id); } catch { attempt = undefined; }
    if (attempt && RESUMPTIVE_ATTEMPT_LIFECYCLES.has(attempt.lifecycle)) return "worker_resume";
  }

  // R3.2: existing project-state owners.
  if (reviewStore.getLatestOpenCase(projectId)) return "review";
  if (supervision.state === "needs_input") {
    // answered rows are consumed by the existing resume transition, so both
    // pending and answered requests make the input owner authoritative
    const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
    const answered = reviewStore.getAnsweredInputRequests(projectId);
    if (pending.length > 0 || answered.length > 0) return "input";
  }
  if (supervision.state === "repairing") {
    const anyLive = children.some(c => c.status === "queued" || c.status === "running");
    const allTerminal = children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status));
    if (anyLive || allTerminal) return "repair";
  }

  // R2: the Reconciler's review case creation owns an executing project whose
  // direct children are all terminal. Zero children is normally NOT this
  // owner — it must reach the no-owner decision so the Orc spawns Workers.
  // #1605: an Orc-only project (no delegated criteria) is the exception — the
  // Orc is the sole executor, no Worker lane can exist, and the design §2
  // requires it to proceed directly to review with zero children.
  if (supervision.state === "executing") {
    if (children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status))) {
      return "executing_terminal_children";
    }
    if (children.length === 0 && hasNoDelegatedCriteria(projectId, reviewStore)) {
      return "executing_terminal_children";
    }
  }

  // R3.2: a live Orc row matching the current supervision generation is an
  // existing durable owner — never a fresh claim.
  try {
    const liveRun = new OrcProjectRunStore().getLiveRunForProject(projectId);
    if (liveRun && liveRun.project_generation === supervision.generation) return "orc_claim";
  } catch { /* fail-closed: no live-claim observation */ }

  return "none";
}

/**
 * #1546: the running root's no-owner path. Only a non-terminal project with no
 * resumable owner and no claimable continuation reaches last-resort settlement.
 */
function claimOrcContinuation(generation: ReconcilerGeneration, projectId: number, _supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore, project: KanbanCard): "owned" | "settled" {
  // #1554: the coordinator is a mandatory generation dependency; a running
  // generation always has one.
  const coordinator = generation.deps.coordinator;
  // The goal is the root card's durable goal when available,
  // otherwise a bounded continuation instruction naming the card and run.
  const goal = project.goal && project.goal.trim().length > 0
    ? project.goal
    : `[CONTINUATION] Supervised project #${projectId}, run ${project.source_id ?? "unknown"}: inspect the existing project contract and durable project rows and resume the supervised lifecycle from its current durable state (spawn pending Workers, complete the review, or settle). Do not re-author the contract.`;

  const result = coordinator.scheduleScheduledProject(projectId, goal);
  switch (result.kind) {
    case "claimed":
    case "idempotent":
      logInfo(TAG, `Project ${projectId}: scheduled Orc continuation ${result.kind} — coordinator owns it`);
      return "owned";
    case "busy": {
      logInfo(TAG, `Project ${projectId}: scheduled continuation busy — live run ${result.activeRunId} owns it; no second run created`);
      return "owned";
    }
    case "conflict": {
      // #1546 R3: conflict is never a direct settle signal. Re-read supervision
      // and re-derive ownership once; only a second pass that still finds no
      // owner and no claimable continuation may settle.
      const reRead = reviewStore.getSupervision(projectId);
      if (reRead) {
        const rederived = inspectProjectOwnership(projectId, reRead, reviewStore);
        if (rederived !== "none") {
          logInfo(TAG, `Project ${projectId}: continuation conflict — re-derive found owner ${rederived}`);
          return "owned";
        }
        const retry = coordinator.scheduleScheduledProject(projectId, goal);
        if (retry.kind === "claimed" || retry.kind === "idempotent" || retry.kind === "busy") return "owned";
      }
      settleProjectLastResortFor(generation, projectId);
      return "settled";
    }
    case "not_actionable":
      logWarn(TAG, `Project ${projectId}: scheduled continuation not actionable (${result.reason}) — settling as last resort`);
      settleProjectLastResortFor(generation, projectId);
      return "settled";
  }
}

/**
 * #1546 R3.4: last-resort settlement for a correlated scheduled root with no
 * durable owner and no claimable continuation. Freezes the project through the
 * existing idempotent abortProject path, then settles the matching active
 * scheduled run exactly once with `interruption/restart_interrupted`. Never
 * waits for the absolute run deadline. `appendRunOnce` in the settler is the
 * single dedupe authority: a concurrent waiter settle returns duplicate/late.
 */
function settleProjectLastResortFor(generation: ReconcilerGeneration, projectId: number): void {
  const card = kanbanGetCard(projectId);
  if (!card) return;
  const matched = findActiveScheduledRun(card);
  const children = kanbanGetChildren(projectId);
  const reason = "no scheduled Orc continuation owner after restart";
  // The freeze must not prevent the exactly-once settle: even if a child
  // cancellation rejects, the occurrence still settles through the settler.
  void abortProject(generation, projectId, children, reason, { skipRootFail: true })
    .catch((err) => logWarn(TAG, `last-resort abort for project ${projectId} failed — ${err instanceof Error ? err.message : String(err)}`))
    .then(() => {
    if (!matched) {
      // There is no run row to settle, but the root still needs terminal
      // evidence. Freeze the supervision row WITHOUT the run-correlated
      // authority: an orphaned scheduled root (source_id with no task_runs
      // row) has no live run to protect, so the gate would reject the block
      // with run_mismatch and leave the row stuck in 'executing' forever.
      const reviewStore = new ProjectReviewStore();
      if (reviewStore.getSupervision(projectId)) {
        // Use the same compatibility boundary as the coverage gate. Besides
        // keeping the terminalization shape identical, this lets injected
        // recovery stores that predate blockProject still fail closed through
        // their state-transition implementation.
        blockProjectWithInvalidation(reviewStore, projectId, `aborted: ${reason}`, undefined, { failCard: false });
      }
      kanbanFail(projectId, reason);
      return;
    }
    try {
      settleRunOnce({
        entry: matched.entry,
        run: matched.run,
        outcome: "failed",
        diagnostic: makeTaskFailure("interruption", "restart_interrupted", "executing", "scheduled project continuation unavailable after restart", "none"),
        detail: "reconcileProject: no durable owner and no claimable scheduled Orc continuation",
        cardId: projectId,
        onFailure: generation.deps.failureCascade,
      });
      logInfo(TAG, `Project ${projectId}: settled run ${matched.run.runId} as restart_interrupted (last resort)`);
    } catch (err) {
      logWarn(TAG, `Project ${projectId}: last-resort settlement failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/** #1554: public last-resort boundary — fail closed without a running generation. */
export function requestLastResortSettlement(projectId: number): void {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("requestLastResortSettlement", `project ${projectId}`);
    return;
  }
  settleProjectLastResortFor(generation, projectId);
}

/**
 * #1554: public last-resort boundary — fail closed without a running generation.
 */
export function settleProjectLastResort(projectId: number): void {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("settleProjectLastResort", `project ${projectId}`);
    return;
  }
  settleProjectLastResortFor(generation, projectId);
}

function findActiveScheduledRun(card: KanbanCard): { entry: import("./tasks/task-types.js").ScheduledTask; run: import("./tasks/task-state-store.js").ActiveTaskRun } | undefined {
  try {
    for (const entry of readEntries()) {
      const state = readState(entry.id);
      const run = state?.activeRun;
      if (run && run.runId === card.source_id && run.cardId === card.id) return { entry, run };
    }
  } catch (err) {
    logWarn(TAG, `findActiveScheduledRun failed for card ${card.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return undefined;
}

/**
 * #1546 R3.4: state-branch ownership handlers. `handleInputState` and
 * `handleRepairState` return "transitioned" when they advanced the project
 * (the driver re-reads and re-derives), "owned" when an existing owner holds
 * the state, and "none" when a prerequisite is missing (fall through to the
 * scheduled Orc continuation).
 */
function handleInputState(projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): BranchResult {
  const answered = reviewStore.getAnsweredInputRequests(projectId);
  if (answered.length > 0) {
    logInfo(TAG, `Project ${projectId}: ${answered.length} input(s) answered — resuming execution`);
    const authority = projectMutationAuthority(projectId, supervision.generation);
    reviewStore.clearInputNotice(projectId, authority);
    // The resume transition re-opens execution; the following case creation
    // owns the review_round advance (a fresh read bumps exactly once).
    return reviewStore.stateTransition(projectId, ["needs_input"], "executing", undefined, { authority })
      ? "transitioned"
      : "none";
  }
  const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
  if (pending.length > 0) return "owned";
  logWarn(TAG, `Project ${projectId}: needs_input state but no pending or answered requests — falling through to the no-owner decision`);
  return "none";
}

type RepairItem = {
  id: string;
  affected_criterion_ids: string[];
  strategy: string;
  required_evidence: string;
  capabilities: string[];
  budget: { max_attempts?: number; max_tokens?: number };
};

function repairWorkerGoal(item: RepairItem): string {
  // The item marker is durable in the Worker contract goal. It lets restart
  // recovery correlate a child with one decision item even though spawnChild
  // allocates the final card/contract IDs itself.
  return `Repair: ${item.strategy.slice(0, 200)} [repair-item:${item.id}]`;
}

function sameStringSet(left: readonly string[] | undefined, right: readonly string[]): boolean {
  if (!left || left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every(value => expected.has(value));
}

function hasRepairWorkerForItem(
  projectId: number,
  children: readonly KanbanCard[],
  item: RepairItem,
  supervisionService: WorkerSupervisionService,
): boolean {
  const goal = repairWorkerGoal(item);
  const legacyGoal = `Repair: ${item.strategy.slice(0, 200)}`;
  for (const child of children) {
    let contract: WorkerAcceptanceContractV1 | undefined;
    try { contract = supervisionService.getContractForCard(child.id); } catch { contract = undefined; }
    if (!contract || contract.provenance.root_card_id !== projectId) continue;
    if (contract.goal === goal) return true;
    // Existing workers created before the marker was added remain durable
    // owners. Their legacy goal is accepted only with the same root criteria,
    // so an unrelated Worker cannot satisfy a repair item by text alone.
    if (contract.goal === legacyGoal && sameStringSet(contract.supports_root_criteria, item.affected_criterion_ids)) return true;
  }
  return false;
}

function handleRepairState(generation: ReconcilerGeneration, projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): BranchResult {
  const authority = projectMutationAuthority(projectId, supervision.generation);
  if (supervision.state === "repair_planned") {
    const decision = reviewStore.getLatestDecisionForProject(projectId);
    if (!decision) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no decision found — falling through to the no-owner decision`);
      return "none";
    }
    const parsed = JSON.parse(decision.decision_json) as { repair?: { items: RepairItem[] } };
    const items = parsed.repair?.items ?? [];
    if (items.length === 0) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no repair items — falling through to the no-owner decision`);
      return "none";
    }
    const contractRow2 = reviewStore.getContractByProjectCardId(projectId);
    const rootContract = contractRow2 ? JSON.parse(contractRow2.contract_json) as { criteria: Array<{ id: string; description: string }> } : null;
    const rootCardId = resolveRootId(projectId) ?? projectId;
    const children = kanbanGetChildren(projectId);
    const supervisionService = new WorkerSupervisionService();
    for (const item of items) {
      const goal = repairWorkerGoal(item);
      if (hasRepairWorkerForItem(projectId, children, item, supervisionService)) {
        logInfo(TAG, `Project ${projectId}: repair worker for item ${item.id} already exists — reusing durable Worker`);
        continue;
      }
      logInfo(TAG, `Project ${projectId}: creating repair worker for item ${item.id} (criteria: ${item.affected_criterion_ids.join(",")})`);
      const criteria = rootContract?.criteria
        .filter(c => item.affected_criterion_ids.includes(c.id))
        .map(c => ({ id: c.id, description: c.description })) ?? [];
      const contract: WorkerAcceptanceContractV1 = {
        schema_version: 1,
        id: `repair_${projectId}_${item.id}_${Date.now()}`,
        digest: "",
        goal,
        criteria: criteria.length > 0 ? criteria : [{ id: "repair", description: goal }],
        expected_artifacts: [],
        verification_commands: [],
        required_capabilities: item.capabilities ?? [],
        supports_root_criteria: [...item.affected_criterion_ids],
        limits: { max_tokens: item.budget?.max_tokens },
        provenance: { root_card_id: rootCardId, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
      };
      try {
        spin.spawnChild(projectId, { goal, source: "agent", contract, settlementOwner: "spin" });
      } catch (err) {
        logWarn(TAG, `Project ${projectId}: failed to dispatch repair worker for item ${item.id} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return reviewStore.stateTransition(projectId, ["repair_planned"], "repairing", undefined, { authority })
      ? "transitioned"
      : "none";
  }
  if (supervision.state === "repairing") {
    const children = kanbanGetChildren(projectId);
    const allTerminal = children.length > 0 && children.every(c => KANBAN_TERMINAL_STATUSES.includes(c.status));
    if (allTerminal) {
      logInfo(TAG, `Project ${projectId}: all repair children terminal — creating new review round`);
      return reviewStore.stateTransition(projectId, ["repairing"], "executing", { repair_round: supervision.repair_round + 1 }, { authority })
        ? "transitioned"
        : "none";
    }
    if (children.length === 0) {
      logWarn(TAG, `Project ${projectId}: repairing with no children — falling through to the no-owner decision`);
      return "none";
    }
    // recoverable child rows — Reconciler/Worker dispatcher owns
    requestWorkerDispatchFor(generation);
    return "owned";
  }
  return "none";
}

/**
 * #1546 R2: the existing review owner. `review_ready` without an open case is
 * Reconciler case creation (crash recovery); `review_requested`/`reviewing`
 * dispatch through the existing review request, never a fresh authoring claim.
 */
async function handleReviewState(generation: ReconcilerGeneration, projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): Promise<void> {
  if (supervision.state === "review_ready" && !reviewStore.getLatestOpenCase(projectId)) {
    await createReviewCase(generation, projectId, supervision, reviewStore, 0);
    return;
  }
  const openCase = reviewStore.getLatestOpenCase(projectId);
  if (!openCase) return; // no open case — the inspection classifies this as none
  const existingReq = reviewStore.getReviewRequestByCaseId(openCase.id);
  if (!existingReq) {
    const authority = projectMutationAuthority(projectId, supervision.generation);
    const { id: rrId } = reviewStore.insertReviewRequest(projectId, openCase.id, supervision.generation, undefined, authority);
    if (!rrId) return;
    scheduleOrcReview(generation, projectId, supervision.generation, openCase.id, rrId);
  } else if (existingReq.status === "pending") {
    scheduleOrcReview(generation, projectId, supervision.generation, openCase.id, existingReq.id);
  } else if (existingReq.status === "abandoned") {
    // #1678: a stale abandoned request at an older generation is inert — it
    // must neither settle the current generation nor throw from a deep store
    // assertion. The fence is cheap here; do not rely on the settlement's
    // internal generation assertion to catch what the caller can see.
    if (openCase.generation !== supervision.generation || existingReq.generation !== supervision.generation) {
      logWarn(TAG, `Project ${projectId}: skipping abandoned settlement — stale generation ` +
        `(case=${openCase.generation} request=${existingReq.generation} current=${supervision.generation})`);
      return;
    }
    logWarn(TAG, `Project ${projectId}: review request abandoned — settling blocked`);
    const authority = projectMutationAuthority(projectId, supervision.generation);
    reviewStore.settleBlocked(
      projectId,
      openCase.id,
      { action: "blocked", reason: "Review request abandoned (attempts/deadline)" },
      REVIEW_REQUEST_ABANDONED,
      undefined,
      undefined,
      authority,
    );
    try { nerve.fire("card:failed", projectId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
  }
}

/**
 * #1604 R2 + #1605 R3: the coverage lifecycle gate, evaluated inside
 * createReviewCase before the executing → review_ready transition. Returns:
 *  - "blocked"    → project settled terminal (undeterminable/missing contract
 *                   only — a readable semantic gap is never a terminal gate)
 *  - "waiting"    → coverage round claimed/dispatched, or another wake owns it;
 *                   project stays executing and remains spawn-eligible
 *  - "reviewable" → proceed to review_ready (clean, or gap persisted after the
 *                   bounded remediation turn — the Orc decides the gap)
 *
 * The gate rides existing reconciler wakes — no timers, no heartbeat. The
 * scheduled path's live Orc run row (orc_claim) suppresses re-entry while the
 * coverage turn runs; the non-scheduled legacy dispatch is bounded by
 * COVERAGE_ROUND_GRACE_MS instead, since it creates no observable claim.
 */
function runCoverageGate(generation: ReconcilerGeneration, projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore): "blocked" | "waiting" | "reviewable" {
  const authority = projectMutationAuthority(projectId, supervision.generation);
  const coverage = readProjectCriterionCoverage(projectId);

  // 1. Undeterminable or missing root contract — fail closed, never "covered".
  if (coverage.kind === "undeterminable") {
    settleCoverageBlocked(projectId, reviewStore, `coverage_undeterminable: ${coverage.reason}`, undefined, authority);
    return "blocked";
  }
  if (coverage.kind === "no_project_contract") {
    settleCoverageBlocked(projectId, reviewStore, "coverage_undeterminable: no project contract", undefined, authority);
    return "blocked";
  }

  const uncovered = coverage.read.uncovered;
  const signature = coverageSignature(
    kanbanGetChildren(projectId).map(c => c.id),
    uncovered,
  );

  // 2. Fully covered — record the clean evaluation and proceed.
  if (uncovered.length === 0) {
    if (reviewStore.recordCoverageClear(projectId, signature, authority) === false) return "waiting";
    return "reviewable";
  }

  // 3. Gap — bounded remediation turn, then review with the persisted gap.
  // The round cap is a loop guard only: an exhausted cap means the gap reaches
  // review immediately (repair re-entry cannot restart coverage looping).
  if (supervision.coverage_rounds >= MAX_COVERAGE_ROUNDS) {
    if (reviewStore.recordCoverageReviewable(projectId, signature, uncovered, authority)) {
      logInfo(TAG, `Project ${projectId}: coverage round cap reached (${uncovered.join(", ")}) — proceeding to review_ready`);
      return "reviewable";
    }
    return "waiting";
  }

  if (supervision.coverage_signature === signature) {
    const elapsed = Date.now() - Date.parse(supervision.updated_at);
    if (Number.isFinite(elapsed) && elapsed >= COVERAGE_ROUND_GRACE_MS) {
      // #1605: the Orc had its coverage turn and the gap is unchanged — it is
      // an evidence gap for the review, not a terminal gate decision.
      if (reviewStore.recordCoverageReviewable(projectId, signature, uncovered, authority)) {
        logInfo(TAG, `Project ${projectId}: coverage gap persisted for review (${uncovered.join(", ")}) — proceeding to review_ready`);
        return "reviewable";
      }
      return "waiting";
    }
    // Same signature, grace not elapsed — the Orc had its turn; wait for the
    // next wake (tight-loop guard).
    logInfo(TAG, `Project ${projectId}: coverage round ${supervision.coverage_rounds} in flight (${uncovered.join(", ")}) — waiting`);
    return "waiting";
  }

  // New signature below cap — claim one coverage round; the CAS makes
  // concurrent wakes single-claimant.
  if (!reviewStore.claimCoverageRound(projectId, signature, uncovered, MAX_COVERAGE_ROUNDS, authority)) {
    logInfo(TAG, `Project ${projectId}: coverage round claimed by another wake — waiting`);
    return "waiting";
  }
  dispatchCoverageRound(generation, projectId, uncovered);
  return "waiting";
}

/** #1604: freeze a project as blocked, naming the coverage fact in the reason and the durable column. */
const LIVE_PROJECT_STATES: readonly ProjectState[] = [
  "awaiting_contract", "executing", "review_ready", "review_requested", "reviewing",
  "repair_planned", "repairing", "needs_input",
];

function blockProjectWithInvalidation(
  reviewStore: ProjectReviewStore,
  projectId: number,
  reason: string,
  extraSets?: Record<string, string | number | null>,
  options?: { failCard?: boolean; authority?: ProjectMutationAuthority },
): boolean {
  const terminalizer = (reviewStore as unknown as {
    blockProject?: (
      cardId: number,
      blockerReason: string,
      sets?: Record<string, string | number | null>,
      opts?: { failCard?: boolean; authority?: ProjectMutationAuthority },
    ) => boolean;
  }).blockProject;
  if (terminalizer) return terminalizer.call(reviewStore, projectId, reason, extraSets, options);

  // Test doubles and older injected stores do not expose the #1644 helper.
  // Production always takes the shared transactional path above.
  const transitioned = reviewStore.stateTransition(projectId, LIVE_PROJECT_STATES, "blocked", {
    blocked_reason: reason.slice(0, 500),
    ...extraSets,
  }, options?.authority ? { authority: options.authority } : undefined);
  if (options?.failCard !== false) kanbanFail(projectId, reason.slice(0, 1000));
  return transitioned;
}

function settleCoverageBlocked(
  projectId: number,
  reviewStore: ProjectReviewStore,
  reason: string,
  uncoveredIds: readonly string[] | undefined,
  authority: ProjectMutationAuthority,
): void {
  // Coverage is a terminal project decision even though it has no review
  // decision row. Use the same transaction as review/abort blocking so stale
  // Orc runs, review ownership, and descendant attempts are invalidated
  // before the root card is failed.
  const blocked = blockProjectWithInvalidation(
    reviewStore,
    projectId,
    reason,
    uncoveredIds !== undefined ? { coverage_uncovered_ids: JSON.stringify(uncoveredIds) } : undefined,
    { authority },
  );
  if (blocked) {
    try { nerve.fire("card:failed", projectId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
  }
  logWarn(TAG, `Project ${projectId}: coverage gate blocked — ${reason}`);
}

/** #1604/#1605: dispatch the Orc coverage turn — coordinator for supervised roots, legacy dispatch otherwise. */
function dispatchCoverageRound(generation: ReconcilerGeneration, projectId: number, uncovered: readonly string[]): void {
  const goal = `[COVERAGE GAP] Supervised project #${projectId}: delegated root criteria ${uncovered.join(", ")} have no Worker mapped to them. Spawn a Worker to map any that should be delegated, or leave the gap for the imminent quality review if it cannot or should not be covered (e.g. the evidence came from another lane, or the criterion is being covered by Orc synthesis). Never spawn a Worker for Orc-owned criteria. Do not re-author the contract. Do not write the final report artifact yet.`;
  const card = kanbanGetCard(projectId);
  if (card && isSupervisedRootIdentity(card)) {
    const coordinator = generation.deps.coordinator;
    const claim = coordinator.scheduleScheduledProject(projectId, goal);
    if (claim.kind === "claimed" || claim.kind === "idempotent" || claim.kind === "busy") {
      logInfo(TAG, `Project ${projectId}: coverage round dispatched to scheduled Orc (${uncovered.join(", ")})`);
    } else {
      logWarn(TAG, `Project ${projectId}: coverage round claim ${claim.kind} (${claim.reason}) — waiting for the next wake`);
    }
  } else {
    legacyOrcDispatch(goal, projectId);
    logInfo(TAG, `Project ${projectId}: coverage round dispatched via legacy Orc (${uncovered.join(", ")})`);
  }
}

/**
 * #1546: the Reconciler's review case creation for a project whose direct
 * children are all terminal. `roundOffset` is 0 when the review round was
 * already advanced by a preceding transition (e.g. input resume), 1 otherwise.
 *
 * #1604 R2: coverage is gated here, BEFORE the executing → review_ready
 * transition, so an uncovered project never enters an acceptance review it
 * structurally cannot pass. Evaluation is fail-closed: an undeterminable read
 * blocks the project; a gap dispatches a bounded coverage round to the Orc.
 * The gate runs only when entering review_ready from `executing` — the
 * `review_ready` crash-recovery path (roundOffset 0) has already passed the
 * gate, and `claimCoverageRound` pins `state = 'executing'`, so a gap there
 * could never be claimed and would stall recovery forever.
 */
async function createReviewCase(generation: ReconcilerGeneration, projectId: number, supervision: ProjectSupervisionRow, reviewStore: ProjectReviewStore, roundOffset: 0 | 1 = 1): Promise<void> {
  const authority = projectMutationAuthority(projectId, supervision.generation);
  if (supervision.state === "executing") {
    const coverageGate = runCoverageGate(generation, projectId, supervision, reviewStore);
    if (coverageGate === "waiting" || coverageGate === "blocked") return;
  }

  const nextRound = supervision.review_round + roundOffset;
  const transitioned = reviewStore.stateTransition(
    projectId,
    ["executing", "review_ready"] as ProjectState[],
    "review_ready",
    { review_round: nextRound },
    { authority },
  );
  if (!transitioned) {
    logWarn(TAG, `Project ${projectId}: failed to transition to review_ready`);
    return;
  }

  const assembler = new ReviewCaseAssembler();
  const snapshot = await assembler.assembleCase(projectId, supervision.generation, nextRound);
  if ("error" in snapshot) {
    logWarn(TAG, `Project ${projectId}: review case assembly failed — ${snapshot.error}`);
    return;
  }

  const snapshotDigest = `rc_${projectId}_${supervision.generation}_${nextRound}`;
  let caseId = "";
  let reviewRequestId = "";
  reviewStore.db.transaction(() => {
    const { id: cId } = reviewStore.insertReviewCase(projectId, supervision.generation, nextRound, snapshot, snapshotDigest);
    caseId = cId;
    const transitioned2 = reviewStore.stateTransition(projectId, ["review_ready"] as ProjectState[], "review_requested", undefined, { authority });
    if (!transitioned2) throw new Error(`failed to transition project ${projectId} to review_requested`);
    const { id: rrId } = reviewStore.insertReviewRequest(projectId, cId, supervision.generation, undefined, authority);
    if (!rrId) throw new Error(`failed to authorize review request for project ${projectId}`);
    reviewRequestId = rrId;
  });
  logInfo(TAG, `Project ${projectId}: review ready — case ${caseId} created, request ${reviewRequestId} (gen=${supervision.generation}, round=${nextRound})`);
  logSwarmTrace({ event: "review_case_created", project: projectId, card: projectId, reviewCase: caseId, reason: "all_children_terminal", generation: supervision.generation });
  scheduleOrcReview(generation, projectId, supervision.generation, caseId, reviewRequestId);
}

/**
 * #1546: the single state-aware project driver. Accepts a running root or a
 * queued due scheduled root; a future-dated queued root is a no-op. The driver
 * decides from durable rows whether existing work resumes, whether a scheduled
 * Orc continuation must be claimed, or whether the existing terminal authority
 * settles the occurrence as a last resort. State transitions made during one
 * pass are followed by a fresh durable read before selecting the next owner.
 */
async function reconcileProject(generation: ReconcilerGeneration, projectId: number): Promise<void> {
  let project = kanbanGetCard(projectId);
  if (!project) return;
  if (!isProjectReconcileEligible(project)) return;

  const reviewStore = new ProjectReviewStore();
  const hasRootContract = reviewStore.contractExists(projectId);
  const contractRow = hasRootContract ? reviewStore.getContractByProjectCardId(projectId) : undefined;

  const now = Date.now();

  if (contractRow) {
    try {
      const contract = JSON.parse(contractRow.contract_json) as { limits?: { hard_deadline_at?: string } };
      const configuredDeadline = contract.limits?.hard_deadline_at ? Date.parse(contract.limits.hard_deadline_at) : NaN;
      if (Number.isFinite(configuredDeadline) && now > configuredDeadline) {
        await abortProject(generation, projectId, kanbanGetChildren(projectId), "configured hard deadline exceeded");
        return;
      }
    } catch (err) {
      logWarn(TAG, `Project ${projectId}: invalid root contract deadline: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!hasRootContract) {
    const supervision = reviewStore.getSupervision(projectId);
    if (!supervision) {
      reviewStore.ensureAwaitingContract(projectId);
      logInfo(TAG, `Project ${projectId}: awaiting contract — dispatching Orc authoring turn`);
      if (isScheduledRootIdentity(project)) {
        const owned = scheduleContractAuthoringOrSettle(generation, projectId);
        if (project.status === "queued" && (owned.kind === "claimed" || owned.kind === "idempotent")) kanbanPromoteDueRetry(projectId);
      } else if (isSupervisedRootIdentity(project)) {
        // #1618: peer/CLI supervised roots use the same durable Orc coordinator.
        scheduleContractAuthoringOrSettle(generation, projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    } else if (supervision.state === "awaiting_contract") {
      logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
      if (isScheduledRootIdentity(project)) {
        const owned = scheduleContractAuthoringOrSettle(generation, projectId);
        if (project.status === "queued" && (owned.kind === "claimed" || owned.kind === "idempotent")) kanbanPromoteDueRetry(projectId);
      } else if (isSupervisedRootIdentity(project)) {
        // #1618: peer/CLI supervised roots use the same durable Orc coordinator.
        scheduleContractAuthoringOrSettle(generation, projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    }
    // #1546 R4: a retried queued root is promoted only after the authoring
    // owner decision above.
    if (project.status === "queued" && !isScheduledRootIdentity(project)) kanbanPromoteDueRetry(projectId);
    return;
  }

  const supervision = reviewStore.getSupervision(projectId);
  if (!supervision) {
    logWarn(TAG, `Project ${projectId}: root contract exists but no supervision state — initializing`);
    if (contractRow) {
      reviewStore.initializeSupervision(projectId, contractRow.id);
    }
    return;
  }

  if (supervision.state === "accepted" || supervision.state === "blocked") return;
  if (supervision.state === "awaiting_contract") {
    logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
    if (isScheduledRootIdentity(project)) {
      const owned = scheduleContractAuthoringOrSettle(generation, projectId);
      if (project.status === "queued" && (owned.kind === "claimed" || owned.kind === "idempotent")) kanbanPromoteDueRetry(projectId);
    } else if (isSupervisedRootIdentity(project)) {
      // #1618: peer/CLI supervised roots use the same durable Orc coordinator.
      scheduleContractAuthoringOrSettle(generation, projectId);
    } else {
      legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      if (project.status === "queued") kanbanPromoteDueRetry(projectId);
    }
    return;
  }

  // ── #1546: owner-driven loop with fresh durable reads per pass ──────────
  for (let pass = 0; pass < 4; pass++) {
    project = kanbanGetCard(projectId);
    if (!project) return;
    if (!isProjectReconcileEligible(project)) return;

    const supervision = reviewStore.getSupervision(projectId);
    if (!supervision) return;
    if (supervision.state === "accepted" || supervision.state === "blocked") return;

    if (project.max_tokens != null && (project.tokens_used ?? 0) >= project.max_tokens) {
      await abortProject(generation, projectId, kanbanGetChildren(projectId), `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
      return;
    }

    if (project.status === "queued") {
      // #1546 R4: claim-before-promotion — only when no durable owner exists.
      // A crash between the Orc claim and the card write leaves queued+due,
      // which the next wake observes as already owned and promotes.
      if (inspectProjectOwnership(projectId, supervision, reviewStore) === "none") {
        if (claimOrcContinuation(generation, projectId, supervision, reviewStore, project) === "settled") return;
      }
      if (!kanbanPromoteDueRetry(projectId)) return; // lost the conditional race — next wake re-reads
      continue;
    }

    switch (inspectProjectOwnership(projectId, supervision, reviewStore)) {
      case "terminal":
        return;
      case "worker_resume":
        requestWorkerDispatch();
        return;
      case "orc_claim":
        return; // existing live Orc row owns the project
      case "review":
        await handleReviewState(generation, projectId, supervision, reviewStore);
        return;
      case "input": {
        const result = handleInputState(projectId, supervision, reviewStore);
        if (result === "transitioned" || result === "none") continue;
        return; // pending input owned by the input dispatcher
      }
      case "repair": {
        const result = handleRepairState(generation, projectId, supervision, reviewStore);
        if (result === "transitioned" || result === "none") continue;
        return; // recoverable children owned by the Worker path
      }
      case "executing_terminal_children":
        await createReviewCase(generation, projectId, supervision, reviewStore, 1);
        return;
      case "none":
        // #1546/#1618: the Orc continuation claim and last-resort settlement
        // apply to supervised roots (scheduled, peer, and CLI projects).
        // Generic unscheduled O cards without supervision retain their current
        // fallback behavior (no claim, no freeze).
        if (!isScheduledProjectRoot(project) && !isSupervisedRootIdentity(project)) return;
        // At most one correlated claim per wake: the coordinator's live row
        // (or a re-derived owner) is re-read on the next wake. The queued
        // branch promotes first and continues so the state owner still runs.
        if (claimOrcContinuation(generation, projectId, supervision, reviewStore, project) === "settled") return;
        return; // the claim (or its re-derived owner) now owns the project
    }
  }
}

function dispatchPendingReviewRequests(generation: ReconcilerGeneration): number {
  const store = new ProjectReviewStore();
  const pending = store.getPendingReviewRequests();
  let dispatched = 0;
  for (const req of pending) {
    const result = generation.deps.coordinator.scheduleReview(req.project_card_id, req.generation, req.review_case_id);
    // #1678: `dispatched` means "requests acted on this pass" — a real claim or
    // a rejected dispatch. An `idempotent`/`busy` result observed nothing new.
    if (result.kind === "claimed") {
      try { store.recordReviewRequestDispatchAttempt(req.id, null); } catch (err) { logAndSwallow(TAG, "record review request dispatch attempt", err); }
      dispatched++;
    } else if (result.kind === "conflict" || result.kind === "not_actionable") {
      try { store.recordReviewRequestDispatchAttempt(req.id, result.reason); } catch (err) { logAndSwallow(TAG, "record review request dispatch attempt", err); }
      dispatched++;
    }
  }
  return dispatched;
}

// ── #1405: Pi executor lane ──────────────────────────────────────────────────

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
            kanbanComplete(card.id, null, "worker completed");
          } else {
            kanbanFail(card.id, "worker completed without passing acceptance");
          }
        } else {
          kanbanFail(card.id, `worker ${latestAttempt.lifecycle}`);
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
        }
        kanbanFail(card.id, "Pi executor unavailable for coding child");
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
      kanbanFail(card.id, "could not enter starting state");
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
            kanbanComplete(card.id, null, "worker completed");
          } else {
            kanbanFail(card.id, "worker completed without passing acceptance");
          }
        } else {
          kanbanFail(card.id, `worker ${afterStart.lifecycle}`);
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
        kanbanFail(card.id, `worker start deferred but could not requeue: ${observation.reason}`);
      }
    } else {
      logSwarmTrace({ event: "worker_start_failed", card: card.id, attempt: claim.attemptId, reason: "start_failed" });
      store.terminalSettlement({
        attemptId: claim.attemptId,
        expectedGeneration: claim.generation,
        desiredState: "failed",
        stableReason: `start_failed: ${observation.reason}`,
      });
      kanbanFail(card.id, `worker start failed: ${observation.reason}`);
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

async function abortProject(generation: ReconcilerGeneration, projectId: number, children: KanbanCard[], reason: string, opts?: { skipRootFail?: boolean }): Promise<void> {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  // Freeze supervision before cancelling child executors. Late Orc review
  // results must not be able to move an aborted project back to accepted.
  const reviewStore = new ProjectReviewStore();
  const blocked = blockProjectWithInvalidation(
    reviewStore,
    projectId,
    `aborted: ${reason}`,
    undefined,
    {
      failCard: !opts?.skipRootFail,
      authority: (() => {
        const supervision = reviewStore.getSupervision(projectId);
        return supervision ? projectMutationAuthority(projectId, supervision.generation) : undefined;
      })(),
    },
  );
  if (blocked && !opts?.skipRootFail) {
    try { nerve.fire("card:failed", projectId); } catch (err) { logAndSwallow(TAG, "fire card:failed", err); }
  }
  const store = new WorkerSupervisionStore();
  for (const card of children) {
    if (card.status !== "running" && card.status !== "queued") continue;
    const attempt = store.getLatestAttempt(card.id);
    if (!attempt) {
      kanbanFail(card.id, `project aborted: ${reason}`);
      continue;
    }
    const settlement = store.terminalSettlement({
      attemptId: attempt.id,
      expectedGeneration: attempt.generation || 1,
      desiredState: "cancelled",
      stableReason: `project_abort: ${reason}`,
    });
    if (settlement.kind === "settled" || settlement.kind === "replayed") {
      const executor = dispatchExecutor(generation, attempt.executor_kind, attempt.executor_id);
      if (executor) {
        await executor.adapter.cancel({
          attemptId: attempt.id,
          cardId: attempt.card_id,
          contractId: attempt.contract_id,
          executorKind: executor.kind,
          executorId: executor.id,
          generation: attempt.generation || 1,
          claimedAt: attempt.claimed_at ?? attempt.started_at,
          hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
        }, "project_abort");
      }
    }
    kanbanFail(card.id, `project aborted: ${reason}`);
  }
  // #1546: the last-resort settler performs the one root card mutation after
  // winning settlement; a second root fail would emit a duplicate terminal
  // event (proved by the focused exactly-once settlement test).
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

export function retryPendingReviewRequests(): number {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("retryPendingReviewRequests", "no work scheduled");
    return 0;
  }
  return dispatchPendingReviewRequests(generation);
}

export function scanActiveProjects(): number {
  const generation = activeGeneration;
  if (!generation || generation.phase !== "running") {
    boundedFacadeLog("scanActiveProjects", "no work scheduled");
    return 0;
  }
  // #1628: union running roots with stranded queued roots — a queued root
  // with no live Orc run (project 63's state) is otherwise never rediscovered.
  // #1664: quarantined cards are not re-woken at boot; the returned count is
  // the number actually woken, so the "recovered N running project(s)" log is
  // truthful.
  const projectIds = [...new Set([
    ...kanbanRunningProjectIds(),
    ...kanbanStrandedQueuedProjectIds(),
  ])].sort((a, b) => a - b);
  const skipped: number[] = [];
  let woken = 0;
  for (const projectId of projectIds) {
    if (wakeCard(generation, projectId)) woken += 1;
    else skipped.push(projectId);
  }
  if (skipped.length > 0) logWarn(TAG, `Skipped ${skipped.length} quarantined project(s): ${skipped.join(", ")}`);
  return woken;
}

export function answerInputRequest(requestId: string, response: string): boolean {
  const store = new ProjectReviewStore();
  const answered = store.answerInputRequest(requestId, response);
  if (answered) {
    const rows = store.db.prepare(`SELECT project_card_id FROM project_input_requests WHERE id = ?`).get(requestId) as { project_card_id: number } | undefined;
    if (rows) requestReconcile(rows.project_card_id);
  }
  return answered;
}

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
    const onDone = (cardId: number) => requestReconcileForProject(cardId);
    const onFailed = (cardId: number) => requestReconcileForProject(cardId);
    nerve.on("card:queued", onQueued);
    nerve.on("card:done", onDone);
    nerve.on("card:failed", onFailed);
    generation.disposers.push(() => {
      nerve.off("card:queued", onQueued);
      nerve.off("card:done", onDone);
      nerve.off("card:failed", onFailed);
    });

    // 4. Coordinator ownership-release subscription (returns its disposer).
    const onOwnershipReleased = (event: OrcOwnershipReleasedV1): void => {
      if (generation.phase === "starting") {
        generation.pendingProjectWakes.add(event.projectCardId);
        return;
      }
      if (event.intentKind !== "contract_authoring") { requestReconcile(event.projectCardId); return; }
      requestReconcileForProject(event.projectCardId);
    };
    generation.disposers.push(deps.coordinator.onOwnershipReleased(onOwnershipReleased));

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

    // 9. Active-project scan queues into pendingProjectWakes while starting;
    // the flush below runs the quarantine-aware wake path after running.
    const activeIds = [...new Set([...kanbanRunningProjectIds(), ...kanbanStrandedQueuedProjectIds()])];

    // 10. Running — then flush the deduplicated/sorted union of coordinator
    // recovery ids, queued startup wakes, and the active-project scan.
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
          if (card) kanbanFail(card.id, "bridge_restart");
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
