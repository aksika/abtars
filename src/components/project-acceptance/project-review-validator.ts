import { ProjectReviewStore } from "./project-review-store.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";

// ── Decision types ────────────────────────────────────────────────────────────

export type ProjectReviewAction = "accept" | "repair" | "blocked" | "needs_input";
export type CriterionVerdict = "satisfied" | "unsatisfied" | "inconclusive" | "not_evaluated";
export type OutputDisposition = "verified" | "present" | "missing" | "invalid" | "remote_only";

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
    disposition: "resolved" | "repair" | "blocking" | "inconclusive";
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

// ── Validation ────────────────────────────────────────────────────────────────

export type ValidationSeverity = "error" | "warn";
export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly tag: string;
  readonly path: string;
  readonly message: string;
}

function error(tag: string, path: string, message: string): ValidationIssue {
  return { severity: "error", tag, path, message };
}

function warn(tag: string, path: string, message: string): ValidationIssue {
  return { severity: "warn", tag, path, message };
}

export class ProjectReviewValidator {
  private store: ProjectReviewStore;

  constructor() {
    this.store = new ProjectReviewStore();
  }

  /**
   * Validate a review decision against the case snapshot.
   * Returns errors array — empty means valid.
   */
  validateDecision(
    decision: ProjectReviewDecisionV1,
    caseSnapshot: ReviewCaseSnapshot,
  ): readonly ValidationIssue[] {
    const errors: ValidationIssue[] = [];

    // Schema
    if (decision.schema_version !== 1) {
      errors.push(error("unknown_version", "$.schema_version", "unsupported schema_version"));
    }

    // Case IDs must match
    if (decision.project_card_id !== caseSnapshot.project_card_id) {
      errors.push(error("bad_reference", "$.project_card_id", "project_card_id does not match case"));
    }
    if (decision.project_generation !== caseSnapshot.generation) {
      errors.push(error("bad_reference", "$.project_generation", `generation mismatch: expected ${caseSnapshot.generation}, got ${decision.project_generation}`));
    }

    // Active case check
    const storedCase = this.store.getReviewCase(decision.review_case_id);
    if (!storedCase) {
      errors.push(error("bad_reference", "$.review_case_id", "review case not found"));
    } else if (storedCase.status !== "open") {
      errors.push(error("bad_reference", "$.review_case_id", `review case is ${storedCase.status}, not open`));
    }

    // Criteria: every root criterion must have exactly one verdict
    const rootCriterionIds = new Set(caseSnapshot.root_contract.criteria.map(c => c.id));
    const decisionCriterionIds = new Set(decision.criteria.map(c => c.criterion_id));

    for (const rcId of rootCriterionIds) {
      if (!decisionCriterionIds.has(rcId)) {
        errors.push(error("missing_field", `$.criteria`, `missing verdict for root criterion "${rcId}"`));
      }
    }

    const validVerdicts: CriterionVerdict[] = ["satisfied", "unsatisfied", "inconclusive", "not_evaluated"];
    for (const c of decision.criteria) {
      if (!rootCriterionIds.has(c.criterion_id)) {
        errors.push(error("bad_reference", `$.criteria[${c.criterion_id}]`, `unknown criterion id "${c.criterion_id}"`));
      }
      if (!validVerdicts.includes(c.verdict)) {
        errors.push(error("type_error", `$.criteria[${c.criterion_id}].verdict`, `invalid verdict "${c.verdict}"`));
      }
      if (c.rationale.length > 2000) {
        errors.push(error("too_long", `$.criteria[${c.criterion_id}].rationale`, "rationale exceeds 2000 characters"));
      }
    }

    // Outputs: every required output must have a disposition
    const requiredOutputIds = new Set(
      caseSnapshot.root_contract.required_outputs.filter(o => o.required).map(o => o.id),
    );
    const decisionOutputIds = new Set(decision.outputs.map(o => o.output_id));

    for (const oid of requiredOutputIds) {
      if (!decisionOutputIds.has(oid)) {
        errors.push(warn("missing_field", `$.outputs`, `missing disposition for required output "${oid}"`));
      }
    }

    const validDispositions: OutputDisposition[] = ["verified", "present", "missing", "invalid", "remote_only"];
    for (const o of decision.outputs) {
      if (!validDispositions.includes(o.disposition)) {
        errors.push(error("type_error", `$.outputs[${o.output_id}].disposition`, `invalid disposition "${o.disposition}"`));
      }
    }

    // Evidence references must point to known items in the case
    for (const c of decision.criteria) {
      for (const eid of c.evidence_ids) {
        if (caseSnapshot.child_summaries.some(cs => cs.contract_id === eid || `card_${cs.card_id}` === eid)) continue;
      }
    }

    // Contradictions
    const validContradictionDispositions = ["resolved", "repair", "blocking", "inconclusive"];
    for (const cc of decision.contradictions) {
      if (!validContradictionDispositions.includes(cc.disposition)) {
        errors.push(error("type_error", `$.contradictions[${cc.id}].disposition`, `invalid disposition "${cc.disposition}"`));
      }
      for (const acid of cc.affected_criterion_ids) {
        if (!rootCriterionIds.has(acid)) {
          errors.push(error("bad_reference", `$.contradictions[${cc.id}].affected_criterion_ids`, `unknown criterion "${acid}"`));
        }
      }
    }

    // Action-specific validation
    switch (decision.action) {
      case "accept":
        errors.push(...this.validateAccept(decision, caseSnapshot, rootCriterionIds, requiredOutputIds));
        break;
      case "repair":
        errors.push(...this.validateRepair(decision, caseSnapshot));
        break;
      case "blocked":
        errors.push(...this.validateBlocked(decision));
        break;
      case "needs_input":
        errors.push(...this.validateNeedsInput(decision));
        break;
      default:
        errors.push(error("type_error", "$.action", `invalid action "${decision.action}"`));
    }

    return errors;
  }

