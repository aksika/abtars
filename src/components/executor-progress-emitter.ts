import { ExecutorLeaseStore } from "./executor-lease-store.js";
import type { ExecutorProgressEventV1, ProgressKind, ProgressPhase } from "./executor-progress.js";
import { validateProgressEvent } from "./executor-progress.js";

interface EmitOptions {
  attemptId: string;
  claimGeneration: number;
  executorKind: "agent" | "pi" | "remote";
  executorId: string;
  kind: ProgressKind;
  phase?: ProgressPhase;
  operationId?: string;
  operationLabel?: string;
  expectedTimeoutMs?: number;
  outputUnits?: number;
  milestoneId?: string;
  inputRequestId?: string;
  summary?: string;
}

export class ExecutorProgressEmitter {
  private leaseStore = new ExecutorLeaseStore();
  private sequenceCache = new Map<string, number>();

  private nextSequence(attemptId: string): number {
    const current = this.sequenceCache.get(attemptId) ?? 0;
    const next = current + 1;
    this.sequenceCache.set(attemptId, next);
    return next;
  }

  emit(opts: EmitOptions): void {
    const sequence = this.nextSequence(opts.attemptId);
    const event: ExecutorProgressEventV1 = {
      schema_version: 1,
      attempt_id: opts.attemptId,
      claim_generation: opts.claimGeneration,
      executor: { kind: opts.executorKind, id: opts.executorId },
      sequence,
      kind: opts.kind,
      phase: opts.phase,
      producer_at: new Date().toISOString(),
      payload: {
        operation_id: opts.operationId,
        operation_label: opts.operationLabel,
        expected_timeout_ms: opts.expectedTimeoutMs,
        output_units: opts.outputUnits,
        milestone_id: opts.milestoneId,
        input_request_id: opts.inputRequestId,
        summary: opts.summary,
      },
    };

    const validation = validateProgressEvent(event);
    if (!validation.ok) return;

    const receivedAt = new Date().toISOString();
    this.leaseStore.ingestEvent(event, receivedAt);
  }

  emitAlive(attemptId: string, claimGeneration: number, executorId: string): void {
    this.emit({ attemptId, claimGeneration, executorKind: "agent", executorId, kind: "alive" });
  }

  emitOutput(attemptId: string, claimGeneration: number, executorId: string, outputUnits: number): void {
    this.emit({ attemptId, claimGeneration, executorKind: "agent", executorId, kind: "producing_output", outputUnits });
  }

  emitToolStart(attemptId: string, claimGeneration: number, executorId: string, operationId: string, operationLabel: string, expectedTimeoutMs?: number): void {
    this.emit({ attemptId, claimGeneration, executorKind: "agent", executorId, kind: "using_tool", phase: "start", operationId, operationLabel, expectedTimeoutMs });
  }

  emitToolEnd(attemptId: string, claimGeneration: number, executorId: string, operationId: string): void {
    this.emit({ attemptId, claimGeneration, executorKind: "agent", executorId, kind: "using_tool", phase: "end", operationId });
  }

  emitMilestone(attemptId: string, claimGeneration: number, executorId: string, milestoneId: string, summary?: string): void {
    this.emit({ attemptId, claimGeneration, executorKind: "agent", executorId, kind: "durable_milestone", milestoneId, summary });
  }
}
