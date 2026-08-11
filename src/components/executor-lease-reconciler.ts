import type { SwarmExecutorAdapter, ExecutionClaim, CancelReason } from "./swarm-executor-types.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { evaluateLease, applyInspectionOutcome } from "./executor-lease-policy.js";
import type { LeasePolicy, AttemptLeaseSnapshotV1 } from "./executor-progress.js";
import { DEFAULT_LOCAL_POLICY } from "./executor-progress.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { logInfo, logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";

const TAG = "lease-reconciler";

export interface AdapterResolver {
  (executorKind: string, executorId: string): SwarmExecutorAdapter | undefined;
}

export class LeaseReconciliationService {
  private leaseStore: ExecutorLeaseStore;
  private supervisionStore: WorkerSupervisionStore;
  private resolveAdapter: AdapterResolver;
  private policy: LeasePolicy;

  constructor(
    resolveAdapter: AdapterResolver,
    leaseStore?: ExecutorLeaseStore,
    supervisionStore?: WorkerSupervisionStore,
    policy?: LeasePolicy,
  ) {
    this.leaseStore = leaseStore ?? new ExecutorLeaseStore();
    this.supervisionStore = supervisionStore ?? new WorkerSupervisionStore();
    this.resolveAdapter = resolveAdapter;
    this.policy = policy ?? DEFAULT_LOCAL_POLICY;
  }

  /** Evaluate one attempt's lease and take policy action. */
  evaluateAndAct(attemptId: string, cardId: number): void {
    const snapshot = this.leaseStore.getSnapshot(attemptId);
    if (!snapshot) return;

    if (snapshot.closedAt) return;
    if (snapshot.evaluation.phase === "closed" || snapshot.evaluation.phase === "cancel_requested") return;

    const attempt = this.supervisionStore.getAttempt(attemptId);
    if (!attempt) return;

    const hardDeadlineAt = attempt.hard_deadline_at
      ? new Date(attempt.hard_deadline_at).getTime()
      : undefined;

    const decision = evaluateLease(snapshot, Date.now(), this.policy, hardDeadlineAt);

    const sv = snapshot.stateVersion;

    switch (decision.action) {
      case "healthy": {
        if (snapshot.evaluation.phase !== "healthy") {
          this.leaseStore.updateEvaluation(attemptId, "healthy", sv);
        }
        if (decision.nextAt) {
          this.leaseStore.setUpcomingEvaluation(attemptId, decision.nextAt);
        }
        break;
      }

      case "warning": {
        if (snapshot.evaluation.phase !== "warning") {
          this.leaseStore.updateEvaluation(attemptId, "warning", sv);
          logWarn(TAG, `Lease warning for attempt ${attemptId}: ${decision.reason}`);
        }
        if (decision.nextAt) {
          this.leaseStore.setUpcomingEvaluation(attemptId, decision.nextAt);
        }
        break;
      }

      case "inspect": {
        this._performInspection(snapshot, attemptId, cardId, sv);
        break;
      }

      case "cancel": {
        this._performCancellation(snapshot, attemptId, cardId, decision.reason ?? "liveness_expired", sv);
        break;
      }

      case "closed": {
        break;
      }
    }
  }

