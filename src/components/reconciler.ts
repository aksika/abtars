import { nerve } from "./nerve.js";
import { spin } from "./spin.js";
import {
  kanbanFail,
  kanbanGetCard, kanbanGetChildren, kanbanRunningProjectIds,
  kanbanQueuedDispatchOrder,
  isUnblocked, cascadeFail, type KanbanCard,
} from "./tasks/kanban-board.js";
import { logInfo, logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { SpinWorkerAdapter } from "./spin-worker-adapter.js";
import type { SwarmExecutorAdapter, ExecutionClaim } from "./swarm-executor-types.js";
import { resolveSchedulingPolicy, deriveDeadline } from "./swarm-dispatch-policy.js";
import { LeaseReconciliationService } from "./executor-lease-reconciler.js";
import type { LifecycleWakeScheduler } from "./lifecycle-wake-scheduler.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { ProjectReviewStore, type ProjectState } from "./project-acceptance/project-review-store.js";
import { ReviewCaseAssembler } from "./project-acceptance/project-review-case.js";
import type { PiRunService } from "./pi-executor/pi-run-service.js";
import type { AttemptLifecycle, AttemptRow } from "./worker-supervision-store.js";
import type { WorkerAcceptanceContractV1 } from "./worker-contract.js";

const TAG = "reconciler";

let _shutdownRequested = false;

let _piService: PiRunService | null = null;
let _workerAdapter: SwarmExecutorAdapter | null = null;

export function setPiService(service: PiRunService | null): void {
  _piService = service;
}

export function setWorkerAdapter(adapter: SwarmExecutorAdapter | null): void {
  _workerAdapter = adapter;
}

function workerAdapter(): SwarmExecutorAdapter {
  return _workerAdapter ??= new SpinWorkerAdapter();
}

function dispatchExecutor(executorKind: string, executorId: string): { kind: "agent" | "pi"; id: string; adapter: SwarmExecutorAdapter } | undefined {
  if (executorKind === "local_worker" || executorKind === "agent") {
    // Older attempts were created as local_worker/spin. They are still Spin
    // attempts, but all new claims use the durable executor identity below.
    return { kind: "agent", id: "spin-local", adapter: workerAdapter() };
  }
  if (executorKind === "pi" && _piService) {
    const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
    return { kind: "pi", id: executorId, adapter: new PiExecutorAdapter(_piService.executor) };
  }
  return undefined;
}

export function requestShutdown(): void {
  _shutdownRequested = true;
}

import type { OrcProjectCoordinator } from "./orc-project/orc-project-coordinator.js";

let _orcCoordinator: OrcProjectCoordinator | null = null;

export function setOrcCoordinator(c: OrcProjectCoordinator | null): void {
  _orcCoordinator = c;
}

export function getOrcCoordinator(): OrcProjectCoordinator | null {
  return _orcCoordinator;
}

/**
 * #1516: Get the shared Orc coordinator, initializing it (and its boot
 * recovery) on first use. The scheduled-project runner calls this so its
 * goal-bearing claim races ahead of the Reconciler's generic authoring goal.
 */
export function getOrCreateOrcCoordinator(): OrcProjectCoordinator | null {
  if (_orcCoordinator) return _orcCoordinator;
  try {
    const { loadPeerConfig } = require("./peer-config.js") as typeof import("./peer-config.js");
    const peerName = loadPeerConfig().self.name;
    const { OrcProjectCoordinator } = require("./orc-project/orc-project-coordinator.js") as typeof import("./orc-project/orc-project-coordinator.js");
    _orcCoordinator = new OrcProjectCoordinator({
      ownerPeer: peerName,
      startPort: async (context, goal) => {
        await spin.spin({
          type: "O",
          goal,
          sessionId: context.sessionId,
          cardId: context.projectCardId,
          settlementOwner: "spin",
          source: "agent",
          orcContext: context,
        });
      },
    });
    logInfo(TAG, "Orc coordinator initialized");
    _orcCoordinator.bootRecovery();
  } catch (err) {
    logWarn(TAG, `Failed to initialize Orc coordinator: ${err instanceof Error ? err.message : String(err)}`);
  }
  return _orcCoordinator;
}

/**
 * #1516: Public project-abort boundary. Terminalizes all non-terminal Worker
 * children and the root idempotently. A terminal root (accepted/delivered/
 * failed) is never touched — late cancellation cannot clobber settled state.
 */
export async function abortProjectById(projectId: number, reason: string): Promise<void> {
  const card = kanbanGetCard(projectId);
  if (!card) return;
  if (card.status === "done" || card.status === "delivered" || card.status === "failed") {
    logInfo(TAG, `Project ${projectId}: already terminal (${card.status}) — abort skipped`);
    return;
  }
  const children = kanbanGetChildren(projectId);
  await abortProject(projectId, children, reason);
}

function scheduleOrcReview(projectId: number, generation: number, caseId: string, requestId: string): void {
  if (_orcCoordinator) {
    const result = _orcCoordinator.scheduleReview(projectId, generation, caseId);
    if (result.kind === "claimed" || result.kind === "idempotent") {
      try { (new ProjectReviewStore()).bumpReviewRequestAttempt(requestId); } catch {}
    }
  } else {
    legacyOrcReviewDispatch(projectId, generation, caseId, requestId);
  }
}

function legacyOrcDispatch(goal: string, cardId: number): void {
  try {
    spin.dispatch({ type: "O", goal, source: "agent", cardId, settlementOwner: "spin" });
  } catch (err) {
    logWarn(TAG, `Failed to dispatch Orc — ${err instanceof Error ? err.message : String(err)}`);
  }
}

function legacyOrcReviewDispatch(projectId: number, generation: number, caseId: string, requestId: string): void {
  try {
    spin.dispatch({ type: "O", goal: `Review project #${projectId}: project_card_id=${projectId}, project_generation=${generation}, review_case_id=${caseId}`, source: "agent", cardId: projectId, settlementOwner: "spin" });
    try { (new ProjectReviewStore()).bumpReviewRequestAttempt(requestId); } catch {}
  } catch (err) {
    logWarn(TAG, `Failed to dispatch Orc review — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Keyed scheduler (per-card reconciliation) ────────────────────────────────

interface CardReconcilerState {
  running: boolean;
  dirty: boolean;
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

  if (card.type === "O" && card.status === "running") {
    await reconcileProject(cardId);
    return;
  }

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

  if (contractRow) {
    try {
      const contract = JSON.parse(contractRow.contract_json) as { limits?: { hard_deadline_at?: string } };
      const configuredDeadline = contract.limits?.hard_deadline_at ? Date.parse(contract.limits.hard_deadline_at) : NaN;
      if (Number.isFinite(configuredDeadline) && now > configuredDeadline) {
        await abortProject(projectId, children, "configured hard deadline exceeded");
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
      if (_orcCoordinator) {
        _orcCoordinator.scheduleContractAuthoring(projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    } else if (supervision.state === "awaiting_contract") {
      logInfo(TAG, `Project ${projectId}: still awaiting contract — waking Orc`);
      if (_orcCoordinator) {
        _orcCoordinator.scheduleContractAuthoring(projectId);
      } else {
        legacyOrcDispatch(`Define acceptance contract for project #${projectId}; call define_project_contract with project_card_id=${projectId}`, projectId);
      }
    }
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
  if (supervision.state === "awaiting_contract") return;

  if (children.length === 0) return;

  if (project.max_tokens != null && (project.tokens_used ?? 0) >= project.max_tokens) {
    await abortProject(projectId, children, `budget exceeded (${project.tokens_used}/${project.max_tokens} tokens)`);
    return;
  }

  // #1510: Request dispatch pump instead of directly starting workers
  requestWorkerDispatch();

  if (supervision.state === "needs_input") {
    const answered = reviewStore.getAnsweredInputRequests(projectId);
    if (answered.length > 0) {
      logInfo(TAG, `Project ${projectId}: ${answered.length} input(s) answered — creating new review case`);
      reviewStore.clearInputNotice(projectId);
      const nextRound = supervision.review_round + 1;
      reviewStore.stateTransition(projectId, ["needs_input"], "executing", { review_round: nextRound });
    } else {
      const pending = reviewStore.getPendingInputRequests().filter(r => r.project_card_id === projectId);
      if (pending.length === 0) {
        logWarn(TAG, `Project ${projectId}: needs_input state but no pending or answered requests — recovering`);
        reviewStore.setState(projectId, "executing", { review_round: supervision.review_round + 1 });
      } else {
        return;
      }
    }
  }

  if (supervision.state === "review_requested") {
    const openCase = reviewStore.getLatestOpenCase(projectId);
    if (openCase) {
      const existingReq = reviewStore.getReviewRequestByCaseId(openCase.id);
      if (!existingReq) {
        const { id: rrId } = reviewStore.insertReviewRequest(projectId, openCase.id, supervision.generation);
        scheduleOrcReview(projectId, supervision.generation, openCase.id, rrId);
      } else if (existingReq.status === "pending") {
        scheduleOrcReview(projectId, supervision.generation, openCase.id, existingReq.id);
      } else if (existingReq.status === "abandoned") {
        logWarn(TAG, `Project ${projectId}: review request abandoned — settling blocked`);
        reviewStore.settleBlocked(projectId, openCase.id, { action: "blocked", reason: "Review request abandoned (attempts/deadline)" }, "Review abandoned");
        try { nerve.fire("card:failed", projectId); } catch {}
      }
    }
    return;
  }

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
    const contractRow2 = reviewStore.getContractByProjectCardId(projectId);
    const rootContract = contractRow2 ? JSON.parse(contractRow2.contract_json) as { criteria: Array<{ id: string; description: string }> } : null;
    const rootCardId = (() => {
      try { return require("./tasks/kanban-board.js").resolveRootId(projectId) ?? projectId; } catch { return projectId; }
    })();
    for (const item of items) {
      const goal = `Repair: ${item.strategy.slice(0, 200)}`;
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
    reviewStore.setState(projectId, "repairing");
    return;
  }

  if (supervision.state === "repairing") {
    const allTerminal = children.length > 0 && children.every(c => {
      const terminalStatuses = ["done", "delivered", "failed"];
      return terminalStatuses.includes(c.status);
    });
    if (allTerminal) {
      logInfo(TAG, `Project ${projectId}: all repair children terminal — creating new review round`);
      reviewStore.setState(projectId, "executing", { repair_round: supervision.repair_round + 1 });
    } else {
      return;
    }
  }

  const finalChildren = kanbanGetChildren(projectId);
  const allChildrenTerminal = finalChildren.every(c => {
    const terminalStatuses = ["done", "delivered", "failed"];
    return terminalStatuses.includes(c.status);
  });
  if (!allChildrenTerminal) return;

  const existingOpenCase = reviewStore.getLatestOpenCase(projectId);
  if (existingOpenCase) return;

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

  const assembler = new ReviewCaseAssembler();
  const snapshot = await assembler.assembleCase(projectId, supervision.generation, supervision.review_round + 1);
  if ("error" in snapshot) {
    logWarn(TAG, `Project ${projectId}: review case assembly failed — ${snapshot.error}`);
    return;
  }

  const snapshotDigest = `rc_${projectId}_${supervision.generation}_${supervision.review_round + 1}`;
  let caseId = "";
  let reviewRequestId = "";
  reviewStore.db.transaction(() => {
    const { id: cId } = reviewStore.insertReviewCase(projectId, supervision.generation, supervision.review_round + 1, snapshot, snapshotDigest);
    caseId = cId;
    const transitioned2 = reviewStore.stateTransition(projectId, ["review_ready"] as ProjectState[], "review_requested");
    if (!transitioned2) throw new Error(`failed to transition project ${projectId} to review_requested`);
    const { id: rrId } = reviewStore.insertReviewRequest(projectId, cId, supervision.generation);
    reviewRequestId = rrId;
  });
  logInfo(TAG, `Project ${projectId}: review ready — case ${caseId} created, request ${reviewRequestId} (gen=${supervision.generation}, round=${supervision.review_round + 1})`);
  logSwarmTrace({ event: "review_case_created", project: projectId, card: projectId, reviewCase: caseId, reason: "all_children_terminal", generation: supervision.generation });
  scheduleOrcReview(projectId, supervision.generation, caseId, reviewRequestId);
}

function dispatchPendingReviewRequests(): number {
  const store = new ProjectReviewStore();
  const pending = store.getPendingReviewRequests();
  let dispatched = 0;
  for (const req of pending) {
    if (_orcCoordinator) {
      const result = _orcCoordinator.scheduleReview(req.project_card_id, req.generation, req.review_case_id);
      if (result.kind === "claimed" || result.kind === "idempotent") {
        try { store.bumpReviewRequestAttempt(req.id); } catch {}
        dispatched++;
      }
    } else {
      legacyOrcReviewDispatch(req.project_card_id, req.generation, req.review_case_id, req.id);
      dispatched++;
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

  const claim = svc.store.claimQueuedGeneration(card.id);
  if (!claim.claimed) {
    logWarn(TAG, `Failed to claim Pi card ${card.id}: ${claim.reason}`);
    return;
  }

  logInfo(TAG, `Starting Pi run ${claim.runId} (card ${card.id}, gen ${claim.generation})`);
  svc.executor.startWithClaim(claim.runId, claim.generation, run.currentSessionId ?? `${Date.now()}_C_pi_${claim.runId}`).catch((err) => {
    logWarn(TAG, `Pi start failed for ${claim.runId}: ${err instanceof Error ? err.message : String(err)}`);
  });
}

async function reconcileChildCard(card: KanbanCard): Promise<void> {
  if (card.type === "pi") {
    reconcilePiCard(card);
    return;
  }

  const svc = new WorkerSupervisionService();
  const hasContract = svc.cardHasContract(card.id);
  if (!hasContract) return;

  const latestAttempt = getLatestAttemptInfo(card.id);

  if (card.status === "queued") {
    if (!isUnblocked(card)) return;
    if (latestAttempt && latestAttempt.lifecycle === "pending") {
      requestWorkerDispatch();
    }
    return;
  }

  if (card.status === "failed" && latestAttempt) {
    handleSupervisedRetry(card, latestAttempt.lifecycle);
    return;
  }

  if (latestAttempt && !isTerminal(latestAttempt.lifecycle)) {
    evaluateLease(card);
    return;
  }

  if (latestAttempt && latestAttempt.lifecycle === "cancel_requested") {
    return;
  }
}

export function requestWorkerDispatch(): void {
  dispatchPumpState.dirty = true;
  if (!dispatchPumpState.running) {
    dispatchPumpState.running = true;
    queueMicrotask(() => runWorkerDispatch());
  }
}

interface DispatchPumpState {
  running: boolean;
  dirty: boolean;
}

const dispatchPumpState: DispatchPumpState = { running: false, dirty: false };

async function runWorkerDispatch(): Promise<void> {
  try {
    do {
      dispatchPumpState.dirty = false;
      if (_shutdownRequested) return;
      await dispatchOnePass();
    } while (dispatchPumpState.dirty);
  } finally {
    dispatchPumpState.running = false;
  }
}

async function dispatchOnePass(): Promise<void> {
  const store = new WorkerSupervisionStore();
  const capacities = new Map<string, { adapter: SwarmExecutorAdapter; max: number }>();
  const rootDeadlines = new Map<number, string | undefined>();

  const queued = kanbanQueuedDispatchOrder();
  for (const card of queued) {
    if (_shutdownRequested) return;

    if (!isUnblocked(card)) continue;
    if (card.parent_id == null) continue;
    const projectId = card.parent_id;

    const project = kanbanGetCard(projectId);
    if (!project || project.status !== "running") continue;

    const supSvc = new WorkerSupervisionService();
    const hasContract = supSvc.cardHasContract(card.id);
    if (!hasContract) continue;

    const latestAttempt = store.getLatestAttempt(card.id);
    if (!latestAttempt || latestAttempt.lifecycle !== "pending") continue;

    const executor = dispatchExecutor(latestAttempt.executor_kind ?? "local_worker", latestAttempt.executor_id ?? "spin");
    if (!executor) continue;
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
      store.db.prepare(`UPDATE kanban_board SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`).run("budget_exhausted", card.id);
      kanbanFail(card.id, "budget_exhausted");
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

function evaluateLease(card: KanbanCard): void {
  try {
    const supStore = new WorkerSupervisionStore();
    const latestAttempt = supStore.getLatestAttempt(card.id);
    if (!latestAttempt) return;

    const adapterResolver = (executorKind: string, _executorId: string) => {
      if (executorKind === "agent") return workerAdapter();
      if (executorKind === "pi") {
        const svc = _piService;
        if (!svc) return undefined;
        const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
        return new PiExecutorAdapter(svc.executor);
      }
      return undefined;
    };

    const service = new LeaseReconciliationService(adapterResolver);
    service.evaluateAndAct(latestAttempt.id, card.id);
    scheduleLeaseEvaluations();
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

function buildRetryService(): import("./retry/retry-service.js").RetryService {
  const { RetryService } = require("./retry/retry-service.js") as typeof import("./retry/retry-service.js");
  const { LocalExecutorCatalog } = require("./retry/local-executor-catalog.js") as typeof import("./retry/local-executor-catalog.js");
  const { providerForAdapter } = require("./retry/local-executor-catalog.js") as typeof import("./retry/local-executor-catalog.js");
  const catalog = new LocalExecutorCatalog({
    spinProvider: providerForAdapter(workerAdapter(), "spin"),
  });
  return new RetryService({ executorCatalog: catalog });
}

function getLatestAttemptInfo(cardId: number): AttemptRow | undefined {
  const store = new WorkerSupervisionStore();
  return store.getLatestAttempt(cardId);
}

async function abortProject(projectId: number, children: KanbanCard[], reason: string): Promise<void> {
  logWarn(TAG, `ABORT project ${projectId}: ${reason}`);
  // Freeze supervision before cancelling child executors. Late Orc review
  // results must not be able to move an aborted project back to accepted.
  const reviewStore = new ProjectReviewStore();
  reviewStore.stateTransition(
    projectId,
    ["awaiting_contract", "executing", "review_ready", "review_requested", "reviewing", "repair_planned", "repairing", "needs_input"],
    "blocked",
    { blocked_reason: `aborted: ${reason}`.slice(0, 500) },
  );
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
      const executor = dispatchExecutor(attempt.executor_kind, attempt.executor_id);
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
  kanbanFail(projectId, reason);
}

// ── Public API ───────────────────────────────────────────────────────────────

export function requestReconcile(cardId: number): void {
  wakeCard(cardId);
}

export function requestReconcileForProject(cardId: number): void {
  const card = kanbanGetCard(cardId);
  if (card?.parent_id) {
    wakeCard(card.parent_id);
  }
  wakeCard(cardId);
}

export function retryPendingReviewRequests(): number {
  return dispatchPendingReviewRequests();
}

export function scanActiveProjects(): number {
  const projectIds = kanbanRunningProjectIds();
  for (const projectId of projectIds) wakeCard(projectId);
  return projectIds.length;
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

function scheduleLeaseEvaluations(): void {
  getWakeScheduler()?.sourceChanged("executor-lease");
}

let _reconcilerStarted = false;

export function startReconciler(): void {
  if (_reconcilerStarted) {
    logInfo(TAG, "Reconciler already started — skipping duplicate init");
    return;
  }
  _reconcilerStarted = true;

  getOrCreateOrcCoordinator();

  // #1510: Boot recovery — terminalize process-bound attempts from dead bridge
  runBootRecovery();

  // #1539: executor-lease due source on the lifecycle wake scheduler.
  registerExecutorLeaseSource();

  nerve.on("card:queued", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:done", (cardId: number) => requestReconcileForProject(cardId));
  nerve.on("card:failed", (cardId: number) => requestReconcileForProject(cardId));
  const count = scanActiveProjects();

  logInfo(TAG, `Reconciler started — recovered ${count} running project(s)`);
}

function leaseWake(cardId: number): void {
  const card = require("./tasks/kanban-board.js").kanbanGetCard(cardId) as { parent_id?: number } | undefined;
  if (card?.parent_id) wakeCard(card.parent_id);
  requestReconcile(cardId);
}

/** #1539: register the executor-lease due source with the wake scheduler. */
function registerExecutorLeaseSource(): void {
  const scheduler = getWakeScheduler();
  if (!scheduler) {
    logWarn(TAG, "Lease source not registered — lifecycle wake scheduler unavailable");
    return;
  }
  const { ExecutorLeaseStore: StoreWithHook } = require("./executor-lease-store.js") as typeof import("./executor-lease-store.js");
  scheduler.register({
    id: "executor-lease",
    listDueItems: () => new ExecutorLeaseStore().getEvaluationSchedule()
      .map(s => ({ key: `lease:${s.attemptId}`, dueAt: new Date(s.nextEvaluationAt).getTime() })),
    wakeDue: (_now: number) => {
      for (const s of new ExecutorLeaseStore().getDueSnapshots()) {
        leaseWake(s.cardId);
      }
    },
  });
  StoreWithHook.onLeaseChanged = () => {
    scheduler.sourceChanged("executor-lease");
  };
  // Registration is a source mutation: immediate scan + re-arm.
  scheduler.sourceChanged("executor-lease");
}

let _wakeScheduler: LifecycleWakeScheduler | null = null;

export function setWakeScheduler(scheduler: LifecycleWakeScheduler | null): void {
  _wakeScheduler = scheduler;
}

export function getWakeScheduler(): LifecycleWakeScheduler | null {
  return _wakeScheduler;
}

function runBootRecovery(): void {
  try {
    const store = new WorkerSupervisionStore();
    const active = store.getActiveSupervisedAttempts();
    if (active.length === 0) {
      logInfo(TAG, "Boot recovery: no active attempts to recover");
      return;
    }

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
          const card = kanbanGetCard(attempt.card_id);
          if (card) kanbanFail(card.id, "bridge_restart");
        }
        recovered++;
      } else if (policy.recovery === "inspectable") {
        const adapter = resolveAdapterForRecovery(attempt.executor_kind, attempt.executor_id);
        if (adapter) {
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
          adapter.inspect(claim).then(observation => {
            if (observation.kind === "terminal") {
              store.terminalSettlement({
                attemptId: attempt.id,
                expectedGeneration: attempt.generation || 1,
                desiredState: observation.lifecycle as "completed" | "failed" | "cancelled" | "timed_out",
                stableReason: "recovery_inspection_terminal",
              });
            }
          }).catch(err => {
            logWarn(TAG, `Boot recovery inspection failed for ${attempt.id}: ${err instanceof Error ? err.message : String(err)}`);
          });
          logSwarmTrace({ event: "recovery_inspect", card: attempt.card_id, attempt: attempt.id, reason: "inspectable_attempt" });
        }
      }
    }
    if (recovered > 0) {
      logInfo(TAG, `Boot recovery: settled ${recovered} process-bound attempt(s)`);
    }
  } catch (err) {
    logWarn(TAG, `Boot recovery error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function resolveAdapterForRecovery(executorKind: string, _executorId: string): SwarmExecutorAdapter | undefined {
  if (executorKind === "agent") return workerAdapter();
  if (executorKind === "pi") {
    const svc = _piService;
    if (!svc) return undefined;
    const { PiExecutorAdapter } = require("./pi-executor-adapter.js") as typeof import("./pi-executor-adapter.js");
    return new PiExecutorAdapter(svc.executor);
  }
  return undefined;
}
