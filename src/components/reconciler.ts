/**
 * reconciler.ts — K8s-inspired reconciliation loop for the Orc (#1364).
 *
 * Single scheduling authority: every supervised dispatch, retry, cancel, and
 * release decision originates here. Nerve/heartbeat events are only wakeups.
 * Reconciliation is keyed by card — independent cards run concurrently; one
 * card has at most one active pass (dirty-bit coalescing).
 */

import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanFail, kanbanComplete, kanbanUpdate,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds,
  isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { ProjectReviewStore, type ProjectState } from "./project-acceptance/project-review-store.js";
import { ReviewCaseAssembler } from "./project-acceptance/project-review-case.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle } from "./worker-supervision-store.js";

const TAG = "reconciler";
const MAX_RETRIES = 3;
const MAX_WORKERS = 10;
const MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

let _shutdownRequested = false;

let _piService: PiRunService | null = null;

export function setPiService(service: PiRunService | null): void {
  _piService = service;
}

export function requestShutdown(): void {
  _shutdownRequested = true;
}

// ── Keyed scheduler ──────────────────────────────────────────────────────────

interface CardReconcilerState {
  running: boolean;       // true while reconcileCard() is in flight
  dirty: boolean;         // true if a wakeup arrived during the pass
}

const _states = new Map<number, CardReconcilerState>();

function getState(cardId: number): CardReconcilerState {
  let s = _states.get(cardId);
  if (!s) { s = { running: false, dirty: false }; _states.set(cardId, s); }
  return s;
}

function wakeCard(cardId: number): void {
  const s = getState(cardId);
  if (s.running) { s.dirty = true; return; }
  s.running = true;
  s.dirty = false;
  // Use microtask to avoid deep stacks
  queueMicrotask(() => reconcileCard(cardId));
}

async function reconcileCard(cardId: number): Promise<void> {
  const s = getState(cardId);
  try {
    do {
      s.dirty = false;
      if (_shutdownRequested) return;
      deriveAction(cardId);
    } while (s.dirty);
  } finally {
    s.running = false;
  }
}

// ── Derive action ─────────────────────────────────────────────────────────────

function deriveAction(cardId: number): void {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  // Project card (type "O") — reconcile children
  if (card.type === "O" && card.status === "running") {
    reconcileProject(cardId);
    return;
  }

  // Non-project card — check if supervised and reconcile individually
  reconcileChildCard(card);
}

