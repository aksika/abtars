import { logWarn } from "./logger.js";
import { PiExecutor } from "./pi-executor/pi-executor.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "pi-adapter";

export class PiExecutorAdapter implements SwarmExecutorAdapter {
  readonly kind = "pi" as const;
  readonly schedulingPolicy = { recovery: "inspectable" as const };
  private executor: PiExecutor;
  private progressEmitter?: ExecutorProgressEmitter;
  private readonly leaseUnsubscribers = new Map<string, () => void>();

  constructor(executor: PiExecutor, progressEmitter?: ExecutorProgressEmitter) {
    this.executor = executor;
    this.progressEmitter = progressEmitter;
  }

  private _emitter(): ExecutorProgressEmitter {
    if (!this.progressEmitter) {
      this.progressEmitter = new ExecutorProgressEmitter();
    }
    return this.progressEmitter;
  }

  capacitySnapshot(): ExecutorCapacity {
    return {
      available: Math.max(0, this.executor.maxConcurrent - this.executor.activeCount),
      max: this.executor.maxConcurrent,
    };
  }

  async capacity(): Promise<ExecutorCapacity> {
    return this.capacitySnapshot();
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    try {
      this.leaseUnsubscribers.get(claim.attemptId)?.();
      this.leaseUnsubscribers.set(claim.attemptId, this.wireLeaseProgress(claim.attemptId, claim.generation, claim.executorId));
      this._emitter().emitAlive(claim.attemptId, claim.generation, claim.executorId, "pi");
    } catch { /* best-effort */ }

    try {
      const run = this.executor.piStore.get(claim.attemptId) as { currentSessionId?: string } | undefined;
      const sessionId = run?.currentSessionId ?? `${Date.now()}_C_pi_${claim.attemptId}`;
      const result = await this.executor.startWithClaim(claim.attemptId, claim.generation, sessionId);
      switch (result) {
        case "started":
          return { kind: "started", attemptId: claim.attemptId, generation: claim.generation, executorId: claim.executorId };
        default:
          return { kind: "start_failed", reason: String(result), retryable: false };
      }
    } catch (err) {
      logWarn(TAG, `start failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "start_failed", reason: "exception", retryable: true };
    }
  }

  async cancel(claim: ExecutionClaim, _reason: CancelReason): Promise<CancelObservation> {
    try {
      await this.executor.cancel(claim.attemptId);
      this.leaseUnsubscribers.get(claim.attemptId)?.();
      this.leaseUnsubscribers.delete(claim.attemptId);
      return { kind: "cancelled", attemptId: claim.attemptId };
    } catch (err) {
      logWarn(TAG, `cancel failed for ${claim.attemptId}: ${err instanceof Error ? err.message : String(err)}`);
      return { kind: "cancel_failed", reason: String(err) };
    }
  }

  async inspect(claim: ExecutionClaim): Promise<ExecutionObservation> {
    const run = this.executor.piStore.get(claim.attemptId);
    if (!run) return { kind: "unknown", message: "run not found" };
    switch (run.status) {
      case "starting":
      case "running":
      case "awaiting_input":
        return { kind: "running", lifecycle: "running" };
      case "completed":
        return { kind: "terminal", lifecycle: "completed" };
      case "failed":
        return { kind: "terminal", lifecycle: "failed" };
      case "cancelled":
        return { kind: "terminal", lifecycle: "cancelled" };
      default:
        return { kind: "unknown", message: `status=${run.status}` };
    }
  }

  /** Wire local Pi progress into the lease progress store. */
  wireLeaseProgress(attemptId: string, claimGeneration: number, executorId: string): () => void {
    const unsubTransition = this.executor.onTransition((runId, _fromStatus, toStatus) => {
      if (runId !== attemptId) return;
      const emitter = this._emitter();
      const run = this.executor.piStore.get(runId);
      switch (toStatus) {
        case "running":
          if (_fromStatus === "awaiting_input" && run?.lastUiReplyRequestId) {
            emitter.emitInputResolved(attemptId, claimGeneration, executorId, run.lastUiReplyRequestId, "pi");
          }
          emitter.emitAlive(attemptId, claimGeneration, executorId, "pi");
          break;
        case "awaiting_input":
          if (run?.pendingRequestId) {
            emitter.emitInputStart(attemptId, claimGeneration, executorId, run.pendingRequestId, undefined, "pi");
          }
          break;
        case "starting":
          break;
        default:
          if (["completed", "failed", "cancelled", "interrupted"].includes(toStatus)) {
            const unsubscribe = this.leaseUnsubscribers.get(attemptId);
            if (unsubscribe) {
              unsubscribe();
              this.leaseUnsubscribers.delete(attemptId);
            }
          }
          break;
      }
    });

    const unsubProgress = this.executor.onProgress((runId, payload, progressType) => {
      if (runId !== attemptId) return;
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const name = typeof parsed["name"] === "string" ? parsed["name"] : "tool";
      if (progressType === "tool_execution_start") {
        this._emitter().emitToolStart(attemptId, claimGeneration, executorId, `pi-tool:${runId}:${name}`, name, undefined, "pi");
      } else if (progressType === "tool_execution_end") {
        this._emitter().emitToolEnd(attemptId, claimGeneration, executorId, `pi-tool:${runId}:${name}`, `pi-tool-end:${runId}:${name}:${Date.now()}`, "pi");
      } else if (progressType === "agent_start") {
        this._emitter().emitAlive(attemptId, claimGeneration, executorId, "pi");
      }
    });

    return () => { unsubTransition(); unsubProgress(); };
  }
}
