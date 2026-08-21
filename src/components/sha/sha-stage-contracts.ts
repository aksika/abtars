/**
 * sha-stage-contracts.ts — deterministic SHA root and stage contracts
 * (#1688 Task 4). Centralizes the fixed per-stage limits (R6), the normalized
 * v2 root acceptance contract, and the Worker contract specs. Every generated
 * contract passes through the existing project/Worker validators — no SHA-only
 * validation exceptions.
 */
import { createContractId, normalizeContract } from "../project-acceptance/project-contract.js";
import type { CriterionExecutionOwner, EvidenceExpectation, ProjectAcceptanceContractV2 } from "../project-acceptance/project-contract.js";
import type { SelfHealMode } from "./sha-types.js";

export const SHA_WORKSPACE_ALIAS = "sha";

export type ShaStage = "rca" | "design" | "solution";

export const SHA_STAGE_CRITERIA: Readonly<Record<ShaStage, string>> = {
  rca: "sha-rca",
  design: "sha-design",
  solution: "sha-solution",
};

export const SHA_FINAL_REVIEW_CRITERION = "sha-final-review";

/** R6: fixed worker stage limits — never inherit the old 30-minute SHA value. */
export const SHA_STAGE_LIMITS: Readonly<Record<ShaStage, { max_duration_ms: number; max_tokens: number }>> = {
  rca: { max_duration_ms: 600_000, max_tokens: 24_000 },
  design: { max_duration_ms: 600_000, max_tokens: 24_000 },
  solution: { max_duration_ms: 1_200_000, max_tokens: 48_000 },
};

/** R6: mode-specific root caps; deadlines are computed at admission. */
export const SHA_ROOT_LIMITS: Readonly<Record<"investigation" | "full", { max_duration_ms: number; max_tokens: number }>> = {
  investigation: { max_duration_ms: 25 * 60_000, max_tokens: 48_000 },
  full: { max_duration_ms: 50 * 60_000, max_tokens: 96_000 },
};

/** #1688 R5: stage sets per captured mode. Investigation never upgrades. */
export function stagesForMode(mode: SelfHealMode): readonly ShaStage[] {
  if (mode === "investigation") return ["rca", "design"];
  if (mode === "full") return ["rca", "design", "solution"];
  return [];
}

export interface ShaArtifactSpec {
  id: string;
  kind: "file";
  ref: string;
}

export function artifactForStage(stage: ShaStage): ShaArtifactSpec {
  switch (stage) {
    case "rca": return { id: "sha-rca-json", kind: "file", ref: "sha/rca.json" };
    case "design": return { id: "sha-design-md", kind: "file", ref: "sha/design.md" };
    case "solution": return { id: "sha-solution-patch", kind: "file", ref: "sha/solution.patch" };
  }
}

export function solutionVerificationArtifact(): ShaArtifactSpec {
  return { id: "sha-verification-json", kind: "file", ref: "sha/verification.json" };
}

const STAGE_GOALS: Readonly<Record<ShaStage, string>> = {
  rca: `Root-cause analysis. Produce sha/rca.json with: summary, causal chain, confidence,
affected surfaces, reproduction evidence, and unresolved questions. Read-only analysis:
do NOT modify any file in the workspace. The workspace starts at the baseline commit and
must end byte-identical (git status --porcelain empty).`,
  design: `Implementation design. Produce sha/design.md covering ownership, interfaces,
state transitions, race precedence, failure/cleanup behavior, files to change, and tests.
Design is proposal-only and must not modify any workspace file beyond the single
sha/design.md output.`,
  solution: `Solution preparation in the isolated disposable workspace. Produce
sha/solution.patch (a bounded git diff against the baseline) plus sha/verification.json
listing verification commands, exit status, bounded output digest, and unresolved risk.
Never apply the patch to the canonical checkout, mutate live configuration, or deploy.`,
};

const STAGE_CRITERIA_DESCRIPTIONS: Readonly<Record<ShaStage, string>> = {
  rca: "Evidence-backed root-cause analysis artifact sha/rca.json with all required sections; zero workspace mutation.",
  design: "Implementation design sha/design.md covering the required sections; zero workspace mutation beyond the output.",
  solution: "Bounded solution patch sha/solution.patch plus verification report sha/verification.json; canonical/live files untouched.",
};

export interface RootContractInput {
  rootCardId: number;
  mode: "investigation" | "full";
  sourceScope: string;
  fingerprintPrefix: string;
  deadlineAt: number;
}

