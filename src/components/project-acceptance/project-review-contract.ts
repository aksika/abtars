/**
 * project-review-contract.ts — single runtime source for the Orc review
 * decision vocabulary (#1620). Enums, types, provider-visible JSON Schema
 * fragments, and native argument narrowing all derive from the same
 * constants so the validator, the case projection, and every transport
 * adapter can never drift apart.
 */

// ── Decision vocabulary (one runtime source) ─────────────────────────────────

export const REVIEW_ACTIONS = ["accept", "repair", "blocked", "needs_input"] as const;
export const CRITERION_VERDICTS = [
  "satisfied",
  "unsatisfied",
  "inconclusive",
  "not_evaluated",
] as const;
export const OUTPUT_DISPOSITIONS = [
  "verified",
  "present",
  "missing",
  "invalid",
  "remote_only",
] as const;
export const CONTRADICTION_DISPOSITIONS = [
  "resolved",
  "repair",
  "blocking",
  "inconclusive",
] as const;

// ── Stable blocker classes (#1630) ────────────────────────────────────────────
// Stable identifiers stored in project_supervision.blocked_reason — never a
// sentence. The human-readable explanation lives in the decision payload's
// `reason`, not in the class column.

export const INVALID_CONTRACT_PROPOSALS_EXHAUSTED = "invalid_contract_proposals_exhausted";
export const REVIEW_REQUEST_ABANDONED = "review_request_abandoned";
/** #1686: a persisted repair decision cannot authorize a Worker — its repair
 * items lack a usable source contract (missing, corrupt, foreign, or not
 * covering the affected criteria). One structural block, never a review loop. */
export const REPAIR_SOURCE_CONTRACT_INVALID = "repair_source_contract_invalid";

export type ProjectReviewAction = (typeof REVIEW_ACTIONS)[number];
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];
export type OutputDisposition = (typeof OUTPUT_DISPOSITIONS)[number];
export type ContradictionDisposition = (typeof CONTRADICTION_DISPOSITIONS)[number];

// ── Validation issues ────────────────────────────────────────────────────────

export type ValidationSeverity = "error" | "warn";

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly tag: string;
  readonly path: string;
  readonly message: string;
}

export function validationError(tag: string, path: string, message: string): ValidationIssue {
  return { severity: "error", tag, path, message };
}

export function validationWarn(tag: string, path: string, message: string): ValidationIssue {
  return { severity: "warn", tag, path, message };
}

// ── Decision shape ───────────────────────────────────────────────────────────

export interface ProjectReviewDecisionV1 {
  schema_version: 1;
  id: string;
  project_card_id: number;
  review_case_id: string;
  project_generation: number;
  action: ProjectReviewAction;
  criteria: Array<{
    criterion_id: string;
    verdict: CriterionVerdict;
    evidence_ids: string[];
    rationale: string;
  }>;
  outputs: Array<{
    output_id: string;
    disposition: OutputDisposition;
    evidence_ids: string[];
  }>;
  contradictions: Array<{
    id: string;
    affected_criterion_ids: string[];
    evidence_ids: string[];
    disposition: ContradictionDisposition;
    rationale: string;
  }>;
  residual_risks: Array<{
    text: string;
    blocking: boolean;
    evidence_ids: string[];
  }>;
  synthesis: string;
  repair?: ProjectRepairProposal;
  blocker?: ProjectBlocker;
  input_request?: ProjectInputRequest;
  authored_at: string;
}

export interface ProjectRepairProposal {
  items: Array<{
    id: string;
    /** #1686: the validated Worker contract whose evidence paths and execution
     * routing this repair must preserve. One repair item references one
     * mapped source contract and spans only root criteria it covers. */
    source_contract_id: string;
    affected_criterion_ids: string[];
    required_evidence: string;
    strategy: string;
    do_not_repeat: string[];
    capabilities: string[];
    budget: { max_attempts?: number; max_tokens?: number };
  }>;
  rationale: string;
}

export interface ProjectBlocker {
  blocker_class: string;
  affected_criterion_ids: string[];
  exhausted_failures: string[];
  contradiction_evidence: string[];
  what_was_attempted: string;
  unblock_conditions: string;
}

export interface ProjectInputRequest {
  question: string;
  affected_criterion_ids: string[];
  expected_response_kind: string;
  context: string;
}

