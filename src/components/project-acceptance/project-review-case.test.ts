import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";
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
});
