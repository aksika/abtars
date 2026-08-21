import { describe, it, expect } from "vitest";
import {
  SHA_FINAL_REVIEW_CRITERION,
  SHA_STAGE_CRITERIA,
  SHA_STAGE_LIMITS,
  SHA_ROOT_LIMITS,
  SHA_WORKSPACE_ALIAS,
  artifactForStage,
  buildShaRootContract,
  buildShaWorkerContract,
  stagesForMode,
} from "./sha-stage-contracts.js";
import { validateContract, delegatedCriterionIds, type ProjectAcceptanceContractV2 } from "../project-acceptance/project-contract.js";

describe("stage sets and limits (R6)", () => {
  it("investigation stages are rca+design; full adds solution; off has none", () => {
    expect(stagesForMode("investigation")).toEqual(["rca", "design"]);
    expect(stagesForMode("full")).toEqual(["rca", "design", "solution"]);
    expect(stagesForMode("off")).toEqual([]);
  });

  it("exact fixed limits — never the old 30-minute SHA default", () => {
    expect(SHA_STAGE_LIMITS.rca).toEqual({ max_duration_ms: 600_000, max_tokens: 24_000 });
    expect(SHA_STAGE_LIMITS.design).toEqual({ max_duration_ms: 600_000, max_tokens: 24_000 });
    expect(SHA_STAGE_LIMITS.solution).toEqual({ max_duration_ms: 1_200_000, max_tokens: 48_000 });
    expect(SHA_ROOT_LIMITS.investigation.max_duration_ms).toBe(25 * 60_000);
    expect(SHA_ROOT_LIMITS.full.max_duration_ms).toBe(50 * 60_000);
    expect(SHA_ROOT_LIMITS.full.max_tokens).toBe(96_000);
  });
});

describe("root contract (R5)", () => {
  function build(mode: "investigation" | "full" = "full"): ProjectAcceptanceContractV2 {
    return buildShaRootContract({
      rootCardId: 42,
      mode,
      sourceScope: "daily-ai",
      fingerprintPrefix: "abcd1234",
      deadlineAt: Date.now() + SHA_ROOT_LIMITS[mode].max_duration_ms,
    });
  }

  it("validates through the existing project validator", () => {
    const contract = build();
    expect(validateContract(contract).ok).toBe(true);
    expect(contract.schema_version).toBe(2);
    expect(contract.digest).toHaveLength(64);
  });

  it("full mode has exactly the three stage criteria plus the Orc final review", () => {
    const contract = build("full");
    const ids = contract.criteria.map((c) => c.id);
    expect(ids).toEqual(["sha-rca", "sha-design", "sha-solution", SHA_FINAL_REVIEW_CRITERION]);
    const finalReview = contract.criteria.find((c) => c.id === SHA_FINAL_REVIEW_CRITERION);
    expect(finalReview?.execution_owner).toBe("orc");
    expect(contract.criteria.filter((c) => c.execution_owner === "delegated")).toHaveLength(3);
  });

  it("investigation omits the solution stage and never upgrades", () => {
    const contract = build("investigation");
    const ids = contract.criteria.map((c) => c.id);
    expect(ids).toEqual(["sha-rca", "sha-design", SHA_FINAL_REVIEW_CRITERION]);
    expect(contract.criteria.some((c) => c.id === "sha-solution")).toBe(false);
  });

  it("root limits are one review round, zero repairs, mode-specific caps", () => {
    const contract = build("full");
    expect(contract.limits.max_review_rounds).toBe(1);
    expect(contract.limits.max_repair_rounds).toBe(0);
    expect(contract.limits.max_tokens).toBe(SHA_ROOT_LIMITS.full.max_tokens);
    expect(contract.limits.hard_deadline_at).toBeDefined();
  });

  it("delegated criteria are exactly the stage criteria (legal mapping targets)", () => {
    const contract = build("full");
    expect([...delegatedCriterionIds(contract)].sort()).toEqual(["sha-design", "sha-rca", "sha-solution"]);
  });
});

describe("worker contracts (R5)", () => {
  it("binds the pre-created card, maps exactly its root criterion, and validates", () => {
    const spec = buildShaWorkerContract({
      rootCardId: 42,
      cardId: 43,
      stage: "rca",
      contractId: "sha-contract-rca",
      sourceScope: "daily-ai",
      fingerprintPrefix: "abcd1234",
    });
    expect(spec.createChildOpts.cardId).toBe(43);
    expect(spec.createChildOpts.workspaceAlias).toBe(SHA_WORKSPACE_ALIAS);
    expect(spec.createChildOpts.supportsRootCriteria).toEqual([SHA_STAGE_CRITERIA.rca]);
    expect(spec.createChildOpts.limits).toEqual(SHA_STAGE_LIMITS.rca);
    expect(spec.createChildOpts.expectedArtifacts).toEqual([
      { id: "sha-rca-json", kind: "file", ref: "sha/rca.json", required: true, criterion_ids: ["sha-rca"] },
    ]);
    expect(spec.rawGoal).toContain("stage: rca");
  });

  it("solution includes the verification artifact", () => {
    const spec = buildShaWorkerContract({
      rootCardId: 42,
      cardId: 44,
      stage: "solution",
      contractId: "sha-contract-sol",
      sourceScope: "daily-ai",
      fingerprintPrefix: "abcd1234",
    });
    const refs = spec.createChildOpts.expectedArtifacts.map((a) => a.ref);
    expect(refs).toContain("sha/solution.patch");
    expect(refs).toContain("sha/verification.json");
    expect(spec.createChildOpts.limits).toEqual(SHA_STAGE_LIMITS.solution);
  });

  it("carries accepted predecessor evidence into the goal", () => {
    const spec = buildShaWorkerContract({
      rootCardId: 42,
      cardId: 45,
      stage: "design",
      contractId: "sha-contract-design",
      sourceScope: "daily-ai",
      fingerprintPrefix: "abcd1234",
      predecessorEvidence: { stage: "rca", artifactRef: "sha/rca.json", digest: "deadbeef" },
    });
    expect(spec.rawGoal).toContain("Accepted predecessor evidence (rca)");
    expect(spec.rawGoal).toContain("sha/rca.json");
    expect(spec.rawGoal).toContain("deadbeef");
  });

  it("artifact refs are relative and bounded", () => {
    expect(artifactForStage("rca").ref).toBe("sha/rca.json");
    expect(artifactForStage("design").ref).toBe("sha/design.md");
    expect(artifactForStage("solution").ref).toBe("sha/solution.patch");
  });
});