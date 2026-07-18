import { createHash } from "node:crypto";

export type ProgressKind =
  | "alive"
  | "producing_output"
  | "using_tool"
  | "durable_milestone"
  | "awaiting_input"
  | "stalled";

export type ProgressPhase = "start" | "advance" | "end" | "resolved";

export type ExecutorKind = "agent" | "pi" | "remote";

export const SUPPORTED_SCHEMA_VERSION = 1;

export const MAX_EVENT_JSON_BYTES = 10_000;
export const MAX_PAYLOAD_SUMMARY_LENGTH = 500;
export const MAX_OPERATION_LABEL_LENGTH = 200;
export const MAX_STALL_REASON_LENGTH = 500;
export const MAX_LEASES_PER_ATTEMPT = 100;

/**
 * #1439: Shared candidate-staleness threshold for a "running" Kanban card.
 * This is the shortest `meaningfulProgressMs` across the lease policies
 * below (DEFAULT_LOCAL_POLICY) — the point at which the lease-based
 * reconciler (reconciler.ts → evaluateLease) would first consider a
 * supervised card's progress questionable. Doctor's read-only Kanban probe
 * uses this same constant as its candidate-age threshold instead of a
 * separate hardcoded value, so there is exactly one definition of "old
 * running work" shared between the actual lifecycle owner and doctor's
 * health probe.
 */
export const KANBAN_STALE_CANDIDATE_MS = 300_000;

export interface ExecutorProgressEventV1 {
  readonly schema_version: 1;
  readonly attempt_id: string;
  readonly claim_generation: number;
  readonly executor: {
    readonly kind: ExecutorKind;
    readonly id: string;
  };
  readonly sequence: number;
  readonly kind: ProgressKind;
  readonly phase?: ProgressPhase;
  readonly producer_at: string;
  readonly payload: {
    readonly operation_id?: string;
    readonly operation_label?: string;
    readonly expected_timeout_ms?: number;
    readonly output_units?: number;
    readonly milestone_id?: string;
    readonly input_request_id?: string;
    readonly summary?: string;
  };
}

export interface AttemptLeaseEvent {
  sequence: number;
  kind: ProgressKind;
  phase?: string;
  fingerprint?: string;
  receivedAt: string;
}

export interface AttemptLeaseSnapshot {
  attemptId: string;
  claimGeneration: number;
  executorKind: ExecutorKind;
  executorId: string;
  highWaterSequence: number;
  semanticState: ProgressKind;
  stateFingerprint?: string;
  lastReceivedAt: string;
  lastLivenessAt: string;
  lastMeaningfulProgressAt: string;
  livenessDeadlineAt: string;
  progressDeadlineAt: string;
  operation?: {
    id: string;
    label: string;
    startedAt: string;
    silenceDeadlineAt: string;
  };
  awaitingInput?: {
    requestId: string;
    since: string;
    deadlineAt: string;
  };
  evaluation: "healthy" | "warning" | "inspect_due" | "cancel_requested";
  updatedAt: string;
}

export type ValidationIssue = {
  severity: "error" | "warn";
  tag: string;
  path: string;
  message: string;
};

export type ProgressValidationResult =
  | { ok: true; event: ExecutorProgressEventV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

function issue(severity: "error" | "warn", tag: string, path: string, message: string): ValidationIssue {
  return { severity, tag, path, message };
}
function error(tag: string, path: string, message: string): ValidationIssue {
  return issue("error", tag, path, message);
}

export function validateProgressEvent(raw: unknown): ProgressValidationResult {
  const errors: ValidationIssue[] = [];

  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: [error("type_error", "$", "event must be an object")] };
  }

  const obj = raw as Record<string, unknown>;

  if (obj["schema_version"] !== 1) {
    errors.push(error("unknown_version", "$.schema_version", `unsupported version: ${String(obj["schema_version"])}`));
    return { ok: false, errors };
  }

  if (typeof obj["attempt_id"] !== "string" || !obj["attempt_id"]) {
    errors.push(error("missing_field", "$.attempt_id", "attempt_id is required"));
  }

  if (typeof obj["claim_generation"] !== "number" || obj["claim_generation"]! < 1) {
    errors.push(error("type_error", "$.claim_generation", "claim_generation must be a positive number"));
  }

  const exec = obj["executor"];
  if (typeof exec !== "object" || exec === null) {
    errors.push(error("missing_field", "$.executor", "executor is required"));
  } else {
    const e = exec as Record<string, unknown>;
    const ek = e["kind"];
    if (ek !== "agent" && ek !== "pi" && ek !== "remote") {
      errors.push(error("type_error", "$.executor.kind", 'must be "agent", "pi", or "remote"'));
    }
    if (typeof e["id"] !== "string" || !e["id"]) {
      errors.push(error("missing_field", "$.executor.id", "executor id is required"));
    }
  }

  if (typeof obj["sequence"] !== "number" || obj["sequence"]! < 1) {
    errors.push(error("type_error", "$.sequence", "sequence must be a positive number"));
  }

  const validKinds: ProgressKind[] = ["alive", "producing_output", "using_tool", "durable_milestone", "awaiting_input", "stalled"];
  if (!validKinds.includes(obj["kind"] as ProgressKind)) {
    errors.push(error("type_error", "$.kind", `invalid kind: ${String(obj["kind"])}`));
  }

  const validPhases: ProgressPhase[] = ["start", "advance", "end", "resolved"];
  if (obj["phase"] !== undefined && !validPhases.includes(obj["phase"] as ProgressPhase)) {
    errors.push(error("type_error", "$.phase", `invalid phase: ${String(obj["phase"])}`));
  }

  if (typeof obj["producer_at"] !== "string" || !obj["producer_at"]) {
    errors.push(error("missing_field", "$.producer_at", "producer_at is required"));
  }

  if (typeof obj["payload"] !== "object" || obj["payload"] === null) {
    errors.push(error("missing_field", "$.payload", "payload is required"));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (Buffer.byteLength(JSON.stringify(obj), "utf-8") > MAX_EVENT_JSON_BYTES) {
    errors.push(error("too_long", "$", `event exceeds ${MAX_EVENT_JSON_BYTES} bytes`));
    return { ok: false, errors };
  }

  return { ok: true, event: obj as unknown as ExecutorProgressEventV1 };
}