// ── Provider-visible JSON Schema fragments ───────────────────────────────────
// Every nested enum and required field survives each transport adapter because
// the registry schema itself carries the full constraint set.

export const REVIEW_CRITERION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    criterion_id: { type: "string" },
    verdict: { type: "string", enum: [...CRITERION_VERDICTS] },
    evidence_ids: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
  },
  required: ["criterion_id", "verdict", "evidence_ids", "rationale"],
} as const;

export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    output_id: { type: "string" },
    disposition: { type: "string", enum: [...OUTPUT_DISPOSITIONS] },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["output_id", "disposition", "evidence_ids"],
} as const;

export const REVIEW_CONTRADICTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    affected_criterion_ids: { type: "array", items: { type: "string" } },
    evidence_ids: { type: "array", items: { type: "string" } },
    disposition: { type: "string", enum: [...CONTRADICTION_DISPOSITIONS] },
    rationale: { type: "string" },
  },
  required: ["id", "affected_criterion_ids", "evidence_ids", "disposition", "rationale"],
} as const;

export const REVIEW_RESIDUAL_RISK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    blocking: { type: "boolean" },
    evidence_ids: { type: "array", items: { type: "string" } },
  },
  required: ["text", "blocking", "evidence_ids"],
} as const;

export const REVIEW_REPAIR_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    source_contract_id: { type: "string", description: "id of the mapped Worker contract (from the review case children/mapped contracts) whose evidence and routing this repair preserves — one repair item references exactly one source contract and may affect only root criteria that contract covers" },
    affected_criterion_ids: { type: "array", items: { type: "string" } },
    required_evidence: { type: "string" },
    strategy: { type: "string" },
    do_not_repeat: { type: "array", items: { type: "string" } },
    capabilities: { type: "array", items: { type: "string" } },
    budget: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_attempts: { type: "number" },
        max_tokens: { type: "number" },
      },
      required: [],
    },
  },
  required: ["id", "source_contract_id", "affected_criterion_ids", "required_evidence", "strategy"],
} as const;

export const REVIEW_BLOCKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    blocker_class: { type: "string" },
    affected_criterion_ids: { type: "array", items: { type: "string" } },
    exhausted_failures: { type: "array", items: { type: "string" } },
    contradiction_evidence: { type: "array", items: { type: "string" } },
    what_was_attempted: { type: "string" },
    unblock_conditions: { type: "string" },
  },
  required: ["blocker_class", "affected_criterion_ids", "what_was_attempted"],
} as const;

export const REVIEW_INPUT_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    question: { type: "string" },
    affected_criterion_ids: { type: "array", items: { type: "string" } },
    expected_response_kind: { type: "string" },
    context: { type: "string" },
  },
  required: ["question", "affected_criterion_ids"],
} as const;

export const REVIEW_REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    items: { type: "array", items: REVIEW_REPAIR_ITEM_SCHEMA },
    rationale: { type: "string" },
  },
  required: ["items"],
} as const;

/** Native provider-visible schema for the `review_project` tool. */
export const REVIEW_PROJECT_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", description: "accept | repair | blocked | needs_input", enum: [...REVIEW_ACTIONS] },
    project_card_id: { type: "number", description: "Explicit supervised project card ID" },
    project_generation: { type: "number", description: "Expected project supervision generation" },
    review_case_id: { type: "string", description: "Explicit review case ID from get_project_review_case" },
    criteria: {
      type: "array",
      description: "One entry per root criterion: criterion_id, verdict (satisfied | unsatisfied | inconclusive | not_evaluated), evidence_ids (use only ids returned by get_project_review_case), rationale (required for every non-satisfied verdict, and for satisfied Orc-owned criteria)",
      items: REVIEW_CRITERION_SCHEMA,
    },
    outputs: {
      type: "array",
      description: "Every required output needs an entry with output_id and disposition (verified | present | missing | invalid | remote_only); present even when empty",
      items: REVIEW_OUTPUT_SCHEMA,
    },
    contradictions: {
      type: "array",
      description: "Contradiction dispositions from the case: resolved | repair | blocking | inconclusive; present even when empty",
      items: REVIEW_CONTRADICTION_SCHEMA,
    },
    residual_risks: {
      type: "array",
      description: "Residual risks with blocking flag; present even when empty",
      items: REVIEW_RESIDUAL_RISK_SCHEMA,
    },
    synthesis: { type: "string", description: "Final synthesis of the review" },
    repair: { ...REVIEW_REPAIR_SCHEMA, description: "Repair proposal (required if action=repair). Each item references exactly one mapped source contract (source_contract_id) and may affect only delegated root criteria that contract covers; a repair spanning contracts must be split into one item per source contract." },
    blocker: { ...REVIEW_BLOCKER_SCHEMA, description: "Blocker information (required if action=blocked)" },
    input_request: { ...REVIEW_INPUT_REQUEST_SCHEMA, description: "Input request (required if action=needs_input)" },
  },
  required: [
    "action",
    "project_card_id",
    "project_generation",
    "review_case_id",
    "criteria",
    "outputs",
    "contradictions",
    "residual_risks",
    "synthesis",
  ],
} as const;

