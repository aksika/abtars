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
  // #1638: proven-no-start contention. The adapter proves no process was
  // started; the Reconciler returns the attempt to pending without settling.
  | { kind: "deferred"; reason: "capacity" | "resource_busy"; provesNoStart: true }
  | { kind: "start_failed"; reason: string; retryable: boolean };

export type CancelReason = "operator" | "deadline" | "project_abort" | "shutdown" | "superseded" | "session_end";

export type CancelObservation =
  | { kind: "cancelled"; attemptId: string }
  | { kind: "already_terminal"; lifecycle: AttemptLifecycle }
  | { kind: "not_found" }
  | { kind: "cancel_failed"; reason: string };

export type ExecutionObservation =
  | { kind: "running"; lifecycle: AttemptLifecycle }
  | { kind: "terminal"; lifecycle: AttemptLifecycle }
  | { kind: "unknown"; message: string };

/**
 * #1778: product-owned outcome envelope at the adapter/owner seam. An
 * observational handoff record, never a second state machine: adapters map
 * their rich private result into this shape once, and the durable owner of
 * the entity validates identity/generation and settles in its own
 * transaction. Pi/provider/process types must never appear here.
 *
 * Generation scopes are kept distinct on purpose: `attemptGeneration` fences
 * a worker attempt, `ownershipGeneration` fences a project run. They are
 * never compared numerically against each other — each is validated only
 * against the row of the entity that owns that scope.
 */
export type RuntimeObservation = "terminal" | "running" | "unknown";

export type ProductOutcome = "completed" | "failed" | "cancelled" | "timed_out";

/**
 * Physical-cleanup evidence, separate from the logical outcome. A caller may
 * observe its logical terminal result while cleanup is still `pending`; no
 * lease, workspace, or capacity may be released until `confirmed`.
 */
export type CleanupState = "not_required" | "pending" | "confirmed" | "failed" | "unknown";

export type OutcomeSource = "spin" | "worker" | "pi" | "scheduled" | "orc";

export interface ExecutionOutcomeEnvelope {
  source: OutcomeSource;
  /** Immutable execution identity captured at dispatch (e.g. attempt:generation). */
  executionRef: string;
  attemptId?: string;
  projectId?: number;
  /** Project-run ownership scope fence (orc-project-run-store generation). */
  ownershipGeneration?: number;
  /** Worker-attempt scope fence (worker_attempts generation). */
  attemptGeneration?: number;
  observation: RuntimeObservation;
  /** Required exactly when observation is terminal; forbidden otherwise. */
  outcome?: ProductOutcome;
  cleanup: CleanupState;
  /** Idempotency/correlation key: same identity + same outcome replays inert. */
  correlationKey: string;
  occurredAt: string;
  detail?: string;
  evidence?: Record<string, string | number | boolean>;
}

const ENVELOPE_DETAIL_MAX = 500;
const ENVELOPE_EVIDENCE_MAX_ENTRIES = 8;
const ENVELOPE_EVIDENCE_KEY_MAX = 64;
const ENVELOPE_EVIDENCE_STRING_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * #1778: validate and bound a handoff envelope. Fails closed: missing
 * identity, a terminal observation without an outcome, an outcome on a
 * non-terminal observation, or an unknown observation carrying a terminal
 * verdict are all rejected — an unknown observation must enter the existing
 * reconciliation or fail-closed path, never settle as success.
 */
export function makeExecutionOutcomeEnvelope(input: {
  source: OutcomeSource;
  executionRef: string;
  attemptId?: string;
  projectId?: number;
  ownershipGeneration?: number;
  attemptGeneration?: number;
  observation: RuntimeObservation;
  outcome?: ProductOutcome;
  cleanup: CleanupState;
  correlationKey: string;
  occurredAt?: string;
  detail?: string;
  evidence?: Record<string, unknown>;
}): { ok: true; envelope: ExecutionOutcomeEnvelope } | { ok: false; error: string } {
  if (!input.executionRef || input.executionRef.length === 0) {
    return { ok: false, error: "executionRef is required" };
  }
  if (!input.correlationKey || input.correlationKey.length === 0) {
    return { ok: false, error: "correlationKey is required" };
  }
  if (input.observation === "terminal" && input.outcome === undefined) {
    return { ok: false, error: "terminal observation requires an outcome" };
  }
  if (input.observation !== "terminal" && input.outcome !== undefined) {
    return { ok: false, error: "only a terminal observation may carry an outcome" };
  }
  for (const [name, value] of [["attemptGeneration", input.attemptGeneration], ["ownershipGeneration", input.ownershipGeneration]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      return { ok: false, error: `${name} must be a non-negative integer when present` };
    }
  }
  let evidence: Record<string, string | number | boolean> | undefined;
  if (input.evidence !== undefined) {
    if (!isRecord(input.evidence)) return { ok: false, error: "evidence must be a record" };
    const entries = Object.entries(input.evidence);
    if (entries.length > ENVELOPE_EVIDENCE_MAX_ENTRIES) {
      return { ok: false, error: `evidence is bounded to ${ENVELOPE_EVIDENCE_MAX_ENTRIES} entries` };
    }
    evidence = {};
    for (const [key, value] of entries) {
      if (key.length === 0 || key.length > ENVELOPE_EVIDENCE_KEY_MAX) {
        return { ok: false, error: "evidence keys must be non-empty and bounded" };
      }
      if (typeof value === "string") {
        evidence[key] = value.slice(0, ENVELOPE_EVIDENCE_STRING_MAX);
      } else if (typeof value === "boolean") {
        evidence[key] = value;
      } else if (typeof value === "number") {
        evidence[key] = Number.isFinite(value) ? value : 0;
      } else {
        return { ok: false, error: `evidence[${key}] must be a string, number, or boolean` };
      }
    }
  }
  const envelope: ExecutionOutcomeEnvelope = {
    source: input.source,
    executionRef: input.executionRef,
    ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.ownershipGeneration !== undefined ? { ownershipGeneration: input.ownershipGeneration } : {}),
    ...(input.attemptGeneration !== undefined ? { attemptGeneration: input.attemptGeneration } : {}),
    observation: input.observation,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    cleanup: input.cleanup,
    correlationKey: input.correlationKey,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    ...(input.detail !== undefined ? { detail: input.detail.slice(0, ENVELOPE_DETAIL_MAX) } : {}),
    ...(evidence !== undefined ? { evidence } : {}),
  };
  return { ok: true, envelope };
}

export interface ExecutorSchedulingPolicy {
  recovery: "process_bound" | "inspectable";
  defaultMaxDurationMs?: number;
}

export interface SwarmExecutorAdapter {
  readonly kind: ExecutorKind;
  readonly schedulingPolicy: ExecutorSchedulingPolicy;
  /** Optional synchronous snapshot used by durable retry selection. */
  capacitySnapshot?(): ExecutorCapacity;
  capacity(): Promise<ExecutorCapacity>;
  start(claim: ExecutionClaim): Promise<StartObservation>;
  cancel(claim: ExecutionClaim, reason: CancelReason): Promise<CancelObservation>;
  inspect(claim: ExecutionClaim): Promise<ExecutionObservation>;
}
