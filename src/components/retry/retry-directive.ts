import { createHash } from "node:crypto";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import type { RetryPolicyDecision } from "./retry-policy.js";
import type { SelectionRationale } from "./executor-selector.js";

export type RetryMode = "clean_rerun" | "strategy_change" | "executor_escalation" | "repair";

export interface RetryDirectiveV1 {
  schema_version: 1;
  id: string;
  root_contract_id: string;
  source_attempt_id: string;
  target_ordinal: number;
  classification_id: string;
  decision_id: string;
  mode: RetryMode;
  strategy: {
    instruction: string;
    do_not_repeat: string[];
    added_inputs: Array<{ id: string; ref: string }>;
    added_checks: string[];
  };
  executor: {
    selected_id: string;
    selected_kind: string;
    selection_rationale: string;
  };
  prior_context: {
    evidence_ids: string[];
    failed_criterion_ids: string[];
    unresolved_risks: string[];
    bounded_summary: string;
  };
  semantic_change_fingerprint: string;
  authored_by: "policy" | "orc";
  created_at: string;
}

export function createDirectiveId(): string {
  const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
  return "d_" + randomBytes(12).toString("hex");
}

function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map(k => JSON.stringify(k) + ":" + canonicalJson(record[k]));
  return "{" + pairs.join(",") + "}";
}

export function computeDirectiveFingerprint(directive: Record<string, unknown>): string {
  const withOutId = { ...directive, id: "", semantic_change_fingerprint: "", created_at: "" };
  const canonical = canonicalJson(withOutId);
  return createHash("sha256").update(canonical, "utf-8").digest("hex").slice(0, 32);
}

export function buildDirective(
  rootContract: WorkerAcceptanceContractV1,
  sourceAttemptId: string,
  targetOrdinal: number,
  classification: FailureClassificationV1,
  decision: RetryPolicyDecision,
  selectionRationale: SelectionRationale,
  opts: {
    mode: RetryMode;
    instruction: string;
    doNotRepeat?: string[];
    addedInputs?: Array<{ id: string; ref: string }>;
    addedChecks?: string[];
    authoredBy: "policy" | "orc";
    priorEvidenceIds?: string[];
    failedCriterionIds?: string[];
    unresolvedRisks?: string[];
    boundedSummary?: string;
  },
): RetryDirectiveV1 {
  const directive: RetryDirectiveV1 = {
    schema_version: 1,
    id: createDirectiveId(),
    root_contract_id: rootContract.id,
    source_attempt_id: sourceAttemptId,
    target_ordinal: targetOrdinal,
    classification_id: classification.id,
    decision_id: decision.sourceAttemptId,
    mode: opts.mode,
    strategy: {
      instruction: opts.instruction.slice(0, 2000),
      do_not_repeat: (opts.doNotRepeat ?? []).slice(0, 10),
      added_inputs: (opts.addedInputs ?? []).slice(0, 10),
      added_checks: (opts.addedChecks ?? []).slice(0, 10),
    },
    executor: {
      selected_id: selectionRationale.selectedId,
      selected_kind: selectionRationale.selectedKind,
      selection_rationale: `${selectionRationale.selectionStrategy} score=${selectionRationale.score} eligible=${selectionRationale.eligibleCount}`,
    },
    prior_context: {
      evidence_ids: (opts.priorEvidenceIds ?? classification.evidence_ids).slice(0, 20),
      failed_criterion_ids: (opts.failedCriterionIds ?? []).slice(0, 20),
      unresolved_risks: (opts.unresolvedRisks ?? []).slice(0, 10),
      bounded_summary: (opts.boundedSummary ?? classification.recommended_actions.join("; ")).slice(0, 500),
    },
    semantic_change_fingerprint: "",
    authored_by: opts.authoredBy,
    created_at: new Date().toISOString(),
  };

  const raw = directive as unknown as Record<string, unknown>;
  directive.semantic_change_fingerprint = computeDirectiveFingerprint(raw);

  return directive;
}

export function deriveContractRevision(
  original: WorkerAcceptanceContractV1,
  directive: RetryDirectiveV1,
): WorkerAcceptanceContractV1 {
  const retryContextSection = `\n\nRETRY CONTEXT (attempt ${directive.source_attempt_id} → ${directive.target_ordinal}):\n${directive.strategy.instruction}\nDo not repeat: ${directive.strategy.do_not_repeat.join(", ")}\nPrior evidence: ${directive.prior_context.evidence_ids.join(", ")}\nFailed criteria: ${directive.prior_context.failed_criterion_ids.join(", ")}`;

  const revisedGoal = original.goal + retryContextSection;

  const revised: Record<string, unknown> = {
    schema_version: 1,
    id: original.id,
    digest: "",
    goal: revisedGoal.slice(0, 4000),
    criteria: original.criteria.map(c => ({ id: c.id, description: c.description })),
    expected_artifacts: original.expected_artifacts.map(a => ({
      id: a.id,
      kind: a.kind,
      ref: a.ref,
      required: a.required,
      criterion_ids: [...a.criterion_ids],
    })),
    verification_commands: original.verification_commands.map(c => ({
      id: c.id,
      argv: [...c.argv],
      cwd: c.cwd,
      timeout_ms: c.timeout_ms,
      criterion_ids: [...c.criterion_ids],
    })),
    required_capabilities: [...original.required_capabilities],
    limits: { ...original.limits },
    provenance: { ...original.provenance },
  };

  const digest = computeContractDigest(revised);
  revised.digest = digest;

  return revised as unknown as WorkerAcceptanceContractV1;
}

function computeContractDigest(obj: Record<string, unknown>): string {
  const { createHash: hash } = require("node:crypto") as typeof import("node:crypto");
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).filter(k => k !== "digest").sort()) {
    sorted[k] = obj[k];
  }
  return hash("sha256").update(canonicalJson(sorted), "utf-8").digest("hex");
}

export function validateDirective(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (raw.schema_version !== 1) errors.push("unsupported schema_version");
  if (!raw.root_contract_id) errors.push("root_contract_id required");
  if (!raw.source_attempt_id) errors.push("source_attempt_id required");
  if (typeof raw.target_ordinal !== "number" || (raw.target_ordinal as number) < 1) errors.push("target_ordinal must be >= 1");
  if (!raw.mode) errors.push("mode required");
  const exec = raw.executor as Record<string, unknown> | undefined;
  if (!exec || !exec.selected_id) errors.push("executor.selected_id required");
  const validModes: RetryMode[] = ["clean_rerun", "strategy_change", "executor_escalation", "repair"];
  if (!validModes.includes(raw.mode as RetryMode)) errors.push(`invalid mode: ${String(raw.mode)}`);
  return errors;
}

export function validateContractRevision(original: WorkerAcceptanceContractV1, revised: WorkerAcceptanceContractV1): string[] {
  const errors: string[] = [];

  if (revised.criteria.length < original.criteria.length) {
    errors.push("criteria count cannot decrease");
  }

  const originalCriteriaMap = new Map(original.criteria.map(c => [c.id, c]));
  for (const rc of revised.criteria) {
    const oc = originalCriteriaMap.get(rc.id);
    if (oc && rc.description !== oc.description) {
      errors.push(`criterion ${rc.id} description changed`);
    }
  }

  const originalCapCount = original.required_capabilities.length;
  const revisedCapCount = revised.required_capabilities.length;
  if (revisedCapCount < originalCapCount) {
    errors.push("capabilities cannot be removed");
  }

  if (!revised.goal.startsWith(original.goal.slice(0, 100))) {
    errors.push("root goal changed");
  }

  return errors;
}