// ── Native argument narrowing ────────────────────────────────────────────────

type NarrowResult =
  | { ok: true; decision: ProjectReviewDecisionV1 }
  | { ok: false; issues: ValidationIssue[] };

/** Accept a native number, or a numeric string from wrappers that stringify. Absent optional fields pass through as undefined. */
function narrowNumber(value: unknown, path: string, issues: ValidationIssue[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  issues.push(validationError("type_error", path, `expected an integer number, got ${typeof value}`));
  return undefined;
}

function narrowString(value: unknown, path: string, issues: ValidationIssue[]): string | undefined {
  if (typeof value === "string") return value;
  issues.push(validationError("type_error", path, `expected a string, got ${typeof value}`));
  return undefined;
}

function narrowStringArray(value: unknown, path: string, issues: ValidationIssue[]): string[] {
  if (!Array.isArray(value)) {
    issues.push(validationError("type_error", path, "expected an array of strings"));
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else issues.push(validationError("type_error", `${path}[]`, `expected a string, got ${typeof item}`));
  }
  return out;
}

function narrowOptionalString(value: unknown, path: string, fallback: string, issues: ValidationIssue[]): string {
  if (value === undefined) return fallback;
  return narrowString(value, path, issues) ?? fallback;
}

function narrowOptionalStringArray(value: unknown, path: string, issues: ValidationIssue[]): string[] {
  if (value === undefined) return [];
  return narrowStringArray(value, path, issues);
}

/**
 * Narrow an enum field structurally: a non-string value is a payload defect;
 * membership in `legal` is intentionally deferred to the semantic validator,
 * which reports enum violations with the legal values and counts them against
 * the invalid-proposal budget (#1620 scenario 5).
 */
function narrowEnum<T extends readonly string[]>(
  value: unknown,
  legal: T,
  path: string,
  issues: ValidationIssue[],
): T[number] | undefined {
  if (typeof value !== "string") {
    issues.push(validationError("type_error", path, `expected a string, got ${typeof value}`));
    return undefined;
  }
  void legal;
  return value as T[number];
}

function narrowObject(value: unknown, path: string, issues: ValidationIssue[]): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(validationError("type_error", path, "expected an object"));
    return undefined;
  }
  return value as Record<string, unknown>;
}

function narrowRepairItem(raw: Record<string, unknown>, path: string, issues: ValidationIssue[]): ProjectRepairProposal["items"][number] {
  const id = narrowString(raw.id, `${path}.id`, issues);
  // #1686: structural narrowing requires a non-empty source contract reference
  // for new provider responses. A legacy item without one cannot authorize a
  // Worker; the reconciler records an actionable structural blocker instead.
  const sourceContractId = narrowString(raw.source_contract_id, `${path}.source_contract_id`, issues);
  const affected = narrowStringArray(raw.affected_criterion_ids, `${path}.affected_criterion_ids`, issues);
  const requiredEvidence = narrowString(raw.required_evidence, `${path}.required_evidence`, issues);
  const strategy = narrowString(raw.strategy, `${path}.strategy`, issues);
  const doNotRepeat = narrowOptionalStringArray(raw.do_not_repeat, `${path}.do_not_repeat`, issues);
  const capabilities = narrowOptionalStringArray(raw.capabilities, `${path}.capabilities`, issues);
  let maxAttempts: number | undefined;
  let maxTokens: number | undefined;
  if (raw.budget !== undefined) {
    const budget = narrowObject(raw.budget, `${path}.budget`, issues);
    if (budget) {
      maxAttempts = raw.budget == null ? undefined : narrowNumber(budget.max_attempts, `${path}.budget.max_attempts`, issues);
      maxTokens = raw.budget == null ? undefined : narrowNumber(budget.max_tokens, `${path}.budget.max_tokens`, issues);
    }
  }
  if (sourceContractId === undefined || sourceContractId.trim().length === 0) {
    issues.push(validationError("empty_string", `${path}.source_contract_id`, "source_contract_id is required — reference the mapped Worker contract whose evidence this repair must preserve"));
  }
  return {
    id: id ?? "",
    source_contract_id: sourceContractId ?? "",
    affected_criterion_ids: affected,
    required_evidence: requiredEvidence ?? "",
    strategy: strategy ?? "",
    do_not_repeat: doNotRepeat,
    capabilities,
    budget: { max_attempts: maxAttempts, max_tokens: maxTokens },
  };
}