export function computeSequenceFingerprint(event: ExecutorProgressEventV1): string {
  const payload = event.payload;
  const parts: string[] = [event.kind, event.phase ?? ""];
  if (payload.operation_id) parts.push(payload.operation_id);
  if (payload.milestone_id) parts.push(payload.milestone_id);
  if (payload.input_request_id) parts.push(payload.input_request_id);
  if (payload.output_units !== undefined) parts.push(String(payload.output_units));
  if (payload.summary) parts.push(payload.summary.slice(0, 100));
  return createHash("sha256").update(parts.join("|"), "utf-8").digest("hex").slice(0, 16);
}

export interface LeasePolicy {
  livenessMs: number;
  meaningfulProgressMs: number;
  warningBeforeMs: number;
  inspectGraceMs: number;
  maxUnknownInspections: number;
  maxToolSilenceMs: number;
  awaitingInputMs: number;
  outputOnlyProgressCapMs: number;
}

export const DEFAULT_LOCAL_POLICY: LeasePolicy = {
  livenessMs: 120_000,
  meaningfulProgressMs: 300_000,
  warningBeforeMs: 30_000,
  inspectGraceMs: 30_000,
  maxUnknownInspections: 3,
  maxToolSilenceMs: 600_000,
  awaitingInputMs: 600_000,
  outputOnlyProgressCapMs: 120_000,
};

export const DEFAULT_REMOTE_POLICY: LeasePolicy = {
  livenessMs: 300_000,
  meaningfulProgressMs: 600_000,
  warningBeforeMs: 60_000,
  inspectGraceMs: 60_000,
  maxUnknownInspections: 3,
  maxToolSilenceMs: 900_000,
  awaitingInputMs: 900_000,
  outputOnlyProgressCapMs: 300_000,
};

export const DEFAULT_PI_POLICY: LeasePolicy = {
  livenessMs: 180_000,
  meaningfulProgressMs: 600_000,
  warningBeforeMs: 60_000,
  inspectGraceMs: 60_000,
  maxUnknownInspections: 3,
  maxToolSilenceMs: 900_000,
  awaitingInputMs: 1_800_000,
  outputOnlyProgressCapMs: 300_000,
};

export function isMeaningfulProgress(kind: ProgressKind, phase?: string): boolean {
  switch (kind) {
    case "durable_milestone":
      return true;
    case "using_tool":
      return phase === "end" || phase === "advance";
    case "producing_output":
      return true;
    case "awaiting_input":
      return phase === "resolved";
    default:
      return false;
  }
}

export function computeDeadlines(
  now: number,
  policy: LeasePolicy,
  snapshot?: Partial<AttemptLeaseSnapshot>,
  hardDeadlineMs?: number,
): { livenessDeadlineAt: string; progressDeadlineAt: string } {
  const lastLivenessAt = snapshot?.lastLivenessAt ? new Date(snapshot.lastLivenessAt).getTime() : now;
  const lastProgressAt = snapshot?.lastMeaningfulProgressAt ? new Date(snapshot.lastMeaningfulProgressAt).getTime() : now;

  let livenessDeadline = lastLivenessAt + policy.livenessMs;
  let progressDeadline = lastProgressAt + policy.meaningfulProgressMs;

  if (hardDeadlineMs) {
    const hardAt = now + hardDeadlineMs;
    if (hardAt < livenessDeadline) livenessDeadline = hardAt;
    if (hardAt < progressDeadline) progressDeadline = hardAt;
  }

  return {
    livenessDeadlineAt: new Date(livenessDeadline).toISOString(),
    progressDeadlineAt: new Date(progressDeadline).toISOString(),
  };
}
