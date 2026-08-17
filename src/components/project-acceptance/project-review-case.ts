import { ProjectReviewStore } from "./project-review-store.js";
import type { ProjectAcceptanceContract } from "./project-contract.js";
import { criterionPolicyView, validateContract } from "./project-contract.js";
import { readProjectCriterionCoverage } from "./project-criterion-coverage.js";
import { WorkerSupervisionService } from "../worker-supervision-service.js";
import { WorkerSupervisionStore } from "../worker-supervision-store.js";
import type { WorkerResultEnvelopeV1 } from "../worker-contract.js";
import { redactEnvelope, acceptancePassed } from "../worker-contract.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { ExecutorKind } from "../worker-executor-identity.js";
import { REVIEW_ACTIONS, CRITERION_VERDICTS, OUTPUT_DISPOSITIONS, CONTRADICTION_DISPOSITIONS } from "./project-review-contract.js";
import { logAndSwallow } from "../log-and-swallow.js";

const TAG = "project-review-case";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CriterionCoverageHint = "supported" | "conflicting" | "gap" | "orc_owned" | "failed";

export interface CriterionReviewInput {
  criterion_id: string;
  description: string;
  /** #1605: durable policy fields carried into the immutable case */
  required: boolean;
  execution_owner: "delegated" | "orc";
  evidence_expectation: "observed" | "artifact" | "synthesis";
  mapped_child_contract_ids: string[];
  /** #1656: contract ids of mapped children whose latest attempt/card/envelope
   * is terminal-successful. Only these produce positive evidence. */
  successful_mapped_child_contract_ids: string[];
  /** #1656: contract ids of mapped children that are missing, failed,
   * incomplete, or stale. These produce negative evidence only. */
  unsuccessful_mapped_child_contract_ids: string[];
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
    executor_kind: ExecutorKind | "unknown";
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

interface MappedChildSummary {
  card_status: string;
  outcome: string;
  result?: WorkerResultEnvelopeV1;
  contract?: WorkerAcceptanceContractV1;
}

/**
 * #1656: a mapped child is successful evidence only when its latest attempt
 * lifecycle AND card are terminal-successful, its envelope outcome is
 * `completed`, and every criterion declared by that exact contract is present
 * once and passed (`acceptancePassed`). Child criterion ids are never compared
 * to root criterion ids.
 */
function isSuccessfulChild(summary: MappedChildSummary): boolean {
  if (summary.card_status !== "done" && summary.card_status !== "delivered") return false;
  if (summary.outcome !== "completed") return false;
  if (!summary.result || summary.result.outcome !== "completed") return false;
  if (!summary.contract) return false;
  return acceptancePassed(summary.contract, summary.result);
}

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
    } catch (err) { logAndSwallow(TAG, "enrich review case with kanban contributions", err); }

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
    } catch (err) { logAndSwallow(TAG, "enrich review case with peer contributions", err); }

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
      executor_kind: ExecutorKind | "unknown";
      card_status: string;
      result?: WorkerResultEnvelopeV1;
      /** #1656: the parsed exact contract — never compared to root criterion ids. */
      contract?: import("../worker-contract.js").WorkerAcceptanceContractV1;
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
        card_status: child.status,
        result: envelope ? redactEnvelope(envelope) : undefined,
        contract,
      });
    }

    // Compute coverage from the read-model (already fail-closed above)
    const uncoveredCriteria = coverage.read.uncovered;

    // Build per-criterion review input with evidence from attempt results.
    // #1605: policy (required/execution_owner) and coverage state come from
    // the read-model rows, never inferred here.
    // #1656: evidence is contract-level — a mapped child contract supports
    // the root criterion as a whole; child criterion ids are NEVER compared
    // to root criterion ids.
    const criterionInputs: CriterionReviewInput[] = coverageCriteria.map(cov => {
      const policy = rootPolicy.find(p => p.id === cov.criterionId)!;
      const mappedContractIds = cov.mappedContractIds;

      const successfulContractIds: string[] = [];
      const unsuccessfulContractIds: string[] = [];
      const observedEvidence: string[] = [];
      const workerClaimIds: string[] = [];
      const failedOrInconclusiveChecks: string[] = [];
      const artifactObs: string[] = [];
      const retryLineageIds: string[] = [];

      for (const mappedContractId of mappedContractIds) {
        // Peer mappings are claims, never child evidence — they do not
        // classify as successful/unsuccessful child contracts.
        if (mappedContractId.startsWith("peer:")) continue;
        const matched = childSummaries.filter(s => s.contract_id === mappedContractId);
        const successes = matched.filter(s => isSuccessfulChild(s));
        if (successes.length > 0) successfulContractIds.push(mappedContractId);
        if (matched.length === 0 || successes.length < matched.length) unsuccessfulContractIds.push(mappedContractId);
      }

      for (const summary of childSummaries) {
        if (!summary.contract) continue;
        if (!mappedContractIds.includes(summary.contract.id)) continue;
        if (summary.contract.id.startsWith("peer:")) continue;

        if (summary.attempts > 1) {
          retryLineageIds.push(`card_${summary.card_id}_${summary.attempts}_attempts`);
        }

        if (!summary.result) continue;

        const attemptId = summary.result.attempt.id;
        const checkIds = new Set(summary.result.checks.map(c => c.check_id));
        const qualify = (id: string): string => checkIds.has(id)
          ? `attempt:${attemptId}:check:${id}`
          : `attempt:${attemptId}:artifact:${id}`;

        // Worker claims are claims — they never enter compatible evidence.
        for (const claim of summary.result.worker_report.claims) {
          workerClaimIds.push(`claim_${attemptId}_${claim.text.slice(0, 20)}`);
        }

        if (isSuccessfulChild(summary)) {
          // Positive evidence: passed-check ids and existing-artifact ids
          // from a successful mapped child only.
          for (const cr of summary.result.criteria) {
            if (cr.status !== "passed") continue;
            for (const eid of cr.evidence_ids) {
              if (checkIds.has(eid)) observedEvidence.push(`attempt:${attemptId}:check:${eid}`);
            }
          }
          for (const art of summary.result.artifacts) {
            if (art.exists) artifactObs.push(`attempt:${attemptId}:artifact:${art.artifact_id}`);
          }
        } else {
          // Negative evidence: failed/inconclusive checks and missing
          // artifacts from an unsuccessful mapped child. The same qualified
          // id may be cited by criterion evidence and the artifact observation
          // — dedupe so each piece of evidence appears once.
          const negative = new Set<string>();
          for (const cr of summary.result.criteria) {
            if (cr.status !== "passed" && cr.status !== "not_run") {
              for (const eid of cr.evidence_ids) negative.add(qualify(eid));
            }
          }
          for (const art of summary.result.artifacts) {
            if (!art.exists) negative.add(`attempt:${attemptId}:artifact:${art.artifact_id}`);
          }
          failedOrInconclusiveChecks.push(...negative);
        }
      }

      // #1656: semantic hint from the mapped-child classification. The
      // structural `mapped`/`gap` state remains the pre-review gate; this
      // hint is the review-time semantic truth.
      let coverageHint: CriterionCoverageHint;
      if (cov.state === "orc_owned") {
        coverageHint = "orc_owned";
      } else if (cov.state === "gap") {
        coverageHint = "gap";
      } else if (successfulContractIds.length > 0 && unsuccessfulContractIds.length > 0) {
        coverageHint = "conflicting";
      } else if (successfulContractIds.length > 0) {
        coverageHint = "supported";
      } else {
        coverageHint = "failed";
      }

      return {
        criterion_id: policy.id,
        description: policy.description,
        required: policy.required,
        execution_owner: policy.execution_owner,
        evidence_expectation: policy.evidence_expectation,
        mapped_child_contract_ids: [...mappedContractIds],
        successful_mapped_child_contract_ids: successfulContractIds,
        unsuccessful_mapped_child_contract_ids: unsuccessfulContractIds,
        observed_evidence_ids: observedEvidence,
        worker_claim_ids: workerClaimIds,
        failed_or_inconclusive_check_ids: failedOrInconclusiveChecks,
        artifact_observation_ids: artifactObs,
        retry_lineage_ids: retryLineageIds,
        coverage_hint: coverageHint,
      };
    });

    // #1656: contradiction candidates use the same envelope-based semantic
    // classification — one successful mapped child plus one unsuccessful
    // mapped child is conflicting. Sources name card and contract ids.
    const contradictionCandidates: ContradictionCandidate[] = [];
    for (const input of criterionInputs) {
      if (input.coverage_hint !== "conflicting") continue;
      const sources: string[] = [];
      const evidenceIds: string[] = [];
      for (const summary of childSummaries) {
        if (!summary.contract || !input.mapped_child_contract_ids.includes(summary.contract.id)) continue;
        if (summary.contract.id.startsWith("peer:")) continue;
        sources.push(`card:${summary.card_id}:${summary.contract.id}`);
        if (isSuccessfulChild(summary) && summary.result) {
          const attemptId = summary.result.attempt.id;
          const checkIds = new Set(summary.result.checks.map(c => c.check_id));
          for (const cr of summary.result.criteria) {
            if (cr.status !== "passed") continue;
            for (const eid of cr.evidence_ids) {
              if (checkIds.has(eid)) evidenceIds.push(`attempt:${attemptId}:check:${eid}`);
            }
          }
        }
      }
      contradictionCandidates.push({
        id: `cc_${input.criterion_id}_${round}`,
        affected_criterion_ids: [input.criterion_id],
        description: `Conflicting outcomes for criterion "${input.criterion_id}": some mapped children passed, others failed`,
        evidence_ids: evidenceIds,
        sources,
      });
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

// ── Decision-ready brief projection (#1620) ───────────────────────────────────
// A bounded, side-effect-free read over the immutable case snapshot. Facts
// come only from the stored case JSON and shared typed constants — never from
// Worker or peer tables, and never from free-form prose that could drift from
// the validator's enums.

export interface ProjectReviewChildBriefV1 {
  card_id: number;
  contract_id: string;
  outcome: string;
  criterion_statuses: Array<{ criterion_id: string; status: string }>;
  attempts: number;
  executor_kind: ExecutorKind | "unknown";
}

export interface ProjectReviewBriefV1 {
  schema_version: 1;
  project_card_id: number;
  project_generation: number;
  review_case_id: string;
  round: number;
  goal: string;
  criteria: Array<{
    criterion_id: string;
    description: string;
    required: boolean;
    execution_owner: "delegated" | "orc";
    evidence_expectation: "observed" | "artifact" | "synthesis";
    coverage_hint: CriterionCoverageHint;
    successful_mapped_child_contract_ids: string[];
    unsuccessful_mapped_child_contract_ids: string[];
    compatible_evidence: {
      observed: string[];
      failed_or_inconclusive: string[];
      artifacts: string[];
    };
  }>;
  outputs: Array<{ output_id: string; description: string; kind: string; required: boolean }>;
  contradictions: ContradictionCandidate[];
  children: ProjectReviewChildBriefV1[];
  /** #1433/#1493: peer claims are claims, never requester-observed evidence. */
  peer_claims: ReviewCaseSnapshot["peer_contributions"];
  uncovered_criteria: string[];
  budgets: ReviewCaseSnapshot["budgets"];
  legal_values: {
    actions: readonly string[];
    criterion_verdicts: readonly string[];
    output_dispositions: readonly string[];
    contradiction_dispositions: readonly string[];
  };
  decision_skeleton: unknown;
}

const BRIEF_GOAL_MAX = 1000;
const BRIEF_DESCRIPTION_MAX = 300;

function truncateProse(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(max - 3, 0))}...`;
}

/**
 * Project the immutable open review case into a decision-ready brief.
 * The caller (the Orc tool boundary) owns ownership/generation/status checks;
 * this projection is pure after the row is loaded.
 */
export function projectReviewBrief(
  caseId: string,
  store = new ProjectReviewStore(),
): { ok: true; brief: ProjectReviewBriefV1 }
  | { ok: false; code: "review_case_unknown" | "review_case_not_open" | "review_case_unreadable"; error: string } {
  const row = store.getReviewCase(caseId);
  if (!row) return { ok: false, code: "review_case_unknown", error: `review case "${caseId}" not found` };
  if (row.status !== "open") return { ok: false, code: "review_case_not_open", error: `review case "${caseId}" is ${row.status}, not open` };

  let snapshot: ReviewCaseSnapshot;
  try {
    snapshot = JSON.parse(row.case_json) as ReviewCaseSnapshot;
  } catch {
    return { ok: false, code: "review_case_unreadable", error: "review case snapshot is unparseable" };
  }
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.project_card_id === undefined ||
      snapshot.project_card_id !== row.project_card_id || snapshot.generation !== row.generation) {
    return { ok: false, code: "review_case_unreadable", error: "review case snapshot is structurally invalid" };
  }

  // The immutable snapshot is trusted by the TypeScript type only after the
  // JSON parse. A corrupt-but-parseable row can still have the four identity
  // fields above while omitting a nested array/object; keep those failures in
  // the typed unreadable outcome instead of letting them escape as an
  // internal_error from the tool boundary.
  try {
    const policyByCriterionId = new Map(snapshot.criterion_inputs.map(ci => [ci.criterion_id, ci]));

    const criteria = snapshot.root_contract.criteria.map(c => {
      const input = policyByCriterionId.get(c.id);
      return {
        criterion_id: c.id,
        description: truncateProse(c.description, BRIEF_DESCRIPTION_MAX),
        required: c.required,
        execution_owner: c.execution_owner,
        evidence_expectation: c.evidence_expectation,
        coverage_hint: input?.coverage_hint ?? (c.execution_owner === "orc" ? "orc_owned" : "gap"),
        successful_mapped_child_contract_ids: [...(input?.successful_mapped_child_contract_ids ?? [])],
        unsuccessful_mapped_child_contract_ids: [...(input?.unsuccessful_mapped_child_contract_ids ?? [])],
        compatible_evidence: {
          observed: [...(input?.observed_evidence_ids ?? [])],
          failed_or_inconclusive: [...(input?.failed_or_inconclusive_check_ids ?? [])],
          artifacts: [...(input?.artifact_observation_ids ?? [])],
        },
      };
    });

    const outputs = snapshot.root_contract.required_outputs.map(o => ({
      output_id: o.id,
      description: truncateProse(o.description, BRIEF_DESCRIPTION_MAX),
      kind: o.kind,
      required: o.required,
    }));

    // The immutable assembler keeps the full redacted Worker envelope on the
    // stored snapshot for local evidence derivation. It is not part of the
    // decision-ready child summary: project only the metadata fields declared by
    // the brief so raw checks, argv/cwd, artifacts, and Worker prose never cross
    // the Orc review tool boundary.
    const children: ProjectReviewChildBriefV1[] = snapshot.child_summaries.map(child => ({
      card_id: child.card_id,
      contract_id: child.contract_id,
      outcome: truncateProse(child.outcome, 64),
      criterion_statuses: child.criterion_statuses.map(status => ({
        criterion_id: status.criterion_id,
        status: truncateProse(status.status, 64),
      })),
      attempts: child.attempts,
      executor_kind: truncateProse(child.executor_kind, 64) as ExecutorKind | "unknown",
    }));

    const contradictions: ContradictionCandidate[] = snapshot.contradiction_candidates.map(candidate => ({
      id: candidate.id,
      affected_criterion_ids: [...candidate.affected_criterion_ids],
      description: truncateProse(candidate.description, BRIEF_DESCRIPTION_MAX),
      evidence_ids: [...candidate.evidence_ids],
      sources: [...candidate.sources],
    }));

    // Peer rows are explicitly claims. Preserve their stored references and
    // bound their prose/metadata before exposing them to the provider.
    const peerClaims: ProjectReviewBriefV1["peer_claims"] = snapshot.peer_contributions.map(claim => ({
      card_id: claim.card_id,
      peer: truncateProse(claim.peer, 128),
      outcome: truncateProse(claim.outcome, 64),
      projection_summary: truncateProse(claim.projection_summary, 200),
      root_criteria: [...claim.root_criteria],
      provenance: truncateProse(claim.provenance, 1000),
    }));

    const decisionSkeleton = {
      project_card_id: snapshot.project_card_id,
      project_generation: snapshot.generation,
      review_case_id: row.id,
      criteria: snapshot.root_contract.criteria.map(c => ({
        criterion_id: c.id,
        verdict: null,
        evidence_ids: [],
        rationale: "",
      })),
      outputs: outputs.map(o => ({ output_id: o.output_id, disposition: null, evidence_ids: [] })),
      contradictions: [],
      residual_risks: [],
      synthesis: "",
    };

    return {
      ok: true,
      brief: {
        schema_version: 1,
        project_card_id: snapshot.project_card_id,
        project_generation: snapshot.generation,
        review_case_id: row.id,
        round: snapshot.round,
        goal: truncateProse(snapshot.root_contract.goal, BRIEF_GOAL_MAX),
        criteria,
        outputs,
        contradictions,
        children,
        peer_claims: peerClaims,
        uncovered_criteria: [...snapshot.uncovered_criteria],
        budgets: snapshot.budgets,
        legal_values: {
          actions: REVIEW_ACTIONS,
          criterion_verdicts: CRITERION_VERDICTS,
          output_dispositions: OUTPUT_DISPOSITIONS,
          contradiction_dispositions: CONTRADICTION_DISPOSITIONS,
        },
        decision_skeleton: decisionSkeleton,
      },
    };
  } catch {
    return { ok: false, code: "review_case_unreadable", error: "review case snapshot is structurally invalid" };
  }
}
