import { requireTaskDatabase, kanbanTransition, sqliteNow, type TaskDatabase } from "../tasks/kanban-board.js";
import type { ProjectAcceptanceContract } from "./project-contract.js";
import { logSwarmTrace } from "../swarm-trace.js";

// ── Project supervision states ────────────────────────────────────────────────

export type ProjectState =
  | "awaiting_contract"
  | "executing"
  | "review_ready"
  | "review_requested"
  | "reviewing"
  | "repair_planned"
  | "repairing"
  | "needs_input"
  | "blocked"
  | "accepted";

export const VALID_PROJECT_STATES: readonly ProjectState[] = [
  "awaiting_contract", "executing", "review_ready", "review_requested", "reviewing",
  "repair_planned", "repairing", "needs_input", "blocked", "accepted",
];

export const TERMINAL_PROJECT_STATES: readonly ProjectState[] = ["blocked", "accepted"];

// ── Case status ───────────────────────────────────────────────────────────────

export type ReviewCaseStatus = "open" | "superseded" | "accepted";

// ── Row types ─────────────────────────────────────────────────────────────────

export interface ProjectContractRow {
  id: string;
  project_card_id: number;
  contract_json: string;
  contract_digest: string;
  created_at: string;
}

export interface ProjectSupervisionRow {
  project_card_id: number;
  contract_id: string;
  state: ProjectState;
  generation: number;
  review_round: number;
  repair_round: number;
  active_review_case_id: string | null;
  accepted_decision_id: string | null;
  blocked_reason: string | null;
  /** #1604: coverage evaluation lifecycle. NULL = never evaluated (unknown). */
  coverage_rounds: number;
  coverage_signature: string | null;
  coverage_uncovered_ids: string | null;
  updated_at: string;
}

export interface ReviewCaseRow {
  id: string;
  project_card_id: number;
  generation: number;
  round: number;
  snapshot_digest: string;
  case_json: string;
  status: ReviewCaseStatus;
  created_at: string;
  superseded_at: string | null;
}

/** Bounded review facts shared by the Orc and task-list visibility surfaces. */
export function summarizeReviewCase(row: ReviewCaseRow | undefined): string {
  if (!row) return "";
  try {
    const snapshot = JSON.parse(row.case_json) as {
      root_contract?: { criteria?: unknown[] };
      criterion_inputs?: Array<{ criterion_id?: string; coverage_hint?: string; retry_lineage_ids?: unknown[]; required?: boolean; execution_owner?: string }>;
      uncovered_criteria?: unknown[];
      contradiction_candidates?: unknown[];
      child_summaries?: Array<{ attempts?: number }>;
      budgets?: { total_cost?: number; total_tokens?: number };
    };
    const inputs = snapshot.criterion_inputs ?? [];
    const totalCriteria = snapshot.root_contract?.criteria?.length ?? 0;
    const coveredCriteria = inputs.filter(i => i.coverage_hint === "supported").length;
    // #1605: surface the policy split the Orc must honor in review — hard vs
    // optional criteria and which criteria are Orc-owned.
    const orcOwned = inputs.filter(i => i.coverage_hint === "orc_owned").length;
    const optional = inputs.filter(i => i.required === false).length;
    const gaps = snapshot.uncovered_criteria?.length ?? 0;
    // #1605 Task 5: name the gaps and mark each optional vs hard so the Orc
    // sees what it may consciously omit vs what must be satisfied/repaired.
    const gapIds = (snapshot.uncovered_criteria ?? []) as string[];
    const gapDetail = gapIds.length > 0
      ? " gap-ids:" + gapIds.map(id => {
          const input = inputs.find(i => i.criterion_id === id);
          return input?.required === false ? `${id}(optional)` : id;
        }).join(",")
      : "";
    const contradictions = snapshot.contradiction_candidates?.length ?? 0;
    const lineage = inputs.reduce((n, i) => n + (i.retry_lineage_ids?.length ?? 0), 0)
      + (snapshot.child_summaries ?? []).filter(c => (c.attempts ?? 0) > 1).length;
    const cost = snapshot.budgets?.total_cost === undefined ? "?" : String(snapshot.budgets.total_cost);
    const tokens = snapshot.budgets?.total_tokens === undefined ? "?" : String(snapshot.budgets.total_tokens);
    const policy = orcOwned > 0 || optional > 0 ? ` orc-owned:${orcOwned} optional:${optional}` : "";
    return ` coverage:${coveredCriteria}/${totalCriteria} gaps:${gaps}${gapDetail} contradictions:${contradictions} lineage:${lineage} cost:${cost} tokens:${tokens}${policy}`;
  } catch {
    return " review:unavailable";
  }
}

