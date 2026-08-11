import type { SwarmExecutorAdapter, ExecutionClaim, ExecutorCapacity, StartObservation, CancelObservation, ExecutionObservation, CancelReason } from "./swarm-executor-types.js";

/** @deprecated Generic remote execution is replaced by the ContributionStore + peer_ask_help + help.event.v1 lifecycle (#1493). */
export class RemoteWorkerAdapter implements SwarmExecutorAdapter {
  readonly kind = "remote" as const;
  readonly schedulingPolicy = { recovery: "inspectable" as const };
  async capacity(): Promise<ExecutorCapacity> { return { available: 0, max: 0 }; }
  async start(_claim: ExecutionClaim): Promise<StartObservation> { return { kind: "start_failed", reason: "RemoteWorkerAdapter retired (#1493)", retryable: false }; }
  async cancel(_claim: ExecutionClaim, _reason: CancelReason): Promise<CancelObservation> { return { kind: "not_found" }; }
  async inspect(_claim: ExecutionClaim): Promise<ExecutionObservation> { return { kind: "unknown", message: "RemoteWorkerAdapter retired (#1493)" }; }
}
