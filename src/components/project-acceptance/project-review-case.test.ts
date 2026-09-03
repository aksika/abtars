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
    const lane1Contract = makeChildContract(lane1, rootCardId, ["lane1-feeds"]);
    supStore.insertContract(lane1Contract, lane1);
    // #1656: lane 1 is a SUCCESSFUL mapped child — terminal card + completed
    // attempt + exact-contract envelope with every criterion passed.
    const lane1Attempt = {
      id: `att_lane1_ok`,
      card_id: lane1,
      contract_id: lane1Contract.id,
      ordinal: 1,
      executor_kind: "agent" as const,
      executor_id: "spin",
      status: "settled",
      started_at: new Date().toISOString(),
    };
    supStore.insertAttempt(lane1Attempt);
    supStore.lifecycleTransition(lane1Attempt.id, ["pending"], "completed", { status: "settled", settled_at: new Date().toISOString() });
    supStore.insertResult(lane1Attempt.id, {
      schema_version: 1,
      attempt: { id: lane1Attempt.id, ordinal: 1, contract_id: lane1Contract.id, contract_digest: lane1Contract.digest, executor_kind: "agent", executor_id: "spin", started_at: lane1Attempt.started_at, finished_at: new Date().toISOString() },
      outcome: "completed",
      criteria: [{ criterion_id: `l${lane1}c1`, status: "passed", evidence_ids: ["a1"] }],
      checks: [],
      artifacts: [{ artifact_id: "a1", exists: true, kind: "file", ref: "handoff.md", size: 10 }],
      worker_report: { summary: "done", claims: [], unresolved_risks: [] },
    });
    kanban.kanbanRunning(lane1);
    kanban.kanbanComplete(lane1, null, "worker completed");
    const lane2 = kanban.kanbanEnqueue("lane B", "agent", undefined, { type: "W", parent_id: rootCardId });
    const lane2Contract = makeChildContract(lane2, rootCardId, ["lane2-newsletters"]);
    supStore.insertContract(lane2Contract, lane2);
    // lane 2 is mapped but never produced a successful child — semantic failed
    const lane3 = kanban.kanbanEnqueue("lane C", "agent", undefined, { type: "W", parent_id: rootCardId });
    const lane3Contract = makeChildContract(lane3, rootCardId, ["lane3-web"]);
    supStore.insertContract(lane3Contract, lane3);
    // lane 3 fails (optional lane) — a durable failure with no result envelope
    supStore.insertAttempt({
      id: `att_lane3_failed`,
      card_id: lane3,
      contract_id: lane3Contract.id,
      ordinal: 1,
      executor_kind: "agent",
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

    // Coverage hints: orc_owned for the four Orc duties, semantic hints for lanes
    const inputs = new Map(snap.criterion_inputs.map(ci => [ci.criterion_id, ci]));
    expect(inputs.get("synthesis")?.coverage_hint).toBe("orc_owned");
    expect(inputs.get("synthesis")?.execution_owner).toBe("orc");
    expect(inputs.get("synthesis")?.mapped_child_contract_ids).toEqual([]);
    // #1656: successful mapped children carry provenance and qualified evidence
    expect(inputs.get("lane1-feeds")?.coverage_hint).toBe("supported");
    expect(inputs.get("lane1-feeds")?.execution_owner).toBe("delegated");
    expect(inputs.get("lane1-feeds")?.successful_mapped_child_contract_ids).toEqual([lane1Contract.id]);
    expect(inputs.get("lane1-feeds")?.unsuccessful_mapped_child_contract_ids).toEqual([]);
    expect(inputs.get("lane1-feeds")?.artifact_observation_ids).toEqual([`attempt:${lane1Attempt.id}:artifact:a1`]);
    expect(inputs.get("lane1-feeds")?.observed_evidence_ids).toEqual([]);
    // mapped children without any successful outcome are semantically failed
    expect(inputs.get("lane2-newsletters")?.coverage_hint).toBe("failed");
    expect(inputs.get("lane2-newsletters")?.unsuccessful_mapped_child_contract_ids).toEqual([lane2Contract.id]);
    expect(inputs.get("lane3-web")?.coverage_hint).toBe("failed");
    expect(inputs.get("lane3-web")?.required).toBe(false);
    expect(inputs.get("lane3-web")?.unsuccessful_mapped_child_contract_ids).toEqual([lane3Contract.id]);

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
          mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned",
        },
        {
          criterion_id: "c_sup", description: "Delegated supported", required: true, execution_owner: "delegated", evidence_expectation: "observed",
          mapped_child_contract_ids: ["cc_1"], successful_mapped_child_contract_ids: ["cc_1"], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["chk_1"], worker_claim_ids: ["claim_1"],
          failed_or_inconclusive_check_ids: ["chk_fail"], artifact_observation_ids: ["art_1"], retry_lineage_ids: ["card_1_2_attempts"],
          coverage_hint: "supported",
        },
        {
          criterion_id: "c_gap", description: "Delegated gap", required: true, execution_owner: "delegated", evidence_expectation: "observed",
          mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [],
          artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap",
        },
      ],
      contradiction_candidates: [
        { id: "cc_1", affected_criterion_ids: ["c_sup"], description: "Conflicting outcomes", evidence_ids: ["chk_1"], sources: ["card_1", "card_2"] },
      ],
      uncovered_criteria: ["c_gap"],
      child_summaries: [
        { card_id: 1001, contract_id: "cc_1", outcome: "completed", criterion_statuses: [{ criterion_id: "c_sup", status: "passed" }], attempts: 2, executor_kind: "agent" },
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
    if (!missing.ok) {
      expect(missing.code).toBe("review_case_unknown");
      expect(missing.error).toContain("not found");
    }
    const closed = projectReviewBrief(id, store);
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.code).toBe("review_case_not_open");
      expect(closed.error).toContain("not open");
    }
  });

  it("#1677: a case whose snapshot is unparseable or structurally invalid maps to review_case_unreadable with unchanged prose", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    store.db.prepare(`INSERT INTO project_review_cases (id, project_card_id, generation, round, snapshot_digest, case_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("rc_unparseable", 7718, 2, 1, "digest_brief_u", "{ not json", new Date().toISOString());
    const unparseable = projectReviewBrief("rc_unparseable", store);
    expect(unparseable.ok).toBe(false);
    if (!unparseable.ok) {
      expect(unparseable.code).toBe("review_case_unreadable");
      expect(unparseable.error).toBe("review case snapshot is unparseable");
    }

    const { id: invalidId } = store.insertReviewCase(7719, 2, 1, { schema_version: 99, project_card_id: 0 }, "digest_brief_i");
    const invalid = projectReviewBrief(invalidId, store);
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.code).toBe("review_case_unreadable");
      expect(invalid.error).toBe("review case snapshot is structurally invalid");
    }
  });

  it("#1677: a parseable snapshot with malformed nested fields is also unreadable, not an escaped throw", async () => {
    const reviewStoreMod = await import("./project-review-store.js");
    const { projectReviewBrief } = await import("./project-review-case.js");
    const store = new reviewStoreMod.ProjectReviewStore();
    const { id } = store.insertReviewCase(
      7720,
      1,
      1,
      { schema_version: 1, project_card_id: 7720, generation: 1 },
      "digest_brief_nested_invalid",
    );

    expect(projectReviewBrief(id, store)).toEqual({
      ok: false,
      code: "review_case_unreadable",
      error: "review case snapshot is structurally invalid",
    });
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

describe("ReviewCaseAssembler #1656 contract-level evidence", () => {
  async function setupProject(criteria: Array<{ id: string; required: boolean; execution_owner: "delegated" | "orc" }>): Promise<{ rootCardId: number; kanban: typeof import("../tasks/kanban-board.js"); reviewStoreMod: typeof import("./project-review-store.js"); supStoreMod: typeof import("../worker-supervision-store.js"); reviewStore: import("./project-review-store.js").ProjectReviewStore; supStore: import("../worker-supervision-store.js").WorkerSupervisionStore }> {
    const kanban = await import("../tasks/kanban-board.js");
    const reviewStoreMod = await import("./project-review-store.js");
    const supStoreMod = await import("../worker-supervision-store.js");
    const rootCardId = kanban.kanbanEnqueue("root", "task", `run-${Date.now()}`, { type: "O" });
    const reviewStore = new reviewStoreMod.ProjectReviewStore();
    reviewStore.insertContract(makeRootContractV2(rootCardId, criteria));
    reviewStore.initializeSupervision(rootCardId, `pc_rca_${rootCardId}`, "executing");
    return { rootCardId, kanban, reviewStoreMod, supStoreMod, reviewStore, supStore: new supStoreMod.WorkerSupervisionStore() };
  }

  async function seedChild(
    ctx: { rootCardId: number; supStore: import("../worker-supervision-store.js").WorkerSupervisionStore; kanban: typeof import("../tasks/kanban-board.js") },
    opts: {
      supports: string[];
      outcome: "success" | "failed" | "missing_result" | "no_attempt";
      checkId?: string;
    },
  ): Promise<{ cardId: number; contractId: string; attemptId?: string }> {
    const { supStore, kanban, rootCardId } = ctx;
    const cardId = kanban.kanbanEnqueue("lane", "agent", undefined, { type: "W", parent_id: rootCardId });
    const contract = makeChildContract(cardId, rootCardId, opts.supports);
    supStore.insertContract(contract, cardId);

    if (opts.outcome === "no_attempt") return { cardId, contractId: contract.id };

    const attemptId = `att_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    supStore.insertAttempt({
      id: attemptId, card_id: cardId, contract_id: contract.id, ordinal: 1,
      executor_kind: "agent", executor_id: "spin", status: "settled",
      started_at: new Date().toISOString(),
    });

    if (opts.outcome === "success") {
      supStore.lifecycleTransition(attemptId, ["pending"], "completed", { status: "settled", settled_at: new Date().toISOString() });
      supStore.insertResult(attemptId, {
        schema_version: 1,
        attempt: { id: attemptId, ordinal: 1, contract_id: contract.id, contract_digest: contract.digest, executor_kind: "agent", executor_id: "spin", started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
        outcome: "completed",
        criteria: [{ criterion_id: `l${cardId}c1`, status: "passed", evidence_ids: [opts.checkId ?? "a1"] }],
        checks: opts.checkId ? [{ check_id: opts.checkId, argv: ["true"], started_at: "", finished_at: "", timed_out: false, exit_code: 0, signal: null, stdout_excerpt: "", stderr_excerpt: "" }] : [],
        artifacts: [{ artifact_id: "a1", exists: true, kind: "file", ref: "handoff.md", size: 10 }],
        worker_report: { summary: "ok", claims: [], unresolved_risks: [] },
      });
      kanban.kanbanRunning(cardId);
      kanban.kanbanComplete(cardId, null, "worker completed");
    } else if (opts.outcome === "failed") {
      supStore.lifecycleTransition(attemptId, ["pending"], "failed", { status: "failed", settled_at: new Date().toISOString() });
      supStore.insertResult(attemptId, {
        schema_version: 1,
        attempt: { id: attemptId, ordinal: 1, contract_id: contract.id, contract_digest: contract.digest, executor_kind: "agent", executor_id: "spin", started_at: new Date().toISOString(), finished_at: new Date().toISOString() },
        outcome: "completed",
        criteria: [{ criterion_id: `l${cardId}c1`, status: "failed", evidence_ids: ["a1"] }],
        checks: [],
        artifacts: [{ artifact_id: "a1", exists: false, kind: "file", ref: "handoff.md", error: "not found" }],
        worker_report: { summary: "nope", claims: [], unresolved_risks: [] },
      });
      kanban.kanbanRunning(cardId);
      kanban.kanbanFail(cardId, "worker completed without passing acceptance");
    } else {
      // missing_result — a completed attempt lifecycle with no persisted envelope
      supStore.lifecycleTransition(attemptId, ["pending"], "completed", { status: "settled", settled_at: new Date().toISOString() });
      kanban.kanbanRunning(cardId);
      kanban.kanbanComplete(cardId, null, "worker completed");
    }
    return { cardId, contractId: contract.id, attemptId };
  }

  it("all failed mapped children: hint failed, negative evidence only, no positive arrays", async () => {
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    const a = await seedChild(ctx, { supports: ["r1"], outcome: "failed" });
    const b = await seedChild(ctx, { supports: ["r1"], outcome: "failed" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const input = (snap as ReviewCaseSnapshot).criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.coverage_hint).toBe("failed");
    expect(input.successful_mapped_child_contract_ids).toEqual([]);
    expect([...input.unsuccessful_mapped_child_contract_ids].sort()).toEqual([a.contractId, b.contractId].sort());
    expect(input.observed_evidence_ids).toEqual([]);
    expect(input.artifact_observation_ids).toEqual([]);
    // each failed child contributes one qualified negative id (criterion
    // evidence and the missing-artifact observation dedupe to the same id)
    expect(input.failed_or_inconclusive_check_ids).toHaveLength(2);
    expect(input.failed_or_inconclusive_check_ids.every(id => id.startsWith("attempt:"))).toBe(true);
    expect(new Set(input.failed_or_inconclusive_check_ids).size).toBe(2);  });

  it("one successful mapped child: hint supported, qualified positive evidence", async () => {
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    const a = await seedChild(ctx, { supports: ["r1"], outcome: "success" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const input = (snap as ReviewCaseSnapshot).criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.coverage_hint).toBe("supported");
    expect(input.successful_mapped_child_contract_ids).toEqual([a.contractId]);
    expect(input.unsuccessful_mapped_child_contract_ids).toEqual([]);
    expect(input.artifact_observation_ids).toEqual([`attempt:${a.attemptId}:artifact:a1`]);
    expect(input.failed_or_inconclusive_check_ids).toEqual([]);
  });

  it("mixed outcomes: hint conflicting, one contradiction candidate naming card and contract", async () => {
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    await seedChild(ctx, { supports: ["r1"], outcome: "success" });
    await seedChild(ctx, { supports: ["r1"], outcome: "failed" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const snapshot = snap as ReviewCaseSnapshot;
    const input = snapshot.criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.coverage_hint).toBe("conflicting");
    expect(input.successful_mapped_child_contract_ids).toHaveLength(1);
    expect(input.unsuccessful_mapped_child_contract_ids).toHaveLength(1);
    const contradiction = snapshot.contradiction_candidates.find(c => c.affected_criterion_ids.includes("r1"));
    expect(contradiction).toBeDefined();
    expect(contradiction!.sources.every(s => /^card:\d+:.+$/.test(s))).toBe(true);
  });

  it("reused local evidence ids from different children stay distinct via attempt qualification", async () => {
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    const a = await seedChild(ctx, { supports: ["r1"], outcome: "success", checkId: "v1" });
    const b = await seedChild(ctx, { supports: ["r1"], outcome: "success", checkId: "v1" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const input = (snap as ReviewCaseSnapshot).criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.observed_evidence_ids).toEqual([
      `attempt:${a.attemptId}:check:v1`,
      `attempt:${b.attemptId}:check:v1`,
    ]);
    expect(new Set(input.observed_evidence_ids).size).toBe(2);
  });

  it("a completed attempt with no persisted envelope is not successful evidence", async () => {
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    await seedChild(ctx, { supports: ["r1"], outcome: "missing_result" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const input = (snap as ReviewCaseSnapshot).criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.coverage_hint).toBe("failed");
    expect(input.successful_mapped_child_contract_ids).toEqual([]);
    expect(input.observed_evidence_ids).toEqual([]);
  });

  it("child criterion ids are never compared to root criterion ids", async () => {
    // the child's own criteria are l<card>c1 — completely unrelated names to
    // the root criterion r1; classification is contract-level
    const ctx = await setupProject([{ id: "r1", required: true, execution_owner: "delegated" }]);
    const a = await seedChild(ctx, { supports: ["r1"], outcome: "success" });

    const { ReviewCaseAssembler } = await import("./project-review-case.js");
    const snap = await new ReviewCaseAssembler().assembleCase(ctx.rootCardId, 1, 1);
    expect("error" in snap).toBe(false);
    const input = (snap as ReviewCaseSnapshot).criterion_inputs.find(c => c.criterion_id === "r1")!;
    expect(input.coverage_hint).toBe("supported");
    expect(input.successful_mapped_child_contract_ids).toEqual([a.contractId]);
    expect(input.artifact_observation_ids).toEqual([`attempt:${a.attemptId}:artifact:a1`]);
  });
});
