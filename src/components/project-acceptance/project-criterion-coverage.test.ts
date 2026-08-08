import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1, ProjectAcceptanceContractV2, CriterionExecutionOwner } from "./project-contract.js";
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

function makeRootContractV2(cardId: number, criteria: Array<{ id: string; required: boolean; execution_owner: CriterionExecutionOwner }>): ProjectAcceptanceContractV2 {
  return {
    schema_version: 2,
    id: `pc_root_${cardId}`,
    digest: `digest_root_${cardId}`,
    project_card_id: cardId,
    goal: "Root goal",
    criteria: criteria.map(c => ({ id: c.id, description: `Criterion ${c.id}`, required: c.required, execution_owner: c.execution_owner, evidence_expectation: c.execution_owner === "orc" ? "synthesis" : "observed" })),
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

  it("invalid child mappings are undeterminable, not silently treated as gaps", () => {
    const rootId = setupRoot([{ id: "c1" }]);
    addChild(rootId, ["not-a-root-criterion"]);
    const result = mod.coverage.readProjectCriterionCoverage(rootId);
    expect(result.kind).toBe("undeterminable");
    if (result.kind === "undeterminable") expect(result.reason).toContain("invalid root-criterion mapping");
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

// #1605: ownership-aware classification — one table covering mixed mapped
// delegated + Orc-owned, unmapped delegated, Orc-only, v1, and bad child cases.
describe("readProjectCriterionCoverage v2 ownership", () => {
  let mod: Awaited<ReturnType<typeof loadModules>>;

  beforeEach(async () => {
    vi.resetModules();
    TEST_HOME = join(tmpdir(), `cov-v2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    mod = await loadModules();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  it("production shape: 3 mapped delegated + 4 Orc-owned criteria reaches read with orc_owned states and no uncovered", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContractV2(rootCardId, [
      { id: "lane1-feeds", required: true, execution_owner: "delegated" },
      { id: "lane2-newsletters", required: true, execution_owner: "delegated" },
      { id: "lane3-web", required: true, execution_owner: "delegated" },
      { id: "synthesis", required: true, execution_owner: "orc" },
      { id: "quality", required: true, execution_owner: "orc" },
      { id: "budget", required: true, execution_owner: "orc" },
      { id: "honest-stats", required: true, execution_owner: "orc" },
    ]);
    store.insertContract(contract);

    const sup = new mod.supStore.WorkerSupervisionStore();
    const lane1 = mod.kanban.kanbanEnqueue("lane1", "agent", undefined, { type: "W", parent_id: rootCardId });
    sup.insertContract(makeChildContract(lane1, rootCardId, ["lane1-feeds"]), lane1);
    const lane2 = mod.kanban.kanbanEnqueue("lane2", "agent", undefined, { type: "W", parent_id: rootCardId });
    sup.insertContract(makeChildContract(lane2, rootCardId, ["lane2-newsletters"]), lane2);
    const lane3 = mod.kanban.kanbanEnqueue("lane3", "agent", undefined, { type: "W", parent_id: rootCardId });
    sup.insertContract(makeChildContract(lane3, rootCardId, ["lane3-web"]), lane3);

    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual([]);
      const byId = new Map(result.read.criteria.map(c => [c.criterionId, c]));
      expect(byId.get("lane1-feeds")?.state).toBe("mapped");
      expect(byId.get("lane1-feeds")?.mappedContractIds).toEqual([`pc_child_${lane1}`]);
      expect(byId.get("synthesis")?.state).toBe("orc_owned");
      expect(byId.get("synthesis")?.executionOwner).toBe("orc");
      expect(byId.get("synthesis")?.mappedContractIds).toEqual([]);
      expect(byId.get("budget")?.state).toBe("orc_owned");
    }
  });

  it("delegated gap survives: unmapped delegated is uncovered, orc_owned is not", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContractV2(rootCardId, [
      { id: "c1", required: true, execution_owner: "delegated" },
      { id: "c2", required: true, execution_owner: "orc" },
    ]);
    store.insertContract(contract);
    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual(["c1"]);
      const byId = new Map(result.read.criteria.map(c => [c.criterionId, c]));
      expect(byId.get("c1")?.state).toBe("gap");
      expect(byId.get("c2")?.state).toBe("orc_owned");
    }
  });

  it("child mapping to an Orc-owned criterion is undeterminable, not dropped", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContractV2(rootCardId, [
      { id: "c1", required: true, execution_owner: "delegated" },
      { id: "c2", required: true, execution_owner: "orc" },
    ]);
    store.insertContract(contract);
    const sup = new mod.supStore.WorkerSupervisionStore();
    const child = mod.kanban.kanbanEnqueue("child", "agent", undefined, { type: "W", parent_id: rootCardId });
    sup.insertContract(makeChildContract(child, rootCardId, ["c2"]), child);
    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("undeterminable");
    if (result.kind === "undeterminable") expect(result.reason).toContain("not delegable");
  });

  it("peer mapping to an Orc-owned criterion is undeterminable", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    store.insertContract(makeRootContractV2(rootCardId, [
      { id: "c1", required: true, execution_owner: "delegated" },
      { id: "c2", required: true, execution_owner: "orc" },
    ]));
    store.db.exec(`CREATE TABLE peer_contributions (
      peer TEXT NOT NULL,
      request_id TEXT NOT NULL,
      project_card_id INTEGER,
      root_criteria_json TEXT,
      state TEXT NOT NULL
    )`);
    store.db.prepare(`
      INSERT INTO peer_contributions (peer, request_id, project_card_id, root_criteria_json, state)
      VALUES (?, ?, ?, ?, 'completed')
    `).run("peer-a", "request-a", rootCardId, JSON.stringify(["c2"]));

    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("undeterminable");
    if (result.kind === "undeterminable") expect(result.reason).toContain("invalid root-criterion mapping");
  });

  it("Orc-only project: no delegated criteria, no uncovered, every state orc_owned", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContractV2(rootCardId, [
      { id: "synthesis", required: true, execution_owner: "orc" },
    ]);
    store.insertContract(contract);
    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual([]);
      expect(result.read.criteria[0]?.state).toBe("orc_owned");
    }
  });

  it("optional delegated criterion is still a coverage member when required: false", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContractV2(rootCardId, [
      { id: "c1", required: false, execution_owner: "delegated" },
    ]);
    store.insertContract(contract);
    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual(["c1"]);
      expect(result.read.criteria[0]?.required).toBe(false);
    }
  });

  it("v1 stored contract projects every criterion as required + delegated", () => {
    const rootCardId = mod.kanban.kanbanEnqueue("root", "task", "run-1", { type: "O" });
    const store = new mod.reviewStore.ProjectReviewStore();
    store.insertContract(makeRootContract(rootCardId, [{ id: "c1" }]));
    const result = mod.coverage.readProjectCriterionCoverage(rootCardId);
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.read.uncovered).toEqual(["c1"]);
      expect(result.read.criteria[0]?.executionOwner).toBe("delegated");
      expect(result.read.criteria[0]?.required).toBe(true);
    }
  });

  it("unsupported schema version in stored root contract is undeterminable", () => {
    const store = new mod.reviewStore.ProjectReviewStore();
    const contract = makeRootContract(444, [{ id: "c1" }]);
    store.insertContract(contract);
    store.db.prepare(`UPDATE project_contracts SET contract_json = '{"schema_version":3,"id":"x","project_card_id":444,"goal":"g","criteria":[],"required_outputs":[],"constraints":[],"limits":{},"provenance":{}}' WHERE project_card_id = ?`).run(444);
    const result = mod.coverage.readProjectCriterionCoverage(444);
    expect(result.kind).toBe("undeterminable");
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

  it("returns the root criteria ids (delegated only — Orc-owned are not mapping targets)", () => {
    const store = new mod.reviewStore.ProjectReviewStore();
    store.insertContract(makeRootContractV2(333, [
      { id: "c1", required: true, execution_owner: "delegated" },
      { id: "c2", required: true, execution_owner: "orc" },
    ]));
    expect(mod.coverage.rootCriterionIds(333)).toEqual(["c1"]);
  });

  it("v1 root projects all ids as delegated", () => {
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
