import { describe, it, expect } from "vitest";
import {
  validateContract,
  normalizeContract,
  computeDigest,
  createContractId,
  validateCriterionMapping,
  findUncoveredCriteria,
  criterionPolicyView,
  delegatedCriterionIds,
  MAX_GOAL_LENGTH,
  MAX_CRITERIA_COUNT,
  MAX_CONTRACT_JSON_BYTES,
  type ProjectAcceptanceContractV1,
  type ProjectAcceptanceContractV2,
  type ProjectAcceptanceContract,
} from "./project-contract.js";

const MINIMAL_CONTRACT: Record<string, unknown> = {
  schema_version: 2,
  id: "pc_test_001",
  project_card_id: 42,
  goal: "Build the reporting feature",
  criteria: [
    { id: "c1", description: "Report must be generated", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
    { id: "c2", description: "Report must be accurate", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
  ],
  required_outputs: [
    { id: "o1", description: "Final report document", kind: "file", required: true },
    { id: "o2", description: "Summary of findings", kind: "report", required: false },
  ],
  constraints: ["Must not exceed 1000 tokens", "Must be in English"],
  limits: {
    hard_deadline_at: "2026-07-15T00:00:00.000Z",
    max_tokens: 50000,
    max_cost: 2.0,
    max_review_rounds: 5,
    max_repair_rounds: 3,
  },
  provenance: {
    requested_by: "user123",
    authored_by: "orc",
    created_at: "2026-07-12T00:00:00.000Z",
  },
};

describe("validateContract", () => {
  it("accepts a valid minimal v2 contract", () => {
    const result = validateContract(MINIMAL_CONTRACT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.schema_version).toBe(2);
      expect(result.contract.criteria).toHaveLength(2);
      expect(result.contract.required_outputs).toHaveLength(2);
      expect(result.contract.limits.max_review_rounds).toBe(5);
    }
  });

  it("rejects non-object", () => {
    const result = validateContract("not an object");
    expect(result.ok).toBe(false);
  });

  it("rejects unsupported schema version", () => {
    const result = validateContract({ ...MINIMAL_CONTRACT, schema_version: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.tag).toBe("unknown_version");
  });

  it("accepts a stored v1 contract with original semantics", () => {
    const v1: Record<string, unknown> = {
      ...MINIMAL_CONTRACT,
      schema_version: 1,
      criteria: [
        { id: "c1", description: "Report must be generated", required: true, evidence_expectation: "artifact" },
      ],
    };
    const result = validateContract(v1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.contract.schema_version).toBe(1);
  });

  it("rejects missing id", () => {
    const { id, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path === "$.id")).toBe(true);
  });

  it("rejects missing project_card_id", () => {
    const { project_card_id, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path === "$.project_card_id")).toBe(true);
  });

  it("rejects missing goal", () => {
    const { goal, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects goal exceeding max length", () => {
    const result = validateContract({ ...MINIMAL_CONTRACT, goal: "x".repeat(MAX_GOAL_LENGTH + 1) });
    expect(result.ok).toBe(false);
  });

  it("rejects empty criteria", () => {
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects criteria exceeding max count", () => {
    const criteria = Array.from({ length: MAX_CRITERIA_COUNT + 1 }, (_, i) => ({
      id: `c${i}`,
      description: `Criterion ${i}`,
      required: true,
      execution_owner: "delegated",
      evidence_expectation: "synthesis",
    }));
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate criterion IDs", () => {
    const criteria = [
      { id: "c1", description: "First", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
      { id: "c1", description: "Duplicate", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.tag === "duplicate_id")).toBe(true);
  });

  it("rejects criterion with missing required (v2 must not guess)", () => {
    const criteria = [
      { id: "c1", description: "Test", execution_owner: "delegated", evidence_expectation: "synthesis" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path.includes("required"))).toBe(true);
  });

  it("rejects criterion with missing execution_owner (v2 must not guess)", () => {
    const criteria = [
      { id: "c1", description: "Test", required: true, evidence_expectation: "synthesis" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path.includes("execution_owner"))).toBe(true);
  });

  it("rejects invalid execution_owner", () => {
    const criteria = [
      { id: "c1", description: "Test", required: true, execution_owner: "worker", evidence_expectation: "synthesis" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path.includes("execution_owner"))).toBe(true);
  });

  it("rejects Orc-owned criterion with artifact evidence", () => {
    const criteria = [
      { id: "c1", description: "Test", required: true, execution_owner: "orc", evidence_expectation: "artifact" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(e => e.path.includes("execution_owner"))).toBe(true);
  });

  it("accepts optional criteria (required: false)", () => {
    const criteria = [
      { id: "c1", description: "Optional lane", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(true);
  });

  it("rejects invalid evidence_expectation", () => {
    const criteria = [
      { id: "c1", description: "Test", required: true, execution_owner: "delegated", evidence_expectation: "magic" },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, criteria });
    expect(result.ok).toBe(false);
  });

  it("rejects missing required_outputs", () => {
    const { required_outputs, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects duplicate output IDs", () => {
    const outputs = [
      { id: "o1", description: "First", kind: "file", required: true },
      { id: "o1", description: "Duplicate", kind: "report", required: false },
    ];
    const result = validateContract({ ...MINIMAL_CONTRACT, required_outputs: outputs });
    expect(result.ok).toBe(false);
  });

  it("rejects invalid output kind", () => {
    const outputs = [{ id: "o1", description: "Bad", kind: "binary", required: true }];
    const result = validateContract({ ...MINIMAL_CONTRACT, required_outputs: outputs });
    expect(result.ok).toBe(false);
  });

  it("rejects missing limits", () => {
    const { limits, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects missing max_review_rounds in limits", () => {
    const { max_review_rounds, ...restLimits } = MINIMAL_CONTRACT.limits as Record<string, unknown>;
    const result = validateContract({ ...MINIMAL_CONTRACT, limits: restLimits });
    expect(result.ok).toBe(false);
  });

  it("rejects missing provenance", () => {
    const { provenance, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(false);
  });

  it("rejects contract exceeding max JSON bytes", () => {
    const bigGoal = "x".repeat(MAX_CONTRACT_JSON_BYTES);
    const result = validateContract({ ...MINIMAL_CONTRACT, goal: bigGoal, constraints: [bigGoal] });
    expect(result.ok).toBe(false);
  });

  it("accepts contract without constraints array (valid default)", () => {
    const { constraints, ...rest } = MINIMAL_CONTRACT;
    const result = validateContract(rest);
    expect(result.ok).toBe(true);
  });
});

describe("normalizeContract", () => {
  const v2Input = {
    project_card_id: 42,
    goal: "Build the feature",
    criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }],
    required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
    limits: { max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
  };

  it("creates a valid v2 contract from minimal input", () => {
    const result = normalizeContract(v2Input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.id).toBeTruthy();
      expect(result.contract.digest).toBeTruthy();
      expect(result.contract.schema_version).toBe(2);
      expect(result.contract.criteria[0]?.execution_owner).toBe("delegated");
    }
  });

  it("does not guess execution_owner", () => {
    const result = normalizeContract({
      ...v2Input,
      criteria: [{ id: "c1", description: "Works", required: true, evidence_expectation: "synthesis" }],
    });
    expect(result.ok).toBe(false);
  });

  it("does not guess required", () => {
    const result = normalizeContract({
      ...v2Input,
      criteria: [{ id: "c1", description: "Works", execution_owner: "delegated", evidence_expectation: "synthesis" }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects Orc-owned non-synthesis criteria", () => {
    const result = normalizeContract({
      ...v2Input,
      criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "orc", evidence_expectation: "observed" }],
    });
    expect(result.ok).toBe(false);
  });

  it("fails for non-object input", () => {
    const result = normalizeContract(null);
    expect(result.ok).toBe(false);
  });

  it("generates unique digests for different contracts", () => {
    const c1 = normalizeContract({ ...v2Input, project_card_id: 1, goal: "Goal A" });
    const c2 = normalizeContract({ ...v2Input, project_card_id: 2, goal: "Goal B" });
    if (c1.ok && c2.ok) {
      expect(c1.contract.digest).not.toBe(c2.contract.digest);
    }
  });

  it("digest is sensitive to execution_owner and required", () => {
    const a = normalizeContract({ ...v2Input, criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }] });
    const b = normalizeContract({ ...v2Input, criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "orc", evidence_expectation: "synthesis" }] });
    const c = normalizeContract({ ...v2Input, criteria: [{ id: "c1", description: "Works", required: false, execution_owner: "delegated", evidence_expectation: "synthesis" }] });
    if (a.ok && b.ok && c.ok) {
      expect(a.contract.digest).not.toBe(b.contract.digest);
      expect(a.contract.digest).not.toBe(c.contract.digest);
    }
  });
});

describe("computeDigest", () => {
  it("is deterministic for identical contracts", () => {
    const d1 = computeDigest(MINIMAL_CONTRACT as Record<string, unknown>);
    const d2 = computeDigest(MINIMAL_CONTRACT as Record<string, unknown>);
    expect(d1).toBe(d2);
  });

  it("ignores digest field in computation", () => {
    const withDigest = { ...MINIMAL_CONTRACT, digest: "abc" };
    const withoutDigest = { ...MINIMAL_CONTRACT };
    delete withoutDigest.digest;
    expect(computeDigest(withDigest as Record<string, unknown>)).toBe(computeDigest(withoutDigest as Record<string, unknown>));
  });
});

describe("createContractId", () => {
  it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 10 }, () => createContractId()));
    expect(ids.size).toBe(10);
  });
});

