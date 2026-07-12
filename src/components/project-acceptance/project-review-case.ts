import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectAcceptanceContractV1, ContractCriterionMapping } from "./project-contract.js";
import { findUncoveredCriteria } from "./project-contract.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CriterionCoverageHint = "supported" | "conflicting" | "gap";

export interface CriterionReviewInput {
  criterion_id: string;
  description: string;
  evidence_expectation: "observed" | "artifact" | "synthesis";
  mapped_child_contract_ids: string[];
  observed_evidence_ids: string[];
  worker_claim_ids: string[];
  failed_or_inconclusive_check_ids: string[];
  artifact_observation_ids: string[];
  retry_lineage_ids: string[];
  coverage_hint: CriterionCoverageHint;
}

export interface ContradictionCandidate {
  id: string;
  affected_criterion_ids: string[];
  description: string;
  evidence_ids: string[];
  sources: string[];
}

export interface ReviewCaseSnapshot {
  schema_version: 1;
  project_card_id: number;
  generation: number;
  round: number;
  created_at: string;

  root_contract: {
    id: string;
    digest: string;
    goal: string;
    criteria: readonly {
      id: string;
      description: string;
      evidence_expectation: "observed" | "artifact" | "synthesis";
    }[];
    required_outputs: readonly {
      id: string;
      description: string;
      kind: string;
      required: boolean;
    }[];
  };

  criterion_inputs: CriterionReviewInput[];
  contradiction_candidates: ContradictionCandidate[];
  uncovered_criteria: string[];

  child_summaries: readonly {
    card_id: number;
    contract_id: string;
    outcome: string;
    criterion_statuses: readonly { criterion_id: string; status: string }[];
    attempts: number;
    executor_kind: string;
  }[];

  budgets: {
    total_cost?: number;
    total_tokens?: number;
    wall_clock_ms: number;
    review_round: number;
    repair_round: number;
  };

  // Bounds
  evidence_ref_count: number;
  contradiction_count: number;
}

// ── Assembler ─────────────────────────────────────────────────────────────────

export class ReviewCaseAssembler {
  private reviewStore: ProjectReviewStore;
  private supService: WorkerSupervisionService;
  private supStore: WorkerSupervisionStore;

  constructor() {
    this.reviewStore = new ProjectReviewStore();
    this.supService = new WorkerSupervisionService();
    this.supStore = new WorkerSupervisionStore();
  }

  assembleCase(projectCardId: number, generation: number, round: number): ReviewCaseSnapshot | { error: string } {
    const contractRow = this.reviewStore.getContractByProjectCardId(projectCardId);
    if (!contractRow) return { error: `no root contract for project ${projectCardId}` };

    const rootContract = JSON.parse(contractRow.contract_json) as ProjectAcceptanceContractV1;
    const supervision = this.reviewStore.getSupervision(projectCardId);
    if (!supervision) return { error: `no supervision state for project ${projectCardId}` };

    // Load children
    const { kanbanGetChildren } = require("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const children = kanbanGetChildren(projectCardId);

    // Gather child contract mappings, results, and evidence
    const childMappings: ContractCriterionMapping[] = [];
    const childSummaries: Array<{
      card_id: number;
      contract_id: string;
      outcome: string;
      criterion_statuses: Array<{ criterion_id: string; status: string }>;
      attempts: number;
      executor_kind: string;
    }> = [];

    for (const child of children) {
      const contract = this.supService.getContractForCard(child.id);
      if (!contract) continue;

      if (contract.supports_root_criteria && contract.supports_root_criteria.length > 0) {
        childMappings.push({
          child_contract_id: contract.id,
          supports_root_criteria: [...contract.supports_root_criteria],
        });
      }

      const attempts = this.supStore.getAttemptsForCard(child.id);
      const latestAttempt = attempts.length > 0 ? attempts[attempts.length - 1]! : null;

      childSummaries.push({
        card_id: child.id,
        contract_id: contract.id,
        outcome: latestAttempt?.lifecycle ?? "unknown",
        criterion_statuses: [],
        attempts: attempts.length,
        executor_kind: latestAttempt?.executor_kind ?? "unknown",
      });
    }

    // Compute coverage
    const uncoveredCriteria = findUncoveredCriteria(rootContract, childMappings);

    // Build per-criterion review input
    const criterionInputs: CriterionReviewInput[] = rootContract.criteria.map(c => {
      const mappedChildren = childMappings
        .filter(m => m.supports_root_criteria.includes(c.id))
        .map(m => m.child_contract_id);

      const coverageHint: CriterionCoverageHint = !mappedChildren.length
        ? "gap"
        : "supported";

      return {
        criterion_id: c.id,
        description: c.description,
        evidence_expectation: c.evidence_expectation,
        mapped_child_contract_ids: mappedChildren,
        observed_evidence_ids: [],
        worker_claim_ids: [],
        failed_or_inconclusive_check_ids: [],
        artifact_observation_ids: [],
        retry_lineage_ids: [],
        coverage_hint: coverageHint,
      };
    });

    // Conservative contradiction candidates
    const contradictionCandidates: ContradictionCandidate[] = [];
    // Detect mutually exclusive outcomes for criteria mapped by multiple children
    const criteriaOutcomes = new Map<string, Map<string, Set<string>>>();
    for (const child of children) {
      const contract = this.supService.getContractForCard(child.id);
      if (!contract?.supports_root_criteria) continue;
      for (const rcId of contract.supports_root_criteria) {
        if (!criteriaOutcomes.has(rcId)) criteriaOutcomes.set(rcId, new Map());
        const childMap = criteriaOutcomes.get(rcId)!;
        const outcome = child.status;
        if (!childMap.has(outcome)) childMap.set(outcome, new Set());
        childMap.get(outcome)!.add(`card_${child.id}`);
      }
    }
    for (const [critId, outcomeMap] of criteriaOutcomes) {
      const hasPass = outcomeMap.has("done") || outcomeMap.has("delivered");
      const hasFail = outcomeMap.has("failed");
      if (hasPass && hasFail) {
        const allSources = [...outcomeMap.values()].flatMap(s => [...s]);
        contradictionCandidates.push({
          id: `cc_${critId}_${round}`,
          affected_criterion_ids: [critId],
          description: `Conflicting outcomes for criterion "${critId}": some children passed, others failed`,
          evidence_ids: [],
          sources: allSources,
        });
      }
    }

    const now = Date.now();
    const project = (() => {
      try { return require("../tasks/kanban-board.js").kanbanGetCard(projectCardId); } catch { return null; }
    })();

    return {
      schema_version: 1,
      project_card_id: projectCardId,
      generation,
      round,
      created_at: new Date().toISOString(),
      root_contract: {
        id: rootContract.id,
        digest: rootContract.digest,
        goal: rootContract.goal,
        criteria: rootContract.criteria,
        required_outputs: rootContract.required_outputs,
      },
      criterion_inputs: criterionInputs,
      contradiction_candidates: contradictionCandidates,
      uncovered_criteria: uncoveredCriteria as string[],
      child_summaries: childSummaries,
      budgets: {
        total_cost: undefined,
        total_tokens: project?.tokens_used ?? undefined,
        wall_clock_ms: project ? now - new Date(project.created_at + "Z").getTime() : 0,
        review_round: round,
        repair_round: supervision.repair_round,
      },
      evidence_ref_count: 0,
      contradiction_count: contradictionCandidates.length,
    };
  }
}
