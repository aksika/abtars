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
  kanbanFail,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds,
  isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { SpinWorkerAdapter } from "./spin-worker-adapter.js";
import type { SwarmExecutorAdapter, ExecutionClaim } from "./swarm-executor-types.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { ProjectReviewStore, type ProjectState } from "./project-acceptance/project-review-store.js";
import { ReviewCaseAssembler } from "./project-acceptance/project-review-case.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle, AttemptRow } from "./worker-supervision-store.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

const TAG = "reconciler";
const MAX_WORKERS = 10;
const MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

let _shutdownRequested = false;

let _piService: PiRunService | null = null;
let _workerAdapter: SwarmExecutorAdapter | null = null;

export function setPiService(service: PiRunService | null): void {
  _piService = service;
}

/** Dependency seam for tests and alternate local Worker executors. */
export function setWorkerAdapter(adapter: SwarmExecutorAdapter | null): void {
  _workerAdapter = adapter;
}

function workerAdapter(): SwarmExecutorAdapter {
  return _workerAdapter ??= new SpinWorkerAdapter();
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
      await deriveAction(cardId);
    } while (s.dirty);
  } finally {
    s.running = false;
  }
}

// ── Derive action ─────────────────────────────────────────────────────────────

async function deriveAction(cardId: number): Promise<void> {
  if (cardId <= 0) return;
  const card = kanbanGetCard(cardId);
  if (!card) return;

  // Project card (type "O") — reconcile children
  if (card.type === "O" && card.status === "running") {
    await reconcileProject(cardId);
    return;
  }

  // Non-project card — check if supervised and reconcile individually
  await reconcileChildCard(card);
}

