import { describe, it, expect } from "vitest";
import { buildDirective, deriveContractRevision, validateDirective, validateContractRevision, computeDirectiveFingerprint } from "./retry-directive.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";

const sampleContract: WorkerAcceptanceContractV1 = {
  schema_version: 1,
  id: "c_test_1",
  digest: "abc123",
  goal: "Build a login page",
  criteria: [{ id: "c1", description: "Page renders" }, { id: "c2", description: "Form submits" }],
  expected_artifacts: [{ id: "a1", kind: "file", ref: "src/login.tsx", required: true, criterion_ids: ["c1"] }],
  verification_commands: [{ id: "v1", argv: ["npm", "test"], timeout_ms: 30000, criterion_ids: ["c1"] }],
  required_capabilities: ["code"],
  limits: { max_duration_ms: 600000 },
  provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
};

const sampleClassification = {
  schema_version: 1 as const,
  id: "fc_test_1",
  attempt_id: "a_test_1",
  input_digest: "digest1",
  primary: "acceptance_unmet" as const,
  factors: [],
  evidence_ids: ["env:a_test_1"],
  stable_codes: [],
  confidence: "observed" as const,
  retryability: "review_required" as const,
  recommended_actions: ["repair strategy"],
  classifier_version: "v1",
  created_at: new Date().toISOString(),
};

const sampleDecision = {
  sourceAttemptId: "a_test_1",
  disposition: "orc_review" as const,
  reasonCode: "acceptance_unmet:semantic_failure",
  earliestAt: undefined,
  remaining: { attemptsUsed: 1, attemptsRemaining: 4, sameClassUsed: 1, sameExecutorConsecutiveFailures: 1, executorSwitchesUsed: 0, elapsedMs: 1000, tokensUsed: 0, costUsed: 0 },
  requiredStrategyChanges: ["repair_strategy"],
  candidateExecutorIds: ["spin"],
  inputDigest: "digest1",
  policyVersion: "v1",
  created_at: new Date().toISOString(),
};

const sampleRationale = {
  selectedId: "spin",
  selectedKind: "agent" as const,
  eligibleCount: 1,
  rejected: [],
  score: 100,
  selectionStrategy: "preferred" as const,
};

describe("retry-directive", () => {
  it("builds a valid directive", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix the login form validation",
      doNotRepeat: ["use inline styles"],
      authoredBy: "orc",
    });
    expect(directive.schema_version).toBe(1);
    expect(directive.root_contract_id).toBe("c_test_1");
    expect(directive.source_attempt_id).toBe("a_test_1");
    expect(directive.target_ordinal).toBe(2);
    expect(directive.mode).toBe("repair");
    expect(directive.strategy.instruction).toContain("Fix the login form");
    expect(directive.executor.selected_id).toBe("spin");
    expect(directive.semantic_change_fingerprint).toBeTruthy();
  });

  it("computes a deterministic fingerprint", () => {
    const d1 = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "clean_rerun",
      instruction: "Rerun",
      authoredBy: "policy",
    });
    const d2 = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "clean_rerun",
      instruction: "Rerun",
      authoredBy: "policy",
    });
    expect(d1.semantic_change_fingerprint).toBe(d2.semantic_change_fingerprint);
  });

  it("validates directive structure", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const errors = validateDirective(directive);
    expect(errors).toHaveLength(0);
  });

  it("detects invalid directive", () => {
    const errors = validateDirective({} as any);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("derives contract revision preserving criteria", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix validation",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(sampleContract, directive);
    expect(revised.criteria).toHaveLength(2);
    expect(revised.criteria[0]!.description).toBe("Page renders");
    expect(revised.goal).toContain("Build a login page");
  });

  it("validates contract revision rejects removed criteria", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(sampleContract, directive);
    const bad = { ...revised, criteria: [{ id: "c1", description: "Page renders" }] };
    const errors = validateContractRevision(sampleContract, bad as any);
    expect(errors).toContain("criteria count cannot decrease");
  });

  it("validates contract revision rejects changed criteria description", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(sampleContract, directive);
    const bad = {
      ...revised,
      criteria: [
        { id: "c1", description: "Changed description" },
        { id: "c2", description: "Form submits" },
      ],
    };
    const errors = validateContractRevision(sampleContract, bad as any);
    expect(errors).toContain("criterion c1 description changed");
  });

  it("validates contract revision rejects goal change", () => {
    const directive = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(sampleContract, directive);
    const bad = { ...revised, goal: "Different goal" };
    const errors = validateContractRevision(sampleContract, bad as any);
    expect(errors).toContain("root goal changed");
  });

  it("fingerprint differs for different mode", () => {
    const d1 = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "clean_rerun",
      instruction: "Rerun",
      authoredBy: "policy",
    });
    const d2 = buildDirective(sampleContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Rerun",
      authoredBy: "policy",
    });
    expect(d1.semantic_change_fingerprint).not.toBe(d2.semantic_change_fingerprint);
  });
});
