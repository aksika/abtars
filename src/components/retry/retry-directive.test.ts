import { describe, it, expect } from "vitest";
import { buildDirective, deriveContractRevision, deriveRepairContract, validateDirective, validateContractRevision, computeDirectiveFingerprint } from "./retry-directive.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import { validateContract } from "../worker-contract.js";

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

  it("#1638: revision derivation preserves workspace_alias", () => {
    const aliasContract = { ...sampleContract, workspace_alias: "repo-a" };
    const directive = buildDirective(aliasContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(aliasContract, directive, 2, 2);
    expect(revised.workspace_alias).toBe("repo-a");
    expect(validateContractRevision(aliasContract, revised)).toEqual([]);
  });

  it("#1638: revision validation rejects a changed or removed workspace_alias", () => {
    const aliasContract = { ...sampleContract, workspace_alias: "repo-a" };
    const directive = buildDirective(aliasContract, "a_test_1", 2, sampleClassification as any, sampleDecision, sampleRationale, {
      mode: "repair",
      instruction: "Fix it",
      authoredBy: "orc",
    });
    const revised = deriveContractRevision(aliasContract, directive, 2, 2);
    const removed = { ...revised, workspace_alias: undefined };
    expect(validateContractRevision(aliasContract, removed as any)).toContain("workspace_alias cannot change within a contract lineage");
    const changed = { ...revised, workspace_alias: "repo-b" };
    expect(validateContractRevision(aliasContract, changed as any)).toContain("workspace_alias cannot change within a contract lineage");
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

describe("#1686 deriveRepairContract — evidence-preserving derivation", () => {
  const item = {
    id: "r1",
    source_contract_id: "c_source_1",
    affected_criterion_ids: ["lane1-x"],
    required_evidence: "observed candidate list",
    strategy: "rework the feed fetch",
    do_not_repeat: ["never re-run the feed twice"],
    capabilities: ["browser"],
    budget: { max_tokens: 5000 },
  };

  function sourceContract(overrides?: Partial<WorkerAcceptanceContractV1>): WorkerAcceptanceContractV1 {
    return {
      schema_version: 1,
      id: "c_source_1",
      digest: "sd1",
      goal: "lane 1",
      criteria: [{ id: "w1", description: "fetch the feed" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
      verification_commands: [{ id: "v1", argv: ["test", "-f", "lane1-x-handoff.md"], timeout_ms: 30000, criterion_ids: ["w1"] }],
      required_capabilities: ["twitter-x"],
      limits: { max_tokens: 1000, max_duration_ms: 600000 },
      provenance: { root_card_id: 1, card_id: 2, authored_by: "orc", created_at: new Date().toISOString() },
      ...overrides,
    };
  }

  it("clones the source evidence paths, root mapping, capabilities, and limits", () => {
    const derived = deriveRepairContract({
      sourceContract: sourceContract(),
      sourceAttemptId: "a_9",
      item,
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
      enclosingLimits: { max_tokens: 100000 },
    });
    expect(derived.criteria).toEqual(sourceContract().criteria);
    expect(derived.expected_artifacts).toEqual(sourceContract().expected_artifacts);
    expect(derived.verification_commands).toEqual(sourceContract().verification_commands);
    expect(derived.supports_root_criteria).toEqual(["lane1-x"]);
    expect(derived.goal).toBe("Repair: rework the feed fetch [repair-item:r1]");
    // Capabilities are additive — source requirements are preserved.
    expect(derived.required_capabilities).toContain("twitter-x");
    expect(derived.required_capabilities).toContain("browser");
    // Limits copy the source; the item budget cannot expand the source bound.
    expect(derived.limits.max_duration_ms).toBe(600000);
    expect(derived.limits.max_tokens).toBe(1000);
    expect(derived.provenance.root_card_id).toBe(1);
  });

  it("applies the item budget only within source and enclosing bounds", () => {
    const derived = deriveRepairContract({
      sourceContract: sourceContract(),
      item: { ...item, budget: { max_tokens: 9000 } },
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
      enclosingLimits: { max_tokens: 5000 },
    });
    // 9000 clamped by source 1000 → 1000; then clamped by enclosing 5000 → 1000.
    expect(derived.limits.max_tokens).toBe(1000);

    const unbounded = deriveRepairContract({
      sourceContract: sourceContract({ limits: { max_duration_ms: 600000 } }),
      item: { ...item, budget: { max_tokens: 4000 } },
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
      enclosingLimits: { max_tokens: 3000 },
    });
    // No source max_tokens — the enclosing bound clamps.
    expect(unbounded.limits.max_tokens).toBe(3000);
  });

  it("records the source lineage and retry context in revision_meta", () => {
    const derived = deriveRepairContract({
      sourceContract: sourceContract(),
      sourceAttemptId: "a_9",
      item,
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
    });
    expect(derived.revision_meta?.parent_contract_id).toBe("c_source_1");
    expect(derived.revision_meta?.root_contract_id).toBe("c_source_1");
    expect(derived.revision_meta?.source_attempt_id).toBe("a_9");
    expect(derived.revision_meta?.retry_context?.mode).toBe("repair");
    expect(derived.revision_meta?.retry_context?.instruction).toBe(item.strategy);
    expect(derived.revision_meta?.retry_context?.required_evidence).toBe(item.required_evidence);
    expect(derived.revision_meta?.retry_context?.do_not_repeat).toEqual(item.do_not_repeat);
    expect(derived.revision_meta?.retry_context?.failed_criterion_ids).toEqual(["lane1-x"]);
  });

  it("preserves the workspace alias (executor routing) from the source", () => {
    const derived = deriveRepairContract({
      sourceContract: sourceContract({ workspace_alias: "repo-a" }),
      item,
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
    });
    expect(derived.workspace_alias).toBe("repo-a");
  });

  it("derived contracts pass the shared worker-contract validator", () => {
    const derived = deriveRepairContract({
      sourceContract: sourceContract(),
      item,
      rootCardId: 1,
      pendingCardId: 0,
      now: "2026-08-21T00:00:00.000Z",
    });
    const validated = validateContract(derived as unknown as Record<string, unknown>);
    expect(validated.ok).toBe(true);
  });
});
