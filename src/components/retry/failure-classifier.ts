import { createHash } from "node:crypto";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import type { AttemptLeaseSnapshot } from "../executor-progress.js";

export type FailureClass =
  | "transient_transport"
  | "executor_unavailable"
  | "capability_mismatch"
  | "lease_expired"
  | "hard_deadline"
  | "resource_or_budget_exhausted"
  | "tool_or_verification_failure"
  | "missing_or_invalid_artifact"
  | "acceptance_unmet"
  | "strategy_failure"
  | "awaiting_input_expired"
  | "operator_cancelled"
  | "policy_or_security_denied"
  | "invalid_contract"
  | "unknown";

export type Confidence = "observed" | "derived" | "inferred" | "ambiguous";
export type Retryability = "automatic" | "review_required" | "needs_input" | "never";

export interface FailureClassificationV1 {
  schema_version: 1;
  id: string;
  attempt_id: string;
  input_digest: string;
  primary: FailureClass;
  factors: FailureClass[];
  evidence_ids: string[];
  stable_codes: string[];
  confidence: Confidence;
  retryability: Retryability;
  recommended_actions: string[];
  classifier_version: string;
  created_at: string;
}

export const FAILURE_CLASSES: readonly FailureClass[] = [
  "transient_transport",
  "executor_unavailable",
  "capability_mismatch",
  "lease_expired",
  "hard_deadline",
  "resource_or_budget_exhausted",
  "tool_or_verification_failure",
  "missing_or_invalid_artifact",
  "acceptance_unmet",
  "strategy_failure",
  "awaiting_input_expired",
  "operator_cancelled",
  "policy_or_security_denied",
  "invalid_contract",
  "unknown",
];

export const CLASSIFIER_VERSION = "v1.0.0";

interface ClassifyInput {
  envelope?: WorkerResultEnvelopeV1;
  leaseSnapshot?: AttemptLeaseSnapshot;
  lifecycle: string;
  lifecycleReason?: string;
  cancelReason?: string;
  hasPendingInput?: boolean;
}

interface ClassifyResult {
  classification: FailureClassificationV1;
}

function makeId(attemptId: string, inputDigest: string): string {
  const hash = createHash("sha256").update(`${attemptId}:${inputDigest}`, "utf-8").digest("hex").slice(0, 16);
  return `fc_${hash}`;
}

