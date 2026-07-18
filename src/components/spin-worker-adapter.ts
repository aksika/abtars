import { logInfo } from "./logger.js";
import { spin } from "./spin.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import { registerControl, removeControlByAttempt, getControl } from "./execution-control.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "spin-worker-adapter";

export class SpinWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "agent" as const;

  async capacity(): Promise<ExecutorCapacity> {
    return { available: 3, max: 3 };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
    if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };

    // Register generation-bound control before async dispatch
    const ctrl = registerControl(claim.attemptId, claim.generation, claim.cardId);

    const sup = new WorkerSupervisionService();
    const contract = sup.getContractForCard(claim.cardId);

    logInfo(TAG, `Starting Worker ${claim.cardId} attempt=${claim.attemptId} gen=${claim.generation}`);

    // #1367: Emit alive progress on start
    try {
      const emitter = new ExecutorProgressEmitter();
      emitter.emitAlive(claim.attemptId, claim.generation, claim.executorId);
    } catch { /* best-effort */ }

    try {
      spin.dispatch({
        type: "W",
        goal: card.title || card.notes || "",
        source: "agent",
        cardId: claim.cardId,
        parentCardId: card.parent_id ?? undefined,
        contract: contract ?? undefined,
        attemptId: claim.attemptId,
        executionControl: ctrl,
      });
    } catch (err) {
      removeControlByAttempt(claim.attemptId);
      return { kind: "start_failed", reason: String(err), retryable: true };
    }

    return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
  }

  async cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation> {
    const ctrl = getControl(claim.attemptId, claim.generation);
    if (!ctrl) {
      // Check durable state — may already be terminal
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

    // Persist cancel intent first, then invoke runtime
    const store = new WorkerSupervisionStore();
    store.requestCancel(claim.attemptId, reason);

    const result = await ctrl.requestCancel(reason);
    logInfo(TAG, `Cancelled Worker ${claim.cardId} attempt=${claim.attemptId} reason=${reason} result=${result}`);

    if (result === "already_terminal") {
      return { kind: "already_terminal", lifecycle: "cancelled" };
    }

    // Keep control until terminal settlement — do not delete here
    return { kind: "cancelled", attemptId: claim.attemptId };
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    const ctrl = getControl(claim.attemptId, claim.generation);
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
}
