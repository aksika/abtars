import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";

let TEST_HOME: string;
let ProjectReviewValidator: typeof import("./project-review-validator.js").ProjectReviewValidator;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;

describe("ProjectReviewValidator", () => {
  let validator: ProjectReviewValidator;
  let store: ProjectReviewStore;
  let seq = 0;
  let testSeq = 0;

  function uniquePid(): number {
    return 9000 + (++testSeq);
  }

  function makeSnapshot(pid?: number): ReviewCaseSnapshot {
    const p = pid ?? 42;
    return {
      schema_version: 1,
      project_card_id: p,
      generation: 1,
      round: 1,
      created_at: "2026-07-12T00:00:00.000Z",
      root_contract: {
        id: `pc_test_${p}`,
        digest: `digest_${p}`,
        goal: "Build the feature",
        criteria: [
          { id: "c1", description: "Works", evidence_expectation: "artifact" },
          { id: "c2", description: "Accurate", evidence_expectation: "synthesis" },
        ],
        required_outputs: [
          { id: "o1", description: "Report", kind: "file", required: true },
          { id: "o2", description: "Notes", kind: "logical", required: false },
        ],
      },
      criterion_inputs: [],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      budgets: { total_cost: 0, total_tokens: 0, wall_clock_ms: 1000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 0,
      contradiction_count: 0,
    };
  }

  function makeValidDecision(pid: number, overrides?: Partial<ProjectReviewDecisionV1>, caseId?: string): ProjectReviewDecisionV1 {
    const cId = caseId ?? `rc_test_${pid}`;
    return {
      schema_version: 1,
      id: `rd_test_${++seq}`,
      project_card_id: pid,
      review_case_id: cId,
      project_generation: 1,
      action: "accept",
      criteria: [
        { criterion_id: "c1", verdict: "satisfied", evidence_ids: ["v1"], rationale: "All checks passed" },
        { criterion_id: "c2", verdict: "satisfied", evidence_ids: ["v2"], rationale: "Output validated" },
      ],
      outputs: [
        { output_id: "o1", disposition: "verified", evidence_ids: ["a1"] },
      ],
      contradictions: [],
      residual_risks: [],
      synthesis: "The feature is complete and all criteria are satisfied.",
      ...overrides,
    };
  }

  function setupCase(pid?: number): { caseId: string; pid: number; snapshot: ReviewCaseSnapshot } {
    const p = pid ?? uniquePid();
    const snap = makeSnapshot(p);
    store.insertContract({
      schema_version: 1,
      id: `pc_test_${p}`,
      digest: `digest_${p}`,
      project_card_id: p,
      goal: "Build the feature",
      criteria: [
        { id: "c1", description: "Works", required: true, evidence_expectation: "artifact" },
        { id: "c2", description: "Accurate", required: true, evidence_expectation: "synthesis" },
      ],
      required_outputs: [
        { id: "o1", description: "Report", kind: "file", required: true },
        { id: "o2", description: "Notes", kind: "logical", required: false },
      ],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
    });
    store.initializeSupervision(p, `pc_test_${p}`);
    const { id } = store.insertReviewCase(p, 1, 1, snap, "digest_snap");
    store.stateTransition(p, ["executing"] as any, "review_ready", { review_round: 1 });
    return { caseId: id, pid: p, snapshot: snap };
  }

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-validator-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod1 = await import("./project-review-validator.js");
    ProjectReviewValidator = mod1.ProjectReviewValidator;
    const mod2 = await import("./project-review-store.js");
    ProjectReviewStore = mod2.ProjectReviewStore;
    validator = new ProjectReviewValidator();
    store = new ProjectReviewStore();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  describe("common validation", () => {
    it("accepts a valid accept decision", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {}, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors).toHaveLength(0);
    });

    it("rejects wrong schema version", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { schema_version: 2 } as any, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "unknown_version")).toBe(true);
    });

    it("rejects mismatched project_card_id", () => {
      const { caseId, snapshot } = setupCase();
      const decision = makeValidDecision(snapshot.project_card_id, { project_card_id: 99 }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path === "$.project_card_id")).toBe(true);
    });

    it("rejects mismatched generation", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { project_generation: 2 }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path === "$.project_generation")).toBe(true);
    });

    it("rejects unknown review case", () => {
      const { pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { review_case_id: "nonexistent" });
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "bad_reference")).toBe(true);
    });

    it("rejects missing criterion verdicts", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { criteria: [] }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path === "$.criteria")).toBe(true);
    });

    it("rejects verdict for unknown criterion", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
          { criterion_id: "c2", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
          { criterion_id: "c99", verdict: "satisfied", evidence_ids: [], rationale: "bad" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "bad_reference")).toBe(true);
    });

    it("rejects invalid verdict value", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied" as any, evidence_ids: [], rationale: "ok" },
          { criterion_id: "c2", verdict: "magic" as any, evidence_ids: [], rationale: "bad" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "type_error")).toBe(true);
    });

    it("rejects unsupported action", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { action: "invalid_action" as any }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "type_error")).toBe(true);
    });
  });

  describe("accept validation", () => {
    it("rejects accept when a required criterion is not satisfied", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
          { criterion_id: "c2", verdict: "unsatisfied", evidence_ids: [], rationale: "failed" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "invalid_proposal")).toBe(true);
    });

    it("rejects accept when required output is missing", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        outputs: [
          { output_id: "o1", disposition: "missing", evidence_ids: [] },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "invalid_proposal")).toBe(true);
    });

    it("rejects accept with blocking contradiction on required criterion", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        contradictions: [
          { id: "cc1", affected_criterion_ids: ["c1"], evidence_ids: [], disposition: "blocking", rationale: "Contradiction" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "invalid_proposal")).toBe(true);
    });

    it("rejects accept with blocking residual risk", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        residual_risks: [
          { text: "Uncertain output", blocking: true, evidence_ids: [] },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "invalid_proposal")).toBe(true);
    });
  });

  describe("repair validation", () => {
    it("rejects repair without repair proposal", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { action: "repair" }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "missing_field")).toBe(true);
    });

    it("rejects repair with empty strategy", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        action: "repair",
        repair: {
          items: [
            { id: "r1", affected_criterion_ids: ["c1"], required_evidence: "", strategy: "", do_not_repeat: [], capabilities: [], budget: {} },
          ],
          rationale: "Fix it",
        },
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "missing_field")).toBe(true);
    });
  });

  describe("blocked validation", () => {
    it("rejects blocked without blocker info", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { action: "blocked" }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "missing_field")).toBe(true);
    });

    it("rejects blocked with empty blocker class", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        action: "blocked",
        blocker: { blocker_class: "", affected_criterion_ids: ["c1"], exhausted_failures: [], contradiction_evidence: [], what_was_attempted: "tried", unblock_conditions: "" },
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path === "$.blocker.blocker_class")).toBe(true);
    });
  });

  describe("needs_input validation", () => {
    it("rejects needs_input without input_request", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, { action: "needs_input" }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "missing_field")).toBe(true);
    });

    it("rejects needs_input with empty question", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        action: "needs_input",
        input_request: { question: "", affected_criterion_ids: ["c1"], expected_response_kind: "text", context: "" },
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path === "$.input_request.question")).toBe(true);
    });
  });
});