export interface ReviewDecisionRow {
  id: string;
  review_case_id: string;
  decision_json: string;
  decision_digest: string;
  created_at: string;
}

export type InvalidProposalRecord =
  | { kind: "counted"; total: number; requestId: string }
  | { kind: "blocked"; total: number; requestId: string; decisionId: string }
  | { kind: "ignored"; total: number; requestId: string };

// ── Action types (used by Kanban projection) ──────────────────────────────────

export type KanbanProjection = "running" | "failed" | "done";

export function projectStateToKanban(state: ProjectState): KanbanProjection {
  switch (state) {
    case "blocked": return "failed";
    case "accepted": return "done";
    default: return "running";
  }
}

export function initializeProjectSupervision(store: ProjectReviewStore, projectCardId: number, contractId: string): void {
  store.db.prepare(`
    INSERT OR REPLACE INTO project_supervision (project_card_id, contract_id, state, updated_at)
    VALUES (?, ?, 'awaiting_contract', ?)
  `).run(projectCardId, contractId, new Date().toISOString());
}

// ── Store ─────────────────────────────────────────────────────────────────────

export class ProjectReviewStore {
  readonly db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    const db = this.db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_contracts (
        id TEXT PRIMARY KEY,
        project_card_id INTEGER UNIQUE NOT NULL,
        contract_json TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_supervision (
        project_card_id INTEGER PRIMARY KEY,
        contract_id TEXT UNIQUE NOT NULL,
        state TEXT NOT NULL DEFAULT 'awaiting_contract' CHECK(state IN ('awaiting_contract','executing','review_ready','review_requested','reviewing','repair_planned','repairing','needs_input','blocked','accepted')),
        invalid_contract_proposals INTEGER NOT NULL DEFAULT 0,
        generation INTEGER NOT NULL DEFAULT 1,
        review_round INTEGER NOT NULL DEFAULT 0,
        repair_round INTEGER NOT NULL DEFAULT 0,
        active_review_case_id TEXT,
        accepted_decision_id TEXT,
        blocked_reason TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_review_requests (
        id TEXT PRIMARY KEY,
        project_card_id INTEGER NOT NULL,
        review_case_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','dispatched','settled','abandoned')),
        attempts INTEGER NOT NULL DEFAULT 0,
        invalid_proposals INTEGER NOT NULL DEFAULT 0,
        deadline_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(review_case_id)
      );

      CREATE TABLE IF NOT EXISTS project_acceptance_outbox (
        id TEXT PRIMARY KEY,
        project_card_id INTEGER NOT NULL,
        peer TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        UNIQUE(project_card_id)
      );

      CREATE TABLE IF NOT EXISTS project_input_requests (
        id TEXT PRIMARY KEY,
        project_card_id INTEGER NOT NULL,
        review_case_id TEXT NOT NULL,
        question TEXT NOT NULL,
        affected_criterion_ids TEXT NOT NULL,
        expected_response_kind TEXT NOT NULL DEFAULT 'text',
        context TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','answered','expired')),
        created_at TEXT NOT NULL,
        answered_at TEXT,
        response_text TEXT
      );

      CREATE TABLE IF NOT EXISTS project_review_cases (
        id TEXT PRIMARY KEY,
        project_card_id INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        round INTEGER NOT NULL,
        snapshot_digest TEXT NOT NULL,
        case_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','superseded','accepted')),
        created_at TEXT NOT NULL,
        superseded_at TEXT,
        UNIQUE(project_card_id, generation, round)
      );

      CREATE TABLE IF NOT EXISTS project_review_decisions (
        id TEXT PRIMARY KEY,
        review_case_id TEXT UNIQUE NOT NULL,
        decision_json TEXT NOT NULL,
        decision_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    // #1604: additive coverage-evaluation columns. The catch is deliberate:
    // ALTER TABLE fails when the column already exists on a re-migrated DB.
    try { db.exec(`ALTER TABLE project_supervision ADD COLUMN coverage_rounds INTEGER NOT NULL DEFAULT 0`); } catch { /* column already present */ }
    try { db.exec(`ALTER TABLE project_supervision ADD COLUMN coverage_signature TEXT`); } catch { /* column already present */ }
    try { db.exec(`ALTER TABLE project_supervision ADD COLUMN coverage_uncovered_ids TEXT`); } catch { /* column already present */ }
  }

  // ── Root contracts ────────────────────────────────────────────────────

  insertContract(contract: ProjectAcceptanceContract): void {
    this.db.prepare(`
      INSERT INTO project_contracts (id, project_card_id, contract_json, contract_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(contract.id, contract.project_card_id, JSON.stringify(contract), contract.digest, new Date().toISOString());
  }

  getContract(contractId: string): ProjectContractRow | undefined {
    return this.db.prepare(`SELECT * FROM project_contracts WHERE id = ?`).get(contractId) as ProjectContractRow | undefined;
  }

  getContractByProjectCardId(projectCardId: number): ProjectContractRow | undefined {
    return this.db.prepare(`SELECT * FROM project_contracts WHERE project_card_id = ?`).get(projectCardId) as ProjectContractRow | undefined;
  }

  contractExists(projectCardId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM project_contracts WHERE project_card_id = ?`).get(projectCardId);
    return row !== undefined;
  }

  // ── Supervision state ─────────────────────────────────────────────────

  initializeSupervision(projectCardId: number, contractId: string, initialState: ProjectState = "executing"): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO project_supervision (project_card_id, contract_id, state, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(projectCardId, contractId, initialState, new Date().toISOString());
  }

  /** Create the durable admission state before the first Orc authoring turn.
   *  The placeholder contract id is unique per project so concurrent admissions
   *  cannot collide on the UNIQUE(contract_id) constraint (#1618). */
  ensureAwaitingContract(projectCardId: number): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO project_supervision (project_card_id, contract_id, state, updated_at)
      VALUES (?, ?, 'awaiting_contract', ?)
    `).run(projectCardId, `awaiting:${projectCardId}`, new Date().toISOString());
    return result.changes > 0;
  }

  getSupervision(projectCardId: number): ProjectSupervisionRow | undefined {
    return this.db.prepare(`SELECT * FROM project_supervision WHERE project_card_id = ?`).get(projectCardId) as ProjectSupervisionRow | undefined;
  }

  stateTransition(
    projectCardId: number,
    fromStates: readonly ProjectState[],
    toState: ProjectState,
    extraSets?: Record<string, string | number | null>,
  ): boolean {
    const sets = ["state = ?", "updated_at = ?"];
    const vals: unknown[] = [toState, new Date().toISOString()];
    if (extraSets) {
      for (const [k, v] of Object.entries(extraSets)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    vals.push(projectCardId);
    const placeholders = fromStates.map(() => "?").join(",");
    const sql = `UPDATE project_supervision SET ${sets.join(", ")} WHERE project_card_id = ? AND state IN (${placeholders})`;
    const result = this.db.prepare(sql).run(...vals, ...fromStates);
    return result.changes > 0;
  }

  setState(projectCardId: number, state: ProjectState, extraSets?: Record<string, string | number | null>): boolean {
    const sets = ["state = ?", "updated_at = ?"];
    const vals: unknown[] = [state, new Date().toISOString()];
    if (extraSets) {
      for (const [k, v] of Object.entries(extraSets)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    vals.push(projectCardId);
    const sql = `UPDATE project_supervision SET ${sets.join(", ")} WHERE project_card_id = ?`;
    const result = this.db.prepare(sql).run(...vals);
    return result.changes > 0;
  }

  incrementGeneration(projectCardId: number): boolean {
    const sql = `UPDATE project_supervision SET generation = generation + 1, updated_at = ? WHERE project_card_id = ?`;
    const result = this.db.prepare(sql).run(new Date().toISOString(), projectCardId);
    return result.changes > 0;
  }

  isTerminal(projectCardId: number): boolean {
    const row = this.db.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(projectCardId) as { state: ProjectState } | undefined;
    if (!row) return false;
    return TERMINAL_PROJECT_STATES.includes(row.state);
  }

  /**
   * #1546: shared active-project-supervision predicate. True only when a
   * `project_supervision` row exists and is not terminal (`accepted`/`blocked`).
   * A terminal supervision row is not an active owner and must never be
   * restarted. Fails closed on store unavailability, matching the legacy drain.
   */
  hasActiveProjectSupervision(projectCardId: number): boolean {
    try {
      const row = this.db.prepare(`SELECT state FROM project_supervision WHERE project_card_id = ?`).get(projectCardId) as { state: string } | undefined;
      if (!row) return false;
      return row.state !== "accepted" && row.state !== "blocked";
    } catch {
      return false;
    }
  }

  // ── #1604 coverage rounds ──────────────────────────────────────────────

  /**
   * CAS: claim one coverage round. Returns false when another wake already
   * claimed this exact signature, the row left `executing`, or the ceiling is
   * reached. The signature pin plus `state = 'executing'` make concurrent
   * wakes single-claimant.
   */
  claimCoverageRound(
    projectCardId: number,
    signature: string,
    uncoveredIds: readonly string[],
    maxRounds: number,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE project_supervision
         SET coverage_signature = ?, coverage_uncovered_ids = ?,
             coverage_rounds = coverage_rounds + 1, updated_at = ?
       WHERE project_card_id = ? AND state = 'executing'
         AND (coverage_signature IS NULL OR coverage_signature != ?)
         AND coverage_rounds < ?
    `).run(signature, JSON.stringify(uncoveredIds), new Date().toISOString(), projectCardId, signature, maxRounds);
    return result.changes === 1;
  }

