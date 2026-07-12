import { ProjectReviewStore } from "./project-review-store.js";
import { ProjectReviewValidator, type ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";

export type ReviewOutcome =
  | { kind: "accepted"; decisionId: string; summary: string }
  | { kind: "repair"; decisionId: string; summary: string }
  | { kind: "blocked"; decisionId: string; summary: string }
  | { kind: "needs_input"; decisionId: string; summary: string }
  | { kind: "invalid"; errors: readonly string[] };

export class ProjectReviewService {
  private store: ProjectReviewStore;
  private validator: ProjectReviewValidator;

  constructor() {
    this.store = new ProjectReviewStore();
    this.validator = new ProjectReviewValidator();
  }

  /**
   * Process a review decision submitted by Orc.
   * Validates, persists, and transitions project state.
   */
  processDecision(decision: ProjectReviewDecisionV1): ReviewOutcome {
    // Load the case
    const caseRow = this.store.getReviewCase(decision.review_case_id);
    if (!caseRow) {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" not found`] };
    }

    if (caseRow.status !== "open") {
      return { kind: "invalid", errors: [`review case "${decision.review_case_id}" is ${caseRow.status}, not open`] };
    }

    const caseSnapshot = JSON.parse(caseRow.case_json) as ReviewCaseSnapshot;
    if (!caseSnapshot) {
      return { kind: "invalid", errors: ["failed to parse case snapshot"] };
    }

    // Validate the decision
    const errors = this.validator.validateDecision(decision, caseSnapshot);
    if (errors.length > 0) {
      return { kind: "invalid", errors: errors.map(e => `[${e.path}] ${e.message}`) };
    }

    const decisionDigest = `rd_${decision.project_card_id}_${decision.review_case_id}_${Date.now()}`;

    // Persist decision
    const { id: decisionId } = this.store.insertDecision(
      decision.review_case_id,
      decision,
      decisionDigest,
    );

    // Transition state based on action
    const cardId = decision.project_card_id;

    switch (decision.action) {
      case "accept": {
        this.store.setState(cardId, "accepted", { accepted_decision_id: decisionId });
        // Update kanban card
        try {
          const { kanbanComplete } = require("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
          kanbanComplete(cardId, null, decision.synthesis.slice(0, 500));
        } catch {}
        return {
          kind: "accepted",
          decisionId,
          summary: `Project accepted: ${decision.synthesis.slice(0, 200)}`,
        };
      }

      case "repair": {
        const repairItems = decision.repair?.items ?? [];
        this.store.setState(cardId, "repair_planned", {
          generation: caseSnapshot.generation,
        });
        this.store.incrementGeneration(cardId);
        return {
          kind: "repair",
          decisionId,
          summary: `Repair planned: ${repairItems.length} items (${repairItems.map(i => i.affected_criterion_ids.join(",")).join("; ")})`,
        };
      }

      case "blocked": {
        const blocker = decision.blocker!;
        this.store.setState(cardId, "blocked", {
          blocked_reason: blocker.blocker_class,
          accepted_decision_id: decisionId,
        });
        try {
          const { kanbanFail } = require("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
          kanbanFail(cardId, `blocked: ${blocker.blocker_class}`);
        } catch {}
        return {
          kind: "blocked",
          decisionId,
          summary: `Project blocked: ${blocker.blocker_class}`,
        };
      }

      case "needs_input": {
        const inputReq = decision.input_request!;
        this.store.setState(cardId, "needs_input", {
          active_review_case_id: decision.review_case_id,
        });
        return {
          kind: "needs_input",
          decisionId,
          summary: `Input requested: ${inputReq.question.slice(0, 200)}`,
        };
      }

      default:
        return { kind: "invalid", errors: [`unknown action: ${decision.action}`] };
    }
  }
}
