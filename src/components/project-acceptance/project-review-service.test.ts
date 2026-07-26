import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let ProjectReviewService: typeof import("./project-review-service.js").ProjectReviewService;

describe("ProjectReviewService — full outcome matrix", () => {
  let service: ProjectReviewService;
  let store: ProjectReviewStore;
  let _seq = 0;

  function uniquePid(): number {
    return 8000 + (++_seq);
  }

  function makeContract(cardId: number) {
    return {
      schema_version: 1,
      id: `pc_svc_${cardId}`,
      digest: `digest_${cardId}`,
      project_card_id: cardId,
      goal: "Build the feature",
      criteria: [{ id: "c1", description: "Works", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
    };
  }

  async function setupCase(pid?: number): Promise<{ cardId: number; caseId: string; store: ProjectReviewStore }> {
    const cardId = pid ?? uniquePid();
    const contract = makeContract(cardId);
    const s = new ProjectReviewStore();
    s.insertContract(contract);
    s.initializeSupervision(cardId, contract.id, "executing");
    const snapshot: ReviewCaseSnapshot = {
      schema_version: 1 as const,
      project_card_id: cardId,
      generation: 1,
      round: 1,
      created_at: new Date().toISOString(),
      root_contract: {
        id: contract.id,
        digest: contract.digest,
        goal: contract.goal,
        criteria: contract.criteria as ReviewCaseSnapshot["root_contract"]["criteria"],
        required_outputs: contract.required_outputs as ReviewCaseSnapshot["root_contract"]["required_outputs"],
        limits: contract.limits,
      },
      criterion_inputs: [{ criterion_id: "c1", description: "Works", evidence_expectation: "synthesis", mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" }],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000 },
      executor_risk: { unknown_changes: false, worker_drift: 0, evidence_age_ms: 0, executor_separation: "same" },
      complete_graph: { attempts: [], retry_chain_ids: [] },
      outcome_summaries: { exhausted: [], cancelled: [], blocked: [] },
    };
    const caseRow = s.insertReviewCase(cardId, 1, 1, snapshot, `digest_${cardId}`);
    s.insertReviewRequest(cardId, caseRow.id, 1);
    s.stateTransition(cardId, ["executing"], "review_ready");
    return { cardId, caseId: caseRow.id, store: s };
  }

  function makeValidDecision(cardId: number, caseId: string, overrides?: Partial<ProjectReviewDecisionV1>): ProjectReviewDecisionV1 {
    return {
      schema_version: 1,
      id: `rd_test_${cardId}_${Date.now()}`,
      project_card_id: cardId,
      review_case_id: caseId,
      project_generation: 1,
      action: "accept",
      criteria: [{ criterion_id: "c1", verdict: "satisfied", evidence_ids: ["e1"], rationale: "Works correctly" }],
      outputs: [{ output_id: "o1", disposition: "verified", evidence_ids: ["e1"] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "All criteria satisfied, project complete.",
      authored_at: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-service-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    const svcMod = await import("./project-review-service.js");
    ProjectReviewService = svcMod.ProjectReviewService;
    store = new ProjectReviewStore();
    service = new ProjectReviewService();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  // ── Accept ──────────────────────────────────────────────────────────────────

  it("accepts a valid project", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, { action: "accept" });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("accepted");

    const sup = store.getSupervision(cardId);
    expect(sup?.state).toBe("accepted");
    expect(sup?.accepted_decision_id).toBeTruthy();
  });

  // ── Repair ──────────────────────────────────────────────────────────────────

  it("routes to repair_planned for valid repair decision", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ affected_criterion_ids: ["c1"], required_evidence: ["observed"], strategy: "rework", do_not_repeat: [], budget: { max_tokens: 5000 }, required_capabilities: [] }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("repair");
    expect(typeof result.decisionId).toBe("string");

    const sup = store.getSupervision(cardId);
    expect(sup?.state).toBe("repair_planned");
  });

  // ── Blocked ─────────────────────────────────────────────────────────────────

  it("blocks the project for valid blocked decision", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, {
      action: "blocked",
      criteria: [{ criterion_id: "c1", verdict: "unsatisfied", evidence_ids: ["e1"], rationale: "Cannot satisfy" }],
      blocker: { blocker_class: "impossible_constraint", affected_criterion_ids: ["c1"], exhausted_failures: [], contradiction_evidence: [], what_was_attempted: "Tried everything", unblock_conditions: "" },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("blocked");

    const sup = store.getSupervision(cardId);
    expect(sup?.state).toBe("blocked");
    expect(sup?.blocked_reason).toBeTruthy();
  });

  // ── Needs input ─────────────────────────────────────────────────────────────

  it("requests user input for valid needs_input decision", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, {
      action: "needs_input",
      criteria: [{ criterion_id: "c1", verdict: "inconclusive", evidence_ids: ["e1"], rationale: "Need user guidance" }],
      input_request: { question: "Which approach should we take?", affected_criterion_ids: ["c1"], expected_response_kind: "text", context: "Two viable approaches" },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("needs_input");
    expect(typeof result.decisionId).toBe("string");

    const sup = store.getSupervision(cardId);
    expect(sup?.state).toBe("needs_input");
  });

  // ── Invalid proposal → blocked after exhaustion ────────────────────────────

  it("blocks project after exhausting invalid proposals", async () => {
    const { cardId, caseId } = await setupCase();
    const baseDecision = makeValidDecision(cardId, caseId, { action: "blocked" });
    const badDecision: ProjectReviewDecisionV1 = {
      ...baseDecision,
      id: `rd_invalid_${cardId}_${Date.now()}`,
      criteria: [],
      outputs: [{ output_id: "o1", disposition: "missing", evidence_ids: [] }],
      synthesis: "Missing verdicts",
    };

    let result = service.processDecision(badDecision);
    expect(result.kind).toBe("invalid");

    result = service.processDecision(badDecision);
    expect(result.kind).toBe("invalid");

    result = service.processDecision(badDecision);
    expect(result.kind).toBe("invalid");

    result = service.processDecision(badDecision);
    expect(result.kind).toBe("invalid");

    result = service.processDecision(badDecision);
    expect(result.kind).toBe("blocked_invalid");
  });

  // ── Rejects stale generation ────────────────────────────────────────────────

  it("rejects decision with mismatched generation", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, { project_generation: 999 });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
  });

  // ── Rejects unknown case ────────────────────────────────────────────────────

  it("rejects decision for unknown review case", async () => {
    const { cardId } = await setupCase();
    const decision = makeValidDecision(cardId, "nonexistent");
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
  });

  // ── Rejects superseded case ──────────────────────────────────────────────────

  it("rejects decision for superseded case", async () => {
    const { cardId, caseId } = await setupCase();
    store.supersedeCase(caseId);
    const decision = makeValidDecision(cardId, caseId);
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
  });
});
