import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectAcceptanceContract } from "./project-contract.js";
import { criterionPolicyView, validateContract } from "./project-contract.js";
import { readProjectCriterionCoverage } from "./project-criterion-coverage.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { redactEnvelope } from "../worker-contract.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CriterionCoverageHint = "supported" | "conflicting" | "gap" | "orc_owned";

export interface CriterionReviewInput {
  criterion_id: string;
  description: string;
  /** #1605: durable policy fields carried into the immutable case */
  required: boolean;
  execution_owner: "delegated" | "orc";
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
      required: boolean;
      execution_owner: "delegated" | "orc";
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

  /** #1433/#1493: Peer contribution cards linked to this project — claims, not observations */
  peer_contributions: readonly {
    card_id: number;
    peer: string;
    outcome: string;
    projection_summary: string;
    root_criteria: readonly string[];
    provenance: string;
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

    // Parse and validate before projecting policy fields. Coverage also reads
    // the contract fail-closed, but doing this first prevents a JSON-valid yet
    // structurally corrupt record from throwing while the assembler calls
    // criterionPolicyView.
    let rootContract: ProjectAcceptanceContract;
    try {
      const parsedContract = JSON.parse(contractRow.contract_json) as unknown;
      const validated = validateContract(parsedContract);
      if (!validated.ok) {
        return { error: `root contract for project ${projectCardId} is invalid: ${validated.errors.map(e => e.message).join("; ")}` };
      }
      rootContract = validated.contract;
    } catch {
      return { error: `root contract for project ${projectCardId} is unparseable` };
    }
    const rootPolicy = criterionPolicyView(rootContract);
    const supervision = this.reviewStore.getSupervision(projectCardId);
    if (!supervision) return { error: `no supervision state for project ${projectCardId}` };

    // Load children via ESM dynamic import (vitest mock intercepts these)
    const { kanbanGetChildren } = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
    const children = kanbanGetChildren(projectCardId);

    // Also gather peer contribution cards linked to this project
    const contributions: Array<{ card_id: number; peer: string; outcome: string; projection_summary: string; root_criteria: readonly string[]; provenance: string }> = [];
    try {
      const { kanbanList } = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
      const peerCards = kanbanList("done", undefined).filter(c => c.source === "peer" && c.type === "contribution");
      for (const pc of peerCards) {
        const notes = pc.notes ? (() => { try { return JSON.parse(pc.notes) as Record<string, unknown>; } catch { return {}; } })() : {};
        if (notes.parent_project_id === projectCardId || (pc.parent_id === projectCardId)) {
          const projection = notes.projection ? (typeof notes.projection === "string" ? notes.projection : JSON.stringify(notes.projection)) : (pc.result_summary ?? "");
          const rootCriteria: string[] = Array.isArray(notes.root_criteria) ? notes.root_criteria as string[] : [];
          contributions.push({
            card_id: pc.id,
            peer: pc.source_peer ?? (typeof notes.peer === "string" ? notes.peer : "unknown"),
            outcome: pc.status,
            projection_summary: projection.slice(0, 200),
            root_criteria: rootCriteria,
            provenance: (typeof notes.provenance === "object" && notes.provenance !== null) ? JSON.stringify(notes.provenance) : "",
          });
        }
      }
    } catch {}

    try {
      const { requireTaskDatabase } = await import("../tasks/kanban-board.js") as typeof import("../tasks/kanban-board.js");
      const db = requireTaskDatabase();
      const rows = db.prepare(
        "SELECT peer, proxy_card_id, state, projection_json, root_criteria_json FROM peer_contributions WHERE project_card_id = ? AND proxy_card_id IS NOT NULL AND state IN ('completed','failed','declined','deferred')",
      ).all(projectCardId) as Array<{ peer: string; proxy_card_id: number | null; state: string; projection_json: string | null; root_criteria_json: string | null }>;
      for (const r of rows) {
        if (!contributions.some(c => r.proxy_card_id && c.card_id === r.proxy_card_id)) {
          const projection = r.projection_json ? (() => { try { return JSON.parse(r.projection_json) as Record<string, unknown>; } catch { return null; } })() : null;
          const provenance = projection?.provenance ? JSON.stringify(projection.provenance) : "";
          const rootCriteria: string[] = r.root_criteria_json ? (() => { try { return JSON.parse(r.root_criteria_json) as string[]; } catch { return []; } })() : [];
          contributions.push({
            card_id: r.proxy_card_id ?? 0,
            peer: r.peer,
            outcome: r.state,
            projection_summary: r.projection_json ? r.projection_json.slice(0, 200) : "",
            root_criteria: rootCriteria,
            provenance,
          });
        }
      }
    } catch {}

    // #1605: the coverage read-model is the single source of truth for
    // ownership, child→root mappings, and the uncovered set. The assembler
    // consumes CoverageRead.criteria; it never independently infers ownership
    // or recalculates gaps. An undeterminable read (unparseable contract)
    // fails the assembly instead of silently treating the project as covered.
    const coverage = readProjectCriterionCoverage(projectCardId);
    if (coverage.kind === "undeterminable" || coverage.kind === "no_project_contract") {
      return { error: coverage.kind === "undeterminable" ? coverage.reason : `no root contract for project ${projectCardId}` };
    }
    const coverageCriteria = coverage.read.criteria;

    // Gather child summaries, results, and evidence
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

    // Compute coverage from the read-model (already fail-closed above)
    const uncoveredCriteria = coverage.read.uncovered;

    // Build per-criterion review input with evidence from attempt results.
    // #1605: policy (required/execution_owner) and coverage state come from
    // the read-model rows, never inferred here.
    const criterionInputs: CriterionReviewInput[] = coverageCriteria.map(cov => {
      const policy = rootPolicy.find(p => p.id === cov.criterionId)!;
      const mappedChildren = cov.mappedContractIds;

      const coverageHint: CriterionCoverageHint = cov.state === "orc_owned"
        ? "orc_owned"
        : cov.state === "mapped"
          ? "supported"
          : "gap";

      const observedEvidence: string[] = [];
      const workerClaimIds: string[] = [];
      const failedOrInconclusiveChecks: string[] = [];
      const artifactObs: string[] = [];
      const retryLineageIds: string[] = [];

      for (const summary of childSummaries) {
        if (!summary.result) continue;

        // Collect evidence from attempt result criteria
        for (const cr of summary.result.criteria) {
          if (cr.criterion_id === policy.id) {
            if (cr.status === "passed") {
              observedEvidence.push(...cr.evidence_ids);
            } else if (cr.status === "failed" || cr.status === "inconclusive") {
              failedOrInconclusiveChecks.push(...cr.evidence_ids);
            }
          }
        }

        // Worker claims
        for (const claim of summary.result.worker_report.claims) {
          if (!claim.criterion_id || claim.criterion_id === policy.id) {
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
        criterion_id: policy.id,
        description: policy.description,
        required: policy.required,
        execution_owner: policy.execution_owner,
        evidence_expectation: policy.evidence_expectation,
        mapped_child_contract_ids: [...mappedChildren],
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
        criteria: rootPolicy,
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
