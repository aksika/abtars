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
