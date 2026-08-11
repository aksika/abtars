import { createHash } from "node:crypto";

export type ProgressKind =
  | "alive"
  | "producing_output"
  | "using_tool"
  | "durable_milestone"
  | "awaiting_input"
  | "stalled";

export type ProgressPhase = "start" | "advance" | "end" | "resolved";

export type LeaseExecutorKind = "agent" | "pi";

export const SUPPORTED_SCHEMA_VERSION = 1;

export const MAX_EVENT_JSON_BYTES = 10_000;
export const MAX_PAYLOAD_SUMMARY_LENGTH = 500;
export const MAX_OPERATION_LABEL_LENGTH = 200;
export const MAX_MILESTONE_ID_LENGTH = 200;
export const MAX_INPUT_REQUEST_ID_LENGTH = 200;
export const MAX_OBSERVATION_ID_LENGTH = 200;
export const MAX_OPERATION_ID_LENGTH = 200;
export const MAX_LEASES_PER_ATTEMPT = 100;
export const MAX_EVENTS_PER_ATTEMPT = 500;

export const KANBAN_STALE_CANDIDATE_MS = 300_000;

export interface ExecutorProgressFactV1 {
  readonly schema_version: 1;
  readonly fact_id: string;
  readonly attempt_id: string;
  readonly claim_generation: number;
  readonly executor: {
    readonly kind: LeaseExecutorKind;
    readonly id: string;
  };
  readonly kind: ProgressKind;
  readonly phase?: ProgressPhase;
  readonly producer_at?: string;
  readonly payload: {
    readonly operation_id?: string;
    readonly operation_label?: string;
    readonly expected_timeout_ms?: number;
    readonly progress_units?: number;
    readonly observation_id?: string;
    readonly milestone_id?: string;
    readonly input_request_id?: string;
    readonly summary?: string;
  };
}

export interface PersistedProgressEventV1 extends ExecutorProgressFactV1 {
  sequence: number;
  received_at: string;
  semantic_fingerprint: string;
  lease_effect: "none" | "liveness" | "meaningful" | "state";
}

export type LeaseReason =
  | "liveness_expired"
  | "progress_expired"
  | "tool_silence_expired"
  | "awaiting_input_expired"
  | "explicit_stall"
  | "hard_deadline"
  | "inspection_unknown_exhausted";

export type EvaluationPhase =
  | "healthy"
  | "warning"
  | "inspect_due"
  | "inspecting"
  | "inspect_grace"
  | "cancel_requested"
  | "closed";

export interface AttemptLeaseOperation {
  id: string;
  label: string;
  startedAt: string;
  absoluteSilenceDeadlineAt: string;
  progressUnits?: number;
  lastObservationId?: string;
}

export interface AttemptLeaseAwaitingInput {
  requestId: string;
  since: string;
  deadlineAt: string;
}

export interface AttemptLeaseEvaluation {
  phase: EvaluationPhase;
  reason?: LeaseReason;
  inspectionCount: number;
  lastInspectionOutcome?: "running" | "terminal" | "unknown";
  graceDeadlineAt?: string;
  version: number;
}

export interface AttemptLeaseSnapshotV1 {
  schemaVersion: 1;
  attemptId: string;
  cardId: number;
  claimGeneration: number;
  executorKind: LeaseExecutorKind;
  executorId: string;
  highWaterSequence: number;
  stateVersion: number;
  semanticState: ProgressKind;
  semanticFingerprint?: string;
  lastMilestoneId?: string;
  lastReceivedAt: string;
  lastLivenessAt: string;
  lastMeaningfulProgressAt: string;
  livenessDeadlineAt: string;
  progressDeadlineAt: string;
  outputOnlySince?: string;
  outputUnits?: number;
  operation?: AttemptLeaseOperation;
  awaitingInput?: AttemptLeaseAwaitingInput;
  evaluation: AttemptLeaseEvaluation;
  nextEvaluationAt?: string;
  closedAt?: string;
  closeReason?: string;
  updatedAt: string;
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

export interface LeaseDecision {
  action: "healthy" | "warning" | "inspect" | "cancel" | "closed";
  reason?: LeaseReason;
  nextAt?: string;
}

export type ValidationIssue = {
  severity: "error" | "warn";
  tag: string;
  path: string;
  message: string;
};

export type ProgressValidationResult =
  | { ok: true; event: ExecutorProgressFactV1 }
  | { ok: false; errors: readonly ValidationIssue[] };

function issue(severity: "error" | "warn", tag: string, path: string, message: string): ValidationIssue {
  return { severity, tag, path, message };
}
function error(tag: string, path: string, message: string): ValidationIssue {
  return issue("error", tag, path, message);
}

const VALID_KINDS: ProgressKind[] = ["alive", "producing_output", "using_tool", "durable_milestone", "awaiting_input", "stalled"];
const VALID_PHASES: ProgressPhase[] = ["start", "advance", "end", "resolved"];

const PHASE_REQUIRED: Partial<Record<ProgressKind, boolean>> = {
  "using_tool": true,
  "awaiting_input": true,
};

const PHASE_OPTIONS: Partial<Record<ProgressKind, ProgressPhase[]>> = {
  "using_tool": ["start", "advance", "end"],
  "awaiting_input": ["start", "resolved"],
};

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

