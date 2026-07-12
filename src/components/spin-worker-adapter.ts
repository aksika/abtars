import { logInfo } from "./logger.js";
import { spin } from "./spin.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "spin-worker-adapter";

interface WorkerExecutionHandle {
  attemptId: string;
  generation: number;
  cardId: number;
  abort?: AbortController;
}

const _executions = new Map<string, WorkerExecutionHandle>();

export function getExecutionHandle(attemptId: string): WorkerExecutionHandle | undefined {
  return _executions.get(attemptId);
}

export class SpinWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "agent" as const;

  async capacity(): Promise<ExecutorCapacity> {
    return { available: 3, max: 3 };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    const existing = _executions.get(claim.attemptId);
    if (existing) {
      if (existing.generation === claim.generation) {
        return { kind: "already_started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
      }
      return { kind: "start_failed", reason: "stale generation", retryable: false };
    }

    const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
    if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };

    const abort = new AbortController();
    const handle: WorkerExecutionHandle = {
      attemptId: claim.attemptId,
      generation: claim.generation,
      cardId: claim.cardId,
      abort,
    };
    _executions.set(claim.attemptId, handle);

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
      });
    } catch (err) {
      _executions.delete(claim.attemptId);
      return { kind: "start_failed", reason: String(err), retryable: true };
    }

    return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
  }

  async cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation> {
    const existing = _executions.get(claim.attemptId);
    if (!existing) return { kind: "not_found" };

    if (existing.generation !== claim.generation) {
      return { kind: "already_terminal", lifecycle: "failed" };
    }

    existing.abort?.abort();
    logInfo(TAG, `Cancelled Worker ${claim.cardId} attempt=${claim.attemptId} reason=${reason}`);

    const store = new WorkerSupervisionStore();
    store.requestCancel(claim.attemptId, reason);
    _executions.delete(claim.attemptId);

    return { kind: "cancelled", attemptId: claim.attemptId };
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    const existing = _executions.get(claim.attemptId);
    if (!existing) {
      const store = new WorkerSupervisionStore();
      const attempt = store.getAttempt(claim.attemptId);
      if (!attempt) return { kind: "unknown", message: "attempt not found" };
      if (store.isAttemptTerminal(attempt.lifecycle)) {
        return { kind: "terminal", lifecycle: attempt.lifecycle };
      }
      return { kind: "unknown", message: "no handle but lifecycle=" + attempt.lifecycle };
    }
    return { kind: "running", lifecycle: "running" };
  }
}