/**
 * Narrow raw provider JSON into a structurally complete decision. Any
 * malformed field produces a stable typed issue; a failure creates no
 * decision and must never reach the validator or the store.
 */
export function narrowReviewProjectArgs(raw: Record<string, unknown>): NarrowResult {
  const issues: ValidationIssue[] = [];

  const action = narrowEnum(raw.action, REVIEW_ACTIONS, "$.action", issues);
  const projectCardId = narrowNumber(raw.project_card_id, "$.project_card_id", issues);
  const projectGeneration = narrowNumber(raw.project_generation, "$.project_generation", issues);
  const reviewCaseId = narrowString(raw.review_case_id, "$.review_case_id", issues);
  const synthesis = narrowString(raw.synthesis, "$.synthesis", issues);

  const criteria: ProjectReviewDecisionV1["criteria"] = [];
  if (Array.isArray(raw.criteria)) {
    for (const item of raw.criteria) {
      const obj = narrowObject(item, "$.criteria[]", issues);
      if (!obj) continue;
      const criterionId = narrowString(obj.criterion_id, "$.criteria[].criterion_id", issues);
      const verdict = narrowEnum(obj.verdict, CRITERION_VERDICTS, "$.criteria[].verdict", issues);
      const evidenceIds = narrowStringArray(obj.evidence_ids, "$.criteria[].evidence_ids", issues);
      const rationale = narrowString(obj.rationale, "$.criteria[].rationale", issues);
      criteria.push({
        criterion_id: criterionId ?? "",
        verdict: verdict ?? "not_evaluated",
        evidence_ids: evidenceIds,
        rationale: rationale ?? "",
      });
    }
  } else {
    issues.push(validationError("type_error", "$.criteria", "expected an array of criteria"));
  }

  const outputs: ProjectReviewDecisionV1["outputs"] = [];
  if (Array.isArray(raw.outputs)) {
    for (const item of raw.outputs) {
      const obj = narrowObject(item, "$.outputs[]", issues);
      if (!obj) continue;
      const outputId = narrowString(obj.output_id, "$.outputs[].output_id", issues);
      const disposition = narrowEnum(obj.disposition, OUTPUT_DISPOSITIONS, "$.outputs[].disposition", issues);
      const evidenceIds = narrowStringArray(obj.evidence_ids, "$.outputs[].evidence_ids", issues);
      outputs.push({ output_id: outputId ?? "", disposition: disposition ?? "missing", evidence_ids: evidenceIds });
    }
  } else {
    issues.push(validationError("type_error", "$.outputs", "expected an array of outputs"));
  }

  const contradictions: ProjectReviewDecisionV1["contradictions"] = [];
  if (Array.isArray(raw.contradictions)) {
    for (const item of raw.contradictions) {
      const obj = narrowObject(item, "$.contradictions[]", issues);
      if (!obj) continue;
      const id = narrowString(obj.id, "$.contradictions[].id", issues);
      const affected = narrowStringArray(obj.affected_criterion_ids, "$.contradictions[].affected_criterion_ids", issues);
      const evidenceIds = narrowStringArray(obj.evidence_ids, "$.contradictions[].evidence_ids", issues);
      const disposition = narrowEnum(obj.disposition, CONTRADICTION_DISPOSITIONS, "$.contradictions[].disposition", issues);
      const rationale = narrowString(obj.rationale, "$.contradictions[].rationale", issues);
      contradictions.push({
        id: id ?? "",
        affected_criterion_ids: affected,
        evidence_ids: evidenceIds,
        disposition: disposition ?? "inconclusive",
        rationale: rationale ?? "",
      });
    }
  } else {
    issues.push(validationError("type_error", "$.contradictions", "expected an array of contradictions"));
  }

  const residualRisks: ProjectReviewDecisionV1["residual_risks"] = [];
  if (Array.isArray(raw.residual_risks)) {
    for (const item of raw.residual_risks) {
      const obj = narrowObject(item, "$.residual_risks[]", issues);
      if (!obj) continue;
      const text = narrowString(obj.text, "$.residual_risks[].text", issues);
      const blocking = obj.blocking;
      if (typeof blocking !== "boolean") {
        issues.push(validationError("type_error", "$.residual_risks[].blocking", `expected a boolean, got ${typeof blocking}`));
      }
      const evidenceIds = narrowStringArray(obj.evidence_ids, "$.residual_risks[].evidence_ids", issues);
      residualRisks.push({ text: text ?? "", blocking: blocking === true, evidence_ids: evidenceIds });
    }
  } else {
    issues.push(validationError("type_error", "$.residual_risks", "expected an array of residual risks"));
  }

  let repair: ProjectRepairProposal | undefined;
  if (action === "repair") {
    const repairRaw = narrowObject(raw.repair, "$.repair", issues);
    if (repairRaw) {
      const items: ProjectRepairProposal["items"] = [];
      if (Array.isArray(repairRaw.items)) {
        for (const item of repairRaw.items) {
          const obj = narrowObject(item, "$.repair.items[]", issues);
          if (obj) items.push(narrowRepairItem(obj, "$.repair.items[]", issues));
        }
      } else {
        issues.push(validationError("type_error", "$.repair.items", "expected an array of repair items"));
      }
      repair = {
        items,
        rationale: narrowString(repairRaw.rationale, "$.repair.rationale", issues) ?? "",
      };
    }
  }

  let blocker: ProjectBlocker | undefined;
  if (action === "blocked") {
    const blockerRaw = narrowObject(raw.blocker, "$.blocker", issues);
    if (blockerRaw) {
      blocker = {
        blocker_class: narrowString(blockerRaw.blocker_class, "$.blocker.blocker_class", issues) ?? "",
        affected_criterion_ids: narrowStringArray(blockerRaw.affected_criterion_ids, "$.blocker.affected_criterion_ids", issues),
        exhausted_failures: narrowOptionalStringArray(blockerRaw.exhausted_failures, "$.blocker.exhausted_failures", issues),
        contradiction_evidence: narrowOptionalStringArray(blockerRaw.contradiction_evidence, "$.blocker.contradiction_evidence", issues),
        what_was_attempted: narrowString(blockerRaw.what_was_attempted, "$.blocker.what_was_attempted", issues) ?? "",
        unblock_conditions: narrowOptionalString(blockerRaw.unblock_conditions, "$.blocker.unblock_conditions", "", issues),
      };
    }
  }

  let inputRequest: ProjectInputRequest | undefined;
  if (action === "needs_input") {
    const inputRaw = narrowObject(raw.input_request, "$.input_request", issues);
    if (inputRaw) {
      inputRequest = {
        question: narrowString(inputRaw.question, "$.input_request.question", issues) ?? "",
        affected_criterion_ids: narrowStringArray(inputRaw.affected_criterion_ids, "$.input_request.affected_criterion_ids", issues),
        expected_response_kind: narrowOptionalString(inputRaw.expected_response_kind, "$.input_request.expected_response_kind", "text", issues),
        context: narrowOptionalString(inputRaw.context, "$.input_request.context", "", issues),
      };
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    decision: {
      schema_version: 1,
      id: `rd_${projectCardId}_${Date.now()}`,
      project_card_id: projectCardId!,
      review_case_id: reviewCaseId!,
      project_generation: projectGeneration!,
      action: action!,
      criteria,
      outputs,
      contradictions,
      residual_risks: residualRisks,
      synthesis: synthesis ?? "",
      repair,
      blocker,
      input_request: inputRequest,
      authored_at: new Date().toISOString(),
    },
  };
}