  private _performInspection(snapshot: AttemptLeaseSnapshotV1, attemptId: string, cardId: number, stateVersion: number): void {
    if (snapshot.evaluation.phase === "inspecting") return;

    const casOk = this.leaseStore.updateEvaluation(attemptId, "inspecting", stateVersion);
    if (!casOk) return;

    const attempt = this.supervisionStore.getAttempt(attemptId);
    if (!attempt) return;

    const adapter = this.resolveAdapter(attempt.executor_kind, attempt.executor_id);
    if (!adapter) {
      logWarn(TAG, `No adapter for ${attempt.executor_kind}/${attempt.executor_id} — skipping inspect`);
      this.leaseStore.updateEvaluation(attemptId, "inspect_due");
      return;
    }

    const claim: ExecutionClaim = {
      attemptId: attempt.id,
      cardId,
      contractId: attempt.contract_id,
      executorKind: attempt.executor_kind as "agent" | "pi",
      executorId: attempt.executor_id,
      generation: attempt.generation,
      claimedAt: attempt.claimed_at ?? attempt.started_at,
      hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
    };

    adapter.inspect(claim).then(observation => {
      const now = Date.now();
      const reloaded = this.leaseStore.getSnapshot(attemptId);
      if (!reloaded || reloaded.closedAt) return;

      const hardDeadlineAt = attempt.hard_deadline_at
        ? new Date(attempt.hard_deadline_at).getTime()
        : undefined;

      let outcome: "running" | "terminal" | "unknown";
      switch (observation.kind) {
        case "running":
          outcome = "running";
          break;
        case "terminal":
          this.leaseStore.closeLease(attemptId, attempt.generation, "inspection_terminal");
          return;
        default:
          outcome = "unknown";
          break;
      }

      const updated = applyInspectionOutcome(reloaded, outcome, now, this.policy, hardDeadlineAt);
      const casOk = this.leaseStore.updateEvaluation(attemptId, updated.evaluation.phase, reloaded.stateVersion, updated.nextEvaluationAt);

      if (casOk && updated.closedAt) {
        this.leaseStore.closeLease(attemptId, attempt.generation, updated.closeReason ?? "inspection_complete");
      }

      logInfo(TAG, `Inspection complete for attempt ${attemptId}: ${outcome} (phase=${updated.evaluation.phase})`);
    }).catch(err => {
      logWarn(TAG, `Inspection failed for attempt ${attemptId}: ${err}`);
      this.leaseStore.updateEvaluation(attemptId, "inspect_due", snapshot.stateVersion);
    });
  }

  private _performCancellation(_snapshot: AttemptLeaseSnapshotV1, attemptId: string, cardId: number, reason: string, stateVersion: number): void {
    const attempt = this.supervisionStore.getAttempt(attemptId);
    if (!attempt) return;

    const committed = this.leaseStore.recordCancelIntent(attemptId, reason, attempt.generation, stateVersion);
    if (!committed) return;

    if (reason === "hard_deadline") {
      logSwarmTrace({ event: "deadline_expired", card: cardId, attempt: attemptId, reason: "hard_deadline" });
      const settlement = this.supervisionStore.terminalSettlement({
        attemptId,
        expectedGeneration: attempt.generation || 1,
        desiredState: "timed_out",
        stableReason: "hard_deadline_expired",
      });
      if (settlement.kind === "settled" || settlement.kind === "replayed") {
        logInfo(TAG, `Hard deadline settlement for attempt ${attemptId}: ${settlement.kind}`);
      }
      return;
    }

    const adapter = this.resolveAdapter(attempt.executor_kind, attempt.executor_id);
    if (!adapter) {
      logWarn(TAG, `No adapter for ${attempt.executor_kind}/${attempt.executor_id} — cancel intent recorded but no runtime cancel`);
      return;
    }

    const claim: ExecutionClaim = {
      attemptId: attempt.id,
      cardId,
      contractId: attempt.contract_id,
      executorKind: attempt.executor_kind as "agent" | "pi",
      executorId: attempt.executor_id,
      generation: attempt.generation,
      claimedAt: attempt.claimed_at ?? attempt.started_at,
      hardDeadlineAt: attempt.hard_deadline_at ?? undefined,
    };

    const cancelReason: CancelReason = reason === "hard_deadline" ? "deadline" : "operator";
    adapter.cancel(claim, cancelReason).catch(err => {
      logWarn(TAG, `Cancel failed for attempt ${attemptId}: ${err}`);
    });

    logInfo(TAG, `Cancel requested for attempt ${attemptId}: ${reason}`);
  }
}
