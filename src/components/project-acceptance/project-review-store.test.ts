import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let projectStateToKanban: typeof import("./project-review-store.js").projectStateToKanban;
let ProjectState: any;

describe("ProjectReviewStore", () => {
  let store: ProjectReviewStore;
  let _cardSeq = 0;

  function uniqueCardId(): number {
    return (Date.now() % 100000) * 1000 + (++_cardSeq);
  }

  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-store-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod = await import("./project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    projectStateToKanban = mod.projectStateToKanban;
    store = new ProjectReviewStore();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  function makeContract(cardId?: number): ProjectAcceptanceContractV1 {
    const cid = cardId ?? uniqueCardId();
    return {
      schema_version: 1,
      id: `pc_test_${cid}`,
      digest: `digest_${cid}`,
      project_card_id: cid,
      goal: "Build the feature",
      criteria: [{ id: "c1", description: "Works", required: true, evidence_expectation: "synthesis" }],
      required_outputs: [{ id: "o1", description: "Output", kind: "logical", required: true }],
      constraints: [],
      limits: { hard_deadline_at: undefined, max_tokens: undefined, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
      provenance: { requested_by: "user", authored_by: "orc", created_at: "2026-07-12T00:00:00.000Z" },
    };
  }

  function setupProject(cardId?: number): { store: ProjectReviewStore; contract: ProjectAcceptanceContractV1; cardId: number } {
    const s = new ProjectReviewStore();
    const c = makeContract(cardId);
    s.insertContract(c);
    s.initializeSupervision(c.project_card_id, c.id);
    return { store: s, contract: c, cardId: c.project_card_id };
  }

  describe("root contracts", () => {
    it("inserts and retrieves a contract", () => {
      const c = makeContract();
      store.insertContract(c);
      const retrieved = store.getContract(c.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.project_card_id).toBe(c.project_card_id);
      expect(retrieved!.contract_digest).toBe(c.digest);
    });

    it("retrieves contract by project card ID", () => {
      const c = makeContract();
      store.insertContract(c);
      const retrieved = store.getContractByProjectCardId(c.project_card_id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(c.id);
    });

    it("checks contract existence", () => {
      const c = makeContract();
      expect(store.contractExists(c.project_card_id)).toBe(false);
      store.insertContract(c);
      expect(store.contractExists(c.project_card_id)).toBe(true);
    });

    it("throws on duplicate contract for same card", () => {
      const c = makeContract();
      store.insertContract(c);
      expect(() => store.insertContract(c)).toThrow();
    });
  });

  describe("supervision state", () => {
    it("initializes supervision in executing state", () => {
      const { store: s, contract: c } = setupProject();
      const sup = s.getSupervision(c.project_card_id);
      expect(sup).toBeDefined();
      expect(sup!.state).toBe("executing");
      expect(sup!.generation).toBe(1);
      expect(sup!.review_round).toBe(0);
    });

    it("allows state transitions from valid source states", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const transitioned = s.stateTransition(cid, ["executing"], "review_ready");
      expect(transitioned).toBe(true);
      expect(s.getSupervision(cid)!.state).toBe("review_ready");
    });

    it("rejects state transition from invalid source state", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const transitioned = s.stateTransition(cid, ["review_ready"], "accepted");
      expect(transitioned).toBe(false);
      expect(s.getSupervision(cid)!.state).toBe("executing");
    });

    it("sets state unconditionally with setState", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.setState(cid, "blocked", { blocked_reason: "Something went wrong" });
      const sup = s.getSupervision(cid);
      expect(sup!.state).toBe("blocked");
      expect(sup!.blocked_reason).toBe("Something went wrong");
    });

    it("increments generation", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.incrementGeneration(cid);
      expect(s.getSupervision(cid)!.generation).toBe(2);
    });

    it("detects terminal states", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.isTerminal(cid)).toBe(false);
      s.setState(cid, "accepted");
      expect(s.isTerminal(cid)).toBe(true);
    });

    it("returns undefined for unknown project", () => {
      expect(store.getSupervision(999)).toBeUndefined();
    });
  });

  describe("review cases", () => {
    it("inserts a review case and retrieves it", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const snapshot = { data: "test" };
      const { id } = s.insertReviewCase(cid, 1, 1, snapshot, "digest123");
      expect(id).toBeTruthy();
      const retrieved = s.getReviewCase(id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.project_card_id).toBe(cid);
      expect(retrieved!.generation).toBe(1);
      expect(retrieved!.status).toBe("open");
    });

    it("retrieves latest open case", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.insertReviewCase(cid, 1, 2, { v: 2 }, "d2");
      const latest = s.getLatestOpenCase(cid);
      expect(latest).toBeDefined();
      expect(latest!.round).toBe(2);
    });

    it("does not return superseded case as latest", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.supersedeCase(id);
      s.insertReviewCase(cid, 1, 2, { v: 2 }, "d2");
      const latest = s.getLatestOpenCase(cid);
      expect(latest!.round).toBe(2);
    });

    it("lists all cases for a project in order", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.insertReviewCase(cid, 1, 2, { v: 2 }, "d2");
      const cases = s.getCasesForProject(cid);
      expect(cases).toHaveLength(2);
      expect(cases[0]!.round).toBe(1);
      expect(cases[1]!.round).toBe(2);
    });

    it("supersedes a case", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      expect(s.supersedeCase(id)).toBe(true);
      const retrieved = s.getReviewCase(id);
      expect(retrieved!.status).toBe("superseded");
      expect(retrieved!.superseded_at).toBeTruthy();
    });

    it("cannot supersede already superseded case again", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.supersedeCase(id);
      expect(s.supersedeCase(id)).toBe(false);
    });
  });

  describe("review decisions", () => {
    it("inserts a decision and retrieves it", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      const { id } = s.insertDecision(caseId, { action: "accept" }, "digest456");
      expect(id).toBeTruthy();
      const retrieved = s.getDecision(id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.review_case_id).toBe(caseId);
    });

    it("retrieves decision by case ID", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.insertDecision(caseId, { action: "accept" }, "digest456");
      const byCase = s.getDecisionByCaseId(caseId);
      expect(byCase).toBeDefined();
      expect(byCase!.decision_digest).toBe("digest456");
    });

    it("checks if case has decision", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      expect(s.hasDecisionForCase(caseId)).toBe(false);
      s.insertDecision(caseId, { action: "accept" }, "digest456");
      expect(s.hasDecisionForCase(caseId)).toBe(true);
    });

    it("rejects duplicate decision for same case", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "d1");
      s.insertDecision(caseId, { action: "accept" }, "digest456");
      expect(() => s.insertDecision(caseId, { action: "accept" }, "digest789")).toThrow();
    });
  });

  describe("projectStateToKanban", () => {
    const cases: Array<[ProjectState, string]> = [
      ["executing", "running"],
      ["review_ready", "running"],
      ["review_requested", "running"],
      ["reviewing", "running"],
      ["repair_planned", "running"],
      ["repairing", "running"],
      ["needs_input", "running"],
      ["blocked", "failed"],
      ["accepted", "done"],
    ];
    for (const [state, expected] of cases) {
      it(`maps ${state} to ${expected}`, () => {
        expect(projectStateToKanban(state)).toBe(expected);
      });
    }
  });
});
