import { ProjectReviewStore } from "./project-review-store.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import {
  REVIEW_ACTIONS,
  CRITERION_VERDICTS,
  OUTPUT_DISPOSITIONS,
  CONTRADICTION_DISPOSITIONS,
  validationError as error,
  validationWarn as warn,
  type ValidationIssue,
  type ProjectReviewDecisionV1,
} from "./project-review-contract.js";

// ── Decision types ────────────────────────────────────────────────────────────
// #1620: one runtime source for every enum lives in project-review-contract.ts;
// these re-exports keep historical importers working.

export type { ProjectReviewAction, CriterionVerdict, OutputDisposition, ProjectReviewDecisionV1, ProjectRepairProposal, ProjectBlocker, ProjectInputRequest } from "./project-review-contract.js";
export type { ValidationSeverity, ValidationIssue } from "./project-review-contract.js";

// ── Validation ────────────────────────────────────────────────────────────────

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
    const seenDecisionIds = new Set<string>();

    for (const rcId of rootCriterionIds) {
      if (!decisionCriterionIds.has(rcId)) {
        errors.push(error("missing_field", `$.criteria`, `missing verdict for root criterion "${rcId}"`));
      }
    }

    const validVerdicts: readonly string[] = CRITERION_VERDICTS;
    for (const c of decision.criteria) {
      // #1605: reject duplicate verdicts for the same criterion id
      if (seenDecisionIds.has(c.criterion_id)) {
        errors.push(error("duplicate_id", `$.criteria[${c.criterion_id}]`, `duplicate verdict for criterion "${c.criterion_id}"`));
      }
      seenDecisionIds.add(c.criterion_id);
      if (!rootCriterionIds.has(c.criterion_id)) {
        errors.push(error("bad_reference", `$.criteria[${c.criterion_id}]`, `unknown criterion id "${c.criterion_id}"`));
      }
      if (!validVerdicts.includes(c.verdict)) {
        errors.push(error("type_error", `$.criteria[${c.criterion_id}].verdict`, `invalid verdict "${c.verdict}" — legal values: ${CRITERION_VERDICTS.join(", ")}`));
      }
      if (c.rationale.length > 2000) {
        errors.push(error("too_long", `$.criteria[${c.criterion_id}].rationale`, "rationale exceeds 2000 characters"));
      }
      // #1605: any non-satisfied verdict needs a rationale the Orc can stand
      // behind — no empty "just trust me" on gaps or failures.
      if (c.verdict !== "satisfied" && c.rationale.trim().length === 0) {
        errors.push(error("empty_string", `$.criteria[${c.criterion_id}].rationale`, `rationale is required for verdict "${c.verdict}"`));
      }
    }

    // Outputs: every required output must have a disposition. #1620: on
    // `accept` an omitted required output disposition is an ERROR (the
    // shipped artifact was never classified); on non-accept actions it
    // remains a deliberate warning — proceeding does not claim delivery.
    const requiredOutputIds = new Set(
      caseSnapshot.root_contract.required_outputs.filter(o => o.required).map(o => o.id),
    );
    const decisionOutputIds = new Set(decision.outputs.map(o => o.output_id));

    for (const oid of requiredOutputIds) {
      if (!decisionOutputIds.has(oid)) {
        if (decision.action === "accept") {
          errors.push(error("missing_field", `$.outputs`, `missing disposition for required output "${oid}"`));
        } else {
          errors.push(warn("missing_field", `$.outputs`, `missing disposition for required output "${oid}"`));
        }
      }
    }

    const validDispositions: readonly string[] = OUTPUT_DISPOSITIONS;
    for (const o of decision.outputs) {
      if (!validDispositions.includes(o.disposition)) {
        errors.push(error("type_error", `$.outputs[${o.output_id}].disposition`, `invalid disposition "${o.disposition}" — legal values: ${OUTPUT_DISPOSITIONS.join(", ")}`));
      }
    }

    // Build the valid evidence IDs from the case snapshot. Keep a
    // criterion-local index as well: a known evidence ID from another lane is
    // not compatible evidence for this criterion's satisfaction.
    const validEvidenceIds = new Set<string>();
    const evidenceIdsByCriterion = new Map<string, Set<string>>();
    for (const ci of caseSnapshot.criterion_inputs) {
      const criterionEvidence = evidenceIdsByCriterion.get(ci.criterion_id) ?? new Set<string>();
      for (const eid of ci.observed_evidence_ids) {
        validEvidenceIds.add(eid);
        criterionEvidence.add(eid);
      }
      for (const eid of ci.failed_or_inconclusive_check_ids) {
        validEvidenceIds.add(eid);
        criterionEvidence.add(eid);
      }
      for (const eid of ci.artifact_observation_ids) {
        validEvidenceIds.add(eid);
        criterionEvidence.add(eid);
      }
      evidenceIdsByCriterion.set(ci.criterion_id, criterionEvidence);
    }
    for (const cc of caseSnapshot.contradiction_candidates) {
      for (const eid of cc.evidence_ids) {
        validEvidenceIds.add(eid);
        for (const criterionId of cc.affected_criterion_ids) {
          const criterionEvidence = evidenceIdsByCriterion.get(criterionId) ?? new Set<string>();
          criterionEvidence.add(eid);
          evidenceIdsByCriterion.set(criterionId, criterionEvidence);
        }
      }
    }

    // Evidence references in decisions must be known
    for (const c of decision.criteria) {
      const compatibleEvidenceIds = evidenceIdsByCriterion.get(c.criterion_id);
      for (const eid of c.evidence_ids) {
        if (!validEvidenceIds.has(eid)) {
          errors.push(error("bad_reference", `$.criteria[${c.criterion_id}].evidence_ids`, `unknown evidence id "${eid}"`));
        } else if (rootCriterionIds.has(c.criterion_id) && !compatibleEvidenceIds?.has(eid)) {
          errors.push(error("bad_reference", `$.criteria[${c.criterion_id}].evidence_ids`, `evidence id "${eid}" is not compatible with criterion "${c.criterion_id}"`));
        }
      }
    }
    for (const cc of decision.contradictions) {
      for (const eid of cc.evidence_ids) {
        if (!validEvidenceIds.has(eid)) {
          errors.push(error("bad_reference", `$.contradictions[${cc.id}].evidence_ids`, `unknown evidence id "${eid}"`));
        }
      }
    }

    // Contradictions
    const validContradictionDispositions: readonly string[] = CONTRADICTION_DISPOSITIONS;
    for (const cc of decision.contradictions) {
      if (!validContradictionDispositions.includes(cc.disposition)) {
        errors.push(error("type_error", `$.contradictions[${cc.id}].disposition`, `invalid disposition "${cc.disposition}" — legal values: ${CONTRADICTION_DISPOSITIONS.join(", ")}`));
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
        errors.push(error("type_error", "$.action", `invalid action "${decision.action}" — legal values: ${REVIEW_ACTIONS.join(", ")}`));
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

    // #1605: per-criterion policy from the immutable case — requiredness and
    // execution ownership, not a set that implies everything is required.
    const policyByCriterionId = new Map(caseSnapshot.criterion_inputs.map(ci => [ci.criterion_id, ci]));

    for (const c of decision.criteria) {
      const policy = policyByCriterionId.get(c.criterion_id);
      const required = policy?.required ?? true;
      const owner = policy?.execution_owner ?? "delegated";

      // not_evaluated never accepts — required or optional
      if (c.verdict === "not_evaluated") {
        errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}]`, `criterion "${c.criterion_id}" is not_evaluated — every criterion must be evaluated to accept`));
        continue;
      }
      // Hard criteria must be satisfied
      if (required && c.verdict !== "satisfied") {
        errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}]`, `required criterion "${c.criterion_id}" is ${c.verdict}, not satisfied`));
        continue;
      }
      if (c.verdict === "satisfied") {
        // Delegated satisfaction requires durable evidence from the case
        if (owner === "delegated" && c.evidence_ids.length === 0) {
          errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}].evidence_ids`, `satisfied delegated criterion "${c.criterion_id}" has no evidence`));
        }
        // #1605: Orc-owned criteria are satisfied by the Orc's own evaluation —
        // a non-empty rationale plus the immutable case is their evidence; no
        // fabricated Worker evidence id is demanded.
        if (owner === "orc" && c.rationale.trim().length === 0) {
          errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}].rationale`, `satisfied Orc-owned criterion "${c.criterion_id}" requires a non-empty rationale`));
        }
      }
      // Optional gaps on accept need an explicit declared omission
      if (!required && (c.verdict === "unsatisfied" || c.verdict === "inconclusive") && c.rationale.trim().length === 0) {
        errors.push(error("invalid_proposal", `$.criteria[${c.criterion_id}].rationale`, `optional criterion "${c.criterion_id}" accepted with verdict ${c.verdict} requires a non-empty rationale`));
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

    // #1363 Task 6: enforce hard deadline and budgets
    if (caseSnapshot.root_contract.limits?.hard_deadline_at) {
      const deadline = new Date(caseSnapshot.root_contract.limits.hard_deadline_at).getTime();
      if (Date.now() > deadline) {
        errors.push(error("invalid_proposal", "$.limits.hard_deadline_at", "project hard deadline has passed"));
      }
    }
    if (caseSnapshot.root_contract.limits?.max_cost !== undefined) {
      if (caseSnapshot.budgets.total_cost === undefined) {
        errors.push(error("invalid_proposal", "$.limits.max_cost", "cost usage is unavailable; cannot verify the configured max_cost"));
      } else if (caseSnapshot.budgets.total_cost > caseSnapshot.root_contract.limits.max_cost) {
        errors.push(error("invalid_proposal", "$.limits.max_cost", `cost ${caseSnapshot.budgets.total_cost} exceeds limit ${caseSnapshot.root_contract.limits.max_cost}`));
      }
    }

    // #1605: persisted coverage gaps are review evidence, decided by the Orc.
    // A gap criterion accepted as satisfied requires case evidence (above); an
    // accepted optional gap requires a rationale (above); a not_evaluated or
    // missing verdict was already rejected. No legacy blanket warn here — gaps
    // are not a reason to distrust an otherwise valid accept.

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
