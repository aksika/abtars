import type { AttemptLifecycle, ExecutorKind } from "./worker-supervision-store.js";

export type { ExecutorKind };

export interface ExecutionClaim {
  attemptId: string;
  cardId: number;
  contractId: string;
  executorKind: ExecutorKind;
  executorId: string;
  generation: number;
  claimedAt: string;
  hardDeadlineAt?: string;
}

export interface ExecutorCapacity {
  available: number;
  max: number;
}

export type StartObservation =
  | { kind: "started"; attemptId: string; generation: number; executorId: string }
  | { kind: "already_started"; attemptId: string; generation: number; executorId: string }
  | { kind: "start_failed"; reason: string; retryable: boolean };

export type CancelReason = "operator" | "deadline" | "project_abort" | "shutdown" | "superseded";

export type CancelObservation =
  | { kind: "cancelled"; attemptId: string }
  | { kind: "already_terminal"; lifecycle: AttemptLifecycle }
  | { kind: "not_found" }
  | { kind: "cancel_failed"; reason: string };

export type ExecutionObservation =
  | { kind: "running"; lifecycle: AttemptLifecycle }
  | { kind: "terminal"; lifecycle: AttemptLifecycle }
  | { kind: "unknown"; message: string };

export interface SwarmExecutorAdapter {
  readonly kind: ExecutorKind;
  capacity(): Promise<ExecutorCapacity>;
  start(claim: ExecutionClaim): Promise<StartObservation>;
  cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation>;
  inspect(claim: ExecutionClaim): Promise<ExecutionObservation>;
}
