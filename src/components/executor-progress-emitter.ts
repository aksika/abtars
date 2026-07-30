import { ExecutorLeaseStore } from "./executor-lease-store.js";
import type { ExecutorProgressFactV1, ProgressKind, ProgressPhase, LeaseExecutorKind } from "./executor-progress.js";
import { validateProgressEvent, DEFAULT_LOCAL_POLICY } from "./executor-progress.js";
import type { LeasePolicy } from "./executor-progress.js";

export type EmitResult =
  | { kind: "accepted" }
  | { kind: "idempotent" }
  | { kind: "rejected"; reason: string };

export interface EmitOptions {
  factId: string;
  attemptId: string;
  claimGeneration: number;
  executorKind: LeaseExecutorKind;
  executorId: string;
  kind: ProgressKind;
  phase?: ProgressPhase;
  operationId?: string;
  operationLabel?: string;
  expectedTimeoutMs?: number;
  progressUnits?: number;
  observationId?: string;
  milestoneId?: string;
  inputRequestId?: string;
  summary?: string;
}

export class ExecutorProgressEmitter {
  private leaseStore: ExecutorLeaseStore;
  private policy: LeasePolicy;

  constructor(leaseStore?: ExecutorLeaseStore, policy?: LeasePolicy) {
    this.leaseStore = leaseStore ?? new ExecutorLeaseStore();
    this.policy = policy ?? DEFAULT_LOCAL_POLICY;
  }

  emit(opts: EmitOptions): EmitResult {
    const fact: ExecutorProgressFactV1 = {
      schema_version: 1,
      fact_id: opts.factId,
      attempt_id: opts.attemptId,
      claim_generation: opts.claimGeneration,
      executor: { kind: opts.executorKind, id: opts.executorId },
      kind: opts.kind,
      phase: opts.phase,
      producer_at: new Date().toISOString(),
      payload: {
        operation_id: opts.operationId,
        operation_label: opts.operationLabel,
        expected_timeout_ms: opts.expectedTimeoutMs,
        progress_units: opts.progressUnits,
        observation_id: opts.observationId,
        milestone_id: opts.milestoneId,
        input_request_id: opts.inputRequestId,
        summary: opts.summary,
      },
    };

    const validation = validateProgressEvent(fact);
    if (!validation.ok) {
      return { kind: "rejected", reason: validation.errors.map(e => e.message).join("; ") };
    }

    const result = this.leaseStore.appendFact(validation.event, this.policy);
    switch (result.kind) {
      case "accepted": return { kind: "accepted" };
      case "idempotent": return { kind: "idempotent" };
      default: return { kind: "rejected", reason: result.reason };
    }
  }

  emitAlive(attemptId: string, claimGeneration: number, executorId: string, executorKind?: LeaseExecutorKind): EmitResult {
    return this.emit({
      factId: `alive:${attemptId}:${Date.now()}`,
      attemptId,
      claimGeneration,
      executorKind: executorKind ?? "agent",
      executorId,
      kind: "alive",
    });
  }

  emitOutput(attemptId: string, claimGeneration: number, executorId: string, progressUnits: number, observationId?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `output:${attemptId}:${observationId ?? progressUnits}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "producing_output",
      progressUnits,
      observationId,
    });
  }

  emitToolStart(attemptId: string, claimGeneration: number, executorId: string, operationId: string, operationLabel: string, expectedTimeoutMs?: number, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `tool:start:${attemptId}:${operationId}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "using_tool",
      phase: "start",
      operationId,
      operationLabel,
      expectedTimeoutMs,
    });
  }

  emitToolAdvance(attemptId: string, claimGeneration: number, executorId: string, operationId: string, progressUnits?: number, observationId?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `tool:adv:${attemptId}:${operationId}:${observationId ?? progressUnits ?? Date.now()}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "using_tool",
      phase: "advance",
      operationId,
      progressUnits,
      observationId,
    });
  }

  emitToolEnd(attemptId: string, claimGeneration: number, executorId: string, operationId: string, observationId?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `tool:end:${attemptId}:${operationId}:${observationId ?? Date.now()}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "using_tool",
      phase: "end",
      operationId,
      observationId,
    });
  }

  emitMilestone(attemptId: string, claimGeneration: number, executorId: string, milestoneId: string, summary?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `ms:${attemptId}:${milestoneId}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "durable_milestone",
      milestoneId,
      summary,
    });
  }

  emitInputStart(attemptId: string, claimGeneration: number, executorId: string, inputRequestId: string, summary?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `input:start:${attemptId}:${inputRequestId}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "awaiting_input",
      phase: "start",
      inputRequestId,
      summary,
    });
  }

  emitInputResolved(attemptId: string, claimGeneration: number, executorId: string, inputRequestId: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `input:end:${attemptId}:${inputRequestId}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "awaiting_input",
      phase: "resolved",
      inputRequestId,
    });
  }

  emitStalled(attemptId: string, claimGeneration: number, executorId: string, reason?: string, executorKind: LeaseExecutorKind = "agent"): EmitResult {
    return this.emit({
      factId: `stalled:${attemptId}:${Date.now()}`,
      attemptId,
      claimGeneration,
      executorKind,
      executorId,
      kind: "stalled",
      summary: reason,
    });
  }
}
