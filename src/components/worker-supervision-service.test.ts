import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let Service: typeof import("./worker-supervision-service.js").WorkerSupervisionService;
let Store: typeof import("./worker-supervision-store.js").WorkerSupervisionStore;
let validateWorkerRootCriteria: typeof import("./worker-supervision-service.js").validateWorkerRootCriteria;
let ReviewStore: typeof import("./project-acceptance/project-review-store.js").ProjectReviewStore;
let kanbanEnqueue: typeof import("./tasks/kanban-board.js").kanbanEnqueue;
let rootId: number;

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `sup-svc-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  const svcMod = await import("./worker-supervision-service.js");
  Service = svcMod.WorkerSupervisionService;
  validateWorkerRootCriteria = svcMod.validateWorkerRootCriteria;
  const storeMod = await import("./worker-supervision-store.js");
  Store = storeMod.WorkerSupervisionStore;
  const reviewMod = await import("./project-acceptance/project-review-store.js");
  ReviewStore = reviewMod.ProjectReviewStore;
  const kanbanMod = await import("./tasks/kanban-board.js");
  kanbanEnqueue = kanbanMod.kanbanEnqueue;
  // #1644: createChild now authorizes against a durable project root — every
  // supervised child requires a live O root with supervision state.
  rootId = kanbanEnqueue("Test project", "test", undefined, { type: "O", goal: "Root project" });
  new ReviewStore().initializeSupervision(rootId, `pc_${rootId}`, "executing");
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

/** Create a W child card and its supervised contract/attempt under the root. */
function makeChild(svc: import("./worker-supervision-service.js").WorkerSupervisionService, goal: string, opts: {
  criteria: Array<{ id: string; description: string }>;
  expectedArtifacts?: Array<{ id: string; kind: "file" | "directory" | "report" | "logical"; ref: string; required: boolean; criterion_ids: string[] }>;
  verificationCommands?: Array<{ id: string; argv: string[]; cwd?: string; timeout_ms: number; criterion_ids: string[] }>;
  requiredCapabilities?: string[];
  supportsRootCriteria?: string[];
  limits?: { max_duration_ms?: number; max_tokens?: number };
  workspaceAlias?: string;
}): ReturnType<import("./worker-supervision-service.js").WorkerSupervisionService["createChild"]> {
  const cardId = kanbanEnqueue(goal, "agent", undefined, { type: "W", parent_id: rootId });
  return svc.createChild(goal, rootId, "orc", { cardId, ...opts });
}

/** Claim + run the pending attempt so collectAndSettle can settle it. */
function claimAndRun(svc: import("./worker-supervision-service.js").WorkerSupervisionService, cardId: number, attemptId: string): void {
  const contract = svc.getContractForCard(cardId)!;
  const pending = new Store().getAttempt(attemptId)!;
  const claim = new Store().claimAttempt(cardId, contract.id, pending.executor_kind, pending.executor_id, pending.generation || 1);
  if (claim) new Store().markAttemptRunning(claim.attemptId);
}

describe("WorkerSupervisionService", () => {
  it("createChild creates contract and attempt for a card", () => {
    const svc = new Service();
    const result = makeChild(svc, "Build report", {
      criteria: [{ id: "c1", description: "Report must exist" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
      verificationCommands: [{ id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.contract.id).toMatch(/^c_/);
      expect(result.contract.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.contract.criteria[0]!.id).toBe("c1");
      expect(result.attemptId).toMatch(/^a_/);
      const attempt = new Store().getAttempt(result.attemptId)!;
      expect(attempt.root_project_card_id).toBe(rootId);
      expect(attempt.root_project_generation).toBe(1);
    }
  });

  it("createChild returns error for duplicate card", () => {
    const svc = new Service();
    const first = makeChild(svc, "Build report", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    if ("error" in first) throw new Error(first.error);
    const result = svc.createChild("Another report", rootId, "orc", {
      cardId: first.cardId,
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("already has a contract");
    }
  });

  it("createChild rejects a child under a terminal (blocked) root", () => {
    const svc = new Service();
    const reviewStore = new ReviewStore();
    reviewStore.db.prepare(`UPDATE project_supervision SET state = 'blocked' WHERE project_card_id = ?`).run(rootId);
    const result = makeChild(svc, "Late work", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("project_terminal");
    // The pre-created card in this fixture path stays card-only: the rejected
    // transaction committed no contract and no attempt.
    const contracts = new Store().db.prepare(`SELECT COUNT(*) AS cnt FROM worker_contracts`).get() as { cnt: number };
    expect(contracts.cnt).toBe(0);
    const attempts = new Store().db.prepare(`SELECT COUNT(*) AS cnt FROM worker_attempts`).get() as { cnt: number };
    expect(attempts.cnt).toBe(0);
  });

  it("createChild rejects a child when the root generation is stale", () => {
    const svc = new Service();
    const reviewStore = new ReviewStore();
    reviewStore.incrementGeneration(rootId);
    const result = svc.createChild("Stale gen work", rootId, "orc", {
      authority: { projectCardId: rootId, projectGeneration: 1 },
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("generation_mismatch");
  });

  it("getContractForCard returns parsed contract", () => {
    const svc = new Service();
    const result = makeChild(svc, "Build report", {
      criteria: [{ id: "c1", description: "Test" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    if ("error" in result) throw new Error(result.error);
    const contract = svc.getContractForCard(result.cardId);
    expect(contract).toBeDefined();
    expect(contract!.goal).toBe("Build report");
  });

  it("getContractForCard returns undefined for unknown card", () => {
    const svc = new Service();
    expect(svc.getContractForCard(999)).toBeUndefined();
  });

  it("cardHasContract returns correct state", () => {
    const svc = new Service();
    const result = makeChild(svc, "Build report", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    if ("error" in result) throw new Error(result.error);
    expect(svc.cardHasContract(result.cardId)).toBe(true);
  });

  it("rejects evidence-free supervised children (no criteria)", () => {
    const svc = new Service();
    const cardId = kanbanEnqueue("Do something", "agent", undefined, { type: "W", parent_id: rootId });
    const result = svc.createChild("Do something", rootId, "orc", { cardId });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("at least one acceptance criterion");
    }
  });

  it("#1638: an alias contract creates a Pi attempt with pi-coding", () => {
    const svc = new Service();
    const result = makeChild(svc, "Coding work", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      workspaceAlias: "repo-a",
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.contract.workspace_alias).toBe("repo-a");
      const attempt = new Store().getAttempt(result.attemptId);
      expect(attempt?.executor_kind).toBe("pi");
      expect(attempt?.executor_id).toBe("pi-coding");
    }
  });

  it("#1638: a no-alias contract creates a Spin attempt with spin-local", () => {
    const svc = new Service();
    const result = makeChild(svc, "Report work", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const attempt = new Store().getAttempt(result.attemptId);
      expect(attempt?.executor_kind).toBe("agent");
      expect(attempt?.executor_id).toBe("spin-local");
    }
  });

  it("#1638: a syntactically invalid alias rejects contract creation transactionally", () => {
    const svc = new Service();
    const result = makeChild(svc, "Coding work", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      workspaceAlias: "../escape",
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("workspace_alias rejected");
    expect(svc.cardHasContract(101)).toBe(false);
  });

  it("#1638: an alias unknown to a readable Pi config rejects contract creation", () => {
    const { writeFileSync, mkdirSync: mkdir } = require("node:fs") as typeof import("node:fs");
    const { join: pjoin } = require("node:path") as typeof import("node:path");
    const configDir = pjoin(TEST_HOME, "config");
    mkdir(configDir, { recursive: true });
    writeFileSync(pjoin(configDir, "pi-executor.json"), JSON.stringify({
      enabled: true,
      command: "pi",
      workspaceAliases: { "repo-a": { path: "/tmp/repo-a" } },
      maxConcurrent: 1,
    }));
    const svc = new Service();
    const result = makeChild(svc, "Coding work", {
      criteria: [{ id: "c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      workspaceAlias: "repo-b",
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("unknown workspace alias");
    expect(svc.cardHasContract(101)).toBe(false);
  });

  it("rejects root-criterion mappings that are unknown to the immutable root contract", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [{ id: "root_c1", description: "Root criterion", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    expect(validateWorkerRootCriteria(rootId, "child_c1", ["root_missing"]))
      .toContain("is not delegable");
  });

  it("#1604 rejects an empty mapping under a contract-bearing root, naming every legal id", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [
        { id: "c1", description: "C1", required: true, evidence_expectation: "synthesis" },
        { id: "c2", description: "C2", required: true, evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const err = validateWorkerRootCriteria(rootId, "child_c1", []);
    expect(err).toContain("supports_root_criteria is required");
    expect(err).toContain("c1, c2");
  });

  it("#1604 admits a supervised child with no mapping when the root has no project contract", () => {
    const err = validateWorkerRootCriteria(999_001, "child_c1", []);
    expect(err).toBeUndefined();
  });

  it("#1604 rejects a case-mismatched mapping and names the legal set", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [
        { id: "c1", description: "C1", required: true, evidence_expectation: "synthesis" },
        { id: "c2", description: "C2", required: true, evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const err = validateWorkerRootCriteria(rootId, "child_c1", ["C1"]);
    expect(err).toContain(`is not delegable`);
    expect(err).toContain("legal delegated ids: c1, c2");
  });

  it("#1605 rejects a mapping to an Orc-owned criterion even though the id exists", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 2,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [
        { id: "lane1", description: "Lane 1", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const err = validateWorkerRootCriteria(rootId, "child_c1", ["synthesis"]);
    expect(err).toContain(`"synthesis" is not delegable`);
    expect(err).toContain("legal delegated ids: lane1");
    // empty mapping rejected — a delegated criterion exists
    const emptyErr = validateWorkerRootCriteria(rootId, "child_c1", []);
    expect(emptyErr).toContain("supports_root_criteria is required");
  });

  it("#1605 admits an unmapped child under an Orc-only root (no delegated criteria)", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 2,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [
        { id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    expect(validateWorkerRootCriteria(rootId, "child_c1", [])).toBeUndefined();
  });

  it("#1605 rejects a mapping to an Orc-owned criterion under an Orc-only root", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 2,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [
        { id: "synthesis", description: "Synthesis", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const err = validateWorkerRootCriteria(rootId, "child_c1", ["synthesis"]);
    expect(err).toContain("no delegable root criteria");
  });

  it("#1604 createChild rejects a supervised child with no mapping under a contract-bearing root", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: rootId,
      goal: "Root project",
      criteria: [{ id: "c1", description: "C1", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const svc = new Service();
    const result = makeChild(svc, "Child work", {
      criteria: [{ id: "l1c1", description: "Must work" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["l1c1"] }],
    });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("supports_root_criteria is required");
    }
  });

  it("renderContractForPrompt produces XML-formatted contract", () => {
    const svc = new Service();
    const result = makeChild(svc, "Build report", {
      criteria: [{ id: "c1", description: "Report must exist" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
      supportsRootCriteria: [],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      const rendered = svc.renderContractForPrompt(result.contract);
      expect(rendered).toContain("<worker-contract");
      expect(rendered).toContain("<goal>Build report</goal>");
      expect(rendered).toContain('<criterion id="c1">');
    }
  });

  describe("collectAndSettle", () => {
    it("returns stale for a card without a known attempt identity", () => {
      const svc = new Service();
      const outcome = svc.collectAndSettle(999, "worker output", undefined, "a_missing", 1);
      expect(outcome.settled).toBe(false);
      expect(outcome.stale).toBe(true);
    });

    it("settles and produces envelope for contracted card", () => {
      const svc = new Service();
      const created = makeChild(svc, "Build report", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
        supportsRootCriteria: [],
      });
      if ("error" in created) throw new Error(created.error);
      claimAndRun(svc, created.cardId, created.attemptId);
      const outcome = svc.collectAndSettle(created.cardId, "<summary>Done</summary>", undefined, created.attemptId, 1);
      expect(outcome.settled).toBe(true);
      expect(outcome.envelope).toBeDefined();
      expect(outcome.envelope!.attempt.contract_id).toMatch(/^c_/);
      expect(["completed", "failed"]).toContain(outcome.envelope!.outcome);
      expect(outcome.envelope!.criteria.length).toBe(1);
    });

    it("rejects a late result once the root is terminal", () => {
      const svc = new Service();
      const created = makeChild(svc, "Build report", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
        supportsRootCriteria: [],
      });
      if ("error" in created) throw new Error(created.error);
      claimAndRun(svc, created.cardId, created.attemptId);
      new ReviewStore().db.prepare(`UPDATE project_supervision SET state = 'blocked' WHERE project_card_id = ?`).run(rootId);
      const outcome = svc.collectAndSettle(created.cardId, "<summary>Done</summary>", undefined, created.attemptId, 1);
      expect(outcome.settled).toBe(false);
      expect(outcome.stale).toBe(true);
      expect(new Store().getAttempt(created.attemptId)!.lifecycle).toBe("running");
    });

    it("parses worker report from XML tags", () => {
      const svc = new Service();
      const created = makeChild(svc, "Build report", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
        supportsRootCriteria: [],
      });
      if ("error" in created) throw new Error(created.error);
      claimAndRun(svc, created.cardId, created.attemptId);
      const outcome = svc.collectAndSettle(created.cardId, `
        <summary>All checks passed</summary>
        <claim criterion_id="c1">I verified the output</claim>
        <risk>Network might be slow</risk>
      `, undefined, created.attemptId, 1);
      expect(outcome.settled).toBe(true);
      expect(outcome.envelope!.worker_report.summary).toContain("All checks passed");
      expect(outcome.envelope!.worker_report.claims).toHaveLength(1);
      expect(outcome.envelope!.worker_report.unresolved_risks).toHaveLength(1);
    });

    it("terminalSettlement returns conflict on duplicate call", () => {
      const svc = new Service();
      const created = makeChild(svc, "Build report", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
        supportsRootCriteria: [],
      });
      if ("error" in created) throw new Error(created.error);
      claimAndRun(svc, created.cardId, created.attemptId);
      svc.collectAndSettle(created.cardId, "<summary>Done</summary>", undefined, created.attemptId, 1);
      const second = svc.collectAndSettle(created.cardId, "<summary>Different result</summary>", undefined, created.attemptId, 1);
      expect(second.settled).toBe(false);
      expect(second.summary).toContain("conflict");
    });

    it("ignores a late result from an older attempt", () => {
      const svc = new Service();
      const created = makeChild(svc, "Build report", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
        supportsRootCriteria: [],
      });
      if ("error" in created) throw new Error(created.error);
      const store = new Store();
      const first = store.getAttempt(created.attemptId)!;
      store.insertAttempt({
        id: "a_newer", card_id: created.cardId, contract_id: first.contract_id,
        ordinal: 2, executor_kind: "agent", executor_id: "spin-01",
        status: "running", started_at: "2026-07-12T00:01:00.000Z",
        root_project_card_id: rootId, root_project_generation: 1, scheduled_run_id: null,
      });

      const outcome = svc.collectAndSettle(created.cardId, "<summary>late</summary>", undefined, first.id, first.generation);
      expect(outcome.settled).toBe(false);
      expect(outcome.stale).toBe(true);
      expect(store.getAttempt("a_newer")!.lifecycle).toBe("running");
      expect(store.getResult(first.id)).toBeUndefined();
    });
  });
});