  if (typeof obj["fact_id"] !== "string" || !obj["fact_id"] || Buffer.byteLength(obj["fact_id"], "utf8") > 200) {
    errors.push(error("missing_field", "$.fact_id", "fact_id is required"));
  }

  if (typeof obj["attempt_id"] !== "string" || !obj["attempt_id"] || Buffer.byteLength(obj["attempt_id"], "utf8") > 200) {
    errors.push(error("missing_field", "$.attempt_id", "attempt_id is required"));
  }

  if (typeof obj["claim_generation"] !== "number" || !Number.isSafeInteger(obj["claim_generation"]) || obj["claim_generation"]! < 1) {
    errors.push(error("type_error", "$.claim_generation", "claim_generation must be a positive number"));
  }

  const exec = obj["executor"];
  if (typeof exec !== "object" || exec === null) {
    errors.push(error("missing_field", "$.executor", "executor is required"));
  } else {
    const e = exec as Record<string, unknown>;
    const ek = e["kind"];
    if (ek !== "agent" && ek !== "pi") {
      errors.push(error("type_error", "$.executor.kind", 'must be "agent" or "pi"'));
    }
    if (typeof e["id"] !== "string" || !e["id"] || Buffer.byteLength(e["id"], "utf8") > 200) {
      errors.push(error("missing_field", "$.executor.id", "executor id is required"));
    }
  }

  const kind = obj["kind"] as string;
  if (!VALID_KINDS.includes(kind as ProgressKind)) {
    errors.push(error("type_error", "$.kind", `invalid kind: ${kind}`));
  }

  const phase = obj["phase"] as string | undefined;
  if (phase !== undefined && !VALID_PHASES.includes(phase as ProgressPhase)) {
    errors.push(error("type_error", "$.phase", `invalid phase: ${phase}`));
  }

  if (kind && PHASE_REQUIRED[kind as ProgressKind] && !phase) {
    errors.push(error("missing_field", "$.phase", `${kind} requires a phase`));
  }

  if (kind && phase && PHASE_OPTIONS[kind as ProgressKind]) {
    const allowed = PHASE_OPTIONS[kind as ProgressKind]!;
    if (!allowed.includes(phase as ProgressPhase)) {
      errors.push(error("type_error", "$.phase", `${kind} does not support phase "${phase}"`));
    }
  }

