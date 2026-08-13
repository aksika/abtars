import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";

// #1618: acceptance-outbox drain tests drive a fake broker. Hoisted so the
// module factory can reference it; tests that never call the drain are
// unaffected.
const { testBroker } = vi.hoisted(() => ({
  testBroker: { sendRequest: async () => { throw new Error("no broker configured"); } },
}));
vi.mock("../peer-transport/peer-ws-broker.js", () => ({
  getPeerWsBroker: () => testBroker,
}));

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
    // #1626: settlement requires a live kanban card — the real projection must
    // apply from a legal live status inside the settlement transaction.
    s.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, datetime('now'), datetime('now'))`)
      .run(cardId, "svc project", "task", "svc goal");
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
      criterion_inputs: [{ criterion_id: "c1", description: "Works", evidence_expectation: "synthesis", mapped_child_contract_ids: ["pc_child_c1"], successful_mapped_child_contract_ids: ["pc_child_c1"], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" }],
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

describe("renderAcceptedSynthesis (#1605)", () => {
  let renderAcceptedSynthesis: typeof import("./project-review-service.js").renderAcceptedSynthesis;

  beforeEach(async () => {
    renderAcceptedSynthesis = (await import("./project-review-service.js")).renderAcceptedSynthesis;
  });

  function makeSnapshot(): ReviewCaseSnapshot {
    return {
      schema_version: 1,
      project_card_id: 1,
      generation: 1,
      round: 1,
      created_at: new Date().toISOString(),
      root_contract: {
        id: "pc_1",
        digest: "d",
        goal: "g",
        criteria: [
          { id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact" },
          { id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        ],
        required_outputs: [],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      },
      criterion_inputs: [
        { criterion_id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: ["pc_child_lane1"], successful_mapped_child_contract_ids: ["pc_child_lane1"], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" },
        { criterion_id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap" },
        { criterion_id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned" },
      ],
      contradiction_candidates: [],
      uncovered_criteria: ["lane3"],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000 },
      executor_risk: { unknown_changes: false, worker_drift: 0, evidence_age_ms: 0, executor_separation: "same" },
      complete_graph: { attempts: [], retry_chain_ids: [] },
      outcome_summaries: { exhausted: [], cancelled: [], blocked: [] },
    };
  }

  function makeDecision(synthesis: string): ProjectReviewDecisionV1 {
    return {
      schema_version: 1,
      id: "rd_1",
      project_card_id: 1,
      review_case_id: "rc_1",
      project_generation: 1,
      action: "accept",
      criteria: [
        { criterion_id: "lane1", verdict: "satisfied", evidence_ids: ["e1"], rationale: "ok" },
        { criterion_id: "lane3", verdict: "unsatisfied", evidence_ids: [], rationale: "source feed unreachable" },
        { criterion_id: "synthesis", verdict: "satisfied", evidence_ids: [], rationale: "synthesized from lanes" },
      ],
      outputs: [],
      contradictions: [],
      residual_risks: [],
      synthesis,
      authored_at: new Date().toISOString(),
    };
  }

  it("returns the authored synthesis unchanged when there are no accepted optional gaps", () => {
    const decision = makeDecision("Everything fine");
    decision.criteria[1] = { criterion_id: "lane3", verdict: "satisfied", evidence_ids: [], rationale: "covered by lane1 evidence" };
    const result = renderAcceptedSynthesis(decision, makeSnapshot());
    expect(result).toBe("Everything fine");
  });

  it("appends a canonical Known gaps section in root-contract order for accepted optional gaps", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("Report delivered");
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result).toContain("Known gaps:");
    expect(result).toContain("- lane3: unsatisfied — source feed unreachable");
    expect(result.indexOf("Report delivered")).toBeLessThan(result.indexOf("Known gaps:"));
  });

  it("bounds the rendered result", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("R".repeat(3900));
    decision.criteria[1] = { criterion_id: "lane3", verdict: "inconclusive", evidence_ids: [], rationale: "x".repeat(2000) };
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("reserves space for the disclosure — a long authored synthesis never drops the Known gaps section", () => {
    const snapshot = makeSnapshot();
    const decision = makeDecision("R".repeat(3950));
    const result = renderAcceptedSynthesis(decision, snapshot);
    expect(result).toContain("Known gaps:");
    expect(result).toContain("- lane3: unsatisfied — source feed unreachable");
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it("keeps every optional gap ID when rationale text must be compacted", () => {
    const snapshot = makeSnapshot();
    const extraIds = Array.from({ length: 12 }, (_, i) => `gap-${i + 1}`);
    const expanded: ReviewCaseSnapshot = {
      ...snapshot,
      root_contract: {
        ...snapshot.root_contract,
        criteria: [
          ...snapshot.root_contract.criteria,
          ...extraIds.map(id => ({ id, description: id, required: false, execution_owner: "delegated" as const, evidence_expectation: "artifact" as const })),
        ],
      },
      criterion_inputs: [
        ...snapshot.criterion_inputs,
        ...extraIds.map(id => ({
          criterion_id: id,
          description: id,
          required: false,
          execution_owner: "delegated" as const,
          evidence_expectation: "artifact" as const,
          mapped_child_contract_ids: [],
          observed_evidence_ids: [],
          worker_claim_ids: [],
          failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [],
          retry_lineage_ids: [],
          coverage_hint: "gap" as const,
        })),
      ],
    };
    const decision = makeDecision("Report delivered");
    for (const id of extraIds) {
      decision.criteria.push({ criterion_id: id, verdict: "unsatisfied", evidence_ids: [], rationale: "x".repeat(500) });
    }

    const result = renderAcceptedSynthesis(decision, expanded);
    expect(result.length).toBeLessThanOrEqual(4000);
    for (const id of extraIds) expect(result).toContain(`- ${id}: unsatisfied`);
  });
});

describe("ProjectReviewService — #1620 severity, correction budget, truthful exhaustion", () => {
  let service: ProjectReviewService;
  let store: ProjectReviewStore;
  let seq = 0;

  function uniquePid(): number {
    return 15000 + (++seq);
  }

  async function setupCase(pid?: number): Promise<{ cardId: number; caseId: string }> {
    const cardId = pid ?? uniquePid();
    const contract = {
      schema_version: 1,
      id: `pc_sv2_${cardId}`,
      digest: `digest_${cardId}`,
      project_card_id: cardId,
      goal: "Build the feature",
      criteria: [{ id: "c1", description: "Works", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
    };
    const s = new ProjectReviewStore();
    s.insertContract(contract);
    s.initializeSupervision(cardId, contract.id, "executing");
    s.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, datetime('now'), datetime('now'))`)
      .run(cardId, "sv2 project", "task", "sv2 goal");
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
      criterion_inputs: [{ criterion_id: "c1", description: "Works", evidence_expectation: "synthesis", mapped_child_contract_ids: ["pc_child_c1"], successful_mapped_child_contract_ids: ["pc_child_c1"], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" }],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
    };
    const caseRow = s.insertReviewCase(cardId, 1, 1, snapshot, `digest_${cardId}`);
    s.insertReviewRequest(cardId, caseRow.id, 1);
    s.stateTransition(cardId, ["executing"], "review_ready");
    return { cardId, caseId: caseRow.id };
  }

  function makeDecision(cardId: number, caseId: string, overrides?: Partial<ProjectReviewDecisionV1>): ProjectReviewDecisionV1 {
    return {
      schema_version: 1,
      id: `rd_sv2_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      project_card_id: cardId,
      review_case_id: caseId,
      project_generation: 1,
      action: "accept",
      criteria: [{ criterion_id: "c1", verdict: "satisfied", evidence_ids: ["e1"], rationale: "Works correctly" }],
      outputs: [{ output_id: "o1", disposition: "verified", evidence_ids: ["e1"] }],
      contradictions: [],
      residual_risks: [],
      synthesis: "Complete.",
      authored_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function invalidCount(): number {
    return store.getReviewRequestByCaseId(caseId) as never as { invalid_proposals: number } | undefined
      ? Number((store.db.prepare("SELECT invalid_proposals FROM project_review_requests WHERE review_case_id = ?").get(caseId) as { invalid_proposals: number }).invalid_proposals)
      : 0;
  }

  let caseId: string;
  let cardId: number;

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-sv2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    const svcMod = await import("./project-review-service.js");
    ProjectReviewService = svcMod.ProjectReviewService;
    store = new ProjectReviewStore();
    service = new ProjectReviewService();
    const setup = await setupCase();
    cardId = setup.cardId;
    caseId = setup.caseId;
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("a warning-only decision settles and leaves the invalid count unchanged", () => {
    const decision = makeDecision(cardId, caseId, {
      action: "blocked",
      // required output o1 omitted → warn (non-accept action proceeds safely)
      outputs: [],
      blocker: { blocker_class: "external_dependency", affected_criterion_ids: ["c1"], exhausted_failures: [], contradiction_evidence: [], what_was_attempted: "tried", unblock_conditions: "" },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("blocked");
    if (result.kind === "blocked") {
      expect(result.warnings?.length).toBe(1);
      expect(result.warnings![0]).toContain("missing disposition for required output");
    }
    expect(invalidCount()).toBe(0);
    const sup = store.getSupervision(cardId)!;
    expect(sup.state).toBe("blocked");
    expect(sup.blocked_reason).toBe("external_dependency");
  });

  it("first error reports count and remaining attempts; a corrected call succeeds", () => {
    // accept with the required output omitted is an explicit error (#1620)
    const bad = makeDecision(cardId, caseId, { outputs: [] });
    const first = service.processDecision(bad);
    expect(first.kind).toBe("invalid");
    if (first.kind === "invalid") {
      expect(first.invalidProposalCount).toBe(1);
      expect(first.remainingAttempts).toBe(4);
      expect(first.issues.some(i => i.tag === "missing_field")).toBe(true);
    }
    const second = service.processDecision(bad);
    if (second.kind === "invalid") {
      expect(second.invalidProposalCount).toBe(2);
      expect(second.remainingAttempts).toBe(3);
    }
    expect(store.hasDecisionForCase(caseId)).toBe(false);

    const fixed = makeDecision(cardId, caseId);
    const success = service.processDecision(fixed);
    expect(success.kind).toBe("accepted");
    expect(invalidCount()).toBe(2);
  });

  it("fifth error settles exactly once with review_protocol_exhausted and no accepted decision", () => {
    const bad = makeDecision(cardId, caseId, { outputs: [] });
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = service.processDecision(bad);
      outcomes.push(r.kind);
    }
    expect(outcomes.filter(k => k === "invalid")).toHaveLength(4);
    expect(outcomes.filter(k => k === "blocked_invalid")).toHaveLength(1);

    const sup = store.getSupervision(cardId)!;
    expect(sup.state).toBe("blocked");
    expect(sup.blocked_reason).toBe("review_protocol_exhausted");

    // exactly one terminal decision row, and the durable blocker carries the count
    const decisions = store.db.prepare("SELECT decision_json FROM project_review_decisions WHERE review_case_id = ?").all(caseId) as Array<{ decision_json: string }>;
    expect(decisions).toHaveLength(1);
    const blocker = JSON.parse(decisions[0]!.decision_json) as { blocker_class: string; invalid_proposals: number };
    expect(blocker.blocker_class).toBe("review_protocol_exhausted");
    expect(blocker.invalid_proposals).toBe(5);

    // card error says protocol failed — it does not claim criteria were reviewed
    const kanbanRow = store.db.prepare("SELECT status, error FROM kanban_board WHERE id = ?").get(cardId) as { status: string; error: string };
    expect(kanbanRow.status).toBe("failed");
    expect(kanbanRow.error).toContain("review_protocol_exhausted");
  });

  it("a settled request can never be re-incremented or double-settled", () => {
    const bad = makeDecision(cardId, caseId, { outputs: [] });
    for (let i = 0; i < 5; i++) service.processDecision(bad);
    expect(store.getSupervision(cardId)!.state).toBe("blocked");

    // a late duplicate decision for the already-settled case is rejected and
    // cannot consume budget or overwrite the terminal decision
    const late = service.processDecision(bad);
    expect(late.kind).toBe("invalid");
    if (late.kind === "invalid") {
      expect(late.invalidProposalCount).toBe(0);
    }
    const decisions = store.db.prepare("SELECT COUNT(*) as cnt FROM project_review_decisions WHERE review_case_id = ?").get(caseId) as { cnt: number };
    expect(Number(decisions.cnt)).toBe(1);
  });

  it("warnings are surfaced on successful non-accept outcomes without incrementing", () => {
    const decision = makeDecision(cardId, caseId, {
      action: "repair",
      outputs: [],
      repair: { items: [{ affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], budget: { max_tokens: 5000 } }], rationale: "needs evidence" },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("repair");
    if (result.kind === "repair") expect(result.warnings?.length).toBe(1);
    expect(invalidCount()).toBe(0);
  });
});

describe("#1618 acceptance outbox drain retry", () => {
  let store: ProjectReviewStore;
  let broker: { sendRequest: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-drain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    broker = { sendRequest: vi.fn() };
    testBroker.sendRequest = broker.sendRequest;
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    await import("./project-review-service.js");
    store = new ProjectReviewStore();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  async function drain(): Promise<number> {
    const svcMod = await import("./project-review-service.js");
    return svcMod.drainAcceptanceOutbox();
  }

  it("retains the row on broker failure and marks it sent only after success", async () => {
    const cardId = 91001;
    store.db.prepare(
      `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, created_at, updated_at)
       VALUES ('ao_1', ?, 'kp', ?, datetime('now'), datetime('now'))`,
    ).run(cardId, JSON.stringify({ event_id: "accept_1", kind: "completed", request_id: "r1", contribution_ref: "c1" }));

    broker.sendRequest.mockRejectedValueOnce(new Error("network down"));
    expect(await drain()).toBe(0);
    const afterFailure = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterFailure.sent_at).toBeNull();
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.last_error).toContain("network down");

    broker.sendRequest.mockResolvedValueOnce(undefined);
    expect(await drain()).toBe(1);
    const afterSuccess = store.db.prepare("SELECT sent_at FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterSuccess.sent_at).not.toBeNull();
    expect(broker.sendRequest).toHaveBeenCalledWith("kp", "help.event.v1", expect.objectContaining({ kind: "completed" }));
  });

  it("does not resend a row already marked sent", async () => {
    const cardId = 91002;
    store.db.prepare(
      `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, sent_at, created_at, updated_at)
       VALUES ('ao_2', ?, 'kp', ?, datetime('now'), datetime('now'), datetime('now'))`,
    ).run(cardId, JSON.stringify({ event_id: "accept_2", kind: "completed" }));

    broker.sendRequest.mockResolvedValueOnce(undefined);
    expect(await drain()).toBe(0);
    expect(broker.sendRequest).not.toHaveBeenCalled();
  });
});
