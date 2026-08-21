import { createHash } from "node:crypto";
import type { WorkerAcceptanceContractV1, RetryContext, WorkerContractRevisionV1 } from "../worker-contract.js";
import { createContractId } from "../worker-contract.js";
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
  _cardId: number,
  revision: number,
): WorkerAcceptanceContractV1 {
  const rootId = original.revision_meta?.root_contract_id ?? original.id;
  const retryContext: RetryContext = {
    directive_id: directive.id,
    mode: directive.mode,
    instruction: directive.strategy.instruction,
    do_not_repeat: directive.strategy.do_not_repeat,
    prior_evidence_ids: directive.prior_context.evidence_ids,
    failed_criterion_ids: directive.prior_context.failed_criterion_ids,
    unresolved_risks: directive.prior_context.unresolved_risks,
  };
  const revMeta: WorkerContractRevisionV1 = {
    revision,
    root_contract_id: rootId,
    parent_contract_id: original.id,
    source_attempt_id: directive.source_attempt_id,
    retry_context: retryContext,
  };

  const newId = createContractId();
  const revised: Record<string, unknown> = {
    schema_version: 1,
    id: newId,
    digest: "",
    revision_meta: revMeta,
    goal: original.goal,
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
    supports_root_criteria: original.supports_root_criteria ? [...original.supports_root_criteria] : undefined,
    // #1638: the workspace marker is immutable within one card lineage.
    workspace_alias: original.workspace_alias,
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

// ── #1686: evidence-preserving repair derivation ─────────────────────────────
//
// A repair Worker is a clone of the referenced source contract, never a new
// prose-authored evidence plan. The immutable fields (criteria, artifacts,
// verification commands, capabilities, executor routing, bounds) are copied;
// only the goal, root mapping, lineage, and retry context are derived at the
// system boundary.

export interface RepairItemContractInput {
  id: string;
  source_contract_id: string;
  affected_criterion_ids: readonly string[];
  required_evidence: string;
  strategy: string;
  do_not_repeat?: readonly string[];
  capabilities?: readonly string[];
  budget?: { max_attempts?: number; max_tokens?: number };
}

export interface DeriveRepairContractInput {
  sourceContract: WorkerAcceptanceContractV1;
  /** The latest attempt of the source contract card, when one exists. */
  sourceAttemptId?: string;
  item: RepairItemContractInput;
  rootCardId: number;
  pendingCardId: number;
  now: string;
  /** Enclosing root-contract limits the item budget can never expand. */
  enclosingLimits?: { max_tokens?: number; max_duration_ms?: number; max_cost?: number };
}

export function deriveRepairContract(input: DeriveRepairContractInput): WorkerAcceptanceContractV1 {
  const { sourceContract, sourceAttemptId, item, rootCardId, pendingCardId, now, enclosingLimits } = input;
  const goal = `Repair: ${item.strategy.slice(0, 200)} [repair-item:${item.id}]`;

  // Capabilities are additive — item capabilities can add, never remove,
  // source requirements.
  const capabilities = [...new Set([...sourceContract.required_capabilities, ...(item.capabilities ?? [])])];

  // Budgets copy source bounds; item max_tokens applies only within the
  // source and enclosing bounds and can never expand an enclosing budget.
  let maxTokens = sourceContract.limits?.max_tokens;
  if (item.budget?.max_tokens !== undefined) {
    maxTokens = item.budget.max_tokens;
    if (sourceContract.limits?.max_tokens !== undefined) {
      maxTokens = Math.min(maxTokens, sourceContract.limits.max_tokens);
    }
    if (enclosingLimits?.max_tokens !== undefined) {
      maxTokens = Math.min(maxTokens, enclosingLimits.max_tokens);
    }
  }
  const limits: WorkerAcceptanceContractV1["limits"] = {
    max_duration_ms: sourceContract.limits?.max_duration_ms ?? enclosingLimits?.max_duration_ms,
    max_tokens: maxTokens,
    max_cost: sourceContract.limits?.max_cost ?? enclosingLimits?.max_cost,
  };
  for (const k of ["max_duration_ms", "max_tokens", "max_cost"] as const) {
    if (limits[k] === undefined) delete limits[k];
  }

  const lineageRoot = sourceContract.revision_meta?.root_contract_id ?? sourceContract.id;
  const revMeta: WorkerContractRevisionV1 = {
    revision: 1,
    root_contract_id: lineageRoot,
    parent_contract_id: item.source_contract_id,
    ...(sourceAttemptId ? { source_attempt_id: sourceAttemptId } : {}),
    retry_context: {
      directive_id: `repair-item:${item.id}`,
      mode: "repair",
      instruction: item.strategy.slice(0, 2000),
      do_not_repeat: (item.do_not_repeat ?? []).slice(0, 10),
      prior_evidence_ids: [],
      failed_criterion_ids: [...item.affected_criterion_ids].slice(0, 20),
      unresolved_risks: [],
      required_evidence: item.required_evidence.slice(0, 500),
    },
  };

  const newId = createContractId();
  const derived: Record<string, unknown> = {
    schema_version: 1,
    id: newId,
    digest: "",
    revision_meta: revMeta,
    goal,
    criteria: sourceContract.criteria.map(c => ({ id: c.id, description: c.description })),
    expected_artifacts: sourceContract.expected_artifacts.map(a => ({
      id: a.id,
      kind: a.kind,
      ref: a.ref,
      required: a.required,
      criterion_ids: [...a.criterion_ids],
    })),
    verification_commands: sourceContract.verification_commands.map(c => ({
      id: c.id,
      argv: [...c.argv],
      cwd: c.cwd,
      timeout_ms: c.timeout_ms,
      criterion_ids: [...c.criterion_ids],
    })),
    required_capabilities: capabilities,
    supports_root_criteria: [...item.affected_criterion_ids],
    // #1638: the executor routing marker is immutable within one lineage —
    // a repair of Pi work stays Pi work, Spin work stays Spin work.
    workspace_alias: sourceContract.workspace_alias,
    limits,
    provenance: {
      root_card_id: rootCardId,
      card_id: pendingCardId,
      authored_by: "orc",
      created_at: now,
    },
  };

  derived.digest = computeContractDigest(derived);
  return derived as unknown as WorkerAcceptanceContractV1;
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
  } else {
    const originalCriteriaMap = new Map(original.criteria.map(c => [c.id, c]));
    for (const rc of revised.criteria) {
      const oc = originalCriteriaMap.get(rc.id);
      if (oc && rc.description !== oc.description) {
        errors.push(`criterion ${rc.id} description changed`);
      }
    }
  }

  if (revised.required_capabilities.length < original.required_capabilities.length) {
    errors.push("capabilities cannot be removed");
  }

  if (revised.goal !== original.goal) {
    errors.push("root goal changed");
  }

  if (JSON.stringify(revised.limits) !== JSON.stringify(original.limits)) {
    errors.push("limits cannot be weakened");
  }

  // #1638: the workspace marker is immutable within one card lineage — a
  // retry cannot move coding work to Spin or Spin work to Pi.
  if ((revised.workspace_alias ?? undefined) !== (original.workspace_alias ?? undefined)) {
    errors.push("workspace_alias cannot change within a contract lineage");
  }

  return errors;
}