  private validateAccept(
    decision: ProjectReviewDecisionV1,
    caseSnapshot: ReviewCaseSnapshot,
    rootCriterionIds: Set<string>,
    requiredOutputIds: Set<string>,
  ): ValidationIssue[] {
    const errors: ValidationIssue[] = [];

    // Every required criterion must be satisfied
    for (const c of decision.criteria) {
      if (rootCriterionIds.has(c.criterion_id) && c.verdict !== "satisfied") {
        errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}]`, `required criterion "${c.criterion_id}" is ${c.verdict}, not satisfied`));
      }
    }

    // Every required output must have valid disposition
    for (const o of decision.outputs) {
      if (requiredOutputIds.has(o.output_id)) {
        if (o.disposition === "missing" || o.disposition === "invalid") {
          errors.push(error("invalid_proposal", `$.outputs[${o.output_id}]`, `required output "${o.output_id}" is ${o.disposition}`));
        }
      }
    }

    // No blocking contradictions
    for (const cc of decision.contradictions) {
      if (cc.disposition === "blocking") {
        const hasAffectedRequired = cc.affected_criterion_ids.some(id => rootCriterionIds.has(id));
        if (hasAffectedRequired) {
          errors.push(error("invalid_proposal", `$.contradictions[${cc.id}]`, "blocking contradiction affects required criteria — cannot accept"));
        }
      }
    }

    // No blocking residual risks
    for (const r of decision.residual_risks) {
      if (r.blocking) {
        errors.push(error("invalid_proposal", `$.residual_risks`, "blocking residual risk prevents acceptance"));
      }
    }

    // Check uncovered criteria in case — must be addressed in decision
    if (caseSnapshot.uncovered_criteria.length > 0) {
      const uncovered = caseSnapshot.uncovered_criteria;
      const addressed = decision.criteria.filter(c => uncovered.includes(c.criterion_id) && c.verdict === "satisfied");
      if (addressed.length < uncovered.length) {
        errors.push(warn("inconclusive", "$.criteria", `${uncovered.length - addressed.length} uncovered criteria remain`));
      }
    }

    return errors;
  }

  private validateRepair(
    _decision: ProjectReviewDecisionV1,
    _caseSnapshot: ReviewCaseSnapshot,
  ): ValidationIssue[] {
    const errors: ValidationIssue[] = [];

    if (!_decision.repair || _decision.repair.items.length === 0) {
      errors.push(error("missing_field", "$.repair", "repair proposal is required for repair action"));
      return errors;
    }

    for (const item of _decision.repair.items) {
      if (item.affected_criterion_ids.length === 0) {
        errors.push(error("missing_field", `$.repair.items[${item.id}].affected_criterion_ids`, "at least one affected criterion is required"));
      }
      if (!item.strategy || item.strategy.length === 0) {
        errors.push(error("missing_field", `$.repair.items[${item.id}].strategy`, "strategy is required"));
      }
      if (!item.required_evidence || item.required_evidence.length === 0) {
        errors.push(error("missing_field", `$.repair.items[${item.id}].required_evidence`, "required evidence is required"));
      }
    }

    return errors;
  }

  private validateBlocked(decision: ProjectReviewDecisionV1): ValidationIssue[] {
    const errors: ValidationIssue[] = [];

    if (!decision.blocker) {
      errors.push(error("missing_field", "$.blocker", "blocker information is required for blocked action"));
      return errors;
    }

    if (!decision.blocker.blocker_class) {
      errors.push(error("missing_field", "$.blocker.blocker_class", "blocker_class is required"));
    }

    if (decision.blocker.affected_criterion_ids.length === 0) {
      errors.push(error("missing_field", "$.blocker.affected_criterion_ids", "at least one affected criterion is required"));
    }

    if (!decision.blocker.what_was_attempted) {
      errors.push(error("missing_field", "$.blocker.what_was_attempted", "description of what was attempted is required"));
    }

    return errors;
  }

  private validateNeedsInput(decision: ProjectReviewDecisionV1): ValidationIssue[] {
    const errors: ValidationIssue[] = [];

    if (!decision.input_request) {
      errors.push(error("missing_field", "$.input_request", "input_request is required for needs_input action"));
      return errors;
    }

    if (!decision.input_request.question) {
      errors.push(error("missing_field", "$.input_request.question", "question is required"));
    }

    if (decision.input_request.affected_criterion_ids.length === 0) {
      errors.push(error("missing_field", "$.input_request.affected_criterion_ids", "at least one affected criterion is required"));
    }

    return errors;
  }
}
