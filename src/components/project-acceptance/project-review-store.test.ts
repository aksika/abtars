import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";
import type { ProjectState } from "./project-review-store.js";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("./project-review-store.js").ProjectReviewStore;
let projectStateToKanban: typeof import("./project-review-store.js").projectStateToKanban;

describe("ProjectReviewStore", () => {
  let store: InstanceType<typeof ProjectReviewStore>;
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

  function setupProject(cardId?: number): { store: InstanceType<typeof ProjectReviewStore>; contract: ProjectAcceptanceContractV1; cardId: number } {
    const s = new ProjectReviewStore();
    const c = makeContract(cardId);
    s.insertContract(c);
    s.initializeSupervision(c.project_card_id, c.id);
    return { store: s, contract: c, cardId: c.project_card_id };
  }

  /** Real kanban_board row so settlement's mandatory Kanban CAS can apply. */
  function insertKanbanCard(s: InstanceType<typeof ProjectReviewStore>, cardId: number, status: string, extra: Record<string, string | number | null> = {}): void {
    const cols = ["id", "title", "source", "status", "type", "goal", "created_at", "updated_at", ...Object.keys(extra)];
    const vals: unknown[] = [cardId, `p${cardId}`, "agent", status, "O", "goal", new Date().toISOString().replace("T", " ").slice(0, 19), new Date().toISOString().replace("T", " ").slice(0, 19), ...Object.values(extra)];
    s.db.prepare(`INSERT INTO kanban_board (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }

  /** #1680: a peer-origin root card with a durable source_peer. */
  function insertPeerKanbanCard(s: InstanceType<typeof ProjectReviewStore>, cardId: number, status: string, extra: Record<string, string | number | null> = {}, sourcePeer = "kp"): void {
    const cols = ["id", "title", "source", "source_peer", "status", "type", "goal", "created_at", "updated_at", ...Object.keys(extra)];
    const vals: unknown[] = [cardId, `p${cardId}`, "peer", sourcePeer, status, "O", "goal", new Date().toISOString().replace("T", " ").slice(0, 19), new Date().toISOString().replace("T", " ").slice(0, 19), ...Object.values(extra)];
    s.db.prepare(`INSERT INTO kanban_board (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...vals);
  }

  /** #1680: migrate the receiver help ledger so the identity resolver has a home. */
  function migratePeerHelpTable(s: InstanceType<typeof ProjectReviewStore>): void {
    s.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_help_requests (
        origin_peer TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','deferred','unknown')),
        contribution_ref TEXT,
        local_card_id INTEGER,
        local_run_id TEXT,
        response_json TEXT,
        withdrawn_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (origin_peer, request_id),
        UNIQUE (contribution_ref)
      )
    `);
  }

  /** #1680: seed the accepted receiver help identity keyed by the local card. */
  function seedPeerHelp(s: InstanceType<typeof ProjectReviewStore>, cardId: number, originPeer: string, requestId: string, contributionRef: string): void {
    s.db.prepare(`
      INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, contribution_ref, local_card_id, response_json, created_at, updated_at)
      VALUES (?, ?, ?, 'accepted', ?, ?, '{}', datetime('now'), datetime('now'))
    `).run(originPeer, requestId, `hash_${requestId}`, contributionRef, cardId);
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

    it("settleBlocked is idempotent per review case and never throws a UNIQUE violation", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      // A review case that already carries a decision must not make a second
      // blocked settlement throw (unhandled rejection crashed the whole
      // bridge in the live two-node runs). The settlement reuses the existing
      // decision and still converges the supervision and card to terminal.
      const existing = s.insertDecision("case-double", { action: "blocked", reason: "first" }, "digest-1");
      const result = s.settleBlocked(cid, "case-double", { action: "blocked", reason: "second" }, "blocker");
      expect(result.decisionId).toBe(existing.id);
      expect(s.getSupervision(cid)!.state).toBe("blocked");
      expect(s.getSupervision(cid)!.accepted_decision_id).toBe(existing.id);
    });

    it("settleAcceptance is idempotent per review case", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      s.insertDecision("case-acc-double", { action: "accept", synthesis: "ok" }, "digest-1");
      expect(() => s.settleAcceptance(cid, "case-acc-double", { action: "accept", synthesis: "ok" }, "ok")).not.toThrow();
      expect(s.getSupervision(cid)!.state).toBe("accepted");
    });

    it("#1677: a mutation whose review case row does not exist is still permitted (synthetic blockers)", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running");
      // No project_review_cases row at all — the shared predicate must never
      // turn the intentional absent-case allowance into a rejected mutation.
      const caseId = `synthetic-${cid}`;
      expect(() => s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker")).not.toThrow();
      expect(s.getSupervision(cid)!.state).toBe("blocked");
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

  describe("#1656 workspace binding", () => {
    it("binds a canonical cwd once and reconstructs the narrow execution scope", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.bindWorkspace(cid, "/tmp/ws/daily-ai")).toEqual({ ok: true });
      const scope = s.getWorkspaceScope(cid);
      expect(scope).toEqual({ cwd: "/tmp/ws/daily-ai", env: { WORKSPACE: "/tmp/ws/daily-ai" } });
      expect(Object.isFrozen(scope!.env)).toBe(true);
      expect(s.getSupervision(cid)!.workspace_cwd).toBe("/tmp/ws/daily-ai");
    });

    it("is idempotent for the same canonical cwd on reattach", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.bindWorkspace(cid, "/tmp/ws/daily-ai")).toEqual({ ok: true });
      expect(s.bindWorkspace(cid, "/tmp/ws/daily-ai")).toEqual({ ok: true });
      expect(s.getSupervision(cid)!.workspace_cwd).toBe("/tmp/ws/daily-ai");
    });

    it("fails closed on a different cwd and never mutates the bound workspace", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      expect(s.bindWorkspace(cid, "/tmp/ws/daily-ai")).toEqual({ ok: true });
      expect(s.bindWorkspace(cid, "/tmp/ws/other")).toEqual({ ok: false, reason: "workspace_mismatch" });
      expect(s.getSupervision(cid)!.workspace_cwd).toBe("/tmp/ws/daily-ai");
      expect(s.getWorkspaceScope(cid)!.cwd).toBe("/tmp/ws/daily-ai");
    });

    it("fails closed when the supervision row is missing", () => {
      expect(store.bindWorkspace(424242, "/tmp/ws/daily-ai")).toEqual({ ok: false, reason: "missing_project" });
      expect(store.getWorkspaceScope(424242)).toBeUndefined();
    });

    it("returns no scope for an unbound project", () => {
      const { store: s, contract: c } = setupProject();
      expect(s.getWorkspaceScope(c.project_card_id)).toBeUndefined();
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
    it("abandons requests at the attempt limit and returns the decision facts", () => {
      const { store: s } = setupProject();
      const requestId = s.insertReviewRequest(123, "case-maintenance", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, requestId);

      const facts = s.abandonExpiredRequests();
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        requestId,
        projectCardId: 123,
        generation: 1,
        reviewCaseId: "case-maintenance",
        attempts: 5,
        lastError: "exceeded max attempts (last: none)",
        cause: "max_attempts",
        liveRunId: null,
      });
      expect(s.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId)).toEqual({ status: "abandoned" });
    });

    it("logs the abandonment fact inside the decision transaction", async () => {
      const logger = await import("../logger.js");
      const warnSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      const { store: s } = setupProject();
      const requestId = s.insertReviewRequest(123, "case-log-boundary", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, requestId);

      let inTransaction = false;
      const transaction = s.db.transaction.bind(s.db);
      s.db.transaction = <T>(fn: () => T): T => transaction(() => {
        inTransaction = true;
        try {
          return fn();
        } finally {
          inTransaction = false;
        }
      });
      warnSpy.mockImplementation(() => {
        expect(inTransaction).toBe(true);
      });

      try {
        const facts = s.abandonExpiredRequests();
        expect(facts).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalledWith(
          "project-review-store",
          expect.stringContaining(`rr=${requestId}`),
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    // #1678: the composed last_error must retain the typed dispatch reason that
    // explains why dispatch kept failing — never overwrite it.
    it("preserves the typed dispatch reason inside the composed last_error", () => {
      const { store: s } = setupProject();
      const requestId = s.insertReviewRequest(123, "case-reason", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ?, last_error = ? WHERE id = ?").run(5, "project_generation_mismatch", requestId);

      const facts = s.abandonExpiredRequests();
      expect(facts[0]!.lastError).toBe("exceeded max attempts (last: project_generation_mismatch)");
      const row = s.db.prepare("SELECT last_error FROM project_review_requests WHERE id = ?").get(requestId) as { last_error: string };
      expect(row.last_error).toBe("exceeded max attempts (last: project_generation_mismatch)");
    });

    it("composes the deadline branch and gives max_attempts precedence when both bounds match", () => {
      const { store: s } = setupProject();
      const attemptsId = s.insertReviewRequest(123, "case-both", 1).id;
      const deadlineId = s.insertReviewRequest(456, "case-deadline", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, attemptsId);
      // deadlines in the past trip the deadline branch only when the attempts
      // branch has not already abandoned the request
      s.db.prepare("UPDATE project_review_requests SET deadline_at = ? WHERE id IN (?, ?)").run(new Date(Date.now() - 60_000).toISOString(), attemptsId, deadlineId);

      const facts = s.abandonExpiredRequests();
      expect(facts).toHaveLength(2);
      const byId = new Map(facts.map(f => [f.requestId, f]));
      expect(byId.get(attemptsId)!.cause).toBe("max_attempts");
      expect(byId.get(attemptsId)!.lastError).toBe("exceeded max attempts (last: none)");
      expect(byId.get(deadlineId)!.cause).toBe("deadline");
      expect(byId.get(deadlineId)!.lastError).toBe("deadline passed (last: none)");
    });

    // #1678: the live-run guard — abandonment requires that no live run owns
    // the case's project at the case's generation.
    it("never abandons a request whose generation has a live Orc run", async () => {
      const { OrcProjectRunStore } = await import("../orc-project/orc-project-run-store.js");
      const { store: s } = setupProject();
      const projectId = s.db.prepare("SELECT project_card_id FROM project_supervision LIMIT 1").get() as { project_card_id: number };
      new OrcProjectRunStore();
      const now = new Date().toISOString();
      s.db.prepare("UPDATE orc_project_runs SET state = 'released', released_at = ? WHERE state IN ('scheduled','dispatching','running')").run(now);
      s.db.prepare("DELETE FROM project_review_requests").run();
      const requestId = s.insertReviewRequest(projectId.project_card_id, "case-live", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, requestId);
      s.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id, project_generation,
           ownership_generation, global_slot, owner_peer, owner_instance_id,
           origin_kind, state, created_at, updated_at)
        VALUES (?, ?, 'project_review', ?, 'review goal', ?, 1, 1, 1, 'kp', 'inst', 'local', 'running', ?, ?)
      `).run("or_guard", "review:case-live", "case-live", projectId.project_card_id, now, now);

      const facts = s.abandonExpiredRequests();
      expect(facts).toHaveLength(0);
      const row = s.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId) as { status: string };
      expect(row.status).toBe("pending");
    });

    it("abandons a request at generation G when the only live run is at G-1", async () => {
      const { OrcProjectRunStore } = await import("../orc-project/orc-project-run-store.js");
      const { store: s } = setupProject();
      const projectId = s.db.prepare("SELECT project_card_id FROM project_supervision LIMIT 1").get() as { project_card_id: number };
      new OrcProjectRunStore();
      const now = new Date().toISOString();
      s.db.prepare("UPDATE orc_project_runs SET state = 'released', released_at = ? WHERE state IN ('scheduled','dispatching','running')").run(now);
      s.db.prepare("DELETE FROM project_review_requests").run();
      const requestId = s.insertReviewRequest(projectId.project_card_id, "case-stale-gen", 1).id;
      s.db.prepare("UPDATE project_review_requests SET attempts = ? WHERE id = ?").run(5, requestId);
      s.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id, project_generation,
           ownership_generation, global_slot, owner_peer, owner_instance_id,
           origin_kind, state, created_at, updated_at)
        VALUES (?, ?, 'project_review', ?, 'review goal', ?, 2, 2, 1, 'kp', 'inst', 'local', 'running', ?, ?)
      `).run("or_stale_gen", "review:case-stale-gen", "case-stale-gen", projectId.project_card_id, now, now);

      const facts = s.abandonExpiredRequests();
      expect(facts).toHaveLength(1);
      expect(facts[0]!.requestId).toBe(requestId);
      // the verdict the guard evaluated: no live run at the request's
      // generation (the only live run is at G-1) — so the fact records null
      expect(facts[0]!.liveRunId).toBe(null);
      const row = s.db.prepare("SELECT status FROM project_review_requests WHERE id = ?").get(requestId) as { status: string };
      expect(row.status).toBe("abandoned");
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
    it("settleAcceptance with a peer recipe creates exactly one completed outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      const caseId = `case-accept-${cid}`;
      s.settleAcceptance(cid, caseId, { action: "accept", synthesis: "ok" }, "ok", { kind: "completed", summary: "ok" }, `rd_settle_${cid}`);

      const rows = s.db.prepare("SELECT id, project_card_id, peer, payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.peer).toBe("kp");
      const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
      expect(payload.kind).toBe("completed");
      expect(payload.request_id).toBe(`r_${cid}`);
      expect(payload.contribution_ref).toBe(`ref_${cid}`);
      expect(payload.acceptance_id).toBe(`rd_settle_${cid}`);
    });

    it("settleBlocked with a peer recipe creates a FAILED row and never a completed one", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      const caseId = `case-block-${cid}`;
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", { kind: "failed", summary: "blocked: blocker" }, `rd_block_${cid}`);

      const rows = s.db.prepare("SELECT payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
      expect(payload.kind).toBe("failed");
      expect(payload.request_id).toBe(`r_${cid}`);
      expect(payload.contribution_ref).toBe(`ref_${cid}`);
      expect(payload.acceptance_id).toBe(`rd_block_${cid}`);
    });

    it("duplicate settlement cannot create a second outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      const caseId = `case-dup-${cid}`;
      s.settleAcceptance(cid, caseId, { action: "accept", synthesis: "ok" }, "ok", { kind: "completed", summary: "ok" }, `rd_dup_${cid}`);
      expect(() => s.settleAcceptance(cid, `case-dup2-${cid}`, { action: "accept", synthesis: "ok" }, "ok", { kind: "completed", summary: "ok" }, `rd_dup2_${cid}`)).toThrow();

      const rows = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any;
      expect(rows.cnt).toBe(1);
    });

    // #1680: the recipe's summary and failure reason survive; the projection is
    // rebuilt from the durable identity, never from mutable card notes.
    it("a recipe's summary and failure reason survive derivation", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      const caseId = `case-rich-${cid}`;
      s.settleBlocked(
        cid, caseId, { action: "blocked", reason: "rich failure reason" }, "rich_blocker",
        { kind: "failed", summary: "explicit rich summary", failureReason: "rich failure reason" },
        `rd_rich_${cid}`,
      );

      const rows = s.db.prepare("SELECT payload_json FROM project_acceptance_outbox WHERE project_card_id = ?").all(cid) as any[];
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0]!.payload_json) as any;
      expect(payload.summary).toBe("explicit rich summary");
      expect(payload.projection.summary).toContain("explicit rich summary");
      expect(payload.projection.summary).toContain("rich failure reason");
      expect(payload.acceptance_id).toBe(`rd_rich_${cid}`);
    });

    it("rollback on a decision conflict leaves no outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      const caseId = `case-roll-${cid}`;
      const recipe = { kind: "failed" as const, summary: "blocked: blocker" };
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", recipe, `rd_roll_${cid}`);
      // same review case again → UNIQUE(review_case_id) on decisions rolls the
      // whole transaction back, including the outbox insert
      expect(() => s.settleBlocked(cid, caseId, { action: "blocked", reason: "y" }, "blocker", recipe, `rd_roll2_${cid}`)).toThrow();

      const rows = s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any;
      expect(rows.cnt).toBe(1);
    });

    it("#1680 a peer root with no accepted help identity fails closed and rolls back", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, "running");
      migratePeerHelpTable(s);
      const caseId = `case-failclosed-${cid}`;

      expect(() => s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", { kind: "failed", summary: "s" }, `rd_fc_${cid}`))
        .toThrow(/peer_terminal_identity_missing/);
      expect(s.getSupervision(cid)!.state).toBe("executing");
      expect(s.hasDecisionForCase(caseId)).toBe(false);
      expect(s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any).toMatchObject({ cnt: 0 });
    });

    it("#1680 a non-peer root settles with no outbox row", () => {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertKanbanCard(s, cid, "running"); // source = agent
      migratePeerHelpTable(s);
      const caseId = `case-nonpeer-${cid}`;
      s.settleBlocked(cid, caseId, { action: "blocked", reason: "x" }, "blocker", { kind: "failed", summary: "s" }, `rd_np_${cid}`);

      expect(s.getSupervision(cid)!.state).toBe("blocked");
      expect(s.db.prepare("SELECT COUNT(*) as cnt FROM project_acceptance_outbox WHERE project_card_id = ?").get(cid) as any).toMatchObject({ cnt: 0 });
    });
  });

  describe("#1626 queued-root terminal settlement", () => {
    const future = (): string => new Date(Date.now() + 60_000).toISOString().replace("T", " ").slice(0, 19);

    function setupQueuedProject(status: "queued" | "running", extra: Record<string, string | number | null> = {}) {
      const { store: s, contract: c } = setupProject();
      const cid = c.project_card_id;
      insertPeerKanbanCard(s, cid, status, extra);
      migratePeerHelpTable(s);
      seedPeerHelp(s, cid, "kp", `r_${cid}`, `ref_${cid}`);
      s.stateTransition(cid, ["executing"], "reviewing");
      const { id: caseId } = s.insertReviewCase(cid, 1, 1, { v: 1 }, "digest");
      s.insertReviewRequest(cid, caseId, 1);
      return { store: s, cardId: cid, caseId };
    }

    it("queued acceptance terminalizes the card to done with synthesis, cleared stale fields, and one journal row", () => {
      const { store: s, cardId, caseId } = setupQueuedProject("queued", { error: "stale failed-turn", next_retry_at: future(), retry_count: 2 });
      const recipe = { kind: "completed" as const, summary: "synthesis text" };

      s.settleAcceptance(cardId, caseId, { action: "accept", synthesis: "ok" }, "synthesis text", recipe, `rd_settle_${cardId}`);

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
      const recipe = { kind: "failed" as const, summary: "blocked: blocker" };

      s.settleBlocked(cardId, caseId, { action: "blocked", reason: "x" }, "blocker", recipe, `rd_block_${cardId}`);

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
      const recipe = { kind: "completed" as const, summary: "syn" };

      expect(() => s.settleAcceptance(cardId, caseId, { action: "accept", synthesis: "ok" }, "syn", recipe, `rd_lost_${cardId}`))
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