function reconcileProject(projectId: number): void {
  const project = kanbanGetCard(projectId);
  if (!project || project.status !== "running") return;

  const children = kanbanGetChildren(projectId);

  const now = Date.now();
  const projectStart = new Date(project.created_at + "Z").getTime();

  // Circuit breaker: wall-clock — evaluated before zero-child early return
  // so an expired project with no children is failed explicitly.
  if (now - projectStart > MAX_WALL_CLOCK_MS) {
    abortProject(projectId, children, "wall-clock exceeded (30min)");
    return;
  }

  // Zero children before deadline — stay running, may still spawn work
  if (children.length === 0) return;

  // Circuit breaker: token budget
  if (project.max_tokens && (project.tokens_used ?? 0) >= project.max_tokens) {
    abortProject(projectId, children, `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
    return;
  }

  // Circuit breaker: too many workers
  if (children.length > MAX_WORKERS) {
    abortProject(projectId, children, `too many workers (${children.length})`);
    return;
  }

  for (const child of children) {
    reconcileChildCard(child);
  }

  // ── Project acceptance gate (#1363) ─────────────────────────────────────
  const reviewStore = new ProjectReviewStore();
  const hasRootContract = reviewStore.contractExists(projectId);

  // Legacy unsupervised project — keep old behavior
  if (!hasRootContract) {
    if (children.every(c => c.status === "done" || c.status === "delivered")) {
      logInfo(TAG, `Project ${projectId}: all children done (unsupervised)`);
      const summaries = children.map(c => c.result_summary).filter(Boolean).join("\n");
      kanbanComplete(projectId, null, summaries.slice(0, 500));
    }
    return;
  }

  // Supervised project — use acceptance gate
  const supervision = reviewStore.getSupervision(projectId);
  if (!supervision) {
    // Root contract exists but supervision not initialized yet
    logWarn(TAG, `Project ${projectId}: root contract exists but no supervision state — initializing`);
    const contractRow = reviewStore.getContractByProjectCardId(projectId);
    if (contractRow) {
      reviewStore.initializeSupervision(projectId, contractRow.id);
    }
    return;
  }

  // Skip if project is already in a terminal state
  if (supervision.state === "accepted" || supervision.state === "blocked") return;

  // Check if project is in repair mode — let repair work complete
  if (supervision.state === "repair_planned" || supervision.state === "repairing") return;

  // Check review readiness: all children must be terminal
  const allChildrenTerminal = children.every(c => {
    const terminalStatuses = ["done", "delivered", "failed"];
    return terminalStatuses.includes(c.status);
  });

  if (!allChildrenTerminal) return;

  // Prevent duplicate review cases: no open case should already exist
  const existingOpenCase = reviewStore.getLatestOpenCase(projectId);
  if (existingOpenCase) return;

  // Transition to review_ready and create review case atomically
  const transitioned = reviewStore.stateTransition(
    projectId,
    ["executing", "review_ready"] as ProjectState[],
    "review_ready",
    { review_round: supervision.review_round + 1 },
  );

  if (!transitioned) {
    logWarn(TAG, `Project ${projectId}: failed to transition to review_ready`);
    return;
  }

  // Assemble full review case
  const assembler = new ReviewCaseAssembler();
  const snapshot = assembler.assembleCase(projectId, supervision.generation, supervision.review_round + 1);

  if ("error" in snapshot) {
    logWarn(TAG, `Project ${projectId}: review case assembly failed — ${snapshot.error}`);
    return;
  }

  const snapshotDigest = `rc_${projectId}_${supervision.generation}_${supervision.review_round + 1}`;
  const { id: caseId } = reviewStore.insertReviewCase(
    projectId,
    supervision.generation,
    supervision.review_round + 1,
    snapshot,
    snapshotDigest,
  );

  logInfo(TAG, `Project ${projectId}: review ready — case ${caseId} created (gen=${supervision.generation}, round=${supervision.review_round + 1}, criteria=${snapshot.root_contract.criteria.length}, uncovered=${snapshot.uncovered_criteria.length}, contradictions=${snapshot.contradiction_count})`);

  // TODO(Task 6): Create Orc review request / wake Orc session
}

// ── #1405: Pi executor lane ──────────────────────────────────────────────────

function reconcilePiCard(card: KanbanCard): void {
  const svc = _piService;
  if (!svc) {
    logWarn(TAG, `Pi card ${card.id} queued but Pi service not available`);
    return;
  }
  if (card.status !== "queued") return;
  if (!isUnblocked(card)) return;

  // Check capacity
  if (svc.executor.activeCount >= svc.executor.maxConcurrent) {
    logInfo(TAG, `Pi card ${card.id} queued but Pi capacity full (${svc.executor.activeCount}/${svc.executor.maxConcurrent})`);
    return;
  }

  // Look up the Pi run by card ID
  const run = svc.store.getByCardId(card.id);
  if (!run) {
    logWarn(TAG, `Pi card ${card.id} has no associated Pi run`);
    return;
  }
  if (run.status !== "queued") {
    logWarn(TAG, `Pi card ${card.id} run ${run.id} status is ${run.status} not queued`);
    return;
  }

  // Atomic claim: run queued→starting + card queued→running
  const claim = svc.store.claimQueuedGeneration(card.id);
  if (!claim.claimed) {
    logWarn(TAG, `Failed to claim Pi card ${card.id}: ${claim.reason}`);
    return;
  }

  // Start the Pi process with the claimed generation
  logInfo(TAG, `Starting Pi run ${claim.runId} (card ${card.id}, gen ${claim.generation})`);
  svc.executor.startWithClaim(claim.runId, claim.generation, run.currentSessionId ?? `${Date.now()}_C_pi_${claim.runId}`).catch((err) => {
    logWarn(TAG, `Pi start failed for ${claim.runId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function reconcileChildCard(card: KanbanCard): void {
  // #1405: Pi lane — route type='pi' cards through Pi executor, not Worker dispatch
  if (card.type === "pi") {
    reconcilePiCard(card);
    return;
  }

  // #1411: Domain guard — only supervised or Pi cards enter Reconciler.
  // Unsupervised legacy cards are owned entirely by Spin's bounded retry path
  // (kanbanRetryOrFail + drainQueued). Reconciler must never touch them.
  const svc = new WorkerSupervisionService();
  const hasContract = svc.cardHasContract(card.id);
  if (!hasContract) return;

  const latestAttempt = getLatestAttemptInfo(card.id);

  // #1364: Supervised queued card — claim if pending attempt exists
  if (card.status === "queued") {
    if (!isUnblocked(card)) return;
    if (latestAttempt && latestAttempt.lifecycle === "pending") {
      logInfo(TAG, `Claiming supervised card ${card.id}`);
      spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
    }
    // Fail closed: no pending attempt → leave card unchanged for supervision service recovery
    return;
  }

  // #1365: Adaptive retry for supervised cards
  if (card.status === "failed" && latestAttempt) {
    handleSupervisedRetry(card, latestAttempt.lifecycle);
    return;
  }

  // #1367: Lease-based stale evaluation for supervised cards
  if (latestAttempt && !isTerminal(latestAttempt.lifecycle)) {
    evaluateLease(card);
    return;
  }

  // #1364: Cancel-requested supervised attempts — do NOT fail the card here;
  // the executor adapter will settle it. Reconciler only records policy intent.
  if (latestAttempt && latestAttempt.lifecycle === "cancel_requested") {
    return;
  }
}

function isTerminal(lc: AttemptLifecycle): boolean {
  return lc === "completed" || lc === "failed" || lc === "cancelled" || lc === "timed_out";
}

function evaluateLease(card: KanbanCard): void {
  try {
    const svc = new WorkerSupervisionService();
    const contract = svc.getContractForCard(card.id);
    if (!contract) return;
    const store = (svc as any)["store"] as import("./worker-supervision-store.js").WorkerSupervisionStore;
    const latestAttempt = store.getLatestAttempt(card.id);
    if (!latestAttempt) return;

    const leaseStore = new ExecutorLeaseStore();
    const snapshot = leaseStore.getSnapshot(latestAttempt.id);
    if (!snapshot) return;

    const now = Date.now();
    const livenessDeadline = new Date(snapshot.livenessDeadlineAt).getTime();
    const progressDeadline = new Date(snapshot.progressDeadlineAt).getTime();

    if (now > livenessDeadline || now > progressDeadline) {
      if (snapshot.evaluation === "healthy") {
        leaseStore.updateEvaluation(latestAttempt.id, "warning");
        logWarn(TAG, `Lease warning for card ${card.id}: attempt=${latestAttempt.id}`);
      } else if (snapshot.evaluation === "warning") {
        leaseStore.updateEvaluation(latestAttempt.id, "inspect_due");
        logWarn(TAG, `Inspect due for card ${card.id}`);
      } else if (snapshot.evaluation === "inspect_due") {
        logWarn(TAG, `Cancelling stale card ${card.id} via lease policy`);
        leaseStore.updateEvaluation(latestAttempt.id, "cancel_requested");
        store.requestCancel(latestAttempt.id, "lease_expired");
      }
    }
  } catch (err) {
    logWarn(TAG, `lease evaluation failed for card ${card.id}: ${err}`);
  }
}

function handleSupervisedRetry(card: KanbanCard, lifecycle: AttemptLifecycle): void {
  // Only retry failed/cancelled/timed_out lifecycles
  if (lifecycle !== "failed" && lifecycle !== "cancelled" && lifecycle !== "timed_out") return;

  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) {
      logWarn(TAG, `handleSupervisedRetry: no attempt for ${card.id} — leaving card failed for Orc review`);
      return;
    }

    const { RetryService } = require("./retry/retry-service.js") as typeof import("./retry/retry-service.js");
    const retryService = new RetryService();

    const result = retryService.handleTerminalAttempt(latestAttempt.id, card.id);
    if ("error" in result) {
      logWarn(TAG, `retry classification failed for ${card.id}: ${result.error} — leaving card failed for Orc review`);
      return;
    }

    const { classification, decision } = result;

    switch (decision.disposition) {
      case "automatic_retry": {
        const directiveResult = retryService.buildAutomaticDirective(
          latestAttempt.id, card.id, classification, decision,
        );
        if ("error" in directiveResult) {
          logWarn(TAG, `auto directive failed for ${card.id}: ${directiveResult.error} — leaving card failed for Orc review`);
          return;
        }
        logInfo(TAG, `Auto-retry card ${card.id}: attempt ${latestAttempt.ordinal} -> ${directiveResult.directive.target_ordinal} (${classification.primary})`);
        kanbanUpdate(card.id, { status: "queued" });
        spin.dispatch({ type: "W", goal: card.notes || card.title, source: "agent", cardId: card.id, parentCardId: card.parent_id ?? undefined });
        break;
      }
      case "orc_review": {
        logInfo(TAG, `Orc review required for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        // Card stays failed — Orc will see it in check_workers and call review_worker_failure
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

function abortProject(projectId: number, children: KanbanCard[], reason: string): void {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  for (const card of children) {
    if (card.status === "running" || card.status === "queued") {
      kanbanFail(card.id, `project aborted: ${reason}`);
    }
  }
  kanbanFail(projectId, reason);
}

function getLatestAttemptInfo(cardId: number): { lifecycle: AttemptLifecycle; id: string } | null {
  try {
    const store = new WorkerSupervisionStore();
    const latest = store.getLatestAttempt(cardId);
    if (!latest) return null;
    return { lifecycle: latest.lifecycle, id: latest.id };
  } catch { return null; }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function requestReconcile(cardId: number): void {
  wakeCard(cardId);
}

export function requestReconcileForProject(cardId: number): void {
  // Wake the project card — it will reconcile children
  const card = kanbanGetCard(cardId);
  if (card?.parent_id) {
    wakeCard(card.parent_id);
  }
  wakeCard(cardId);
}

/** #1414: Scan all running O-type projects and schedule reconciliation. Returns candidate count. */
export function scanActiveProjects(): number {
  const projectIds = kanbanRunningProjectIds();
  for (const projectId of projectIds) wakeCard(projectId);
  return projectIds.length;
}

export function startReconciler(): void {
  nerve.on("card:queued", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:done", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:failed", (cardId: number) => requestReconcileForProject(cardId));
  const count = scanActiveProjects();
  logInfo(TAG, `Reconciler started — recovered ${count} running project(s)`);
}