async function reconcileProject(projectId: number): Promise<void> {
  const project = kanbanGetCard(projectId);
  if (!project || project.status !== "running") return;

  const reviewStore = new ProjectReviewStore();
  const hasRootContract = reviewStore.contractExists(projectId);
  const contractRow = hasRootContract ? reviewStore.getContractByProjectCardId(projectId) : undefined;
  const children = kanbanGetChildren(projectId);

  const now = Date.now();
  const projectStart = new Date(project.created_at + "Z").getTime();
  let deadlineMs = projectStart + MAX_WALL_CLOCK_MS;
  if (contractRow) {
    try {
      const contract = JSON.parse(contractRow.contract_json) as { limits?: { hard_deadline_at?: string } };
      const configuredDeadline = contract.limits?.hard_deadline_at ? Date.parse(contract.limits.hard_deadline_at) : NaN;
      if (Number.isFinite(configuredDeadline)) deadlineMs = configuredDeadline;
    } catch {
      // The contract was normalized before insertion; retain the safety cap if
      // an old/corrupt row cannot provide a usable deadline.
    }
  }

  // Circuit breaker: wall-clock — always first
  if (now > deadlineMs) {
    await abortProject(projectId, children, deadlineMs === projectStart + MAX_WALL_CLOCK_MS
      ? "wall-clock exceeded (30min)"
      : "configured hard deadline exceeded");
    return;
  }

  // ── Contract admission gate (#1363 Task 1a) — before zero-child return ──
  if (!hasRootContract) {
    const supervision = reviewStore.getSupervision(projectId);
    if (!supervision) {
      // No contract, no supervision — create awaiting_contract and wake Orc
      reviewStore.ensureAwaitingContract(projectId);
      logInfo(TAG, `Project ${projectId}: awaiting contract — dispatching Orc authoring turn`);
      try {
        spin.dispatch({ type: "O", goal: `Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
      } catch (err) {
        logWarn(TAG, `Project ${projectId}: failed to dispatch Orc for contract authoring — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (supervision.state === "awaiting_contract") {
      // Orc should already have been dispatched — retry if not
      logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
      try {
        spin.dispatch({ type: "O", goal: `Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
      } catch {}
    }
    return;
  }

  // Supervised project — load supervision state
  const supervision = reviewStore.getSupervision(projectId);
  if (!supervision) {
    logWarn(TAG, `Project ${projectId}: root contract exists but no supervision state — initializing`);
    if (contractRow) {
      reviewStore.initializeSupervision(projectId, contractRow.id);
    }
    return;
  }

  // Skip if project is already in a terminal state
  if (supervision.state === "accepted" || supervision.state === "blocked") return;

  // Handle awaiting_contract: Orc will use define_project_contract tool
  if (supervision.state === "awaiting_contract") return;

  // Zero children before deadline — stay running, may still spawn work
  if (children.length === 0) return;

  // Circuit breaker: token budget
  if (project.max_tokens && (project.tokens_used ?? 0) >= project.max_tokens) {
    await abortProject(projectId, children, `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
    return;
  }

  // Circuit breaker: too many workers
  if (children.length > MAX_WORKERS) {
    await abortProject(projectId, children, `too many workers (${children.length})`);
    return;
  }

  for (const child of children) {
    await reconcileChildCard(child);
  }

  // Handle needs_input: check for answered input requests
  if (supervision.state === "needs_input") {
    const answered = reviewStore.getAnsweredInputRequests(projectId);
    if (answered.length > 0) {
      logInfo(TAG, `Project ${projectId}: ${answered.length} input(s) answered — creating new review case`);
      reviewStore.clearInputNotice(projectId);
      // Transition back to executing, then let the readiness check create a new case
      const nextRound = supervision.review_round + 1;
      reviewStore.stateTransition(projectId, ["needs_input"], "executing", { review_round: nextRound });
      // Fall through to the normal readiness check below (new round creates a new case)
    } else {
      const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
      if (pending.length === 0) {
        logWarn(TAG, `Project ${projectId}: needs_input state but no pending or answered requests — recovering`);
        reviewStore.setState(projectId, "executing", { review_round: supervision.review_round + 1 });
        // Fall through to readiness check
      } else {
        return; // still waiting — nothing to do
      }
    }
  }

  // Handle review_requested: retry dispatch if request is still pending, bound by attempts/deadline

  // Handle review_requested: retry dispatch if request is still pending, bound by attempts/deadline
  if (supervision.state === "review_requested") {
    const openCase = reviewStore.getLatestOpenCase(projectId);
    if (openCase) {
      const existingReq = reviewStore.getReviewRequestByCaseId(openCase.id);
      if (!existingReq) {
        // No request — create one and dispatch (keep pending for retry)
        const { id: rrId } = reviewStore.insertReviewRequest(projectId, openCase.id, supervision.generation);
        try {
          spin.dispatch({ type: "O", goal: `Review project #${projectId}: project_card_id=${projectId}, project_generation=${supervision.generation}, review_case_id=${openCase.id}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
          reviewStore.bumpReviewRequestAttempt(rrId);
        } catch (err) {
          logWarn(TAG, `Project ${projectId}: dispatch failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (existingReq.status === "pending") {
        // cooldown check in getPendingReviewRequests prevents rapid retry
        try {
          spin.dispatch({ type: "O", goal: `Review project #${projectId}: project_card_id=${projectId}, project_generation=${supervision.generation}, review_case_id=${openCase.id}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
          reviewStore.bumpReviewRequestAttempt(existingReq.id);
        } catch (err) {
          logWarn(TAG, `Project ${projectId}: retry dispatch failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (existingReq.status === "abandoned") {
        logWarn(TAG, `Project ${projectId}: review request abandoned — settling blocked`);
        reviewStore.settleBlocked(projectId, openCase.id, { action: "blocked", reason: "Review request abandoned (attempts/deadline)" }, "Review abandoned");
        try { nerve.fire("card:failed", projectId); } catch {}
      }
    }
    return;
  }

  // Handle repair_planned: create child cards for each repair item
  if (supervision.state === "repair_planned") {
    const decision = reviewStore.getLatestDecisionForProject(projectId);
    if (!decision) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no decision found`);
      return;
    }
    const parsed = JSON.parse(decision.decision_json) as { repair?: { items: Array<{ id: string; affected_criterion_ids: string[]; strategy: string; required_evidence: string; capabilities: string[]; budget: { max_attempts?: number; max_tokens?: number } }> } };
    const items = parsed.repair?.items ?? [];
    if (items.length === 0) {
      logWarn(TAG, `Project ${projectId}: repair_planned but no repair items`);
      return;
    }
    // Load root contract for criterion mapping
    const contractRow = reviewStore.getContractByProjectCardId(projectId);
    const rootContract = contractRow ? JSON.parse(contractRow.contract_json) as { criteria: Array<{ id: string; description: string }> } : null;

    const rootCardId = (() => {
      try { return require("./tasks/kanban-board.js").resolveRootId(projectId) ?? projectId; } catch { return projectId; }
    })();

    for (const item of items) {
      const goal = `Repair: ${item.strategy.slice(0, 200)}`;
      logInfo(TAG, `Project ${projectId}: creating repair worker for item ${item.id} (criteria: ${item.affected_criterion_ids.join(",")})`);

      // Build #1366 contract with root criterion mapping
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
    reviewStore.setState(projectId, "repairing");
    return;
  }

  // Check if repair workers have completed
  if (supervision.state === "repairing") {
    const allTerminal = children.length > 0 && children.every(c => {
      const terminalStatuses = ["done", "delivered", "failed"];
      return terminalStatuses.includes(c.status);
    });
    if (allTerminal) {
      logInfo(TAG, `Project ${projectId}: all repair children terminal — creating new review round`);
      reviewStore.setState(projectId, "executing", { repair_round: supervision.repair_round + 1 });
      // Fall through to readiness check below
    } else {
      return;
    }
  }

  // Re-read children after state transitions/reconciliation above (Fix 4: avoid stale snapshot)
  const finalChildren = kanbanGetChildren(projectId);

  // Check review readiness: all children must be terminal
  const allChildrenTerminal = finalChildren.every(c => {
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
  const snapshot = await assembler.assembleCase(projectId, supervision.generation, supervision.review_round + 1);

  if ("error" in snapshot) {
    logWarn(TAG, `Project ${projectId}: review case assembly failed — ${snapshot.error}`);
    return;
  }

  // Atomically insert case, transition state, and create durable review request
  const snapshotDigest = `rc_${projectId}_${supervision.generation}_${supervision.review_round + 1}`;
  let caseId = "";
  let reviewRequestId = "";

  reviewStore.db.transaction(() => {
    const { id: cId } = reviewStore.insertReviewCase(
      projectId,
      supervision.generation,
      supervision.review_round + 1,
      snapshot,
      snapshotDigest,
    );
    caseId = cId;

    const transitioned = reviewStore.stateTransition(
      projectId,
      ["review_ready"] as ProjectState[],
      "review_requested",
    );
    if (!transitioned) throw new Error(`failed to transition project ${projectId} to review_requested`);

    const { id: rrId } = reviewStore.insertReviewRequest(projectId, cId, supervision.generation);
    reviewRequestId = rrId;
  });

  logInfo(TAG, `Project ${projectId}: review ready — case ${caseId} created, request ${reviewRequestId} (gen=${supervision.generation}, round=${supervision.review_round + 1})`);

  // Attempt to dispatch Orc — keep request pending so heartbeat retry can recover
  try {
    spin.dispatch({ type: "O", goal: `Review project #${projectId}: project_card_id=${projectId}, project_generation=${supervision.generation}, review_case_id=${caseId}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
    reviewStore.bumpReviewRequestAttempt(reviewRequestId);
  } catch (err) {
    logWarn(TAG, `Project ${projectId}: failed to dispatch Orc review — ${err instanceof Error ? err.message : String(err)} (request ${reviewRequestId} stays pending)`);
  }
}

/** #1363 Task 6: Drive review dispatch from pending requests. Returns count dispatched. */
function dispatchPendingReviewRequests(): number {
  const store = new ProjectReviewStore();
  const pending = store.getPendingReviewRequests();
  let dispatched = 0;
  for (const req of pending) {
    try {
      spin.dispatch({ type: "O", goal: `Review project #${req.project_card_id}: project_card_id=${req.project_card_id}, project_generation=${req.generation}, review_case_id=${req.review_case_id}`, source: "agent", cardId: req.project_card_id, settlementOwner: "spin" });
      // Keep the request pending. spin.dispatch() returns successfully even
      // when the Orc concurrency gate leaves the card queued; marking it
      // dispatched here would make that durable request unrecoverable.
      store.bumpReviewRequestAttempt(req.id);
      dispatched++;
    } catch (err) {
      logWarn(TAG, `Failed to dispatch pending review request ${req.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return dispatched;
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

async function reconcileChildCard(card: KanbanCard): Promise<void> {
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
      // #1365: Retry successor attempts have source_attempt_id / earliest_claim_at
      if (latestAttempt.source_attempt_id) {
        handleScheduledRetryClaim(card, latestAttempt);
      } else {
        logInfo(TAG, `Claiming supervised card ${card.id}`);
        const contract = svc.getContractForCard(card.id);
        if (contract) await startSupervisedWorker(card, latestAttempt, contract);
      }
    }
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

async function startSupervisedWorker(
  card: KanbanCard,
  attempt: AttemptRow,
  contract: WorkerAcceptanceContractV1,
): Promise<void> {
  // Check required capabilities before claiming.
  if (contract.required_capabilities && contract.required_capabilities.length > 0) {
    if (card.type === "pi") {
      const svc = _piService;
      if (!svc) {
        kanbanFail(card.id, "Pi service unavailable for pi-type card with required capabilities");
        return;
      }
      if (!contract.required_capabilities.every(c => c === "pi")) {
        kanbanFail(card.id, `Pi executor only supports "pi" capability, requires: ${contract.required_capabilities.join(", ")}`);
        return;
      }
    }
    // Agent (Spin) executor supports all standard capabilities — no explicit
    // capability check needed beyond the concurrency gate.
  }

  const capacity = await workerAdapter().capacity();
  if (capacity.available <= 0) return;

  const store = new WorkerSupervisionStore();
  const claim = store.claimAttempt(
    card.id,
    contract.id,
    "agent",
    "spin-local",
    attempt.generation || 1,
  );
  if (!claim) return;

  if (!store.markAttemptStartObservable(claim.attemptId)) {
    store.failAttempt(claim.attemptId);
    kanbanFail(card.id, "worker claim could not enter starting state");
    return;
  }

  let observation;
  try {
    observation = await workerAdapter().start(claim);
  } catch (err) {
    observation = { kind: "start_failed" as const, reason: String(err), retryable: true };
  }

  if (observation.kind === "started" || observation.kind === "already_started") {
    store.markAttemptRunning(claim.attemptId);
    return;
  }

  store.failAttempt(claim.attemptId);
  kanbanFail(card.id, `worker start failed: ${observation.reason}`);
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
  if (lifecycle !== "failed" && lifecycle !== "cancelled" && lifecycle !== "timed_out") return;

  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) {
      logWarn(TAG, `handleSupervisedRetry: no attempt for ${card.id} — leaving card failed for Orc review`);
      return;
    }

    const retryService = buildRetryService();

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
          // Card transitions to queued via the transaction in acceptAutomaticRetry
          wakeCard(card.id);
        } else if (acceptResult.kind === "idempotent") {
          logInfo(TAG, `Auto-retry already scheduled for card ${card.id}: target ${acceptResult.targetAttemptId}`);
          wakeCard(card.id);
        } else {
          logWarn(TAG, `Auto-retry failed for card ${card.id}: ${acceptResult.kind} — leaving card failed`);
        }
        break;
      }
      case "orc_review": {
        logInfo(TAG, `Orc review required for card ${card.id}: attempt ${latestAttempt.id} (${classification.primary})`);
        // Card stays failed — Orc sees it in check_workers and calls review_worker_failure
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

function handleScheduledRetryClaim(card: KanbanCard, pendingAttempt: AttemptRow): void {
  const store = new WorkerSupervisionStore();
  const contractRow = store.getContract(pendingAttempt.contract_id);
  if (!contractRow) {
    logWarn(TAG, `Scheduled retry ${card.id}: no contract ${pendingAttempt.contract_id} — failing`);
    kanbanFail(card.id, "retry contract not found");
    return;
  }
  const contract = JSON.parse(contractRow.contract_json) as WorkerAcceptanceContractV1;

  // Check earliest_claim_at
  if (pendingAttempt.earliest_claim_at && new Date(pendingAttempt.earliest_claim_at).getTime() > Date.now()) {
    const delay = new Date(pendingAttempt.earliest_claim_at).getTime() - Date.now();
    setTimeout(() => wakeCard(card.id), Math.min(delay, 60_000));
    return;
  }

  // Revalidate budget
  const retryService = buildRetryService();
  const budget = retryService["retryStore"].getFullLineageBudget(card.id);
  if (budget.totalAttempts + budget.activeReservations > 5) {
    logWarn(TAG, `Scheduled retry ${card.id}: budget exhausted — cancelling pending attempt`);
    store.cancelPendingAttempt(pendingAttempt.id, "budget_exhausted");
    kanbanFail(card.id, "retry budget exhausted");
    return;
  }

  // Revalidate executor eligibility
  const catalog = retryService["executorCatalog"] as import("./retry/local-executor-catalog.js").LocalExecutorCatalog;
  const { eligible } = catalog.getCandidates({ requiredCapabilities: [...contract.required_capabilities ?? []] });
  const matchingExecutor = eligible.find(e => e.id === pendingAttempt.executor_id && e.kind === pendingAttempt.executor_kind);
  if (!matchingExecutor || !matchingExecutor.healthy) {
    logWarn(TAG, `Scheduled retry ${card.id}: executor ${pendingAttempt.executor_kind}/${pendingAttempt.executor_id} not eligible — failing`);
    store.cancelPendingAttempt(pendingAttempt.id, "executor_ineligible");
    kanbanFail(card.id, "retry executor unavailable");
    return;
  }

  // Update reservation to claimed
  const reservation = store.getReservation(pendingAttempt.source_attempt_id ?? "");
  if (reservation) {
    store.updateReservationStatus(pendingAttempt.source_attempt_id ?? "", "claimed");
  }

  // Claim and start via adapter
  const claim = store.claimAttempt(card.id, contract.id, pendingAttempt.executor_kind as import("./worker-supervision-store.js").ExecutorKind, pendingAttempt.executor_id, pendingAttempt.generation || 1);
  if (!claim) return;

  if (!store.markAttemptStartObservable(claim.attemptId)) {
    store.failAttempt(claim.attemptId);
    kanbanFail(card.id, "retry claim could not enter starting state");
    return;
  }

  const adapter = workerAdapter();
  adapter.start(claim).then(observation => {
    if (observation.kind === "started" || observation.kind === "already_started") {
      store.markAttemptRunning(claim.attemptId);
    } else {
      store.failAttempt(claim.attemptId);
      kanbanFail(card.id, `retry start failed: ${observation.reason}`);
    }
  }).catch(err => {
    store.failAttempt(claim.attemptId);
    kanbanFail(card.id, `retry start error: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function buildRetryService(): import("./retry/retry-service.js").RetryService {
  const { RetryService } = require("./retry/retry-service.js") as typeof import("./retry/retry-service.js");
  const { LocalExecutorCatalog } = require("./retry/local-executor-catalog.js") as typeof import("./retry/local-executor-catalog.js");
  const catalog = new LocalExecutorCatalog({
    spinProvider: {
      kind: "agent" as const,
      id: "spin",
      getCapabilities: () => ["*"],
      isHealthy: () => true,
      currentLoad: () => 0,
      availableCapacity: () => 10,
      supportsWorkspace: () => true,
      respectsSandbox: () => true,
    },
    piEnabled: !!_piService,
    workspaceAlias: undefined,
  });
  return new RetryService({ executorCatalog: catalog });
}

function getLatestAttemptInfo(cardId: number): AttemptRow | undefined {
  const store = new WorkerSupervisionStore();
  return store.getLatestAttempt(cardId);
}

async function abortProject(projectId: number, children: KanbanCard[], reason: string): Promise<void> {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  for (const card of children) {
    if (card.status !== "running" && card.status !== "queued") continue;
    await cancelChild(card, reason);
  }
  kanbanFail(projectId, reason);
}

async function cancelChild(card: KanbanCard, reason: string): Promise<void> {
  const store = new WorkerSupervisionStore();
  const attempt = store.getLatestAttempt(card.id);
  if (!attempt || store.isAttemptTerminal(attempt.lifecycle)) {
    kanbanFail(card.id, `project aborted: ${reason}`);
    return;
  }

  // A pending attempt has no process to interrupt. Cancel it durably before
  // failing the card so a queued wakeup cannot dispatch it after the abort.
  if (attempt.lifecycle === "pending") {
    if (store.cancelPendingAttempt(attempt.id, `project_abort: ${reason}`)) {
      kanbanFail(card.id, `project aborted: ${reason}`);
    }
    return;
  }

  if (!store.requestCancel(attempt.id, `project_abort: ${reason}`)) return;

  const claim: ExecutionClaim = {
    attemptId: attempt.id,
    cardId: card.id,
    contractId: attempt.contract_id,
    executorKind: attempt.executor_kind === "pi" ? "pi" : attempt.executor_kind === "remote" ? "remote" : "agent",
    executorId: attempt.executor_id,
    generation: attempt.generation,
    claimedAt: attempt.claimed_at ?? attempt.started_at,
  };

  let observation;
  if (claim.executorKind === "agent") {
    observation = await workerAdapter().cancel(claim, "project_abort");
  } else if (attempt.executor_kind === "pi") {
    const svc = _piService;
    if (svc) {
      const run = svc.store.getByCardId(card.id);
      if (run) {
        try {
          await svc.executor.cancel(run.id);
          store.cancelAttempt(attempt.id);
          kanbanFail(card.id, `project aborted: ${reason}`);
        } catch {
          return;
        }
      }
    }
  }

  if (observation?.kind === "cancelled" || observation?.kind === "already_terminal") {
    store.cancelAttempt(attempt.id);
    kanbanFail(card.id, `project aborted: ${reason}`);
  }
  logInfo(TAG, `Cancellation requested for card ${card.id} attempt=${attempt.id} via ${attempt.executor_kind} (reason: project_abort)`);
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

/** #1363 Task 6: Retry pending review requests. Returns count dispatched. */
export function retryPendingReviewRequests(): number {
  return dispatchPendingReviewRequests();
}

/** #1414: Scan all running O-type projects and schedule reconciliation. Returns candidate count. */
export function scanActiveProjects(): number {
  const projectIds = kanbanRunningProjectIds();
  for (const projectId of projectIds) wakeCard(projectId);
  return projectIds.length;
}

/** Answer a pending input request. Returns true if the answer was accepted. */
export function answerInputRequest(requestId: string, response: string): boolean {
  const store = new ProjectReviewStore();
  const answered = store.answerInputRequest(requestId, response);
  if (answered) {
    // Wake the project
    const rows = store.db.prepare(`SELECT project_card_id FROM project_input_requests WHERE id = ?`).get(requestId) as { project_card_id: number } | undefined;
    if (rows) requestReconcile(rows.project_card_id);
  }
  return answered;
}

export function startReconciler(): void {
  nerve.on("card:queued", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:done", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:failed", (cardId: number) => requestReconcileForProject(cardId));
  const count = scanActiveProjects();
  logInfo(TAG, `Reconciler started — recovered ${count} running project(s)`);
}