  /** Record a clean coverage evaluation before the review_ready transition. */
  recordCoverageClear(projectCardId: number, signature: string): void {
    this.db.prepare(`
      UPDATE project_supervision
         SET coverage_uncovered_ids = '[]', coverage_signature = ?, updated_at = ?
       WHERE project_card_id = ?
    `).run(signature, new Date().toISOString(), projectCardId);
  }

  /**
   * #1605: persist a normal post-remediation coverage gap before the
   * executing → review_ready transition. State-CAS: only an `executing` row
   * is updated and the signature is pinned, so a concurrent wake that already
   * claimed the same signature (or transitioned the project) cannot double
   * write. The signature predicate prevents a stale grace/cap evaluation from
   * overwriting a newer coverage read. No coverage round is incremented — the
   * cap is a loop/idempotency guard, not acceptance policy.
   */
  recordCoverageReviewable(
    projectCardId: number,
    signature: string,
    uncoveredIds: readonly string[],
  ): boolean {
    const result = this.db.prepare(`
      UPDATE project_supervision
       SET coverage_signature = ?, coverage_uncovered_ids = ?, updated_at = ?
       WHERE project_card_id = ? AND state = 'executing'
         AND (coverage_signature = ? OR coverage_signature IS NULL)
    `).run(signature, JSON.stringify(uncoveredIds), new Date().toISOString(), projectCardId, signature);
    return result.changes === 1;
  }

