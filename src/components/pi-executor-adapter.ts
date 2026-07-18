import { logWarn } from "./logger.js";
import { PiExecutor } from "./pi-executor/pi-executor.js";
import { ExecutorProgressEmitter } from "./executor-progress-emitter.js";
import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

const TAG = "pi-adapter";

export class PiExecutorAdapter implements SwarmExecutorAdapter {
  readonly kind = "pi" as const;
  private executor: PiExecutor;

  constructor(executor: PiExecutor) {
    this.executor = executor;
  }

  async capacity(): Promise<ExecutorCapacity> {
    return {
      available: this.executor.maxConcurrent - this.executor.activeCount,
      max: this.executor.maxConcurrent,
    };
  }

  async start(claim: ExecutionClaim): Promise<StartObservation> {
    try {
      const emitter = new ExecutorProgressEmitter();
      emitter.emitAlive(claim.attemptId, claim.generation, claim.executorId);
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
}