/** R5: pre-authored v2 project acceptance contract — no Orc authoring turn. */
export function buildShaRootContract(input: RootContractInput): ProjectAcceptanceContractV2 {
  const stages = stagesForMode(input.mode);
  const criteria: Array<{
    id: string;
    description: string;
    required: boolean;
    execution_owner: CriterionExecutionOwner;
    evidence_expectation: EvidenceExpectation;
  }> = stages.map((stage) => ({
    id: SHA_STAGE_CRITERIA[stage],
    description: STAGE_CRITERIA_DESCRIPTIONS[stage],
    required: true,
    execution_owner: "delegated",
    evidence_expectation: "artifact",
  }));
  criteria.push({
    id: SHA_FINAL_REVIEW_CRITERION,
    description: "Orc-owned terminal synthesis: all delegated stage artifacts present, stage ordering respected, executor provenance recorded, no canonical/live/runtime writes, unresolved risk stated.",
    required: true,
    execution_owner: "orc",
    evidence_expectation: "synthesis",
  });
  const outputs = stages.map((stage) => {
    const artifact = artifactForStage(stage);
    return { id: artifact.id, description: STAGE_CRITERIA_DESCRIPTIONS[stage], kind: "file" as const, required: true };
  });

  const raw = {
    schema_version: 2,
    id: createContractId("sha"),
    project_card_id: input.rootCardId,
    goal: `SHA incident (${input.sourceScope}, fingerprint ${input.fingerprintPrefix}…). Mode ${input.mode}. Stage workers produce accepted evidence sequentially; the Orc final review is the terminal authority with one review round and zero repair rounds.`,
    criteria,
    required_outputs: outputs,
    constraints: [
      "Never modify the canonical checkout, live configuration, secrets, peers, or runtime state.",
      "Every stage runs inside the disposable sha workspace; solution output is proposal-only.",
      "A rejected or inconclusive final review blocks the incident; no autonomous repair rounds.",
    ],
    limits: {
      hard_deadline_at: new Date(input.deadlineAt).toISOString(),
      max_tokens: SHA_ROOT_LIMITS[input.mode].max_tokens,
      max_review_rounds: 1,
      max_repair_rounds: 0,
    },
    provenance: {
      requested_by: "sha",
      authored_by: "sha-coordinator",
      created_at: new Date().toISOString(),
    },
  };
  const normalized = normalizeContract(raw);
  if (!normalized.ok) {
    throw new Error(`SHA root contract validation failed: ${normalized.errors.map((e) => e.message).join("; ")}`);
  }
  return normalized.contract;
}

export interface PredecessorEvidence {
  stage: ShaStage;
  artifactRef: string;
  digest: string;
}

export interface WorkerContractInput {
  rootCardId: number;
  cardId: number;
  stage: ShaStage;
  contractId: string;
  sourceScope: string;
  fingerprintPrefix: string;
  predecessorEvidence?: PredecessorEvidence;
}

export interface WorkerContractSpec {
  rawGoal: string;
  createChildOpts: {
    cardId: number;
    criteria: Array<{ id: string; description: string }>;
    expectedArtifacts: Array<{ id: string; kind: "file"; ref: string; required: boolean; criterion_ids: string[] }>;
    supportsRootCriteria: string[];
    limits: { max_duration_ms: number; max_tokens: number };
    workspaceAlias: "sha";
    contractId: string;
    source?: string;
    title?: string;
  };
}

/** #1688 R5: deterministic Worker contract bound to its pre-created card. */
export function buildShaWorkerContract(input: WorkerContractInput): WorkerContractSpec {
  const criterionId = SHA_STAGE_CRITERIA[input.stage];
  const artifact = artifactForStage(input.stage);
  const artifacts: Array<{ id: string; kind: "file"; ref: string; required: boolean; criterion_ids: string[] }> = [
    { id: artifact.id, kind: "file", ref: artifact.ref, required: true, criterion_ids: [criterionId] },
  ];
  if (input.stage === "solution") {
    const verification = solutionVerificationArtifact();
    artifacts.push({ id: verification.id, kind: "file", ref: verification.ref, required: true, criterion_ids: [criterionId] });
  }
  const predecessor = input.predecessorEvidence
    ? `\nAccepted predecessor evidence (${input.predecessorEvidence.stage}): artifact ${input.predecessorEvidence.artifactRef}, digest ${input.predecessorEvidence.digest}. Build on it; do not redo it.`
    : "";
  const goal = `SHA incident ${input.sourceScope} (fingerprint ${input.fingerprintPrefix}…) — stage: ${input.stage}.${predecessor}\n\n${STAGE_GOALS[input.stage]}`;
  return {
    rawGoal: goal,
    createChildOpts: {
      cardId: input.cardId,
      criteria: [{ id: criterionId, description: STAGE_CRITERIA_DESCRIPTIONS[input.stage] }],
      expectedArtifacts: artifacts,
      supportsRootCriteria: [criterionId],
      limits: SHA_STAGE_LIMITS[input.stage],
      workspaceAlias: SHA_WORKSPACE_ALIAS,
      contractId: input.contractId,
      source: "sha",
      title: `SHA ${input.stage}: ${input.sourceScope.slice(0, 40)}`,
    },
  };
}