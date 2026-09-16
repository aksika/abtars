import type { SwarmExecutorAdapter, ExecutionClaim, CancelReason } from "./swarm-executor-types.js";
import type { ExecutorKind } from "./worker-executor-identity.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { evaluateLease, applyInspectionOutcome } from "./executor-lease-policy.js";
import type { LeasePolicy, AttemptLeaseSnapshotV1 } from "./executor-progress.js";
import { DEFAULT_LOCAL_POLICY } from "./executor-progress.js";
import { WorkerSupervisionStore, type AttemptRow } from "./worker-supervision-store.js";
import { logInfo, logWarn } from "./logger.js";
import { logSwarmTrace } from "./swarm-trace.js";

const TAG = "lease-reconciler";

export interface AdapterResolver {
  (executorKind: ExecutorKind, executorId: string): SwarmExecutorAdapter | undefined;
}

export interface LeaseTerminalNotification {
  readonly cardId: number;
  readonly attemptId: string;
  readonly attemptGeneration: number;
}

export interface LeaseReconciliationHooks {
  /** #1801: generation-captured reconciliation notification. Called only when
   * the durable latest attempt for the card is terminal and still the
   * cancelled attempt — never from an adapter observation alone, never a
   * card verdict write. */
  readonly onTerminalAttempt?: (info: LeaseTerminalNotification) => void;
}

export class LeaseReconciliationService {
  private leaseStore: ExecutorLeaseStore;
  private supervisionStore: WorkerSupervisionStore;
  private resolveAdapter: AdapterResolver;
  private policy: LeasePolicy;
  private hooks?: LeaseReconciliationHooks;

  constructor(
    resolveAdapter: AdapterResolver,
    leaseStore?: ExecutorLeaseStore,
    supervisionStore?: WorkerSupervisionStore,
    policy?: LeasePolicy,
    hooks?: LeaseReconciliationHooks,
  ) {
    this.leaseStore = leaseStore ?? new ExecutorLeaseStore();
    this.supervisionStore = supervisionStore ?? new WorkerSupervisionStore();
    this.resolveAdapter = resolveAdapter;
    this.policy = policy ?? DEFAULT_LOCAL_POLICY;
    this.hooks = hooks;
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

    const attemptGeneration = attempt.generation || 1;

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
      // #1801: the durable verdict exists — wake reconciliation from the
      // winning attempt state, preserving a concurrent winner. No adapter
      // call on this branch by design.
      this.notifyIfTerminal(cardId, attemptId, attemptGeneration);
      return;
    }

    const adapter = this.resolveAdapter(attempt.executor_kind, attempt.executor_id);
    if (!adapter) {
      logWarn(TAG, `No adapter for ${attempt.executor_kind}/${attempt.executor_id} — cancel intent recorded but no runtime cancel`);
      // #1801: read-only terminal check — a concurrently settled winner still
      // wakes; a live attempt notifies nothing. Never manufacture settlement.
      this.notifyIfTerminal(cardId, attemptId, attemptGeneration);
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
    // #1801: notify from durable state, not the adapter observation. Both
    // fulfillment (including cancel_failed/not_found with a terminal winner)
    // and rejection (including throws after a durable commit) re-read the
    // latest attempt — a still-live/missing attempt notifies nothing.
    adapter.cancel(claim, cancelReason).then(
      () => {
        this.notifyIfTerminal(cardId, attemptId, attemptGeneration);
      },
      (err) => {
        logWarn(TAG, `Cancel failed for attempt ${attemptId}: ${err}`);
        this.notifyIfTerminal(cardId, attemptId, attemptGeneration);
      },
    );

    logInfo(TAG, `Cancel requested for attempt ${attemptId}: ${reason}`);
  }

  /**
   * #1801: read-only terminal gate for the cancellation wake. Re-reads the
   * durable latest attempt and notifies only when it is terminal and still
   * the cancelled attempt — a replacement attempt is untouched, a live or
   * missing attempt produces no verdict. Never writes a card verdict.
   */
  private notifyIfTerminal(cardId: number, attemptId: string, attemptGeneration: number): void {
    const notify = this.hooks?.onTerminalAttempt;
    if (!notify) return;
    let latest: AttemptRow | undefined;
    try {
      latest = this.supervisionStore.getLatestAttempt(cardId);
      if (!latest) return;
      if (latest.id !== attemptId) return;
      if ((latest.generation || 1) !== (attemptGeneration || 1)) return;
      if (!this.supervisionStore.isAttemptTerminal(latest.lifecycle)) return;
    } catch {
      // Unreadable durable verdict: never fabricate a wake.
      return;
    }
    try {
      notify({ cardId, attemptId: latest.id, attemptGeneration: latest.generation || 1 });
    } catch (err) {
      logWarn(TAG, `Terminal notification failed for attempt ${attemptId}: ${err}`);
    }
  }
}
