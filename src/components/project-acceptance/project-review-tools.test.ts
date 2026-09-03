import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";
import type { ReviewCaseSnapshot } from "../project-acceptance/project-review-case.js";
import type { ProjectAcceptanceContractV2 } from "../project-acceptance/project-contract.js";
import { getOrcTools } from "../transport/orc-tools.js";

let TEST_HOME: string;
let ProjectReviewStore: typeof import("../project-acceptance/project-review-store.js").ProjectReviewStore;
let store: InstanceType<typeof import("../project-acceptance/project-review-store.js").ProjectReviewStore>;
let seq = 0;

function uniquePid(): number {
  return 12000 + (++seq);
}

/** Molty-54 shape: Orc-only root, two synthesis criteria, one required output. */
function makeOrcOnlySnapshot(pid: number): ReviewCaseSnapshot {
  return {
    schema_version: 1,
    project_card_id: pid,
    generation: 1,
    round: 1,
    created_at: new Date().toISOString(),
    root_contract: {
      id: `pc_${pid}`,
      digest: `d_${pid}`,
      goal: "Produce the analysis",
      criteria: [
        { id: "synth1", description: "Synthesize findings", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
        { id: "synth2", description: "Quality gate", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
      ],
      required_outputs: [{ id: "out", description: "analysis report", kind: "file", required: true }],
      limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    },
    criterion_inputs: [
      { criterion_id: "synth1", description: "Synthesize findings", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned" },
      { criterion_id: "synth2", description: "Quality gate", required: true, execution_owner: "orc", evidence_expectation: "synthesis", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "orc_owned" },
    ],
    contradiction_candidates: [],
    uncovered_criteria: [],
    child_summaries: [],
    peer_contributions: [],
    budgets: { total_cost: 5, total_tokens: 1200, wall_clock_ms: 1000, review_round: 1, repair_round: 0 },
    evidence_ref_count: 0,
    contradiction_count: 0,
  };
}

/** KP-24 shape: delegated criterion with a failed peer contribution claim. */
function makeDelegatedSnapshot(pid: number): ReviewCaseSnapshot {
  return {
    schema_version: 1,
    project_card_id: pid,
    generation: 1,
    round: 1,
    created_at: new Date().toISOString(),
    root_contract: {
      id: `pc_${pid}`,
      digest: `d_${pid}`,
      goal: "Deliver the analysis",
      criteria: [
        { id: "c1", description: "Peer contribution received", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        { id: "c2", description: "Uncovered delegated criterion", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
      ],
      required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
      limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
    },
    criterion_inputs: [
      { criterion_id: "c1", description: "Peer contribution received", required: true, execution_owner: "delegated", evidence_expectation: "observed", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: ["chk_1"], worker_claim_ids: ["claim_1"], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "supported" },
      { criterion_id: "c2", description: "Uncovered delegated criterion", required: true, execution_owner: "delegated", evidence_expectation: "observed", mapped_child_contract_ids: [], successful_mapped_child_contract_ids: [], unsuccessful_mapped_child_contract_ids: [], observed_evidence_ids: [], worker_claim_ids: [], failed_or_inconclusive_check_ids: [], artifact_observation_ids: [], retry_lineage_ids: [], coverage_hint: "gap" },
    ],
    contradiction_candidates: [],
    uncovered_criteria: ["c2"],
    child_summaries: [],
    peer_contributions: [
      { card_id: 9001, peer: "molty", outcome: "failed", projection_summary: "Molty could not complete the analysis", root_criteria: ["c1"], provenance: '{"receiver_peer":"molty"}' },
    ],
    budgets: { total_cost: 3, total_tokens: 800, wall_clock_ms: 500, review_round: 1, repair_round: 0 },
    evidence_ref_count: 1,
    contradiction_count: 0,
  };
}

async function setupCase(pid: number, snapshot: ReviewCaseSnapshot, contract: ProjectAcceptanceContractV2): Promise<{ pid: number; caseId: string }> {
  store.insertContract(contract);
  store.initializeSupervision(pid, String(contract.id), "executing");
  // #1626: settlement requires a live kanban card — the real projection must
  // apply from a legal live status inside the settlement transaction.
  store.db.prepare(`INSERT INTO kanban_board (id, title, source, status, type, goal, created_at, updated_at) VALUES (?, ?, ?, 'running', 'O', ?, datetime('now'), datetime('now'))`)
    .run(pid, "tools project", "task", "tools goal");
  const { id } = store.insertReviewCase(pid, 1, 1, snapshot, `digest_${pid}`);
  store.insertReviewRequest(pid, id, 1);
  store.stateTransition(pid, ["executing"], "review_requested");
  return { pid, caseId: id };
}

const orcContext = (pid: number) => ({ userId: "test", orcContext: { projectCardId: pid, projectGeneration: 1 } } as never);

function reviewTool(): ReturnType<typeof getOrcTools>[number] {
  return getOrcTools().find(t => t.name === "review_project")!;
}

function caseTool(): ReturnType<typeof getOrcTools>[number] {
  return getOrcTools().find(t => t.name === "get_project_review_case")!;
}

/** orcContext with a configurable bound generation. */
const orcCtx = (pid: number, gen = 1) => ({ userId: "test", orcContext: { projectCardId: pid, projectGeneration: gen } } as never);

/** Flexible project setup for the #1677 rejection-ladder tests. */
async function setupVariant(
  pid: number,
  opts: {
    state?: string;
    gen?: number;
    caseGen?: number;
    caseStatus?: "open" | "superseded";
    withCase?: boolean;
    withCard?: boolean;
    cardStatus?: string;
    cardSource?: string;
    cardSourceId?: string | null;
    garbageSnapshot?: boolean;
  } = {},
): Promise<{ caseId: string | null }> {
  const {
    state = "review_ready",
    gen = 1,
    caseGen = 1,
    caseStatus = "open",
    withCase = true,
    withCard = true,
    cardStatus = "running",
    cardSource = "agent",
    cardSourceId = null,
    garbageSnapshot = false,
  } = opts;
  const contract = orcOnlyContract(pid);
  store.insertContract(contract);
  store.initializeSupervision(pid, String(contract.id), state as never);
  while (store.getSupervision(pid)!.generation < gen) store.incrementGeneration(pid);
  if (withCard) {
    store.db.prepare(`INSERT INTO kanban_board (id, title, source, source_id, status, type, goal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'O', ?, datetime('now'), datetime('now'))`)
      .run(pid, "tools project", cardSource, cardSourceId, cardStatus, "tools goal");
  }
  let caseId: string | null = null;
  if (withCase) {
    const snapshot = garbageSnapshot
      ? { bad: true } as unknown as ReviewCaseSnapshot
      : makeOrcOnlySnapshot(pid);
    const { id } = store.insertReviewCase(pid, caseGen, 1, snapshot, `digest_${pid}`);
    if (caseStatus !== "open") store.supersedeCase(id);
    caseId = id;
  }
  return { caseId };
}

/** Structurally valid accept decision (from the accepted-journey test). */
function acceptDecision(pid: number, caseId: string): Record<string, unknown> {
  return {
    action: "accept",
    project_card_id: pid,
    project_generation: 1,
    review_case_id: caseId,
    criteria: [
      { criterion_id: "synth1", verdict: "satisfied", evidence_ids: [], rationale: "Synthesized from the immutable case" },
      { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "Quality gate passed on Orc evaluation" },
    ],
    outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
    contradictions: [],
    residual_risks: [],
    synthesis: "Analysis complete",
  };
}

const orcOnlyContract = (pid: number): ProjectAcceptanceContractV2 => ({
  schema_version: 2,
  id: `pc_${pid}`,
  digest: `d_${pid}`,
  project_card_id: pid,
  goal: "Produce the analysis",
  criteria: [
    { id: "synth1", description: "Synthesize findings", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
    { id: "synth2", description: "Quality gate", required: true, execution_owner: "orc", evidence_expectation: "synthesis" },
  ],
  required_outputs: [{ id: "out", description: "analysis report", kind: "file", required: true }],
  constraints: [],
  limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
  provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
});

describe("Orc review tools against a real isolated TaskDatabase (#1620)", () => {
  beforeEach(async () => {
    TEST_HOME = join(tmpdir(), `ab-review-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(TEST_HOME, { recursive: true });
    vi.doMock("../../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
    const mod = await import("../project-acceptance/project-review-store.js");
    ProjectReviewStore = mod.ProjectReviewStore;
    store = new ProjectReviewStore();
  });

  afterEach(() => {
    if (TEST_HOME && existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  describe("get_project_review_case", () => {
    it("returns the decision-ready brief for the open case and is side-effect-free", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId }, orcContext(pid));
      const brief = JSON.parse(raw) as Record<string, unknown>;
      expect(brief.schema_version).toBe(1);
      expect(brief.project_card_id).toBe(pid);
      expect(brief.review_case_id).toBe(caseId);
      const criteria = brief.criteria as Array<{ criterion_id: string; execution_owner: string; compatible_evidence: { observed: string[] } }>;
      expect(criteria.every(c => c.execution_owner === "orc")).toBe(true);
      expect((brief.legal_values as { output_dispositions: string[] }).output_dispositions).toContain("remote_only");

      // repeated reads mutate nothing and consume no proposal budget
      await caseTool().execute({ project_card_id: pid, review_case_id: caseId }, orcContext(pid));
      await caseTool().execute({ project_card_id: pid, review_case_id: caseId }, orcContext(pid));
      const sup = store.getSupervision(pid)!;
      expect(sup.state).toBe("review_requested");
      const req = store.getReviewRequestByCaseId(caseId)!;
      expect(req.status).toBe("pending");
      const row = store.db.prepare("SELECT invalid_proposals FROM project_review_requests WHERE review_case_id = ?").get(caseId) as { invalid_proposals: number };
      expect(row.invalid_proposals).toBe(0);
    });

    it("fails closed for foreign, stale, closed, and context-mismatched cases", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const foreign = await caseTool().execute({ project_card_id: pid + 100, review_case_id: caseId }, orcContext(pid));
      expect(JSON.parse(foreign).error).toContain("bound project");

      const stale = await caseTool().execute({ project_card_id: pid, review_case_id: "nonexistent" }, orcContext(pid));
      expect(JSON.parse(stale).error).toContain("not found");

      store.supersedeCase(caseId);
      const closed = await caseTool().execute({ project_card_id: pid, review_case_id: caseId }, orcContext(pid));
      expect(JSON.parse(closed).error).toContain("not open");
    });

    it("labels peer contributions as claims and supplies no fabricated compatible evidence", async () => {
      const pid = uniquePid();
      const delegatedContract: ProjectAcceptanceContractV2 = {
        schema_version: 2,
        id: `pc_${pid}`,
        digest: `d_${pid}`,
        project_card_id: pid,
        goal: "Deliver the analysis",
        criteria: [
          { id: "c1", description: "Peer contribution received", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
          { id: "c2", description: "Uncovered delegated criterion", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        ],
        required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
        constraints: [],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
        provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
      };
      const { caseId } = await setupCase(pid, makeDelegatedSnapshot(pid), delegatedContract);

      const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId }, orcContext(pid));
      const brief = JSON.parse(raw) as { peer_claims: Array<{ peer: string; outcome: string }>; criteria: Array<{ criterion_id: string; compatible_evidence: { observed: string[] } }> };
      expect(brief.peer_claims).toHaveLength(1);
      expect(brief.peer_claims[0]!.peer).toBe("molty");
      expect(brief.peer_claims[0]!.outcome).toBe("failed");
      // the failed peer claim never becomes observed evidence for c1
      const c1 = brief.criteria.find(c => c.criterion_id === "c1")!;
      expect(c1.compatible_evidence.observed).toEqual(["chk_1"]);
    });
  });

  describe("review_project native execution", () => {
    it("accepts an Orc-only project with one typed accept (Molty 54 shape)", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const raw = await reviewTool().execute({
        action: "accept",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: [
          { criterion_id: "synth1", verdict: "satisfied", evidence_ids: [], rationale: "Synthesized from the immutable case" },
          { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "Quality gate passed on Orc evaluation" },
        ],
        outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
        contradictions: [],
        residual_risks: [],
        synthesis: "Analysis complete",
      }, orcContext(pid));

      const result = JSON.parse(raw) as { outcome: string; decision_id: string };
      expect(result.outcome).toBe("accepted");
      expect(result.decision_id).toBeTruthy();

      const sup = store.getSupervision(pid)!;
      expect(sup.state).toBe("accepted");
      const decisionRow = store.getDecision(result.decision_id);
      expect(decisionRow).toBeDefined();
    });

    it("settles a blocked decision with the authored reason (KP 24 shape — not protocol exhaustion)", async () => {
      const pid = uniquePid();
      const delegatedContract: ProjectAcceptanceContractV2 = {
        schema_version: 2,
        id: `pc_${pid}`,
        digest: `d_${pid}`,
        project_card_id: pid,
        goal: "Deliver the analysis",
        criteria: [
          { id: "c1", description: "Peer contribution received", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
          { id: "c2", description: "Uncovered delegated criterion", required: true, execution_owner: "delegated", evidence_expectation: "observed" },
        ],
        required_outputs: [{ id: "out", description: "result", kind: "file", required: true }],
        constraints: [],
        limits: { hard_deadline_at: undefined, max_tokens: 100000, max_cost: undefined, max_review_rounds: 5, max_repair_rounds: 3 },
        provenance: { requested_by: "user", authored_by: "orc", created_at: new Date().toISOString() },
      };
      const { caseId } = await setupCase(pid, makeDelegatedSnapshot(pid), delegatedContract);

      const raw = await reviewTool().execute({
        action: "blocked",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: [
          { criterion_id: "c1", verdict: "satisfied", evidence_ids: ["chk_1"], rationale: "contribution claim reviewed" },
          { criterion_id: "c2", verdict: "unsatisfied", evidence_ids: [], rationale: "peer contribution failed; no lane covered this criterion" },
        ],
        outputs: [{ output_id: "out", disposition: "missing", evidence_ids: [] }],
        contradictions: [],
        residual_risks: [],
        synthesis: "Cannot complete without the failed criterion",
        blocker: { blocker_class: "peer_contribution_failed", affected_criterion_ids: ["c2"], what_was_attempted: "waited for molty contribution" },
      }, orcContext(pid));

      const result = JSON.parse(raw) as { outcome: string; summary: string };
      expect(result.outcome).toBe("blocked");
      expect(result.summary).toContain("peer_contribution_failed");
      expect(result.summary).not.toContain("review_protocol_exhausted");

      const sup = store.getSupervision(pid)!;
      expect(sup.state).toBe("blocked");
      expect(sup.blocked_reason).toBe("peer_contribution_failed");
    });

    it("rejects a bad enum with legal values and four remaining attempts; a corrected call succeeds", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const badRaw = await reviewTool().execute({
        action: "accept",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: [
          { criterion_id: "synth1", verdict: "delivered", evidence_ids: [], rationale: "x" },
          { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "ok" },
        ],
        outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
        contradictions: [],
        residual_risks: [],
        synthesis: "t",
      }, orcContext(pid));

      const bad = JSON.parse(badRaw) as { outcome: string; issues: Array<{ message: string }>; invalid_proposal_count: number; remaining_attempts: number };
      expect(bad.outcome).toBe("invalid");
      expect(bad.issues[0]!.message).toContain("legal values");
      expect(bad.invalid_proposal_count).toBe(1);
      expect(bad.remaining_attempts).toBe(4);
      // no decision was created and no terminal state transition happened
      expect(store.getSupervision(pid)!.state).toBe("reviewing");
      expect(store.hasDecisionForCase(caseId)).toBe(false);

      const goodRaw = await reviewTool().execute({
        action: "accept",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: [
          { criterion_id: "synth1", verdict: "satisfied", evidence_ids: [], rationale: "synthesized" },
          { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "quality ok" },
        ],
        outputs: [{ output_id: "out", disposition: "present", evidence_ids: [] }],
        contradictions: [],
        residual_risks: [],
        synthesis: "complete",
      }, orcContext(pid));
      expect(JSON.parse(goodRaw).outcome).toBe("accepted");
    });

    it("malformed nested payloads create no decision and no state transition", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const raw = await reviewTool().execute({
        action: "accept",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: "not-an-array",
        outputs: [],
        contradictions: [],
        residual_risks: [],
        synthesis: "t",
      }, orcContext(pid));

      const result = JSON.parse(raw) as { outcome: string };
      expect(result.outcome).toBe("invalid_payload");
      expect(store.getSupervision(pid)!.state).toBe("review_requested");
      expect(store.hasDecisionForCase(caseId)).toBe(false);
      // structurally malformed payloads consume no invalid-proposal budget
      const req = store.db.prepare("SELECT invalid_proposals FROM project_review_requests WHERE review_case_id = ?").get(caseId) as { invalid_proposals: number };
      expect(req.invalid_proposals).toBe(0);
    });

    it("missing required output disposition on accept is an error, not a warning", async () => {
      const pid = uniquePid();
      const { caseId } = await setupCase(pid, makeOrcOnlySnapshot(pid), orcOnlyContract(pid));

      const raw = await reviewTool().execute({
        action: "accept",
        project_card_id: pid,
        project_generation: 1,
        review_case_id: caseId,
        criteria: [
          { criterion_id: "synth1", verdict: "satisfied", evidence_ids: [], rationale: "synthesized" },
          { criterion_id: "synth2", verdict: "satisfied", evidence_ids: [], rationale: "quality ok" },
        ],
        outputs: [],
        contradictions: [],
        residual_risks: [],
        synthesis: "complete",
      }, orcContext(pid));

      const result = JSON.parse(raw) as { outcome: string; issues: Array<{ tag: string }> };
      expect(result.outcome).toBe("invalid");
      expect(result.issues.some(i => i.tag === "missing_field")).toBe(true);
      expect(store.hasDecisionForCase(caseId)).toBe(false);
    });
  });

  describe("typed rejection vocabulary at the tool boundary (#1677)", () => {
    const ERROR_CONTEXT_MISSING_GET = "No active Orc project. get_project_review_case only works during a project review turn.";
    const ERROR_CONTEXT_MISSING_REVIEW = "No active Orc project. review_project only works during a project review turn.";
    const ERROR_SUPERVISION_MISSING = "No project supervision state found. Is this a supervised project?";

    describe("get_project_review_case — all 13 error-envelope branches", () => {
      it("context_missing", async () => {
        const raw = await caseTool().execute({ project_card_id: 1, review_case_id: "x" });
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe(ERROR_CONTEXT_MISSING_GET);
        expect(parsed.reason).toBe("context_missing");
      });

      it("invalid_arguments — missing review_case_id", async () => {
        const pid = uniquePid();
        const raw = await caseTool().execute({ project_card_id: pid }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("review_case_id is required.");
        expect(parsed.reason).toBe("invalid_arguments");
      });

      it("invalid_arguments — non-positive project_card_id", async () => {
        const pid = uniquePid();
        const raw = await caseTool().execute({ project_card_id: "abc", review_case_id: "x" }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("project_card_id is required and must be a positive integer.");
        expect(parsed.reason).toBe("invalid_arguments");
      });

      it("project_mismatch", async () => {
        const pid = uniquePid();
        const raw = await caseTool().execute({ project_card_id: pid + 100, review_case_id: "x" }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("does not match the bound project");
        expect(parsed.reason).toBe("project_mismatch");
      });

      it("supervision_missing", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { withCase: false, withCard: false });
        // no project_supervision row exists at all
        const pid2 = uniquePid();
        const raw = await caseTool().execute({ project_card_id: pid2, review_case_id: "x" }, orcCtx(pid2));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe(ERROR_SUPERVISION_MISSING);
        expect(parsed.reason).toBe("supervision_missing");
      });

      it("project_generation_mismatch — stale bound generation", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", gen: 1 });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: "x" }, orcCtx(pid, 2));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("Bound project generation 2 is stale; current generation is 1");
        expect(parsed.reason).toBe("project_generation_mismatch");
      });

      it("project_not_reviewable — non-review live state", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "executing" });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: "x" }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe('Project is in state "executing", not ready for review');
        expect(parsed.reason).toBe("project_not_reviewable");
      });

      it("project_terminal — accepted supervision", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "accepted" });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: "x" }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe('Project is in state "accepted", not ready for review');
        expect(parsed.reason).toBe("project_terminal");
      });

      it("review_case_unknown", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", withCase: false });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: "rc_missing" }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe('Review case "rc_missing" not found');
        expect(parsed.reason).toBe("review_case_unknown");
      });

      it("review_case_project_mismatch", async () => {
        const pid = uniquePid();
        const other = uniquePid();
        await setupVariant(pid, { state: "review_ready" });
        const { caseId } = await setupVariant(other, { state: "review_ready" });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId! }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("does not belong to project");
        expect(parsed.reason).toBe("review_case_project_mismatch");
      });

      it("review_case_generation_mismatch", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", gen: 1, caseGen: 2 });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId! }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("Case generation 2 does not match supervision generation 1");
        expect(parsed.reason).toBe("review_case_generation_mismatch");
      });

      it("review_case_not_open", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", caseStatus: "superseded" });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId! }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("not open");
        expect(parsed.reason).toBe("review_case_not_open");
      });

      it("brief race — an unreadable snapshot forwards brief.code, never collapsing to one code", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", garbageSnapshot: true });
        const raw = await caseTool().execute({ project_card_id: pid, review_case_id: caseId! }, orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("review case snapshot is structurally invalid");
        expect(parsed.reason).toBe("review_case_unreadable");
      });

      it("catch — an unclassified throw surfaces internal_error with bounded prose", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", withCase: false, withCard: false });
        const spy = vi.spyOn(ProjectReviewStore.prototype, "getSupervision").mockImplementation(() => { throw new Error("boom"); });
        try {
          const raw = await caseTool().execute({ project_card_id: pid, review_case_id: "rc_missing" }, orcCtx(pid));
          const parsed = JSON.parse(raw) as { error: string; reason: string };
          expect(parsed.error).toContain("get_project_review_case error:");
          expect(parsed.reason).toBe("internal_error");
        } finally {
          spy.mockRestore();
        }
      });
    });

    describe("review_project — all 12 error-envelope branches plus the settlement race", () => {
      it("context_missing", async () => {
        const pid = uniquePid();
        const raw = await reviewTool().execute(acceptDecision(pid, "rc_x"));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe(ERROR_CONTEXT_MISSING_REVIEW);
        expect(parsed.reason).toBe("context_missing");
      });

      it("project_mismatch", async () => {
        const pid = uniquePid();
        const raw = await reviewTool().execute(acceptDecision(pid + 100, "rc_x"), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("does not match the bound project");
        expect(parsed.reason).toBe("project_mismatch");
      });

      it("supervision_missing", async () => {
        const pid = uniquePid();
        const pid2 = uniquePid();
        const raw = await reviewTool().execute(acceptDecision(pid2, "rc_x"), orcCtx(pid2));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe(ERROR_SUPERVISION_MISSING);
        expect(parsed.reason).toBe("supervision_missing");
      });

      it("project_generation_mismatch — stale bound generation", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", gen: 1 });
        const raw = await reviewTool().execute(acceptDecision(pid, "rc_x"), orcCtx(pid, 2));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("Bound project generation 2 is stale; current generation is 1");
        expect(parsed.reason).toBe("project_generation_mismatch");
      });

      it("project_generation_mismatch — declared generation differs from supervision", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", gen: 1 });
        const decision = acceptDecision(pid, caseId!) as { project_generation: number };
        decision.project_generation = 2;
        const raw = await reviewTool().execute(decision, orcCtx(pid, 1));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("Project generation mismatch: expected 1, got 2");
        expect(parsed.reason).toBe("project_generation_mismatch");
      });

      it("project_not_reviewable — non-review live state", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "executing" });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe('Project is in state "executing", not ready for review');
        expect(parsed.reason).toBe("project_not_reviewable");
      });

      it("review_case_unknown", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", withCase: false });
        const raw = await reviewTool().execute(acceptDecision(pid, "rc_missing"), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe('Review case "rc_missing" not found');
        expect(parsed.reason).toBe("review_case_unknown");
      });

      it("review_case_project_mismatch", async () => {
        const pid = uniquePid();
        const other = uniquePid();
        await setupVariant(pid, { state: "review_ready" });
        const { caseId } = await setupVariant(other, { state: "review_ready" });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("does not belong to project");
        expect(parsed.reason).toBe("review_case_project_mismatch");
      });

      it("review_case_generation_mismatch", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", gen: 1, caseGen: 2 });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("does not match supervision generation");
        expect(parsed.reason).toBe("review_case_generation_mismatch");
      });

      it("review_case_not_open", async () => {
        const pid = uniquePid();
        const { caseId } = await setupVariant(pid, { state: "review_ready", caseStatus: "superseded" });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("not open");
        expect(parsed.reason).toBe("review_case_not_open");
      });

      it("review_ownership_stale — lost review_requested -> reviewing CAS", async () => {
        const pid = uniquePid();
        // A scheduled root whose task_runs row does not exist makes the
        // transition's authority check fail (run_mismatch) after the preflight
        // passed — the ownership-stale race, deterministically.
        store.db.exec(`CREATE TABLE IF NOT EXISTS task_runs (run_id TEXT PRIMARY KEY, finished_at INTEGER, outcome TEXT)`);
        const { caseId } = await setupVariant(pid, {
          state: "review_requested",
          cardSource: "task",
          cardSourceId: "run_missing",
        });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toBe("project mutation rejected: review ownership is stale");
        expect(parsed.reason).toBe("review_ownership_stale");
      });

      it("store ProjectMutationRejectedError race — lost kanban settlement surfaces its typed code", async () => {
        const pid = uniquePid();
        // The preflight passes (open case, review_ready) but the card is
        // already terminal, so settlement loses its durable kanban CAS inside
        // processDecision and must surface the typed code, not internal_error.
        const { caseId } = await setupVariant(pid, { state: "review_ready", cardStatus: "done" });
        const raw = await reviewTool().execute(acceptDecision(pid, caseId!), orcCtx(pid));
        const parsed = JSON.parse(raw) as { error: string; reason: string };
        expect(parsed.error).toContain("kanban settlement lost: observed done");
        expect(parsed.reason).toBe("settlement_lost");
      });

      it("catch — an unclassified throw surfaces internal_error with bounded prose", async () => {
        const pid = uniquePid();
        await setupVariant(pid, { state: "review_ready", withCase: false, withCard: false });
        const spy = vi.spyOn(ProjectReviewStore.prototype, "getSupervision").mockImplementation(() => { throw new Error("boom"); });
        try {
          const raw = await reviewTool().execute(acceptDecision(pid, "rc_missing"), orcCtx(pid));
          const parsed = JSON.parse(raw) as { error: string; reason: string };
          expect(parsed.error).toContain("review_project error:");
          expect(parsed.reason).toBe("internal_error");
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});
