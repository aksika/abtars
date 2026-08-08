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
          { id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "c2", description: "Accurate", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" },
        ],
        required_outputs: [
          { id: "o1", description: "Report", kind: "file", required: true },
          { id: "o2", description: "Notes", kind: "logical", required: false },
        ],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      },
      criterion_inputs: [
        { criterion_id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: [], observed_evidence_ids: ["v1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: ["a1"], retry_lineage_ids: [], coverage_hint: "supported" },
        { criterion_id: "c2", description: "Accurate", required: true, execution_owner: "delegated", evidence_expectation: "synthesis", mapped_child_contract_ids: [], observed_evidence_ids: ["v2"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" },
      ],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: 0, total_tokens: 0, wall_clock_ms: 1000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 2,
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
    it("rejects acceptance when a configured cost cap has no usage data", () => {
      const { caseId, pid, snapshot } = setupCase();
      const cappedSnapshot: ReviewCaseSnapshot = {
        ...snapshot,
        root_contract: {
          ...snapshot.root_contract,
          limits: { ...snapshot.root_contract.limits!, max_cost: 1 },
        },
        budgets: { ...snapshot.budgets, total_cost: undefined },
      };
      const errors = validator.validateDecision(makeValidDecision(pid, {}, caseId), cappedSnapshot);
      expect(errors.some(e => e.path === "$.limits.max_cost")).toBe(true);
    });

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

    // #1605: required vs optional and ownership-aware acceptance

    function snapshotWithCriteria(pid: number, criteria: Array<{ id: string; required: boolean; execution_owner: "delegated" | "orc"; coverage_hint: string }>): ReviewCaseSnapshot {
      const snap = makeSnapshot(pid);
      return {
        ...snap,
        root_contract: {
          ...snap.root_contract,
          criteria: criteria.map(c => ({
            id: c.id,
            description: `Criterion ${c.id}`,
            required: c.required,
            execution_owner: c.execution_owner,
            evidence_expectation: c.execution_owner === "orc" ? "synthesis" : "artifact",
          })),
        },
        criterion_inputs: criteria.map(c => ({
          criterion_id: c.id,
          description: `Criterion ${c.id}`,
          required: c.required,
          execution_owner: c.execution_owner,
          evidence_expectation: c.execution_owner === "orc" ? "synthesis" : "artifact",
          mapped_child_contract_ids: [],
          observed_evidence_ids: [`ev_${c.id}`],
          worker_claim_ids: [],
          failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [],
          retry_lineage_ids: [],
          coverage_hint: c.coverage_hint,
        })),
        uncovered_criteria: criteria.filter(c => c.coverage_hint === "gap").map(c => c.id),
      };
    }

    it("#1605 accepts an optional unsatisfied criterion with a rationale (delegated gap)", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "lane1", required: true, execution_owner: "delegated", coverage_hint: "supported" },
        { id: "lane3", required: false, execution_owner: "delegated", coverage_hint: "gap" },
      ]);
      store.insertContract({
        schema_version: 2,
        id: `pc_test_${pid}`,
        digest: `digest_${pid}`,
        project_card_id: pid,
        goal: "Build the feature",
        criteria: [
          { id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact" },
        ],
        required_outputs: [{ id: "o1", description: "Report", kind: "file", required: true }],
        constraints: [],
        limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
        provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
      });
      store.initializeSupervision(pid, `pc_test_${pid}`);
      const { id } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      store.stateTransition(pid, ["executing"] as any, "review_ready", { review_round: 1 });

      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "lane1", verdict: "satisfied", evidence_ids: ["ev_lane1"], rationale: "lane passed" },
          { criterion_id: "lane3", verdict: "unsatisfied", evidence_ids: [], rationale: "source lane failed; report still useful without it" },
        ],
      }, id);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors).toHaveLength(0);
    });

    it("#1605 rejects an optional gap accepted without a rationale", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "lane1", required: true, execution_owner: "delegated", coverage_hint: "supported" },
        { id: "lane3", required: false, execution_owner: "delegated", coverage_hint: "gap" },
      ]);
      const { id: caseId } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "lane1", verdict: "satisfied", evidence_ids: ["ev_lane1"], rationale: "lane passed" },
          { criterion_id: "lane3", verdict: "unsatisfied", evidence_ids: [], rationale: "" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path.includes("lane3") && e.message.includes("rationale"))).toBe(true);
    });

    it("#1605 rejects not_evaluated on accept — required or optional", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "lane1", required: true, execution_owner: "delegated", coverage_hint: "supported" },
        { id: "lane3", required: false, execution_owner: "delegated", coverage_hint: "gap" },
      ]);
      const { id: caseId } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "lane1", verdict: "satisfied", evidence_ids: ["ev_lane1"], rationale: "lane passed" },
          { criterion_id: "lane3", verdict: "not_evaluated", evidence_ids: [], rationale: "skipped" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.message.includes("not_evaluated"))).toBe(true);
    });

    it("#1605 rejects a satisfied delegated criterion without case evidence", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "lane1", required: true, execution_owner: "delegated", coverage_hint: "supported" },
      ]);
      const { id: caseId } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "lane1", verdict: "satisfied", evidence_ids: [], rationale: "trust me" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path.includes("lane1") && e.message.includes("no evidence"))).toBe(true);
    });

    it("#1605 rejects evidence borrowed from another criterion", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: ["v2"], rationale: "borrowed evidence" },
          { criterion_id: "c2", verdict: "satisfied", evidence_ids: ["v2"], rationale: "accurate" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.message.includes("not compatible with criterion \"c1\""))).toBe(true);
    });

    it("allows contradiction evidence only for its affected criterion", () => {
      const { caseId, pid, snapshot } = setupCase();
      snapshot.contradiction_candidates.push({
        id: "cc_c1",
        affected_criterion_ids: ["c1"],
        description: "conflict",
        evidence_ids: ["conflict-c1"],
        sources: ["worker-a", "worker-b"],
      });
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: ["conflict-c1"], rationale: "resolved" },
          { criterion_id: "c2", verdict: "satisfied", evidence_ids: ["conflict-c1"], rationale: "borrowed conflict evidence" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.message.includes("not compatible with criterion \"c2\""))).toBe(true);
      expect(errors.some(e => e.message.includes("not compatible with criterion \"c1\""))).toBe(false);
    });

    it("#1605 accepts a satisfied Orc-owned criterion with rationale and no fabricated Worker evidence", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "synthesis", required: true, execution_owner: "orc", coverage_hint: "orc_owned" },
      ]);
      const { id: caseId } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "synthesis", verdict: "satisfied", evidence_ids: [], rationale: "Synthesized from all lane handoffs in the case" },
        ],
        outputs: [{ output_id: "o1", disposition: "verified", evidence_ids: [] }],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors).toHaveLength(0);
    });

    it("#1605 rejects a satisfied Orc-owned criterion with an empty rationale", () => {
      const pid = uniquePid();
      const snapshot = snapshotWithCriteria(pid, [
        { id: "synthesis", required: true, execution_owner: "orc", coverage_hint: "orc_owned" },
      ]);
      const { id: caseId } = store.insertReviewCase(pid, 1, 1, snapshot, "digest_snap");
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "synthesis", verdict: "satisfied", evidence_ids: [], rationale: "" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.message.includes("rationale"))).toBe(true);
    });

    it("#1605 rejects duplicate verdicts for the same criterion", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: [], rationale: "also ok" },
          { criterion_id: "c2", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.tag === "duplicate_id")).toBe(true);
    });

    it("#1605 rejects a non-satisfied verdict with an empty rationale (common validation)", () => {
      const { caseId, pid, snapshot } = setupCase();
      const decision = makeValidDecision(pid, {
        action: "blocked",
        blocker: { blocker_class: "B", affected_criterion_ids: ["c2"], exhausted_failures: [], contradiction_evidence: [], what_was_attempted: "tried", unblock_conditions: "" },
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
          { criterion_id: "c2", verdict: "unsatisfied", evidence_ids: [], rationale: "" },
        ],
      }, caseId);
      const errors = validator.validateDecision(decision, snapshot);
      expect(errors.some(e => e.path.includes("c2") && e.message.includes("rationale"))).toBe(true);
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
