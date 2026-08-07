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
});

afterEach(() => {
  if (TEST_HOME && existsSync(TEST_HOME)) {
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
});

describe("WorkerSupervisionService", () => {
  it("createChild creates contract and attempt for a card", () => {
    const svc = new Service();
    const result = svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Report must exist" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
      verificationCommands: [{ id: "v1", argv: ["test", "-f", "output/report.md"], timeout_ms: 10_000, criterion_ids: ["c1"] }],
    });
    expect("error" in result).toBe(false);
    if (!("error" in result)) {
      expect(result.contract.id).toMatch(/^c_/);
      expect(result.contract.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(result.contract.criteria[0]!.id).toBe("c1");
      expect(result.attemptId).toMatch(/^a_/);
    }
  });

  it("createChild returns error for duplicate card", () => {
    const svc = new Service();
    svc.createChild("Build report", 101, 100, "orc", { criteria: [{ id: "c1", description: "Must work" }], expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }] });
    const result = svc.createChild("Another report", 101, 100, "orc", { criteria: [{ id: "c1", description: "Must work" }], expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }] });
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("already has a contract");
    }
  });

  it("getContractForCard returns parsed contract", () => {
    const svc = new Service();
    svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Test" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
    });
    const contract = svc.getContractForCard(101);
    expect(contract).toBeDefined();
    expect(contract!.goal).toBe("Build report");
  });

  it("getContractForCard returns undefined for unknown card", () => {
    const svc = new Service();
    expect(svc.getContractForCard(999)).toBeUndefined();
  });

  it("cardHasContract returns correct state", () => {
    const svc = new Service();
    expect(svc.cardHasContract(101)).toBe(false);
    svc.createChild("Build report", 101, 100, "orc", { criteria: [{ id: "c1", description: "Must work" }], expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }] });
    expect(svc.cardHasContract(101)).toBe(true);
  });

  it("rejects evidence-free supervised children (no criteria)", () => {
    const svc = new Service();
    const result = svc.createChild("Do something", 101, 100, "orc");
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toContain("at least one acceptance criterion");
    }
  });

  it("rejects root-criterion mappings that are unknown to the immutable root contract", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: 100,
      goal: "Root project",
      criteria: [{ id: "root_c1", description: "Root criterion", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    expect(validateWorkerRootCriteria(100, "child_c1", ["root_missing"]))
      .toContain("unknown root criterion id");
  });

  it("#1604 rejects an empty mapping under a contract-bearing root, naming every legal id", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: 100,
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

    const err = validateWorkerRootCriteria(100, "child_c1", []);
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
      project_card_id: 100,
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

    const err = validateWorkerRootCriteria(100, "child_c1", ["C1"]);
    expect(err).toContain(`unknown root criterion id "C1"`);
    expect(err).toContain("legal ids: c1, c2");
  });

  it("#1604 createChild rejects a supervised child with no mapping under a contract-bearing root", () => {
    const rootStore = new ReviewStore();
    rootStore.insertContract({
      schema_version: 1,
      id: "pc_root",
      digest: "root_digest",
      project_card_id: 100,
      goal: "Root project",
      criteria: [{ id: "c1", description: "C1", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [],
      constraints: [],
      limits: { max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "test", authored_by: "orc", created_at: new Date().toISOString() },
    });

    const svc = new Service();
    const result = svc.createChild("Child work", 101, 100, "orc", {
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
    const result = svc.createChild("Build report", 101, 100, "orc", {
      criteria: [{ id: "c1", description: "Report must exist" }],
      expectedArtifacts: [{ id: "a1", kind: "file", ref: "output/report.md", required: true, criterion_ids: ["c1"] }],
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
    it("returns not-settled for card without contract", () => {
      const svc = new Service();
      const outcome = svc.collectAndSettle(999, "worker output");
      expect(outcome.settled).toBe(false);
      expect(outcome.summary).toBe("worker output");
    });

    it("settles and produces envelope for contracted card", () => {
      const svc = new Service();
      svc.createChild("Build report", 101, 100, "orc", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      });
      const outcome = svc.collectAndSettle(101, "<summary>Done</summary>");
      expect(outcome.settled).toBe(true);
      expect(outcome.envelope).toBeDefined();
      expect(outcome.envelope!.attempt.contract_id).toMatch(/^c_/);
      expect(["completed", "failed"]).toContain(outcome.envelope!.outcome);
      expect(outcome.envelope!.criteria.length).toBe(1);
    });

    it("parses worker report from XML tags", () => {
      const svc = new Service();
      svc.createChild("Build report", 101, 100, "orc", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      });
      const outcome = svc.collectAndSettle(101, `
        <summary>All checks passed</summary>
        <claim criterion_id="c1">I verified the output</claim>
        <risk>Network might be slow</risk>
      `);
      expect(outcome.settled).toBe(true);
      expect(outcome.envelope!.worker_report.summary).toContain("All checks passed");
      expect(outcome.envelope!.worker_report.claims).toHaveLength(1);
      expect(outcome.envelope!.worker_report.unresolved_risks).toHaveLength(1);
    });

    it("terminalSettlement returns conflict on duplicate call", () => {
      const svc = new Service();
      svc.createChild("Build report", 101, 100, "orc", {
        criteria: [{ id: "c1", description: "Must work" }],
        expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }],
      });
      svc.collectAndSettle(101, "<summary>Done</summary>");
      const second = svc.collectAndSettle(101, "<summary>Different result</summary>");
      expect(second.settled).toBe(false);
      expect(second.summary).toContain("conflict");
    });

    it("ignores a late result from an older attempt", () => {
      const svc = new Service();
      const created = svc.createChild("Build report", 101, 100, "orc", { criteria: [{ id: "c1", description: "Must work" }], expectedArtifacts: [{ id: "a1", kind: "file", ref: "out/report.md", required: true, criterion_ids: ["c1"] }] });
      if ("error" in created) throw new Error(created.error);
      const store = new Store();
      const first = store.getAttempt(created.attemptId)!;
      store.insertAttempt({
        id: "a_newer", card_id: 101, contract_id: first.contract_id,
        ordinal: 2, executor_kind: "local_worker", executor_id: "spin-01",
        status: "running", started_at: "2026-07-12T00:01:00.000Z",
      });

      const outcome = svc.collectAndSettle(101, "<summary>late</summary>", undefined, first.id, first.generation);
      expect(outcome.settled).toBe(false);
      expect(outcome.stale).toBe(true);
      expect(store.getAttempt("a_newer")!.lifecycle).toBe("running");
      expect(store.getResult(first.id)).toBeUndefined();
    });
  });
});
