import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi, type Mock } from "vitest";
import type { ReviewCaseSnapshot } from "./project-review-case.js";
import type { ProjectReviewDecisionV1 } from "./project-review-validator.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { ProjectAcceptanceContractV2 } from "./project-contract.js";

// #1618: acceptance-outbox drain tests drive a fake broker. Hoisted so the
// module factory can reference it; tests that never call the drain are
// unaffected.
const { testBroker } = vi.hoisted(() => ({
  testBroker: { sendRequest: async (...args: unknown[]) => { throw new Error("no broker configured"); } },
}));
vi.mock("../peer-transport/peer-ws-broker.js", () => ({
  getPeerWsBroker: () => testBroker,
}));

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let ProjectReviewService: typeof import("./project-review-service.js").ProjectReviewService;

describe("ProjectReviewService — full outcome matrix", () => {
  let service: InstanceType<typeof ProjectReviewService>;
  let store: InstanceType<typeof ProjectReviewStore>;
  let _seq = 0;

  function uniquePid(): number {
    return 8000 + (++_seq);
  }

  function makeContract(cardId: number): ProjectAcceptanceContractV2 {
    return {
      schema_version: 2,
      id: `pc_svc_${cardId}`,
      digest: `digest_${cardId}`,
      project_card_id: cardId,
      goal: "Build the feature",
      criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }],
      required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
    };
  }

  /** #1686: seed the durable source Worker contract a repair item references. */
  let _seedSeq = 0;
  async function seedSourceContract(
    contractId: string,
    rootCardId: number,
    supportsRootCriteria: string[],
    overrides?: { provenanceRoot?: number; corrupted?: boolean; missingArtifacts?: boolean },
  ): Promise<void> {
    const { WorkerSupervisionStore } = await import("../worker-supervision-store.js");
    const workerStore = new WorkerSupervisionStore(store.db);
    const childCardId = 2000 + (++_seedSeq);
    const base: WorkerAcceptanceContractV1 = {
      schema_version: 1,
      id: contractId,
      digest: `digest_${contractId}_${childCardId}`,
      goal: `lane ${contractId}`,
      criteria: [{ id: "w1", description: "fetch the lane" }],
      expected_artifacts: overrides?.missingArtifacts
        ? []
        : [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
      verification_commands: [],
      required_capabilities: [],
      supports_root_criteria: supportsRootCriteria,
      limits: {},
      provenance: { root_card_id: overrides?.provenanceRoot ?? rootCardId, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
    };
    if (overrides?.corrupted) {
      workerStore.db.prepare(`INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, parent_contract_id, source_attempt_id, schema_version, contract_json, contract_digest, created_at) VALUES (?, ?, 1, ?, NULL, NULL, 1, ?, 'dd', datetime('now'))`)
        .run(contractId, childCardId, contractId, "not json {{{");
      return;
    }
    workerStore.insertContract(base, childCardId);
  }

  async function setupCase(pid?: number): Promise<{ cardId: number; caseId: string; store: InstanceType<typeof ProjectReviewStore> }> {
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
      criterion_inputs: [{ criterion_id: "c1", description: "Works", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [`pc_child_${cardId}`], successful_mapped_child_contract_ids: [`pc_child_${cardId}`], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" }],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 0,
      contradiction_count: 0,
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
    await seedSourceContract(`pc_child_${cardId}`, cardId, ["c1"]);
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: { max_tokens: 5000 } }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("repair");
    if (result.kind === "repair") {
      expect(typeof result.decisionId).toBe("string");
    }

    const sup = store.getSupervision(cardId);
    expect(sup?.state).toBe("repair_planned");
  });

  // ── #1686: durable repair source-contract validation ──────────────────────

  it("rejects a repair whose source contract is not in the worker supervision store", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.message.includes("not found in the worker supervision store"))).toBe(true);
    }
    // No repair state, no decision, no budget mutation.
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
    expect(store.hasDecisionForCase(caseId)).toBe(false);
  });

  it("rejects a repair whose source contract is corrupt or fails worker validation", async () => {
    const { cardId, caseId } = await setupCase();
    await seedSourceContract(`pc_child_${cardId}`, cardId, ["c1"], { corrupted: true });
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.message.includes("unparseable"))).toBe(true);
    }
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
  });

  it("rejects a source contract with no evidence path (fails worker validation)", async () => {
    const { cardId, caseId } = await setupCase();
    await seedSourceContract(`pc_child_${cardId}`, cardId, ["c1"], { missingArtifacts: true });
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.message.includes("failed worker-contract validation"))).toBe(true);
    }
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
  });

  it("rejects a source contract whose provenance names a different root project", async () => {
    const { cardId, caseId } = await setupCase();
    await seedSourceContract(`pc_child_${cardId}`, cardId, ["c1"], { provenanceRoot: cardId + 1000 });
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.message.includes("belongs to project"))).toBe(true);
    }
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
  });

  it("rejects a repair whose source contract does not cover the affected criteria", async () => {
    const { cardId, caseId } = await setupCase();
    await seedSourceContract(`pc_child_${cardId}`, cardId, ["c1"]);
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1", "ghost"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Need more evidence",
      },
    });
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.message.includes("does not cover affected criterion"))).toBe(true);
    }
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
    expect(store.hasDecisionForCase(caseId)).toBe(false);
  });

  it("a legacy repair item without source_contract_id is rejected before any mutation", async () => {
    const { cardId, caseId } = await setupCase();
    const decision = makeValidDecision(cardId, caseId, {
      action: "repair",
      repair: {
        items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: {} }],
        rationale: "Legacy",
      },
    });
    // #1686: legacy payloads predate source_contract_id; drop it at runtime to
    // exercise the missing-field rejection path the validator guards.
    const firstItem = decision.repair?.items[0];
    if (firstItem === undefined) throw new Error("expected a repair item");
    delete (firstItem as { source_contract_id?: string }).source_contract_id;
    const result = service.processDecision(decision);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues.some(i => i.path.includes("source_contract_id"))).toBe(true);
    }
    expect(store.getSupervision(cardId)?.state).toBe("review_ready");
    expect(store.hasDecisionForCase(caseId)).toBe(false);
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
    if (result.kind === "needs_input") {
      expect(typeof result.decisionId).toBe("string");
    }

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
        { criterion_id: "lane3", description: "Lane 3", required: false, execution_owner: "delegated", evidence_expectation: "artifact", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap" },
        { criterion_id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned" },
      ],
      contradiction_candidates: [],
      uncovered_criteria: ["lane3"],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 0,
      contradiction_count: 0,
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
          successful_mapped_child_contract_ids: [],
          unsuccessful_mapped_child_contract_ids: [],
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
  let service: InstanceType<typeof ProjectReviewService>;
  let store: InstanceType<typeof ProjectReviewStore>;
  let seq = 0;

  function uniquePid(): number {
    return 15000 + (++seq);
  }

  async function setupCase(pid?: number): Promise<{ cardId: number; caseId: string }> {
    const cardId = pid ?? uniquePid();
    const contract: ProjectAcceptanceContractV2 = {
      schema_version: 2,
      id: `pc_sv2_${cardId}`,
      digest: `digest_${cardId}`,
      project_card_id: cardId,
      goal: "Build the feature",
      criteria: [{ id: "c1", description: "Works", required: true, execution_owner: "delegated", evidence_expectation: "synthesis" }],
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
      criterion_inputs: [{ criterion_id: "c1", description: "Works", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [`pc_child_${cardId}`], successful_mapped_child_contract_ids: [`pc_child_${cardId}`], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["e1"], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" }],
      contradiction_candidates: [],
      uncovered_criteria: [],
      child_summaries: [],
      peer_contributions: [],
      budgets: { total_cost: undefined, total_tokens: 1000, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 0,
      contradiction_count: 0,
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
    let settledDecisionId: string | undefined;
    for (let i = 0; i < 5; i++) {
      const r = service.processDecision(bad);
      outcomes.push(r.kind);
      if (r.kind === "blocked_invalid") settledDecisionId = r.decisionId;
    }
    expect(outcomes.filter(k => k === "invalid")).toHaveLength(4);
    expect(outcomes.filter(k => k === "blocked_invalid")).toHaveLength(1);

    const sup = store.getSupervision(cardId)!;
    expect(sup.state).toBe("blocked");
    expect(sup.blocked_reason).toBe("review_protocol_exhausted");

    // exactly one terminal decision row, and the durable blocker carries the count
    const decisions = store.db.prepare("SELECT id, decision_json FROM project_review_decisions WHERE review_case_id = ?").all(caseId) as Array<{ id: string; decision_json: string }>;
    expect(decisions).toHaveLength(1);
    expect(settledDecisionId).toBe(decisions[0]!.id);
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

  it("warnings are surfaced on successful non-accept outcomes without incrementing", async () => {
    const decision = makeDecision(cardId, caseId, {
      action: "repair",
      outputs: [],
      repair: { items: [{ id: "r1", source_contract_id: `pc_child_${cardId}`, affected_criterion_ids: ["c1"], required_evidence: "observed", strategy: "rework", do_not_repeat: [], capabilities: [], budget: { max_tokens: 5000 } }], rationale: "needs evidence" },
    });
    const { WorkerSupervisionStore } = await import("../worker-supervision-store.js");
    const workerStore = new WorkerSupervisionStore(store.db);
    workerStore.insertContract({
      schema_version: 1,
      id: `pc_child_${cardId}`,
      digest: `digest_warnings_${cardId}`,
      goal: "lane 1",
      criteria: [{ id: "w1", description: "fetch the lane" }],
      expected_artifacts: [{ id: "a1", kind: "file", ref: "lane1-x-handoff.md", required: true, criterion_ids: ["w1"] }],
      verification_commands: [],
      required_capabilities: [],
      supports_root_criteria: ["c1"],
      limits: {},
      provenance: { root_card_id: cardId, card_id: 0, authored_by: "orc", created_at: new Date().toISOString() },
    }, 2);
    const result = service.processDecision(decision);
    expect(result.kind).toBe("repair");
    if (result.kind === "repair") expect(result.warnings?.length).toBe(1);
    expect(invalidCount()).toBe(0);
  });
});

describe("#1618 acceptance outbox drain retry", () => {
  let store: InstanceType<typeof ProjectReviewStore>;
  let broker: { sendRequest: Mock };

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
    // The task database is a module-level singleton shared across tests in this
    // describe; clear durable rows so each test starts from an empty outbox.
    store.db.prepare("DELETE FROM project_acceptance_outbox").run();
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

  it("retains the row on broker failure and marks it sent only after a positive application ACK", async () => {
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

    // #1680: `undefined` is NOT a success — only literal `{ ok: true }` is.
    broker.sendRequest.mockResolvedValueOnce(undefined);
    expect(await drain()).toBe(0);
    const afterUndefined = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterUndefined.sent_at).toBeNull();
    expect(afterUndefined.attempts).toBe(2);
    expect(afterUndefined.last_error).toBe("help_event_not_applied");

    broker.sendRequest.mockResolvedValueOnce({ ok: true });
    expect(await drain()).toBe(1);
    const afterSuccess = store.db.prepare("SELECT sent_at FROM project_acceptance_outbox WHERE id = 'ao_1'").get() as any;
    expect(afterSuccess.sent_at).not.toBeNull();
    expect(broker.sendRequest).toHaveBeenCalledWith("kp", "help.event.v1", expect.objectContaining({ kind: "completed" }));
  });

  it("#1680: negative, malformed, and non-object ACKs retain the row and increment attempts", async () => {
    const cases: Array<{ label: string; ack: unknown }> = [
      { label: "ok:false", ack: { ok: false } },
      { label: "non-object", ack: "nope" },
      { label: "null", ack: null },
      { label: "array", ack: [{ ok: true }] },
      { label: "missing ok", ack: { sent: true } },
    ];
    let seq = 0;
    for (const c of cases) {
      const cardId = 91010 + (++seq);
      const id = `ao_case_${cardId}`;
      store.db.prepare(
        `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, created_at, updated_at)
         VALUES (?, ?, 'kp', ?, datetime('now'), datetime('now'))`,
      ).run(id, cardId, JSON.stringify({ event_id: `accept_${id}`, kind: "completed" }));

      broker.sendRequest.mockResolvedValueOnce(c.ack);
      expect(await drain()).toBe(0);
      const row = store.db.prepare("SELECT sent_at, attempts, last_error FROM project_acceptance_outbox WHERE id = ?").get(id) as any;
      expect(row.sent_at, `${c.label}: sent_at must stay null`).toBeNull();
      expect(row.attempts, `${c.label}: attempts must increment`).toBe(1);
      expect(row.last_error).toBe("help_event_not_applied");
    }
  });

  it("does not resend a row already marked sent", async () => {
    const cardId = 91002;
    store.db.prepare(
      `INSERT INTO project_acceptance_outbox (id, project_card_id, peer, payload_json, sent_at, created_at, updated_at)
       VALUES ('ao_2', ?, 'kp', ?, datetime('now'), datetime('now'), datetime('now'))`,
    ).run(cardId, JSON.stringify({ event_id: "accept_2", kind: "completed" }));

    broker.sendRequest.mockResolvedValueOnce({ ok: true });
    expect(await drain()).toBe(0);
    expect(broker.sendRequest).not.toHaveBeenCalled();
  });
});
