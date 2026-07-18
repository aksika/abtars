import { logInfo, logWarn } from "./logger.js";
import { getPeerTransport } from "./peer-transport/index.js";
import { WorkerSupervisionStore } from "./worker-supervision-store.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "remote-adapter";

export class RemoteWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "remote" as const;

  async capacity(): Promise<ExecutorCapacity> {
    return { available: 5, max: 5 };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    try {
      const emitter = new ExecutorProgressEmitter();
      emitter.emitAlive(claim.attemptId, claim.generation, claim.executorId);
    } catch { /* best-effort */ }
    try {
      const card = await import("./tasks/kanban-board.js").then(m => m.kanbanGetCard(claim.cardId));
      if (!card) return { kind: "start_failed", reason: "card not found", retryable: false };

      const notes = card.notes ? JSON.parse(card.notes) : {};
      const peer = notes.peer as string | undefined;
      if (!peer) return { kind: "start_failed", reason: "no peer in card notes", retryable: false };

      const transport = getPeerTransport();
      const request = {
        version: 1 as const,
        request_id: claim.attemptId,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        goal: card.title || card.goal || card.notes || "",
        required_capabilities: [] as string[],
      };
      const result = await transport.askHelp(peer, request);

      if (result.decision === "accepted") {
        logInfo(TAG, `Contribution ${claim.cardId} accepted by ${peer}: ref=${result.contribution_ref}`);
        import("./tasks/kanban-board.js").then(m => m.kanbanUpdate(claim.cardId, {
          notes: JSON.stringify({ ...notes, remote_contribution_ref: result.contribution_ref, outcome: "accepted" }),
        })).catch(() => {});
      }

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
      const contributionRef = notes.remote_contribution_ref as string | undefined;
      const requestId = notes.request_id as string | undefined;
      if (!peer || !contributionRef || !requestId) return { kind: "not_found" };

      const transport = getPeerTransport();
      await transport.withdrawHelp(peer, {
        version: 1,
        request_id: requestId,
        contribution_ref: contributionRef,
        reason: "cancelled_by_origin",
      });

      const store = new WorkerSupervisionStore();
      store.requestCancel(claim.attemptId, "operator");

      logInfo(TAG, `Withdrew help ${claim.cardId} from peer=${peer}`);
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
      const contributionRef = notes.remote_contribution_ref as string | undefined;
      const requestId = notes.request_id as string | undefined;
      if (!peer || !contributionRef || !requestId) return { kind: "unknown", message: "no remote correlation" };

      const transport = getPeerTransport();
      const result = await transport.getHelpStatus(peer, {
        version: 1,
        request_id: requestId,
        contribution_ref: contributionRef,
      });

      switch (result.state) {
        case "running":
        case "queued":
        case "awaiting_input":
          return { kind: "running", lifecycle: "running" };
        case "completed":
          return { kind: "terminal", lifecycle: "completed" };
        case "failed":
          return { kind: "terminal", lifecycle: "failed" };
        default:
          return { kind: "unknown", message: `state=${result.state}` };
      }
    } catch (err) {
      return { kind: "unknown", message: `inspect error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
