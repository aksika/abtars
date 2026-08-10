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

  /** Real kanban_board row so settlement's mandatory Kanban CAS can apply. */
  function insertKanbanCard(s: ProjectReviewStore, cardId: number, status: string, extra: Record<string, string | number | null> = {}): void {
    const cols = ["id", "title", "source", "status", "type", "goal", "created_at", "updated_at", ...Object.keys(extra)];
    const vals: unknown[] = [cardId, `p${cardId}`, "agent", status, "O", "goal", new Date().toISOString().replace("T", " ").slice(0, 19), new Date().toISOString().replace("T", " ").slice(0, 19), ...Object.values(extra)];
    s.db.prepare(`INSERT INTO kanban_board (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
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

    it("hasActiveProjectSupervision: true only for a non-terminal supervision row", () => {
      expect(store.hasActiveProjectSupervision(uniqueCardId())).toBe(false);
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.hasActiveProjectSupervision(cid)).toBe(true);
      s.stateTransition(cid, ["executing"], "review_ready");
      expect(s.hasActiveProjectSupervision(cid)).toBe(true);
      insertKanbanCard(s, cid, "running");
      s.settleBlocked(cid, "case-b", { action: "blocked", reason: "x" }, "blocker");
      expect(s.hasActiveProjectSupervision(cid)).toBe(false);
    });

    it("hasActiveProjectSupervision: accepted supervision is not an active owner", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      s.settleAcceptance(cid, "case-a", { action: "accept", synthesis: "ok" }, "ok");
      expect(s.hasActiveProjectSupervision(cid)).toBe(false);
    });

    it("hasActiveProjectSupervision: awaiting_contract counts as active (the authoring claim owns it)", () => {
      const cid = uniqueCardId();
      store.ensureAwaitingContract(cid);
      expect(store.hasActiveProjectSupervision(cid)).toBe(true);
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

  describe("#1604 coverage rounds", () => {
    it("round-trips the coverage columns (writer + reader)", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.claimCoverageRound(cid, "sig-1", ["c4", "c5"], 3);
      const sup = s.getSupervision(cid);
      expect(sup!.coverage_rounds).toBe(1);
      expect(sup!.coverage_signature).toBe("sig-1");
      expect(JSON.parse(sup!.coverage_uncovered_ids!)).toEqual(["c4", "c5"]);
    });

    it("claimCoverageRound returns true once and false for a second call with the same signature", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.claimCoverageRound(cid, "sig-1", ["c1"], 3)).toBe(true);
      expect(s.claimCoverageRound(cid, "sig-1", ["c1"], 3)).toBe(false);
      expect(s.getSupervision(cid)!.coverage_rounds).toBe(1);
    });

    it("claimCoverageRound allows a new signature after the first round", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.claimCoverageRound(cid, "sig-1", ["c1"], 3);
      expect(s.claimCoverageRound(cid, "sig-2", ["c1"], 3)).toBe(true);
      expect(s.getSupervision(cid)!.coverage_rounds).toBe(2);
    });

    it("claimCoverageRound returns false when state is not executing", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.stateTransition(cid, ["executing"], "review_ready");
      expect(s.claimCoverageRound(cid, "sig-1", ["c1"], 3)).toBe(false);
    });

    it("claimCoverageRound returns false at the maxRounds ceiling", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.claimCoverageRound(cid, "sig-1", ["c1"], 1)).toBe(true);
      expect(s.claimCoverageRound(cid, "sig-2", ["c1"], 1)).toBe(false);
      expect(s.getSupervision(cid)!.coverage_rounds).toBe(1);
    });

    it("recordCoverageClear writes an empty uncovered list and the signature", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.recordCoverageClear(cid, "sig-clear");
      const sup = s.getSupervision(cid);
      expect(sup!.coverage_uncovered_ids).toBe("[]");
      expect(sup!.coverage_signature).toBe("sig-clear");
    });

    it("recordCoverageReviewable persists the gap without incrementing a round (CAS on executing)", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.claimCoverageRound(cid, "sig-gap", ["c1", "c2"], 3)).toBe(true);
      expect(s.recordCoverageReviewable(cid, "sig-gap", ["c1", "c2"])).toBe(true);
      const sup = s.getSupervision(cid);
      expect(sup!.coverage_rounds).toBe(1);
      expect(sup!.coverage_signature).toBe("sig-gap");
      expect(JSON.parse(sup!.coverage_uncovered_ids!)).toEqual(["c1", "c2"]);
    });

    it("recordCoverageReviewable refuses a stale coverage signature", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.claimCoverageRound(cid, "new-signature", ["c1"], 3)).toBe(true);
      expect(s.recordCoverageReviewable(cid, "old-signature", ["c1"])).toBe(false);
      expect(s.getSupervision(cid)!.coverage_signature).toBe("new-signature");
    });

    it("recordCoverageReviewable refuses a non-executing row (false CAS)", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.stateTransition(cid, ["executing"], "review_ready");
      expect(s.recordCoverageReviewable(cid, "sig-gap", ["c1"])).toBe(false);
    });

    it("migration runs twice without error on an existing DB", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      s.migrate();
      s.recordCoverageClear(cid, "sig-2");
      expect(s.getSupervision(cid)!.coverage_uncovered_ids).toBe("[]");
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

  describe("review request maintenance", () => {
    it("abandons requests at the attempt limit", () => {
      const { store: s } = setupProject();
      const requestId = s.insertReviewRequest(123, "case-maintenance", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, requestId);

      expect(s.abandonExpiredRequests()).toBe(1);
      expect(s.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId)).toEqual({ status: "abandoned" });
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

  describe("#1618 terminal event outbox", () => {
    it("settleAcceptance with a peer event creates exactly one completed outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      const caseId = `case-accept-${cid}`;
      const event = { peer: "kp", payload: { event_id: `accept_1_${cid}`, kind: "completed", request_id: "r1", contribution_ref: "c1" } };
      s.settleAcceptance(cid, caseId, { action: "accept", synthesis: "ok" }, "ok", event, `rd_settle_${cid}`);

      const rows = s.db.prepare("SELECT id, project_card_id, peer, payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.peer).toBe("kp");
      const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
      expect(payload.kind).toBe("completed");
      expect(payload.acceptance_id).toBe(`rd_settle_${cid}`);
    });

    it("settleBlocked with a peer event creates a FAILED row and never a completed one", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      const caseId = `case-block-${cid}`;
      const event = { peer: "kp", payload: { event_id: `fail_1_${cid}`, kind: "failed", request_id: "r1", contribution_ref: "c1", summary: "blocked: blocker" } };
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", event, `rd_block_${cid}`);

      const rows = s.db.prepare("SELECT payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
      expect(payload.kind).toBe("failed");
      expect(payload.acceptance_id).toBe(`rd_block_${cid}`);
    });

    it("duplicate settlement cannot create a second outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      const caseId = `case-dup-${cid}`;
      const event = { peer: "kp", payload: { kind: "completed", request_id: "r1", contribution_ref: "c1" } };
      s.settleAcceptance(cid, caseId, { action: "accept", synthesis: "ok" }, "ok", event, `rd_dup_${cid}`);
      expect(() => s.settleAcceptance(cid, `case-dup2-${cid}`, { action: "accept", synthesis: "ok" }, "ok", event, `rd_dup2_${cid}`)).toThrow();

      const rows = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any;
      expect(rows.cnt).toBe(1);
    });

    // #1630 Task 2 verify: an explicitly supplied rich peerEvent always wins
    // over auto-derivation — its projection evidence must survive untouched.
    it("an explicit rich peerEvent is not overwritten by auto-derivation and its evidence survives", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      const caseId = `case-rich-${cid}`;
      const event = {
        peer: "kp",
        payload: {
          version: 1,
          event_id: `fail_rich_${cid}`,
          kind: "failed",
          request_id: "r1",
          contribution_ref: "c1",
          summary: "explicit rich summary",
          projection: {
            schema_version: 1,
            outcome: "failed",
            summary: "explicit rich projection",
            evidence: [{ id: "e1", kind: "check", summary: "observed", observed_by: "kp" }],
            artifacts: [],
            provenance: { receiver_peer: "kp", receiver_project_ref: "project_1", acceptance_id: "rd_rich", accepted_at: new Date().toISOString() },
          },
        },
      };
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "rich_blocker", event, `rd_rich_${cid}`);

      const rows = s.db.prepare("SELECT payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.payload_json) as any;
      expect(payload.summary).toBe("explicit rich summary");
      expect(payload.projection.summary).toBe("explicit rich projection");
      expect(payload.projection.evidence).toEqual([{ id: "e1", kind: "check", summary: "observed", observed_by: "kp" }]);
      expect(payload.acceptance_id).toBe(`rd_rich_${cid}`);
    });

    it("rollback on a decision conflict leaves no outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      const caseId = `case-roll-${cid}`;
      const event = { peer: "kp", payload: { kind: "failed", request_id: "r1", contribution_ref: "c1" } };
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", event, `rd_roll_${cid}`);
      // same review case again → UNIQUE(review_case_id) on decisions rolls the
      // whole transaction back, including the outbox insert
      expect(() => s.settleBlocked(cid, caseId, { action: "blocked", reason: "y" }, "blocker", event, `rd_roll2_${cid}`)).toThrow();

      const rows = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any;
      expect(rows.cnt).toBe(1);
    });
  });

  describe("#1626 queued-root terminal settlement", () => {
    const future = (): string => new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    function setupQueuedProject(status: "queued" | "running", extra: Record<string, string | number | null> = {}) {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, status, extra);
      s.stateTransition(cid, ["executing"], "reviewing");
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "digest");
      s.insertReviewRequest(cid, caseId, 1);
      return { store: s, cardId: cid, caseId };
    }

    it("queued acceptance terminalizes the card to done with synthesis, cleared stale fields, and one journal row", () => {
      const { store: s, cardId, caseId } = setupQueuedProject("queued", { error: "stale failed-turn", next_retry_at: future(), retry_count: 2 });
      const event = { peer: "kp", payload: { kind: "completed", request_id: "r1", contribution_ref: "c1" } };

      s.settleAcceptance(cardId, caseId, { action: "accept", synthesis: "ok" }, "synthesis text", event, `rd_settle_${cardId}`);

      const card = s.db.prepare("SELECT status, result_summary, error, next_retry_at, completed_at FROM kanban_board WHERE id = ?").get(cardId) as any;
      expect(card.status).toBe("done");
      expect(card.result_summary).toBe("synthesis text");
      expect(card.error).toBeNull();
      expect(card.next_retry_at).toBeNull();
      expect(card.completed_at).toBeTruthy();

      const journal = s.db.prepare("SELECT from_status, to_status, actor FROM kanban_card_transitions WHERE card_id = ?").all(cardId) as any[];
      expect(journal).toHaveLength(1);
      expect(journal[0]).toEqual({ from_status: "queued", to_status: "done", actor: "project_acceptance" });

      expect(s.getSupervision(cardId)!.state).toBe("accepted");
      expect(s.getReviewCase(caseId)!.status).toBe("accepted");
      expect(s.getReviewRequestByCaseId(caseId)!.status).toBe("settled");
      const outbox = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cardId) as any;
      expect(outbox.cnt).toBe(1);
    });

    it("queued blocking terminalizes the card to failed with the blocker error and clears the retry date", () => {
      const { store: s, cardId, caseId } = setupQueuedProject("queued", { next_retry_at: future(), retry_count: 1 });
      const event = { peer: "kp", payload: { kind: "failed", request_id: "r1", contribution_ref: "c1" } };

      s.settleBlocked(cardId, caseId, { action: "blocked", reason: "x" }, "blocker", event, `rd_block_${cardId}`);

      const card = s.db.prepare("SELECT status, error, next_retry_at, completed_at FROM kanban_board WHERE id = ?").get(cardId) as any;
      expect(card.status).toBe("failed");
      expect(card.error).toBe("blocked: blocker");
      expect(card.next_retry_at).toBeNull();
      expect(card.completed_at).toBeTruthy();

      const journal = s.db.prepare("SELECT from_status, to_status, actor FROM kanban_card_transitions WHERE card_id = ?").all(cardId) as any[];
      expect(journal).toHaveLength(1);
      expect(journal[0]).toEqual({ from_status: "queued", to_status: "failed", actor: "project_acceptance" });

      expect(s.getSupervision(cardId)!.state).toBe("blocked");
      expect(s.getReviewCase(caseId)!.status).toBe("superseded");
      expect(s.getReviewRequestByCaseId(caseId)!.status).toBe("settled");
      const outbox = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cardId) as any;
      expect(outbox.cnt).toBe(1);
    });

    it("running settlement is unchanged and still terminalizes", () => {
      const { store: s, cardId, caseId } = setupQueuedProject("running", { error: "stale", next_retry_at: future() });
      s.settleAcceptance(cardId, caseId, { action: "accept", synthesis: "ok" }, "synthesis text");
      const card = s.db.prepare("SELECT status, result_summary, error, next_retry_at FROM kanban_board WHERE id = ?").get(cardId) as any;
      expect(card.status).toBe("done");
      expect(card.result_summary).toBe("synthesis text");
      expect(card.error).toBeNull();
      expect(card.next_retry_at).toBeNull();
    });

    it("settlement on an already-terminal card throws and rolls back the whole transaction", () => {
      const { store: s, cardId, caseId } = setupQueuedProject("queued");
      // card escapes to done outside settlement (e.g. a concurrent writer)
      s.db.prepare("UPDATE kanban_board SET status = 'done', updated_at = datetime('now') WHERE id = ?").run(cardId);
      const event = { peer: "kp", payload: { kind: "completed", request_id: "r1", contribution_ref: "c1" } };

      expect(() => s.settleAcceptance(cardId, caseId, { action: "accept", synthesis: "ok" }, "syn", event, `rd_lost_${cardId}`))
        .toThrow(/kanban settlement lost: observed done/);

      expect(s.hasDecisionForCase(caseId)).toBe(false);
      expect(s.getSupervision(cardId)!.state).toBe("reviewing");
      expect(s.getReviewCase(caseId)!.status).toBe("open");
      expect(s.getReviewRequestByCaseId(caseId)!.status).toBe("pending");
      const outbox = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cardId) as any;
      expect(outbox.cnt).toBe(0);
    });

    it("settlement on a missing card throws and leaves no trace", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "digest");
      s.insertReviewRequest(cid, caseId, 1);
      // no kanban_board row at all
      expect(() => s.settleAcceptance(cid, caseId, { action: "accept", synthesis: "ok" }, "syn", undefined, `rd_missing_${cid}`))
        .toThrow(/kanban settlement lost: observed missing/);

      expect(s.hasDecisionForCase(caseId)).toBe(false);
      expect(s.getSupervision(cid)!.state).toBe("executing");
      expect(s.getReviewCase(caseId)!.status).toBe("open");
      expect(s.getReviewRequestByCaseId(caseId)!.status).toBe("pending");
    });
  });
});
