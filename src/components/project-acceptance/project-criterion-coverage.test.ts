import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";

let TEST_HOME: string;

async function loadModules() {
  const coverage = await import("./project-criterion-coverage.js");
  const reviewStore = await import("./project-review-store.js");
  const supStore = await import("../worker-supervision-store.js");
  const kanban = await import("../tasks/kanban-board.js");
  return { coverage, reviewStore, supStore, kanban };
}

function makeRootContract(cardId: number, criteria: Array<{ id: string }>): ProjectAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `pc_root_${cardId}`,
    digest: `digest_root_${cardId}`,
    project_card_id: cardId,
    goal: "Root goal",
    criteria: criteria.map(c => ({ id: c.id, description: `Criterion ${c.id}`, required: true as const, evidence_expectation: "synthesis" as const })),
    required_outputs: [],
    constraints: [],
    limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
  };
}

function makeChildContract(cardId: number, rootCardId: number, supports: string[]): WorkerAcceptanceContractV1 {
  return {
    schema_version: 1,
    id: `pc_child_${cardId}`,
    digest: `digest_child_${cardId}`,
    goal: "Child goal",
    criteria: [{ id: `l${cardId}c1`, description: "Child criterion" }],
    expected_artifacts: [],
    verification_commands: [],
    required_capabilities: [],
    supports_root_criteria: supports,
    limits: {},
    provenance: { root_card_id: rootCardId, card_id: cardId, authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
  };
}

describe("readProjectCriterionCoverage", () => {
  let mod: Awaited<ReturnType<typeof loadModules>>;

  beforeEach(async () => {
    vi.resetModules();
    TEST_HOME = join(tmpdir(), `cov-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    mod = await loadModules();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  function setupRoot(criteria: Array<{ id: string }>): number {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContract(rootCardId, criteria);
    store.insertContract(contract);
    return contract.project_card_id;
  }

  function addChild(rootCardId: number, supports: string[]): number {
    const cardId = mod.kanban.kanbanEnqueue("child", "agent", undefined, { type: "W", parent_id: rootCardId });
    const store = new mod.supStore.WorkerSupervisionStore();
    store.insertContract(makeChildContract(cardId, rootCardId, supports), cardId);
    return cardId;
  }

  it("fully covered: all root criteria mapped by children", () => {
    const rootId = setupRoot([{ id: "c1" }, { id: "c2" }]);
    addChild(rootId, ["c1"]);
    addChild(rootId, ["c2"]);
    const result = mod.coverage.readProjectCriterionCoverage(rootId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual([]);
      expect(result.read.criterionIds).toEqual(["c1", "c2"]);
    }
  });

  it("partial gap: uncovered names the unmapped criteria", () => {
    const rootId = setupRoot([{ id: "c1" }, { id: "c2" }, { id: "c3" }]);
    addChild(rootId, ["c1"]);
    addChild(rootId, ["c3"]);
    const result = mod.coverage.readProjectCriterionCoverage(rootId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual(["c2"]);
    }
  });

  it("no project contract for the root card", () => {
    const result = mod.coverage.readProjectCriterionCoverage(424242);
    expect(result.kind).toBe("no_project_contract");
  });

  it("unparseable root contract is undeterminable, never covered", () => {
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContract(111, [{ id: "c1" }]);
    store.insertContract({ ...contract, contract_json: undefined as unknown as string } as never);
    store.db.prepare(`UPDATE project_contracts SET contract_json = 'not-json{' WHERE project_card_id = ?`).run(111);
    const result = mod.coverage.readProjectCriterionCoverage(111);
    expect(result.kind).toBe("undeterminable");
  });

  it("root contract without a criteria array is undeterminable", () => {
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContract(222, [{ id: "c1" }]);
    store.insertContract(contract);
    store.db.prepare(`UPDATE project_contracts SET contract_json = '{"id":"x","criteria":"not-an-array"}' WHERE project_card_id = ?`).run(222);
    const result = mod.coverage.readProjectCriterionCoverage(222);
    expect(result.kind).toBe("undeterminable");
  });

  it("unparseable child contract is undeterminable, never skipped as unmapped", () => {
    const rootId = setupRoot([{ id: "c1" }, { id: "c2" }]);
    const cardId = addChild(rootId, ["c1"]);
    new mod.supStore.WorkerSupervisionStore().db.prepare(`UPDATE worker_contracts SET contract_json = 'garbage{' WHERE card_id = ?`).run(cardId);
    const result = mod.coverage.readProjectCriterionCoverage(rootId);
    expect(result.kind).toBe("undeterminable");
  });

  it("child without a contract row is not a mapping source but is not undeterminable", () => {
    const rootId = setupRoot([{ id: "c1" }]);
    mod.kanban.kanbanEnqueue("unsupervised sibling", "agent", undefined, { type: "W", parent_id: rootId });
    const result = mod.coverage.readProjectCriterionCoverage(rootId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual(["c1"]);
      expect(result.read.mappings).toEqual([]);
    }
  });
});

describe("rootCriterionIds", () => {
  let mod: Awaited<ReturnType<typeof loadModules>>;

  beforeEach(async () => {
    vi.resetModules();
    TEST_HOME = join(tmpdir(), `cov-ids-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    mod = await loadModules();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("returns the root criteria ids", () => {
    const store = new mod.reviewStore.ProjectReviewStore();
    store.insertContract(makeRootContract(333, [{ id: "c1" }, { id: "c2" }]));
    expect(mod.coverage.rootCriterionIds(333)).toEqual(["c1", "c2"]);
  });

  it("undefined when no project contract exists", () => {
    expect(mod.coverage.rootCriterionIds(777)).toBeUndefined();
  });
});

describe("coverageSignature", () => {
  let mod: Awaited<ReturnType<typeof loadModules>>;

  beforeEach(async () => {
    vi.resetModules();
    TEST_HOME = join(tmpdir(), `cov-sig-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    mod = await loadModules();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("is stable regardless of argument order", () => {
    const a = mod.coverage.coverageSignature([3, 1, 2], ["c2", "c1"]);
    const b = mod.coverage.coverageSignature([2, 3, 1], ["c1", "c2"]);
    expect(a).toBe(b);
  });

  it("changes when the child set or gap changes", () => {
    const base = mod.coverage.coverageSignature([1, 2], ["c1"]);
    expect(mod.coverage.coverageSignature([1, 2, 3], ["c1"])).not.toBe(base);
    expect(mod.coverage.coverageSignature([1, 2], ["c1", "c2"])).not.toBe(base);
  });
});
