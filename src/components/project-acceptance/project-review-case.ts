import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectAcceptanceContractV1, ContractCriterionMapping } from "./project-contract.js";
import { findUncoveredCriteria } from "./project-contract.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { redactEnvelope } from "../worker-contract.js";

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
    limits?: {
      hard_deadline_at?: string;
      max_tokens?: number;
      max_cost?: number;
      max_review_rounds: number;
      max_repair_rounds: number;
    };
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

  /** #1433: Peer contribution cards linked to this project — claims, not observations */
  peer_contributions: readonly {
    card_id: number;
    peer: string;
    outcome: string;
    projection_summary: string;
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

  async assembleCase(projectCardId: number, generation: number, round: number): Promise<ReviewCaseSnapshot | { error: string }> {
    const contractRow = this.reviewStore.getContractByProjectCardId(projectCardId);
    if (!contractRow) return { error: `no root contract for project ${projectCardId}` };

    const rootContract = JSON.parse(contractRow.contract_json) as ProjectAcceptanceContractV1;
    const supervision = this.reviewStore.getSupervision(projectCardId);
    if (!supervision) return { error: `no supervision state for project ${projectCardId}` };

    // Load children via ESM dynamic import (vitest mock intercepts these)
    const { kanbanGetChildren } = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const children = kanbanGetChildren(projectCardId);

    // Also gather peer contribution cards linked to this project
    const contributions: Array<{ card_id: number; peer: string; outcome: string; projection_summary: string }> = [];
    try {
      const { kanbanList } = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
      const peerCards = kanbanList("done", undefined).filter(c => c.source === "peer" && c.type === "contribution");
      for (const pc of peerCards) {
        const notes = pc.notes ? (() => { try { return JSON.parse(pc.notes) as Record<string, unknown>; } catch { return {}; } })() : {};
        // A contribution belongs to this project if its notes reference the project_card_id
        if (notes.project_card_id === projectCardId || notes.parent_project_id === projectCardId) {
          contributions.push({
            card_id: pc.id,
            peer: pc.source_peer ?? "unknown",
            outcome: pc.status,
            projection_summary: pc.result_summary?.slice(0, 200) ?? "",
          });
        }
      }
    } catch {}

    // Gather child contract mappings, results, and evidence
    const childMappings: ContractCriterionMapping[] = [];
    const childSummaries: Array<{
      card_id: number;
      contract_id: string;
      outcome: string;
      criterion_statuses: Array<{ criterion_id: string; status: string }>;
      attempts: number;
      executor_kind: string;
      result?: WorkerResultEnvelopeV1;
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
      let envelope: WorkerResultEnvelopeV1 | undefined;
      let criterionStatuses: Array<{ criterion_id: string; status: string }> = [];
      if (latestAttempt) {
        const resultData = this.supStore.getResultByAttempt(latestAttempt.id);
        if (resultData) {
          envelope = resultData.envelope;
          criterionStatuses = resultData.envelope.criteria.map(c => ({
            criterion_id: c.criterion_id,
            status: c.status,
          }));
        }
      }

      childSummaries.push({
        card_id: child.id,
        contract_id: contract.id,
        outcome: latestAttempt?.lifecycle ?? "unknown",
        criterion_statuses: criterionStatuses,
        attempts: attempts.length,
        executor_kind: latestAttempt?.executor_kind ?? "unknown",
        result: envelope ? redactEnvelope(envelope) : undefined,
      });
    }

    // Compute coverage
    const uncoveredCriteria = findUncoveredCriteria(rootContract, childMappings);

    // Build per-criterion review input with evidence from attempt results
    const criterionInputs: CriterionReviewInput[] = rootContract.criteria.map(c => {
      const mappedChildren = childMappings
        .filter(m => m.supports_root_criteria.includes(c.id))
        .map(m => m.child_contract_id);

      const coverageHint: CriterionCoverageHint = !mappedChildren.length
        ? "gap"
        : "supported";

      const observedEvidence: string[] = [];
      const workerClaimIds: string[] = [];
      const failedOrInconclusiveChecks: string[] = [];
      const artifactObs: string[] = [];
      const retryLineageIds: string[] = [];

      for (const summary of childSummaries) {
        if (!summary.result) continue;

        // Collect evidence from attempt result criteria
        for (const cr of summary.result.criteria) {
          if (cr.criterion_id === c.id) {
            if (cr.status === "passed") {
              observedEvidence.push(...cr.evidence_ids);
            } else if (cr.status === "failed" || cr.status === "inconclusive") {
              failedOrInconclusiveChecks.push(...cr.evidence_ids);
            }
          }
        }

        // Worker claims
        for (const claim of summary.result.worker_report.claims) {
          if (!claim.criterion_id || claim.criterion_id === c.id) {
            workerClaimIds.push(`claim_${summary.result.attempt.id}_${claim.text.slice(0, 20)}`);
          }
        }

        // Artifact observations
        for (const art of summary.result.artifacts) {
          artifactObs.push(art.artifact_id);
        }
      }

      // Retry lineage: count attempts across all children mapping to this criterion
      for (const summary of childSummaries) {
        if (summary.attempts > 1) {
          retryLineageIds.push(`card_${summary.card_id}_${summary.attempts}_attempts`);
        }
      }

      return {
        criterion_id: c.id,
        description: c.description,
        evidence_expectation: c.evidence_expectation,
        mapped_child_contract_ids: mappedChildren,
        observed_evidence_ids: observedEvidence,
        worker_claim_ids: workerClaimIds,
        failed_or_inconclusive_check_ids: failedOrInconclusiveChecks,
        artifact_observation_ids: artifactObs,
        retry_lineage_ids: retryLineageIds,
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

    // Count total evidence references across all criterion inputs
    const evidenceRefCount = criterionInputs.reduce((sum, ci) => {
      return sum + ci.observed_evidence_ids.length + ci.failed_or_inconclusive_check_ids.length + ci.artifact_observation_ids.length;
    }, 0);

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
        limits: rootContract.limits,
      },
      criterion_inputs: criterionInputs,
      contradiction_candidates: contradictionCandidates,
      uncovered_criteria: uncoveredCriteria as string[],
      child_summaries: childSummaries,
      peer_contributions: contributions,
      budgets: {
        total_cost: undefined,
        total_tokens: project?.tokens_used ?? undefined,
        wall_clock_ms: project ? now - new Date(project.created_at + "Z").getTime() : 0,
        review_round: round,
        repair_round: supervision.repair_round,
      },
      evidence_ref_count: evidenceRefCount,
      contradiction_count: contradictionCandidates.length,
    };
  }
}