  if (typeof obj["payload"] !== "object" || obj["payload"] === null || Array.isArray(obj["payload"])) {
    errors.push(error("missing_field", "$.payload", "payload is required"));
  } else {
    const payload = obj["payload"] as Record<string, unknown>;
    const boundedStringFields: Array<[string, number]> = [
      ["operation_id", MAX_OPERATION_ID_LENGTH],
      ["operation_label", MAX_OPERATION_LABEL_LENGTH],
      ["observation_id", MAX_OBSERVATION_ID_LENGTH],
      ["milestone_id", MAX_MILESTONE_ID_LENGTH],
      ["input_request_id", MAX_INPUT_REQUEST_ID_LENGTH],
      ["summary", MAX_PAYLOAD_SUMMARY_LENGTH],
    ];
    for (const [field, maxBytes] of boundedStringFields) {
      const value = payload[field];
      if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes)) {
        errors.push(error("invalid_payload", `$.payload.${field}`, `${field} must be a bounded string`));
      }
    }
    for (const field of ["expected_timeout_ms", "progress_units"]) {
      const value = payload[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
        errors.push(error("invalid_payload", `$.payload.${field}`, `${field} must be a non-negative safe integer`));
      }
    }
    if (kind === "durable_milestone" && typeof payload["milestone_id"] !== "string") {
      errors.push(error("missing_field", "$.payload.milestone_id", "durable_milestone requires milestone_id"));
    }
    if (kind === "using_tool" && typeof payload["operation_id"] !== "string") {
      errors.push(error("missing_field", "$.payload.operation_id", "using_tool requires operation_id"));
    }
    if (kind === "awaiting_input" && typeof payload["input_request_id"] !== "string") {
      errors.push(error("missing_field", "$.payload.input_request_id", "awaiting_input requires input_request_id"));
    }
  }

  if (obj["producer_at"] !== undefined && (typeof obj["producer_at"] !== "string" || obj["producer_at"].length > 64)) {
    errors.push(error("type_error", "$.producer_at", "producer_at must be a bounded string"));
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (Buffer.byteLength(JSON.stringify(obj), "utf-8") > MAX_EVENT_JSON_BYTES) {
    errors.push(error("too_long", "$", `event exceeds ${MAX_EVENT_JSON_BYTES} bytes`));
    return { ok: false, errors };
  }

  return { ok: true, event: obj as unknown as ExecutorProgressFactV1 };
}

export function computeSemanticFingerprint(fact: ExecutorProgressFactV1): string {
  const payload = fact.payload;
  const parts: string[] = [fact.kind, fact.phase ?? ""];
  if (payload.operation_id) parts.push(payload.operation_id);
  if (payload.milestone_id) parts.push(payload.milestone_id);
  if (payload.input_request_id) parts.push(payload.input_request_id);
  if (payload.progress_units !== undefined) parts.push(String(payload.progress_units));
  if (payload.observation_id) parts.push(payload.observation_id);
  if (payload.summary) parts.push(payload.summary.slice(0, 100));
  return createHash("sha256").update(parts.join("|"), "utf-8").digest("hex").slice(0, 16);
}

export function computeDeadlines(
  now: number,
  policy: LeasePolicy,
  snapshot?: Partial<AttemptLeaseSnapshotV1>,
  hardDeadlineAt?: number,
): { livenessDeadlineAt: string; progressDeadlineAt: string } {
  const lastLivenessAt = snapshot?.lastLivenessAt ? new Date(snapshot.lastLivenessAt).getTime() : now;
  const lastProgressAt = snapshot?.lastMeaningfulProgressAt ? new Date(snapshot.lastMeaningfulProgressAt).getTime() : now;

  let livenessDeadline = lastLivenessAt + policy.livenessMs;
  let progressDeadline = lastProgressAt + policy.meaningfulProgressMs;

  if (hardDeadlineAt !== undefined) {
    const hardAt = hardDeadlineAt;
    if (hardAt < livenessDeadline) livenessDeadline = hardAt;
    if (hardAt < progressDeadline) progressDeadline = hardAt;
  }

  return {
    livenessDeadlineAt: new Date(livenessDeadline).toISOString(),
    progressDeadlineAt: new Date(progressDeadline).toISOString(),
  };
}

/**
 * Classify the lease effect of a fact.
 * Note: `producing_output` returns "liveness" here because the actual
 * meaningful-progress effect depends on the output-only cap state in the
 * reducer. The persisted event column is diagnostic only — the authoritative
 * effect is determined at reduce time in executor-lease-reducer.ts.
 */
export function computeLeaseEffect(kind: ProgressKind, phase?: string): "none" | "liveness" | "meaningful" | "state" {
  switch (kind) {
    case "durable_milestone":
      return "meaningful";
    case "producing_output":
      return "liveness";
    case "using_tool":
      return phase === "end" ? "meaningful" : "liveness";
    case "awaiting_input":
      return phase === "resolved" ? "meaningful" : "state";
    case "stalled":
      return "state";
    default:
      return "liveness";
  }
}
