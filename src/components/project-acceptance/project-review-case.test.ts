import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1, ProjectAcceptanceContractV2, CriterionExecutionOwner } from "./project-contract.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { ReviewCaseSnapshot } from "./project-review-case.js";

let TEST_HOME: string;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `rca-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

function makeRootContract(cardId: number, criteria: string[]): ProjectAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `pc_rca_${cardId}`,
    digest: `digest_rca_${cardId}`,
    project_card_id: cardId,
    goal: "Root goal",
    criteria: criteria.map(id => ({ id, description: `Criterion ${id}`, required: true as const, evidence_expectation: "synthesis" as const })),
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
  };
}

function makeChildContract(cardId: number, rootCardId: number, supports: string[]): WorkerAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `pc_rca_child_${cardId}`,
    digest: `digest_rca_child_${cardId}`,
    goal: "Child goal",
    criteria: [{ id: `l${cardId}c1`, description: "Child criterion" }],
    expected_artifacts: [{ id: "a1", kind: "file", ref: "handoff.md", required: true, criterion_ids: [`l${cardId}c1`] }],
    verification_commands: [],
    required_capabilities: [],
    supports_root_criteria: supports,
    limits: {},
    provenance: { root_card_id: rootCardId, card_id: cardId, authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
  };
}

function makeRootContractV2(cardId: number, criteria: Array<{ id: string; required: boolean; execution_owner: CriterionExecutionOwner }>): ProjectAcceptanceContractV2 {
  return {
    schema_version: 2,
    id: `pc_rca_${cardId}`,
    digest: `digest_rca_${cardId}`,
    project_card_id: cardId,
    goal: "Root goal",
    criteria: criteria.map(c => ({ id: c.id, description: `Criterion ${c.id}`, required: c.required, execution_owner: c.execution_owner, evidence_expectation: c.execution_owner === "orc" ? "synthesis" : "observed" })),
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
  };
}

describe("ReviewCaseAssembler coverage read-model (#1604)", () => {
  it("snapshot uncovered_criteria matches the read-model for a partial gap", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const reviewStoreMod = await import("./project-review-store.js");
    const supStoreMod = await import("../worker-supervision-store.js");
    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const { readProjectCriterionCoverage } = await import("./project-criterion-coverage.js");

    const rootCardId = kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract(makeRootContract(rootCardId, ["c1", "c2", "c3"]));
    reviewStore.initializeSupervision(rootCardId, `pc_rca_${rootCardId}`, "executing");

    const supStore = new supStoreMod.WorkerSupervisionStore();
    const childA = kanban.kanbanEnqueue("lane A", "agent", undefined, { type: "W", parent_id: rootCardId });
    const childB = kanban.kanbanEnqueue("lane B", "agent", undefined, { type: "W", parent_id: rootCardId });
    supStore.insertContract(makeChildContract(childA, rootCardId, ["c1"]), childA);
    supStore.insertContract(makeChildContract(childB, rootCardId, ["c3"]), childB);

    const assembler = new ReviewCaseAssembler();
    const snapshot = await assembler.assembleCase(rootCardId, 1, 1);
    expect("error" in snapshot).toBe(false);

    const read = readProjectCriterionCoverage(rootCardId);
    expect(read.kind).toBe("read");
    if (read.kind === "read") {
      const snap = snapshot as ReviewCaseSnapshot;
      expect(snap.uncovered_criteria).toEqual([...read.read.uncovered]);
      expect(snap.uncovered_criteria).toEqual(["c2"]);
    }
  });

  it("undeterminable coverage fails assembly instead of treating the project as covered", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const reviewStoreMod = await import("./project-review-store.js");
    const supStoreMod = await import("../worker-supervision-store.js");
    const { ReviewCaseAssembler } = await import("./project-review-case.js");

    const rootCardId = kanban.kanbanEnqueue("root", "task", "run-2", { type: "O" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract(makeRootContract(rootCardId, ["c1"]));
    reviewStore.initializeSupervision(rootCardId, `pc_rca_${rootCardId}`, "executing");

    const child = kanban.kanbanEnqueue("lane", "agent", undefined, { type: "W", parent_id: rootCardId });
    const supStore = new supStoreMod.WorkerSupervisionStore();
    supStore.insertContract(makeChildContract(child, rootCardId, ["c1"]), child);
    supStore.db.prepare(`UPDATE worker_contracts SET contract_json = 'corrupt{' WHERE card_id = ?`).run(child);

    const assembler = new ReviewCaseAssembler();
    const snapshot = await assembler.assembleCase(rootCardId, 1, 1);
    expect("error" in snapshot).toBe(true);
    if ("error" in snapshot) {
      expect(snapshot.error).toContain("unparseable");
    }
  });

  it("invalid JSON-shaped root contracts fail assembly without throwing", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const reviewStoreMod = await import("./project-review-store.js");
    const { ReviewCaseAssembler } = await import("./project-review-case.js");

    const rootCardId = kanban.kanbanEnqueue("root", "task", "run-invalid-root", { type: "O" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract({
      schema_version: 2,
      id: `pc_invalid_${rootCardId}`,
      digest: "digest",
      project_card_id: rootCardId,
      goal: "Root goal",
      criteria: "not-an-array",
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
    } as never);
    reviewStore.initializeSupervision(rootCardId, `pc_invalid_${rootCardId}`, "executing");

    const assembler = new ReviewCaseAssembler();
    const snapshot = await assembler.assembleCase(rootCardId, 1, 1);
    expect("error" in snapshot).toBe(true);
    if ("error" in snapshot) expect(snapshot.error).toContain("invalid");
  });

  it("#1605: production shape — 3 delegated lanes + 4 Orc-owned criteria carry policy and a failed optional lane into the immutable snapshot", async () => {
    const kanban = await import("../tasks/kanban-board.js");
    const reviewStoreMod = await import("./project-review-store.js");
    const supStoreMod = await import("../worker-supervision-store.js");
    const { ReviewCaseAssembler } = await import("./project-review-case.js");

    const rootCardId = kanban.kanbanEnqueue("root", "task", "run-3", { type: "O" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract(makeRootContractV2(rootCardId, [
      { id: "lane1-feeds", required: true, execution_owner: "delegated" },
      { id: "lane2-newsletters", required: true, execution_owner: "delegated" },
      { id: "lane3-web", required: false, execution_owner: "delegated" },
      { id: "synthesis", required: true, execution_owner: "orc" },
      { id: "quality", required: true, execution_owner: "orc" },
      { id: "budget", required: true, execution_owner: "orc" },
      { id: "honest-stats", required: true, execution_owner: "orc" },
    ]));
    reviewStore.initializeSupervision(rootCardId, `pc_rca_${rootCardId}`, "executing");

    const supStore = new supStoreMod.WorkerSupervisionStore();
    const lane1 = kanban.kanbanEnqueue("lane A", "agent", undefined, { type: "W", parent_id: rootCardId });
    supStore.insertContract(makeChildContract(lane1, rootCardId, ["lane1-feeds"]), lane1);
    const lane2 = kanban.kanbanEnqueue("lane B", "agent", undefined, { type: "W", parent_id: rootCardId });
    supStore.insertContract(makeChildContract(lane2, rootCardId, ["lane2-newsletters"]), lane2);
    const lane3 = kanban.kanbanEnqueue("lane C", "agent", undefined, { type: "W", parent_id: rootCardId });
    const lane3Contract = makeChildContract(lane3, rootCardId, ["lane3-web"]);
    supStore.insertContract(lane3Contract, lane3);
    // lane 3 fails (optional lane) — a durable failure with no result envelope
    supStore.insertAttempt({
      id: `att_lane3_failed`,
      card_id: lane3,
      contract_id: lane3Contract.id,
      ordinal: 1,
      executor_kind: "local_worker",
      executor_id: "spin",
      status: "failed",
      started_at: new Date().toISOString(),
    });

    const assembler = new ReviewCaseAssembler();
    const snapshot = await assembler.assembleCase(rootCardId, 1, 1);
    expect("error" in snapshot).toBe(false);
    const snap = snapshot as ReviewCaseSnapshot;

    // Policy fields carried into root_contract and criterion_inputs
    expect(snap.root_contract.criteria).toHaveLength(7);
    const synthesis = snap.root_contract.criteria.find(c => c.id === "synthesis")!;
    expect(synthesis.execution_owner).toBe("orc");
    const lane3Policy = snap.root_contract.criteria.find(c => c.id === "lane3-web")!;
    expect(lane3Policy.required).toBe(false);

    // Coverage hints: orc_owned for the four Orc duties, supported for lanes
    const inputs = new Map(snap.criterion_inputs.map(ci => [ci.criterion_id, ci]));
    expect(inputs.get("synthesis")?.coverage_hint).toBe("orc_owned");
    expect(inputs.get("synthesis")?.execution_owner).toBe("orc");
    expect(inputs.get("synthesis")?.mapped_child_contract_ids).toEqual([]);
    expect(inputs.get("lane1-feeds")?.coverage_hint).toBe("supported");
    expect(inputs.get("lane1-feeds")?.execution_owner).toBe("delegated");
    expect(inputs.get("lane3-web")?.required).toBe(false);

    // Failed optional lane is durable evidence, not a coverage gap
    expect(snap.uncovered_criteria).toEqual([]);
    const laneSummary = snap.child_summaries.find(c => c.card_id === lane3)!;
    expect(laneSummary.outcome).toContain("failed");
  });
});

describe("projectReviewBrief decision-ready projection (#1620)", () => {
  function makeProjectionSnapshot(): ReviewCaseSnapshot {
    return {
      schema_version: 1,
      project_card_id: 7717,
      generation: 2,
      round: 1,
      created_at: "2026-08-09T00:00:00.000Z",
      root_contract: {
        id: "pc_7717",
        digest: "d_7717",
        goal: "Produce the report",
        criteria: [
          { id: "c_orc", description: "Orc synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
          { id: "c_sup", description: "Delegated supported", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
          { id: "c_gap", description: "Delegated gap", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        ],
        required_outputs: [
          { id: "out_required", description: "Report file", kind: "file", required: true },
          { id: "out_optional", description: "Notes", kind: "logical", required: false },
        ],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      },
      criterion_inputs: [
        {
          criterion_id: "c_orc", description: "Orc synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis",
          mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned",
        },
        {
          criterion_id: "c_sup", description: "Delegated supported", required: true, execution_owner: "delegated", evidence_expectation: "observed",
          mapped_child_contract_ids: ["cc_1"], observed_evidence_ids: ["chk_1"], worker_claim_ids: ["claim_1"],
          failed_or_inconclusive_check_ids: ["chk_fail"], artifact_observation_ids: ["art_1"], retry_lineage_ids: ["card_1_2_attempts"],
          coverage_hint: "supported",
        },
        {
          criterion_id: "c_gap", description: "Delegated gap", required: true, execution_owner: "delegated", evidence_expectation: "observed",
          mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap",
        },
      ],
      contradiction_candidates: [
        { id: "cc_1", affected_criterion_ids: ["c_sup"], description: "Conflicting outcomes", evidence_ids: ["chk_1"], sources: ["card_1", "card_2"] },
      ],
      uncovered_criteria: ["c_gap"],
      child_summaries: [
        { card_id: 1001, contract_id: "cc_1", outcome: "completed", criterion_statuses: [{ criterion_id: "c_sup", status: "passed" }], attempts: 2, executor_kind: "local_worker" },
      ],
      peer_contributions: [
        { card_id: 2001, peer: "molty", outcome: "completed", projection_summary: "Molty completed the analysis", root_criteria: ["c_sup"], provenance: '{"receiver_peer":"molty"}' },
      ],
      budgets: { total_cost: 12.5, total_tokens: 4500, wall_clock_ms: 60000, review_round: 1, repair_round: 0 },
      evidence_ref_count: 3,
      contradiction_count: 1,
    };
  }

  it("projects criteria policy, grouped compatible evidence, claims, budgets, and legal values", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const snapshot = makeProjectionSnapshot();
    const { id } = store.insertReviewCase(7717, 2, 1, snapshot, "digest_brief");

    const result = projectReviewBrief(id, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const brief = result.brief;

    expect(brief.schema_version).toBe(1);
    expect(brief.project_card_id).toBe(7717);
    expect(brief.project_generation).toBe(2);
    expect(brief.review_case_id).toBe(id);
    expect(brief.round).toBe(1);
    expect(brief.goal).toBe("Produce the report");

    const byId = new Map(brief.criteria.map(c => [c.criterion_id, c]));
    expect(byId.get("c_orc")?.execution_owner).toBe("orc");
    expect(byId.get("c_orc")?.coverage_hint).toBe("orc_owned");
    expect(byId.get("c_orc")?.compatible_evidence).toEqual({ observed: [], failed_or_inconclusive: [], artifacts: [] });

    const sup = byId.get("c_sup")!;
    expect(sup.compatible_evidence.observed).toEqual(["chk_1"]);
    expect(sup.compatible_evidence.failed_or_inconclusive).toEqual(["chk_fail"]);
    expect(sup.compatible_evidence.artifacts).toEqual(["art_1"]);
    // worker claim ids are not promoted into compatible evidence
    expect(sup.compatible_evidence.observed).not.toContain("claim_1");

    expect(byId.get("c_gap")?.coverage_hint).toBe("gap");
    expect(brief.uncovered_criteria).toEqual(["c_gap"]);

    const outRequired = brief.outputs.find(o => o.output_id === "out_required")!;
    expect(outRequired.required).toBe(true);
    const outOptional = brief.outputs.find(o => o.output_id === "out_optional")!;
    expect(outOptional.required).toBe(false);

    expect(brief.contradictions).toHaveLength(1);
    expect(brief.contradictions[0]!.id).toBe("cc_1");
    expect(brief.children).toHaveLength(1);
    expect(brief.children[0]!.attempts).toBe(2);

    // peer contributions are labeled claims, never evidence
    expect(brief.peer_claims).toHaveLength(1);
    expect(brief.peer_claims[0]!.peer).toBe("molty");
    expect(brief.budgets.total_cost).toBe(12.5);

    expect(brief.legal_values.actions).toEqual(["accept", "repair", "blocked", "needs_input"]);
    expect(brief.legal_values.criterion_verdicts).toContain("satisfied");
    expect(brief.legal_values.output_dispositions).toContain("remote_only");
    expect(brief.legal_values.contradiction_dispositions).toContain("blocking");
  });

  it("decision skeleton contains only ids and empty fields — never invented verdicts", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { id } = store.insertReviewCase(7717, 2, 1, makeProjectionSnapshot(), "digest_brief_2");

    const result = projectReviewBrief(id, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const skeleton = result.brief.decision_skeleton as {
      project_card_id: number;
      criteria: Array<{ criterion_id: string; verdict: unknown; evidence_ids: unknown[]; rationale: string }>;
      outputs: Array<{ output_id: string; disposition: unknown }>;
      contradictions: unknown[];
      residual_risks: unknown[];
      synthesis: string;
    };
    expect(skeleton.project_card_id).toBe(7717);
    expect(skeleton.criteria).toHaveLength(3);
    for (const c of skeleton.criteria) {
      expect(c.verdict).toBeNull();
      expect(c.evidence_ids).toEqual([]);
      expect(c.rationale).toBe("");
    }
    expect(skeleton.outputs).toHaveLength(2);
    for (const o of skeleton.outputs) expect(o.disposition).toBeNull();
    expect(skeleton.contradictions).toEqual([]);
    expect(skeleton.residual_risks).toEqual([]);
    expect(skeleton.synthesis).toBe("");
  });

  it("fails closed on missing or closed cases", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { id } = store.insertReviewCase(7717, 2, 1, makeProjectionSnapshot(), "digest_brief_3");
    store.supersedeCase(id);

    const missing = projectReviewBrief("nonexistent", store);
    expect(missing.ok).toBe(false);
    const closed = projectReviewBrief(id, store);
    expect(closed.ok).toBe(false);
    if (!closed.ok) expect(closed.error).toContain("not open");
  });

  it("truncates prose but preserves every id and evidence reference", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const snapshot = makeProjectionSnapshot();
    const longDesc = "x".repeat(1000);
    snapshot.root_contract = {
      ...snapshot.root_contract,
      goal: "g".repeat(5000),
      criteria: snapshot.root_contract.criteria.map(c => ({ ...c, description: c.id === "c_sup" ? longDesc : c.description })),
    };
    const { id } = store.insertReviewCase(7717, 2, 1, snapshot, "digest_brief_4");

    const result = projectReviewBrief(id, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.goal.length).toBeLessThanOrEqual(1000);
    const sup = result.brief.criteria.find(c => c.criterion_id === "c_sup")!;
    expect(sup.description.length).toBeLessThanOrEqual(300);
    expect(sup.compatible_evidence.observed).toEqual(["chk_1"]);
    expect(result.brief.uncovered_criteria).toEqual(["c_gap"]);
    expect(result.brief.peer_claims[0]!.card_id).toBe(2001);
  });

  it("projects child metadata without exposing an embedded Worker result envelope", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const snapshot = makeProjectionSnapshot() as unknown as {
      child_summaries: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    snapshot.child_summaries = [{
      ...snapshot.child_summaries[0],
      result: {
        checks: [{ argv: ["cat", "/private/path"], stdout_excerpt: "secret" }],
        worker_report: { summary: "raw Worker prose" },
      },
    }];
    const { id } = store.insertReviewCase(7717, 2, 1, snapshot, "digest_brief_5");

    const result = projectReviewBrief(id, store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brief.children[0]).not.toHaveProperty("result");
    expect(JSON.stringify(result.brief)).not.toContain("/private/path");
    expect(JSON.stringify(result.brief)).not.toContain("raw Worker prose");
  });
});
