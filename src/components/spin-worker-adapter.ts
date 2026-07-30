import { logInfo } from "./logger.js";
import { spin } from "./spin.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import { registerControl, removeControl, getControl } from "./execution-control.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "spin-worker-adapter";

export class SpinWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "agent" as const;
  private progressEmitter?: ExecutorProgressEmitter;

  constructor(progressEmitter?: ExecutorProgressEmitter) {
    this.progressEmitter = progressEmitter;
  }

  private _emitter(): ExecutorProgressEmitter {
    if (!this.progressEmitter) {
      this.progressEmitter = new ExecutorProgressEmitter();
    }
    return this.progressEmitter;
  }

  capacitySnapshot(): ExecutorCapacity {
    const max = 3;
    const running = typeof spin.getRunningCount === "function" ? spin.getRunningCount("W") : 0;
    return { available: Math.max(0, max - running), max };
  }

  async capacity(): Promise<ExecutorCapacity> {
    return this.capacitySnapshot();
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
    if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };

    const ctrl = registerControl(`${claim.attemptId}:${claim.generation}`, { attemptId: claim.attemptId, generation: claim.generation, cardId: claim.cardId });

    const sup = new WorkerSupervisionService();
    const contract = sup.getContract(claim.contractId);
    if (!contract) return { kind: "start_failed", reason: "attempt contract not found", retryable: false };

    logInfo(TAG, `Starting Worker ${claim.cardId} attempt=${claim.attemptId} gen=${claim.generation}`);

    this._emitter().emitAlive(claim.attemptId, claim.generation, claim.executorId);

    try {
      spin.dispatch({
        type: "W",
        goal: contract.goal,
        source: "agent",
        cardId: claim.cardId,
        parentCardId: card.parent_id ?? undefined,
        contract,
        attemptId: claim.attemptId,
        executionControl: ctrl,
        settlementOwner: "spin",
      });
    } catch (err) {
      removeControl(`${claim.attemptId}:${claim.generation}`);
      return { kind: "start_failed", reason: String(err), retryable: true };
    }

    return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
  }

  async cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation> {
    const ctrl = getControl(`${claim.attemptId}:${claim.generation}`);
    if (!ctrl) {
      const store = new WorkerSupervisionStore();
      const attempt = store.getAttempt(claim.attemptId);
      if (!attempt) return { kind: "not_found" };
      if (store.isAttemptTerminal(attempt.lifecycle)) {
        return { kind: "already_terminal", lifecycle: attempt.lifecycle };
      }
      return { kind: "not_found" };
    }

    if (ctrl.generation !== claim.generation) {
      return { kind: "already_terminal", lifecycle: "failed" };
    }

    const store = new WorkerSupervisionStore();
    store.requestCancel(claim.attemptId, reason);

    const result = await ctrl.requestCancel(reason);
    logInfo(TAG, `Cancelled Worker ${claim.cardId} attempt=${claim.attemptId} reason=${reason} result=${result}`);

    if (result === "already_terminal") {
      const attempt = store.getAttempt(claim.attemptId);
      return { kind: "already_terminal", lifecycle: attempt?.lifecycle ?? "cancelled" };
    }

    ctrl.markTerminal("cancelled");
    store.cancelAttempt(claim.attemptId);

    return { kind: "cancelled", attemptId: claim.attemptId };
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    const ctrl = getControl(`${claim.attemptId}:${claim.generation}`);
    if (!ctrl) {
      const store = new WorkerSupervisionStore();
      const attempt = store.getAttempt(claim.attemptId);
      if (!attempt) return { kind: "unknown", message: "attempt not found" };
      if (store.isAttemptTerminal(attempt.lifecycle)) {
        return { kind: "terminal", lifecycle: attempt.lifecycle };
      }
      return { kind: "unknown", message: "no handle but lifecycle=" + attempt.lifecycle };
    }
    if (ctrl.terminal) {
      return { kind: "terminal", lifecycle: ctrl.terminalOutcome === "cancelled" ? "cancelled" : "completed" };
    }
    return { kind: "running", lifecycle: ctrl.cancelled ? "cancel_requested" : "running" };
  }

  /** Expose for Reconciler adapter resolution. */
  static forReconciler(): SpinWorkerAdapter {
    return new SpinWorkerAdapter();
  }
}