function computeInputDigest(input: ClassifyInput): string {
  const canonical = JSON.stringify({
    e: input.envelope ? { outcome: input.envelope.outcome, error: input.envelope.error } : null,
    l: input.leaseSnapshot ? { evaluation: input.leaseSnapshot.evaluation, semanticState: input.leaseSnapshot.semanticState } : null,
    lc: input.lifecycle,
    lr: input.lifecycleReason,
    cr: input.cancelReason,
    pi: input.hasPendingInput,
  });
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export function classify(input: ClassifyInput): ClassifyResult {
  const inputDigest = computeInputDigest(input);
  const evidenceIds: string[] = [];
  const stableCodes: string[] = [];
  const factors: FailureClass[] = [];
  let primary: FailureClass = "unknown";
  let confidence: Confidence = "ambiguous";
  let retryability: Retryability = "review_required";
  const recommendedActions: string[] = [];

  // Phase 1: explicit terminal reason codes (highest precedence)
  if (input.cancelReason) {
    stableCodes.push(`cancel:${input.cancelReason}`);
    evidenceIds.push(`cancel:${input.cancelReason}`);
    if (input.cancelReason === "operator") {
      primary = "operator_cancelled";
      confidence = "observed";
      retryability = "never";
      recommendedActions.push("operator cancelled — no retry");
    } else if (input.cancelReason === "project_abort" || input.cancelReason === "superseded") {
      primary = "operator_cancelled";
      confidence = "derived";
      retryability = "never";
      recommendedActions.push("project aborted or superseded — no retry");
    } else if (input.cancelReason === "shutdown") {
      primary = "transient_transport";
      confidence = "observed";
      retryability = "automatic";
      recommendedActions.push("shutdown — clean rerun");
    }
  }

  if (input.lifecycleReason) {
    stableCodes.push(`lifecycle:${input.lifecycleReason}`);
    evidenceIds.push(`lifecycle:${input.lifecycleReason}`);
  }

  // Phase 2: lease evidence
  if (input.leaseSnapshot) {
    evidenceIds.push(`lease:${input.leaseSnapshot.attemptId}`);
    const evalState = input.leaseSnapshot.evaluation;
    if (evalState === "cancel_requested") {
      factors.push("lease_expired");
      if (primary === "unknown") {
        const leaseState = input.leaseSnapshot.semanticState;
        if (leaseState === "stalled") {
          primary = "lease_expired";
          confidence = "derived";
          retryability = "automatic";
          recommendedActions.push("stalled — clean rerun or executor switch");
        } else {
          primary = "lease_expired";
          confidence = "derived";
          retryability = "review_required";
          recommendedActions.push("lease expired — inspect and retry");
        }
      }
    }
  }

  // Phase 3: envelope evidence
  if (input.envelope) {
    const env = input.envelope;
    evidenceIds.push(`envelope:${env.attempt.id}`);

    if (env.outcome === "completed") {
      // All criteria passed — not a failure
      if (primary === "unknown") {
        primary = "unknown";
        confidence = "ambiguous";
        retryability = "review_required";
        recommendedActions.push("worker completed but reconciler classified — review");
      }
    } else {
      if (env.error?.code) {
        stableCodes.push(`error:${env.error.code}`);
      }

      const criteriaFailed = env.criteria.filter(c => c.status === "failed");

      if (criteriaFailed.length > 0) {
        factors.push("acceptance_unmet");
      }

      const anyCheckFailed = env.checks.some(c => c.exit_code !== 0 || c.timed_out);
      const anyArtifactMissing = env.artifacts.some(a => !a.exists && a.kind !== "logical");

      if (anyCheckFailed) {
        factors.push("tool_or_verification_failure");
        evidenceIds.push("checks_failed");
      }

      if (anyArtifactMissing) {
        factors.push("missing_or_invalid_artifact");
        evidenceIds.push("artifacts_missing");
      }

      if (primary === "unknown") {
        if (env.error?.retryable === true) {
          if (env.error.code === "TRANSPORT" || env.error.code === "CONNECTION") {
            primary = "transient_transport";
            confidence = "observed";
            retryability = "automatic";
            recommendedActions.push("transient transport error — clean rerun with backoff");
          } else if (env.error.code === "DEADLINE" || env.error.code === "TIMEOUT") {
            primary = "hard_deadline";
            confidence = "observed";
            retryability = "never";
            recommendedActions.push("deadline exceeded — no retry");
          } else if (env.error.code === "CAPABILITY") {
            primary = "capability_mismatch";
            confidence = "observed";
            retryability = "review_required";
            recommendedActions.push("capability mismatch — switch executor");
          } else if (env.error.code === "BUDGET" || env.error.code === "QUOTA") {
            primary = "resource_or_budget_exhausted";
            confidence = "observed";
            retryability = "never";
            recommendedActions.push("budget exhausted — no retry");
          }
        }
      }

      if (primary === "unknown" && criteriaFailed.length > 0 && anyCheckFailed) {
        primary = "tool_or_verification_failure";
        confidence = "derived";
        retryability = "review_required";
        recommendedActions.push("checks failed — review and repair strategy");
      }

      if (primary === "unknown" && criteriaFailed.length > 0 && !anyCheckFailed) {
        primary = "acceptance_unmet";
        confidence = "derived";
        retryability = "review_required";
        recommendedActions.push("acceptance criteria not met — review and repair");
      }

      if (primary === "unknown" && anyArtifactMissing) {
        primary = "missing_or_invalid_artifact";
        confidence = "derived";
        retryability = "review_required";
        recommendedActions.push("artifacts missing — review and fix");
      }

      if (env.error?.code === "STRATEGY" || env.error?.code === "PLANNING") {
        factors.push("strategy_failure");
        if (primary === "unknown") {
          primary = "strategy_failure";
          confidence = "inferred";
          retryability = "review_required";
          recommendedActions.push("strategy failure — Orc repair directive required");
        }
      }

      if (env.outcome === "cancelled") {
        if (primary === "unknown") {
          primary = "operator_cancelled";
          confidence = "observed";
          retryability = "never";
          recommendedActions.push("worker cancelled — no retry");
        }
      }
    }
  }

  // Phase 4: lifecycle terminal state
  if (input.lifecycle === "cancelled" && primary === "unknown") {
    primary = "operator_cancelled";
    confidence = "derived";
    retryability = "never";
    recommendedActions.push("attempt cancelled — no retry");
  }

  if (input.lifecycle === "timed_out") {
    factors.push("hard_deadline");
    if (primary === "unknown") {
      primary = "hard_deadline";
      confidence = "observed";
      retryability = "never";
      recommendedActions.push("attempt timed out — no retry");
    }
  }

  // Phase 5: awaiting input
  if (input.hasPendingInput) {
    if (primary === "unknown") {
      primary = "awaiting_input_expired";
      confidence = "derived";
      retryability = "needs_input";
      recommendedActions.push("awaiting input expired — fresh input required");
    } else {
      factors.push("awaiting_input_expired");
    }
  }

  // Policy/security checks
  if (input.envelope?.error?.code === "POLICY" || input.envelope?.error?.code === "SECURITY") {
    primary = "policy_or_security_denied";
    confidence = "observed";
    retryability = "never";
    stableCodes.push("policy_denied");
    factors.length = 0;
    recommendedActions.length = 0;
    recommendedActions.push("policy or security denied — no retry");
  }

  if (input.envelope?.error?.code === "INVALID_CONTRACT") {
    primary = "invalid_contract";
    confidence = "observed";
    retryability = "never";
    stableCodes.push("invalid_contract");
    factors.length = 0;
    recommendedActions.length = 0;
    recommendedActions.push("invalid contract — no retry");
  }

  const attemptId = (input as any).attempt_id ?? (input as any).envelope?.attempt?.id ?? "";
  const id = makeId(attemptId, inputDigest);

  const classification: FailureClassificationV1 = {
    schema_version: 1,
    id,
    attempt_id: attemptId,
    input_digest: inputDigest,
    primary,
    factors: [...new Set(factors)],
    evidence_ids: [...new Set(evidenceIds)],
    stable_codes: [...new Set(stableCodes)],
    confidence,
    retryability,
    recommended_actions: recommendedActions.slice(0, 5),
    classifier_version: CLASSIFIER_VERSION,
    created_at: new Date().toISOString(),
  };

  return { classification };
}
