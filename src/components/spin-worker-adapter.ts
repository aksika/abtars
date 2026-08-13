import { logInfo } from "./logger.js";
import { spin } from "./spin.js";
import { WorkerSupervisionService } from "./worker-supervision-service.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { ExecutionSupervisor } from "./execution-control.js";
import { logSwarmTrace } from "./swarm-trace.js";
import { ProjectReviewStore } from "./project-acceptance/project-review-store.js";
import type { ToolExecutionScope } from "./tasks/task-package.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "spin-worker-adapter";

export class SpinWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "agent" as const;
  readonly schedulingPolicy = { recovery: "process_bound" as const, defaultMaxDurationMs: 1_800_000 };
  private progressEmitter?: ExecutorProgressEmitter;
  private readonly executions: ExecutionSupervisor;

  constructor(progressEmitter?: ExecutorProgressEmitter, executions?: ExecutionSupervisor) {
    this.progressEmitter = progressEmitter;
    // #1540: the single shared supervisor — the facade's own instance. Never
    // a second control registry.
    this.executions = executions ?? spin.executionSupervisor;
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

    const ctrl = this.executions.open({
      executionRef: `${claim.attemptId}:${claim.generation}`,
      attemptId: claim.attemptId,
      generation: claim.generation,
      cardId: claim.cardId,
      type: "W",
    });

    const sup = new WorkerSupervisionService();
    const contract = sup.getContract(claim.contractId);
    if (!contract) return { kind: "start_failed", reason: "attempt contract not found", retryable: false };

    // #1656: resolve the root project scope and thread it into the Worker
    // dispatch. A scheduled root missing its durable binding fails closed
    // before any model turn begins; non-scheduled roots keep their existing
    // explicitly supplied/session workspace behavior.
    const supStore = new WorkerSupervisionStore();
    const attempt = supStore.getAttempt(claim.attemptId);
    const rootCardId = attempt?.root_project_card_id ?? card.parent_id;
    let executionScope: ToolExecutionScope | undefined;
    if (rootCardId !== undefined && rootCardId !== null) {
      const rootCard = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(rootCardId));
      const isScheduledRoot = rootCard?.source === "task" && rootCard.source_id != null && rootCard.source_id.length > 0;
      const scope = new ProjectReviewStore().getWorkspaceScope(rootCardId);
      if (isScheduledRoot && !scope) return { kind: "start_failed", reason: "scheduled project workspace not bound", retryable: false };
      executionScope = scope;
    }

    logInfo(TAG, `Starting Worker ${claim.cardId} attempt=${claim.attemptId} gen=${claim.generation}`);
    logSwarmTrace({ event: "adapter_start", card: claim.cardId, attempt: claim.attemptId, generation: claim.generation, executor: claim.executorId });

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
        deadlineAt: claim.hardDeadlineAt ? new Date(claim.hardDeadlineAt).getTime() : undefined,
        executionScope,
      });
    } catch (err) {
      this.executions.remove(`${claim.attemptId}:${claim.generation}`);
      return { kind: "start_failed", reason: String(err), retryable: true };
    }

    return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
  }

  async cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation> {
    const ctrl = this.executions.get(`${claim.attemptId}:${claim.generation}`);
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
    const ctrl = this.executions.get(`${claim.attemptId}:${claim.generation}`);
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