function makeV2Contract(criteria: Array<Record<string, unknown>>): ProjectAcceptanceContractV2 {
  return {
    schema_version: 2,
    id: "pc_root",
    digest: "abc",
    project_card_id: 1,
    goal: "Test",
    criteria: criteria as unknown as ProjectAcceptanceContractV2["criteria"],
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "u", authored_by: "o", created_at: "now" },
  };
}

describe("validateCriterionMapping", () => {
  const v1Root: ProjectAcceptanceContractV1 = {
    schema_version: 1,
    id: "pc_root",
    digest: "abc",
    project_card_id: 1,
    goal: "Test",
    criteria: [
      { id: "c1", description: "Crit 1", required: true, evidence_expectation: "artifact" },
      { id: "c2", description: "Crit 2", required: true, evidence_expectation: "synthesis" },
    ],
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "u", authored_by: "o", created_at: "now" },
  };

  const v2Root = makeV2Contract([
    { id: "c1", description: "Crit 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
    { id: "c2", description: "Crit 2", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
    { id: "c3", description: "Crit 3", required: false, execution_owner: "delegated", evidence_expectation: "observed" },
  ]);

  it("accepts valid mapping to existing v1 root criteria", () => {
    const errors = validateCriterionMapping(v1Root, {
      child_contract_id: "child_001",
      supports_root_criteria: ["c1", "c2"],
    });
    expect(errors).toHaveLength(0);
  });

  it("rejects unknown root criterion ID (v2)", () => {
    const errors = validateCriterionMapping(v2Root, {
      child_contract_id: "child_001",
      supports_root_criteria: ["c1", "c99"],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.tag === "bad_reference")).toBe(true);
  });

  it("rejects mapping to an Orc-owned criterion (v2)", () => {
    const errors = validateCriterionMapping(v2Root, {
      child_contract_id: "child_001",
      supports_root_criteria: ["c2"],
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.tag === "bad_reference" && e.message.includes("c2"))).toBe(true);
  });

  it("rejects duplicate root criterion IDs in mapping", () => {
    const errors = validateCriterionMapping(v1Root, {
      child_contract_id: "child_001",
      supports_root_criteria: ["c1", "c1"],
    });
    expect(errors.some(e => e.tag === "duplicate_id")).toBe(true);
  });

  it("rejects empty string in supports_root_criteria", () => {
    const errors = validateCriterionMapping(v1Root, {
      child_contract_id: "child_001",
      supports_root_criteria: [""],
    });
    expect(errors.some(e => e.tag === "empty_string")).toBe(true);
  });

  it("rejects missing child_contract_id", () => {
    const errors = validateCriterionMapping(v1Root, {
      child_contract_id: "",
      supports_root_criteria: ["c1"],
    });
    expect(errors.some(e => e.path === "$.child_contract_id")).toBe(true);
  });

  it("rejects non-array supports_root_criteria", () => {
    const errors = validateCriterionMapping(v1Root, {
      child_contract_id: "child_001",
      supports_root_criteria: "c1" as unknown as string[],
    });
    expect(errors.some(e => e.path === "$.supports_root_criteria")).toBe(true);
  });
});

describe("findUncoveredCriteria", () => {
  const v1Root: ProjectAcceptanceContractV1 = {
    schema_version: 1,
    id: "pc_root",
    digest: "abc",
    project_card_id: 1,
    goal: "Test",
    criteria: [
      { id: "c1", description: "Crit 1", required: true, evidence_expectation: "artifact" },
      { id: "c2", description: "Crit 2", required: true, evidence_expectation: "synthesis" },
      { id: "c3", description: "Crit 3", required: true, evidence_expectation: "observed" },
    ],
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "u", authored_by: "o", created_at: "now" },
  };

  const v2Root = makeV2Contract([
    { id: "c1", description: "Crit 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
    { id: "c2", description: "Crit 2", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
    { id: "c3", description: "Crit 3", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
  ]);

  it("returns empty when all v1 criteria are covered", () => {
    const uncovered = findUncoveredCriteria(v1Root, [
      { child_contract_id: "c1", supports_root_criteria: ["c1", "c2"] },
      { child_contract_id: "c2", supports_root_criteria: ["c3"] },
    ]);
    expect(uncovered).toHaveLength(0);
  });

  it("returns uncovered v1 criteria IDs", () => {
    const uncovered = findUncoveredCriteria(v1Root, [
      { child_contract_id: "c1", supports_root_criteria: ["c1"] },
    ]);
    expect(uncovered).toEqual(["c2", "c3"]);
  });

  it("returns all v1 criteria when no mappings exist", () => {
    const uncovered = findUncoveredCriteria(v1Root, []);
    expect(uncovered).toEqual(["c1", "c2", "c3"]);
  });

  it("handles duplicate mappings (doesn't double-report)", () => {
    const uncovered = findUncoveredCriteria(v1Root, [
      { child_contract_id: "c1", supports_root_criteria: ["c1"] },
      { child_contract_id: "c2", supports_root_criteria: ["c1"] },
    ]);
    expect(uncovered).toEqual(["c2", "c3"]);
  });

  it("never includes Orc-owned criteria in uncovered (v2)", () => {
    const uncovered = findUncoveredCriteria(v2Root, [
      { child_contract_id: "c1", supports_root_criteria: ["c1"] },
    ]);
    expect(uncovered).toEqual(["c3"]);
  });

  it("ignores mappings to Orc-owned criteria (v2)", () => {
    const uncovered = findUncoveredCriteria(v2Root, [
      { child_contract_id: "c1", supports_root_criteria: ["c1", "c2"] },
    ]);
    expect(uncovered).toEqual(["c3"]);
  });
});

describe("criterionPolicyView / delegatedCriterionIds", () => {
  it("projects v1 as required + delegated", () => {
    const v1: ProjectAcceptanceContractV1 = {
      schema_version: 1,
      id: "pc_root",
      digest: "abc",
      project_card_id: 1,
      goal: "Test",
      criteria: [
        { id: "c1", description: "Crit 1", required: true, evidence_expectation: "artifact" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "u", authored_by: "o", created_at: "now" },
    };
    const view = criterionPolicyView(v1);
    expect(view[0]).toEqual({ id: "c1", description: "Crit 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" });
    expect(delegatedCriterionIds(v1)).toEqual(["c1"]);
  });

  it("projects v2 ownership and requiredness", () => {
    const v2 = makeV2Contract([
      { id: "c1", description: "Crit 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
      { id: "c2", description: "Crit 2", required: false, execution_owner: "orc", evidence_expectation: "synthesis" },
    ]);
    const view = criterionPolicyView(v2);
    expect(view[1]).toEqual({ id: "c2", description: "Crit 2", required: false, execution_owner: "orc", evidence_expectation: "synthesis" });
    expect(delegatedCriterionIds(v2)).toEqual(["c1"]);
  });
});