  // ── Review requests ────────────────────────────────────────────────────

  insertReviewRequest(projectCardId: number, reviewCaseId: string, generation: number, deadlineAt?: string): { id: string } {
    const id = `rr_${projectCardId}_${Date.now()}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO project_review_requests (id, project_card_id, review_case_id, generation, deadline_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectCardId, reviewCaseId, generation, deadlineAt ?? null, now, now);
    return { id };
  }

  /** #1363 Task 6: requests that need dispatch — pending, under max attempts, and not recently retried */
  getPendingReviewRequests(maxAttempts = 5, retryCooldownMs = 30_000): Array<{ id: string; project_card_id: number; review_case_id: string; generation: number; attempts: number; deadline_at: string | null }> {
    const cooldown = new Date(Date.now() - retryCooldownMs).toISOString();
    return this.db.prepare(`
      SELECT id, project_card_id, review_case_id, generation, attempts, deadline_at
      FROM project_review_requests
      WHERE status = 'pending' AND attempts < ? AND updated_at < ?
      ORDER BY created_at ASC
    `).all(maxAttempts, cooldown) as Array<{ id: string; project_card_id: number; review_case_id: string; generation: number; attempts: number; deadline_at: string | null }>;
  }

  /** Bump attempt counter but keep status pending — allows retry after cooldown */
  bumpReviewRequestAttempt(requestId: string): boolean {
    const result = this.db.prepare(`
      UPDATE project_review_requests SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), requestId);
    return result.changes > 0;
  }

  abandonExpiredRequests(maxAttempts = 5): number {
    const now = new Date().toISOString();
    // Abandon requests that exceeded max attempts or passed deadline
    const exceededAttempts = this.db.prepare(`
      UPDATE project_review_requests SET status = 'abandoned', updated_at = ?, last_error = 'exceeded max attempts'
      WHERE status IN ('pending','dispatched') AND attempts >= ?
    `).run(now, maxAttempts);
    const expired = this.db.prepare(`
      UPDATE project_review_requests SET status = 'abandoned', updated_at = ?, last_error = 'deadline passed'
      WHERE status IN ('pending','dispatched') AND deadline_at IS NOT NULL AND deadline_at < ?
    `).run(now, now);
    return exceededAttempts.changes + expired.changes;
  }

  markReviewRequestDispatched(requestId: string): boolean {
    const result = this.db.prepare(`
      UPDATE project_review_requests SET status = 'dispatched', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'
    `).run(new Date().toISOString(), requestId);
    return result.changes > 0;
  }

  markReviewRequestSettled(requestId: string): boolean {
    const result = this.db.prepare(`
      UPDATE project_review_requests SET status = 'settled', updated_at = ? WHERE id = ? AND status IN ('pending','dispatched')
    `).run(new Date().toISOString(), requestId);
    return result.changes > 0;
  }

  /**
   * #1620: retain the old counter helper for callers that only need to record
   * an invalid proposal. The review service uses recordInvalidProposal below so
   * the fifth increment and terminal settlement share one SQLite transaction.
   */
  incrementInvalidProposals(caseId: string): { total: number; requestId: string; settled: boolean } {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE project_review_requests
           SET invalid_proposals = invalid_proposals + 1, updated_at = ?
         WHERE review_case_id = ? AND status IN ('pending','dispatched')
      `).run(now, caseId);
      if (result.changes !== 1) {
        return { total: 0, requestId: "", settled: true };
      }
      const row = this.db.prepare(`SELECT id, invalid_proposals FROM project_review_requests WHERE review_case_id = ?`).get(caseId) as { id: string; invalid_proposals: number } | undefined;
      if (!row) return { total: 0, requestId: "", settled: true };
      return { total: row.invalid_proposals, requestId: row.id, settled: false };
    });
  }

  /**
   * Record one semantic validation error and, when it is the fifth error,
   * settle the review as protocol-exhausted in the same transaction. The
   * request and case ownership predicates prevent a foreign/stale decision
   * from consuming another project's budget. SQLite serializes competing
   * calls, so only the transaction that changes the count to the threshold
   * can create the terminal decision and outbox row.
   */
  recordInvalidProposal(
    cardId: number,
    reviewCaseId: string,
    maxInvalidProposals: number,
    decision: unknown,
    blockerClass: string,
    peerEvent: { peer: string; payload: unknown } | undefined,
    decisionId: string,
  ): InvalidProposalRecord {
    const result = this.db.transaction((): InvalidProposalRecord => {
      const request = this.db.prepare(`
        SELECT id, project_card_id, invalid_proposals, status
        FROM project_review_requests WHERE review_case_id = ?
      `).get(reviewCaseId) as { id: string; project_card_id: number; invalid_proposals: number; status: string } | undefined;
      const reviewCase = this.db.prepare(`
        SELECT project_card_id, status FROM project_review_cases WHERE id = ?
      `).get(reviewCaseId) as { project_card_id: number; status: ReviewCaseStatus } | undefined;

      if (!request || !reviewCase || request.project_card_id !== cardId || reviewCase.project_card_id !== cardId ||
          (request.status !== "pending" && request.status !== "dispatched") || reviewCase.status !== "open") {
        return { kind: "ignored", total: request?.invalid_proposals ?? 0, requestId: request?.id ?? "" };
      }

      const now = new Date().toISOString();
      if (request.invalid_proposals >= maxInvalidProposals) {
        this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, decisionId, now);
        return { kind: "blocked", total: request.invalid_proposals, requestId: request.id, decisionId };
      }
      const incremented = this.db.prepare(`
        UPDATE project_review_requests
           SET invalid_proposals = invalid_proposals + 1, updated_at = ?
         WHERE id = ? AND project_card_id = ? AND status IN ('pending','dispatched')
           AND invalid_proposals < ?
      `).run(now, request.id, cardId, maxInvalidProposals);
      if (incremented.changes !== 1) {
        const current = this.db.prepare(`SELECT invalid_proposals FROM project_review_requests WHERE id = ?`).get(request.id) as { invalid_proposals: number } | undefined;
        return { kind: "ignored", total: current?.invalid_proposals ?? request.invalid_proposals, requestId: request.id };
      }

      const updated = this.db.prepare(`SELECT invalid_proposals FROM project_review_requests WHERE id = ?`).get(request.id) as { invalid_proposals: number };
      if (updated.invalid_proposals < maxInvalidProposals) {
        return { kind: "counted", total: updated.invalid_proposals, requestId: request.id };
      }

      this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, decisionId, now);
      return { kind: "blocked", total: updated.invalid_proposals, requestId: request.id, decisionId };
    });

    if (result.kind === "blocked") {
      logSwarmTrace({ event: "project_blocked", project: cardId, reviewCase: reviewCaseId, decision: result.decisionId, reason: blockerClass });
    }
    return result;
  }

  getReviewRequestByCaseId(reviewCaseId: string): { id: string; status: string } | undefined {
    return this.db.prepare(`SELECT id, status FROM project_review_requests WHERE review_case_id = ?`).get(reviewCaseId) as { id: string; status: string } | undefined;
  }

  getPendingAcceptanceOutbox(limit = 20): Array<{ id: string; project_card_id: number; peer: string; payload_json: string; attempts: number }> {
    return this.db.prepare(`
      SELECT id, project_card_id, peer, payload_json, attempts
      FROM project_acceptance_outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT ?
    `).all(limit) as Array<{ id: string; project_card_id: number; peer: string; payload_json: string; attempts: number }>;
  }

  markAcceptanceOutboxSent(id: string): boolean {
    const result = this.db.prepare(`
      UPDATE project_acceptance_outbox SET sent_at = ?, updated_at = ? WHERE id = ? AND sent_at IS NULL
    `).run(new Date().toISOString(), new Date().toISOString(), id);
    return result.changes > 0;
  }

  markAcceptanceOutboxAttempt(id: string, error: string): void {
    this.db.prepare(`
      UPDATE project_acceptance_outbox SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ? AND sent_at IS NULL
    `).run(error.slice(0, 1000), new Date().toISOString(), id);
  }

  // ── Input requests ────────────────────────────────────────────────────

  insertInputRequest(
    projectCardId: number,
    reviewCaseId: string,
    question: string,
    affectedCriterionIds: string[],
    expectedResponseKind: string,
    context?: string,
  ): { id: string } {
    const id = `ir_${projectCardId}_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO project_input_requests (id, project_card_id, review_case_id, question, affected_criterion_ids, expected_response_kind, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectCardId, reviewCaseId, question, JSON.stringify(affectedCriterionIds), expectedResponseKind, context ?? null, new Date().toISOString());
    return { id };
  }

  getAnsweredInputRequests(projectCardId: number): Array<{ id: string; question: string; response_text: string }> {
    return this.db.prepare(`
      SELECT id, question, response_text FROM project_input_requests WHERE project_card_id = ? AND status = 'answered' ORDER BY answered_at ASC
    `).all(projectCardId) as Array<{ id: string; question: string; response_text: string }>;
  }

  getPendingInputRequestsForProject(projectCardId: number): Array<{ id: string; project_card_id: number; question: string; expected_response_kind: string; created_at: string }> {
    return this.db.prepare(`
      SELECT id, project_card_id, question, expected_response_kind, created_at FROM project_input_requests WHERE project_card_id = ? AND status = 'pending' ORDER BY created_at ASC
    `).all(projectCardId) as Array<{ id: string; project_card_id: number; question: string; expected_response_kind: string; created_at: string }>;
  }

  getPendingInputRequests(): Array<{ id: string; project_card_id: number; question: string; created_at: string }> {
    return this.db.prepare(`
      SELECT id, project_card_id, question, created_at FROM project_input_requests WHERE status = 'pending' ORDER BY created_at ASC
    `).all() as Array<{ id: string; project_card_id: number; question: string; created_at: string }>;
  }

  answerInputRequest(requestId: string, responseText: string): boolean {
    const result = this.db.prepare(`
      UPDATE project_input_requests SET status = 'answered', response_text = ?, answered_at = ? WHERE id = ? AND status = 'pending'
    `).run(responseText, new Date().toISOString(), requestId);
    return result.changes > 0;
  }

  setInputNotice(projectCardId: number, question: string): void {
    this.db.prepare(`
      UPDATE kanban_board SET error = ?, updated_at = datetime('now') WHERE id = ?
    `).run(`needs_input: ${question}`.slice(0, 1000), projectCardId);
  }

  clearInputNotice(projectCardId: number): void {
    this.db.prepare(`
      UPDATE kanban_board SET error = NULL, updated_at = datetime('now')
      WHERE id = ? AND error LIKE 'needs_input:%'
    `).run(projectCardId);
  }

  // ── Review cases ──────────────────────────────────────────────────────

  insertReviewCase(projectCardId: number, generation: number, round: number, snapshot: unknown, snapshotDigest: string): { id: string } {
    const id = `rc_${projectCardId}_${generation}_${round}_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO project_review_cases (id, project_card_id, generation, round, snapshot_digest, case_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectCardId, generation, round, snapshotDigest, JSON.stringify(snapshot), new Date().toISOString());
    return { id };
  }

  getReviewCase(caseId: string): ReviewCaseRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_cases WHERE id = ?`).get(caseId) as ReviewCaseRow | undefined;
  }

  getLatestOpenCase(projectCardId: number): ReviewCaseRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_cases WHERE project_card_id = ? AND status = 'open' ORDER BY round DESC LIMIT 1`).get(projectCardId) as ReviewCaseRow | undefined;
  }

  getLatestReviewCase(projectCardId: number): ReviewCaseRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_cases WHERE project_card_id = ? ORDER BY round DESC, created_at DESC LIMIT 1`).get(projectCardId) as ReviewCaseRow | undefined;
  }

  getCasesForProject(projectCardId: number): ReviewCaseRow[] {
    return this.db.prepare(`SELECT * FROM project_review_cases WHERE project_card_id = ? ORDER BY round ASC`).all(projectCardId) as unknown as ReviewCaseRow[];
  }

  supersedeCase(caseId: string): boolean {
    const result = this.db.prepare(`UPDATE project_review_cases SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'open'`).run(new Date().toISOString(), caseId);
    return result.changes > 0;
  }

  // ── Review decisions ──────────────────────────────────────────────────

  insertDecision(reviewCaseId: string, decision: unknown, decisionDigest: string): { id: string } {
    const id = `rd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, reviewCaseId, JSON.stringify(decision), decisionDigest, new Date().toISOString());
    return { id };
  }

  /**
   * Atomically settle an accepted decision: persist decision, set supervision to
   * accepted, and update kanban card to done — all in one transaction.
   * Returns the decision ID. Caller must fire nerve events after commit.
   */
  settleAcceptance(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    synthesis: string,
    peerEvent?: { peer: string; payload: unknown },
    acceptanceId?: string,
  ): { decisionId: string } {
    const decisionId = acceptanceId ?? `rd_settle_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_${cardId}_${reviewCaseId}_${Date.now()}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      // Insert decision
      this.db.prepare(`
        INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decisionId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

      // Set supervision to accepted only while the project is live. An abort
      // freezes it in blocked state before cancelling executors, so a late Orc
      // result cannot reverse a terminal scheduled outcome.
      const state = this.db.prepare(`
        UPDATE project_supervision SET state = 'accepted', accepted_decision_id = ?, updated_at = ?
        WHERE project_card_id = ? AND state NOT IN ('accepted', 'blocked')
      `).run(decisionId, now, cardId);
      if (state.changes !== 1) throw new Error(`project ${cardId} is already terminal`);

      // Update kanban card via projectStateToKanban mapping — #1590: through
      // the transition helper inside this transaction. The service layer fires
      // card:done after commit, so emit is disabled here.
      kanbanTransition({
        cardId,
        from: ["running"],
        to: projectStateToKanban("accepted"),
        actor: "project_acceptance",
        reason: "project accepted",
        fields: { result_summary: synthesis.slice(0, 4000), completed_at: sqliteNow() },
        emit: false,
      }, this.db);

      // Close the case and request in the same transaction as acceptance. If
      // settlement fails, the open case remains retryable instead of being
      // left superseded with no accepted decision.
      this.db.prepare(`
        UPDATE project_review_cases SET status = 'accepted' WHERE id = ? AND status = 'open'
      `).run(reviewCaseId);
      this.db.prepare(`
        UPDATE project_review_requests SET status = 'settled', updated_at = ?
        WHERE review_case_id = ? AND status IN ('pending', 'dispatched')
      `).run(now, reviewCaseId);

      if (peerEvent) {
        const payload = peerEvent.payload && typeof peerEvent.payload === "object"
          ? { ...(peerEvent.payload as Record<string, unknown>), acceptance_id: decisionId }
          : peerEvent.payload;
        this.db.prepare(`
          INSERT OR IGNORE INTO project_acceptance_outbox
            (id, project_card_id, peer, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(`ao_${decisionId}`, cardId, peerEvent.peer, JSON.stringify(payload), now, now);
      }
    });

    logSwarmTrace({ event: "project_accepted", project: cardId, reviewCase: reviewCaseId, decision: decisionId, reason: "settle_acceptance" });

    return { decisionId };
  }

  /**
   * Atomically settle a blocked decision: persist decision, set supervision to blocked,
   * and update kanban card to failed.
   */
  settleBlocked(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    blockerClass: string,
    peerEvent?: { peer: string; payload: unknown },
    decisionId?: string,
  ): { decisionId: string } {
    const settledId = decisionId ?? `rd_block_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db.transaction(() => this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, settledId, now));

    logSwarmTrace({ event: "project_blocked", project: cardId, reviewCase: reviewCaseId, decision: settledId, reason: blockerClass });

    return { decisionId: settledId };
  }

  private settleBlockedInTransaction(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    blockerClass: string,
    peerEvent: { peer: string; payload: unknown } | undefined,
    settledId: string,
    now: string,
  ): void {
    const decisionDigest = `sd_blk_${cardId}_${reviewCaseId}_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(settledId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

    const state = this.db.prepare(`
      UPDATE project_supervision SET state = 'blocked', blocked_reason = ?, accepted_decision_id = ?, updated_at = ?
      WHERE project_card_id = ? AND state NOT IN ('accepted', 'blocked')
    `).run(blockerClass, settledId, now, cardId);
    if (state.changes !== 1) throw new Error(`project ${cardId} is already terminal`);

    // #1590: through the transition helper inside this transaction. The
    // service layer fires card:failed after commit, so emit is disabled.
    kanbanTransition({
      cardId,
      from: ["running"],
      to: projectStateToKanban("blocked"),
      actor: "project_acceptance",
      reason: "project blocked",
      fields: { error: `blocked: ${blockerClass}`.slice(0, 1000), completed_at: sqliteNow() },
      emit: false,
    }, this.db);

    this.db.prepare(`
      UPDATE project_review_cases SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'open'
    `).run(now, reviewCaseId);
    this.db.prepare(`
      UPDATE project_review_requests SET status = 'settled', updated_at = ?
      WHERE review_case_id = ? AND status IN ('pending', 'dispatched')
    `).run(now, reviewCaseId);

    // #1618: a failed terminal event row lands in the same transaction that
    // wins the blocked settlement — duplicate settlement cannot create a
    // second row (outbox is UNIQUE per project_card_id).
    if (peerEvent) {
      const payload = peerEvent.payload && typeof peerEvent.payload === "object"
        ? { ...(peerEvent.payload as Record<string, unknown>), acceptance_id: settledId }
        : peerEvent.payload;
      this.db.prepare(`
        INSERT OR IGNORE INTO project_acceptance_outbox
          (id, project_card_id, peer, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ao_${settledId}`, cardId, peerEvent.peer, JSON.stringify(payload), now, now);
    }
  }

  /** Atomically persist a repair decision, advance its generation, and close the review turn. */
  settleRepair(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    expectedGeneration: number,
    additionalTokens: number,
  ): { decisionId: string } {
    const decisionId = `rd_repair_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_repair_${cardId}_${reviewCaseId}_${Date.now()}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decisionId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

      const state = this.db.prepare(`
        UPDATE project_supervision
        SET state = 'repair_planned', generation = generation + 1, updated_at = ?
        WHERE project_card_id = ? AND generation = ? AND state IN ('review_ready', 'review_requested', 'reviewing')
      `).run(now, cardId, expectedGeneration);
      if (state.changes !== 1) throw new Error(`stale or already-settled repair for project ${cardId}`);

      if (additionalTokens > 0) {
        this.db.prepare(`
          UPDATE kanban_board SET max_tokens = COALESCE(max_tokens, 0) + ?, updated_at = datetime('now') WHERE id = ?
        `).run(additionalTokens, cardId);
      }

      this.db.prepare(`
        UPDATE project_review_cases SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'open'
      `).run(now, reviewCaseId);
      this.db.prepare(`
        UPDATE project_review_requests SET status = 'settled', updated_at = ?
        WHERE review_case_id = ? AND status IN ('pending', 'dispatched')
      `).run(now, reviewCaseId);
    });

    return { decisionId };
  }

  /** Atomically persist a needs-input decision, publish its local notice, and close the review turn. */
  settleNeedsInput(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    input: {
      question: string;
      affectedCriterionIds: string[];
      expectedResponseKind: string;
      context?: string;
    },
  ): { decisionId: string } {
    const decisionId = `rd_input_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_input_${cardId}_${reviewCaseId}_${Date.now()}`;
    const inputId = `ir_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decisionId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

      const state = this.db.prepare(`
        UPDATE project_supervision SET state = 'needs_input', active_review_case_id = ?, updated_at = ?
        WHERE project_card_id = ? AND state IN ('review_ready', 'review_requested', 'reviewing')
      `).run(reviewCaseId, now, cardId);
      if (state.changes !== 1) throw new Error(`stale or already-settled input request for project ${cardId}`);

      this.db.prepare(`
        INSERT INTO project_input_requests
          (id, project_card_id, review_case_id, question, affected_criterion_ids, expected_response_kind, context, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(inputId, cardId, reviewCaseId, input.question, JSON.stringify(input.affectedCriterionIds), input.expectedResponseKind, input.context ?? null, now);

      this.db.prepare(`
        UPDATE kanban_board SET error = ?, updated_at = datetime('now') WHERE id = ?
      `).run(`needs_input: ${input.question}`.slice(0, 1000), cardId);

      this.db.prepare(`
        UPDATE project_review_cases SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'open'
      `).run(now, reviewCaseId);
      this.db.prepare(`
        UPDATE project_review_requests SET status = 'settled', updated_at = ?
        WHERE review_case_id = ? AND status IN ('pending', 'dispatched')
      `).run(now, reviewCaseId);
    });

    return { decisionId };
  }

  getDecision(decisionId: string): ReviewDecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_decisions WHERE id = ?`).get(decisionId) as ReviewDecisionRow | undefined;
  }

  getDecisionByCaseId(reviewCaseId: string): ReviewDecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_decisions WHERE review_case_id = ?`).get(reviewCaseId) as ReviewDecisionRow | undefined;
  }

  getLatestDecisionForProject(projectCardId: number): ReviewDecisionRow | undefined {
    return this.db.prepare(`
      SELECT d.* FROM project_review_decisions d
      JOIN project_review_cases c ON d.review_case_id = c.id
      WHERE c.project_card_id = ?
      ORDER BY d.created_at DESC LIMIT 1
    `).get(projectCardId) as ReviewDecisionRow | undefined;
  }

  hasDecisionForCase(reviewCaseId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM project_review_decisions WHERE review_case_id = ?`).get(reviewCaseId);
    return row !== undefined;
  }
}
