import { logInfo, logWarn } from "./logger.js";
import { getPeerTransport } from "./peer-transport/index.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "remote-adapter";

export class RemoteWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "remote" as const;

  async capacity(): Promise<ExecutorCapacity> {
    return { available: 10, max: 10 };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    try {
      const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
      if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };

      const notes = card.notes ? JSON.parse(card.notes) : {};
      const peer = notes.peer as string | undefined;
      if (!peer) return { kind: "start_failed", reason: "no peer in card notes", retryable: false };

      const transport = getPeerTransport();
      const result = await transport.delegateTask(peer, card.title || card.notes || "", {
        priority: card.priority,
        contract: undefined,
        attemptId: claim.attemptId,
      });

      logInfo(TAG, `Delegated ${claim.cardId} to ${peer}: remote#${result.taskId}`);
      return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
    } catch (err) {
      logWarn(TAG, `remote start failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "start_failed", reason: String(err), retryable: true };
    }
  }

  async cancel(claim: ExecutionClaim, _reason: CancelReason): Promise<CancelObservation> {
    try {
      const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
      if (!card) return { kind: "not_found" };

      const notes = card.notes ? JSON.parse(card.notes) : {};
      const peer = notes.peer as string | undefined;
      const remoteTaskId = notes.remote_task_id as number | undefined;
      if (!peer || !remoteTaskId) return { kind: "not_found" };

      const transport = getPeerTransport();
      await transport.terminateTask(peer, remoteTaskId);

      const store = new WorkerSupervisionStore();
      store.requestCancel(claim.attemptId, "operator");

      logInfo(TAG, `Cancelled remote ${claim.cardId} peer=${peer} remote#${remoteTaskId}`);
      return { kind: "cancelled", attemptId: claim.attemptId };
    } catch (err) {
      logWarn(TAG, `remote cancel failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "cancel_failed", reason: String(err) };
    }
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    try {
      const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
      if (!card) return { kind: "unknown", message: "card not found" };

      const notes = card.notes ? JSON.parse(card.notes) : {};
      const peer = notes.peer as string | undefined;
      const remoteTaskId = notes.remote_task_id as number | undefined;
      if (!peer || !remoteTaskId) return { kind: "unknown", message: "no remote correlation" };

      const transport = getPeerTransport();
      const result = await transport.checkTask(peer, remoteTaskId);

      switch (result.status) {
        case "running":
          return { kind: "running", lifecycle: "running" };
        case "done":
          return { kind: "terminal", lifecycle: "completed" };
        case "failed":
          return { kind: "terminal", lifecycle: "failed" };
        default:
          return { kind: "unknown", message: `status=${result.status}` };
      }
    } catch (err) {
      return { kind: "unknown", message: `inspect error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
