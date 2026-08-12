import { requireTaskDatabase, kanbanTransition, kanbanGetCard, sqliteNow, type TaskDatabase } from "../tasks/kanban-board.js";
import type { ProjectAcceptanceContract } from "./project-contract.js";
import { logSwarmTrace } from "../swarm-trace.js";
import { logDebug } from "../logger.js";
import { buildPeerTerminalEvent } from "./peer-terminal-event.js";

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

// ── #1644: project mutation authority ────────────────────────────────────────
//
// Every supervised downstream mutation carries a durable authority tuple: the
// root project card ID, the project supervision generation, and the scheduled
// runId when the root came from a scheduled run. The predicates below run on
// the caller's database connection inside the caller's transaction — a
// preflight read is never the authorization; the mutating statement or
// transaction decides the winner.

export interface ProjectMutationAuthority {
  projectCardId: number;
  projectGeneration: number;
  /** task_runs.run_id when the root is a scheduled project (kanban source_id). */
  scheduledRunId?: string;
}

export type ProjectAuthorityRejection =
  | "missing_authority"
  | "project_missing"
  | "project_terminal"
  | "generation_mismatch"
  | "run_mismatch"
  | "run_failed";

interface RootProjectRow {
  type: string | null;
  source: string | null;
  source_id: string | null;
  status: string | null;
}

interface RootSupervisionRow {
  state: string;
  generation: number;
}

function baseProjectAuthorityCheck(
  db: TaskDatabase,
  authority: ProjectMutationAuthority | undefined,
): ProjectAuthorityRejection | null {
  if (!authority || !Number.isSafeInteger(authority.projectCardId) || authority.projectCardId < 1
      || !Number.isSafeInteger(authority.projectGeneration) || authority.projectGeneration < 1) {
    return "missing_authority";
  }
  const card = db.prepare(`SELECT type, source, source_id, status FROM kanban_board WHERE id = ?`)
    .get(authority.projectCardId) as unknown as RootProjectRow | undefined;
  if (!card || card.type !== "O") return "project_missing";
  const sup = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`)
    .get(authority.projectCardId) as unknown as RootSupervisionRow | undefined;
  if (!sup) return "project_missing";
  if (sup.generation !== authority.projectGeneration) return "generation_mismatch";
  return null;
}

/** Run-identity/outcome half of the authority check. Shared by both predicates. */
function runAuthorityCheck(
  db: TaskDatabase,
  card: RootProjectRow,
  authority: ProjectMutationAuthority,
  requireTerminalSuccess: boolean,
): ProjectAuthorityRejection | null {
  // `source === 'task'` is the scheduled-root marker ONLY together with a
  // durable source_id — the same identity rule as isScheduledRootIdentity
  // (reconciler). A plain supervised project whose source string is 'task'
  // but which carries no scheduled run identity is not scheduled and must not
  // be fenced as one.
  const isScheduled = card.source === "task" && card.source_id != null && card.source_id.length > 0;
  if (isScheduled) {
    if (authority.scheduledRunId === undefined || authority.scheduledRunId !== card.source_id) return "run_mismatch";
    const run = db.prepare(`SELECT finished_at, outcome FROM task_runs WHERE run_id = ?`)
      .get(authority.scheduledRunId) as { finished_at: number | null; outcome: string | null } | undefined;
    if (!run) return "run_mismatch";
    if (requireTerminalSuccess) {
      if (run.finished_at === null || run.outcome !== "success") return "run_failed";
    } else if (run.finished_at !== null) {
      return "run_failed";
    }
    return null;
  }
  if (authority.scheduledRunId !== undefined) return "run_mismatch";
  return null;
}

/**
 * #1644: active-work authorization. True only when the root card exists as a
 * supervised project at the exact generation, is not terminal, and — for a
 * scheduled root — the correlated scheduled run is still live. Non-scheduled
 * projects authorize without a run identity. Runs on the caller's connection,
 * intended to be evaluated inside the caller's transaction.
 */
export function authorizeActiveProjectWork(
  db: TaskDatabase,
  authority: ProjectMutationAuthority | undefined,
): ProjectAuthorityRejection | null {
  const base = baseProjectAuthorityCheck(db, authority);
  if (base) return base;
  const card = db.prepare(`SELECT type, source, source_id, status FROM kanban_board WHERE id = ?`)
    .get(authority!.projectCardId) as unknown as RootProjectRow;
  const sup = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`)
    .get(authority!.projectCardId) as unknown as RootSupervisionRow;
  if (TERMINAL_PROJECT_STATES.includes(sup.state as ProjectState)) return "project_terminal";
  return runAuthorityCheck(db, card, authority!, false);
}

/**
 * #1644: delivery authorization. Requires an `accepted` project at the exact
 * generation and, for a scheduled root, a terminal `task_runs` row with
 * `outcome='success'` for the exact run. A claim for run N can never authorize
 * run N+1. Runs on the caller's connection, intended to be evaluated inside
 * the caller's transaction.
 */
export function authorizeProjectDelivery(
  db: TaskDatabase,
  authority: ProjectMutationAuthority | undefined,
): ProjectAuthorityRejection | null {
  const base = baseProjectAuthorityCheck(db, authority);
  if (base) return base;
  const card = db.prepare(`SELECT type, source, source_id, status FROM kanban_board WHERE id = ?`)
    .get(authority!.projectCardId) as unknown as RootProjectRow;
  const sup = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`)
    .get(authority!.projectCardId) as unknown as RootSupervisionRow;
  if (sup.state !== "accepted") return "project_terminal";
  return runAuthorityCheck(db, card, authority!, true);
}

/** #1644: one bounded rejection trace per rejected project mutation. */
export function emitProjectAuthorityRejection(
  operation: string,
  authority: ProjectMutationAuthority | undefined,
  reason: ProjectAuthorityRejection,
  extra?: { cardId?: number; attemptId?: string },
): void {
  logSwarmTrace({
    event: "project_mutation_rejected",
    operation: operation.slice(0, 120),
    project: authority?.projectCardId ?? extra?.cardId ?? 0,
    card: extra?.cardId ?? authority?.projectCardId,
    generation: authority?.projectGeneration ?? 0,
    run: authority?.scheduledRunId,
    attempt: extra?.attemptId,
    reason,
  });
}

/**
 * #1644: true when `cardId` sits (transitively) under a root card of type `O`
 * that has a `project_supervision` row. Used to fail closed on legacy worker
 * attempts that lack the immutable lineage columns — a supervised project
 * attempt must never infer its authority later.
 */
export function cardIsSupervisedProjectChild(db: TaskDatabase, cardId: number): boolean {
  try {
    // Do not use a fixed hop limit here. A legacy attempt below a deep but
    // valid project tree must fail closed just like one directly below the
    // root; stopping early would silently turn it into an unsupervised row.
    const root = db.prepare(`
      WITH RECURSIVE ancestors(id, parent_id, type, path) AS (
        SELECT id, parent_id, type, printf('/%d/', id)
        FROM kanban_board WHERE id = ?
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.type,
               ancestors.path || printf('%d/', parent.id)
        FROM kanban_board parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE instr(ancestors.path, printf('/%d/', parent.id)) = 0
      )
      SELECT ancestors.id
      FROM ancestors
      JOIN project_supervision ps ON ps.project_card_id = ancestors.id
      WHERE ancestors.type = 'O'
      LIMIT 1
    `).get(cardId) as { id: number } | undefined;
    return root !== undefined;
  } catch {
    return false;
  }
}

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
    options?: { authority?: ProjectMutationAuthority },
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
    if (options?.authority) {
      return this.db.transaction(() => {
        const authority = options.authority!;
        if (authority.projectCardId !== projectCardId) {
          emitProjectAuthorityRejection("project_state_transition", authority, "missing_authority", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("project_state_transition", authority, rejection, { cardId: projectCardId });
          return false;
        }
        const sql = `UPDATE project_supervision SET ${sets.join(", ")} WHERE project_card_id = ? AND generation = ? AND state IN (${placeholders})`;
        const result = this.db.prepare(sql).run(...vals.slice(0, -1), projectCardId, authority.projectGeneration, ...fromStates);
        return result.changes === 1;
      });
    }
    const sql = `UPDATE project_supervision SET ${sets.join(", ")} WHERE project_card_id = ? AND state IN (${placeholders})`;
    const result = this.db.prepare(sql).run(...vals, ...fromStates);
    return result.changes > 0;
  }

  /** #1644: review mutations may be invoked after a preflight read has gone
   * stale. Recheck the bound authority and the open case on the caller's
   * transaction before any decision/state write. Synthetic system blockers
   * (for example contract admission) have no case row and are handled by
   * their own durable state CAS. */
  private assertReviewMutationAuthorityInTransaction(
    cardId: number,
    reviewCaseId: string,
    authority?: ProjectMutationAuthority,
  ): void {
    if (authority) {
      if (authority.projectCardId !== cardId) {
        emitProjectAuthorityRejection("project_review_mutation", authority, "missing_authority", { cardId });
        throw new Error("project mutation rejected: project_mismatch");
      }
      const rejection = authorizeActiveProjectWork(this.db, authority);
      if (rejection) {
        emitProjectAuthorityRejection("project_review_mutation", authority, rejection, { cardId });
        throw new Error(`project mutation rejected: ${rejection}`);
      }
    }

    const reviewCase = this.db.prepare(`
      SELECT project_card_id, generation, status
      FROM project_review_cases WHERE id = ?
    `).get(reviewCaseId) as { project_card_id: number; generation: number; status: string } | undefined;
    if (!reviewCase) return;
    const supervision = this.db.prepare(`
      SELECT generation FROM project_supervision WHERE project_card_id = ?
    `).get(cardId) as { generation: number } | undefined;
    if (reviewCase.project_card_id !== cardId || reviewCase.status !== "open" ||
        supervision?.generation !== reviewCase.generation ||
        (authority && authority.projectGeneration !== reviewCase.generation)) {
      if (authority) {
        emitProjectAuthorityRejection("project_review_mutation", authority, "generation_mismatch", { cardId });
      }
      throw new Error(`stale or already-settled review case ${reviewCaseId}`);
    }
  }

  /**
   * #1644: terminalize a project without a review decision (coverage or
   * operator abort). The supervision CAS, owner invalidation, and optional
   * root-card failure are one transaction so these paths cannot leave a live
   * Orc/Worker owner behind while merely changing the supervision state.
   */
  blockProject(
    projectCardId: number,
    reason: string,
    extraSets?: Record<string, string | number | null>,
    options?: { failCard?: boolean; authority?: ProjectMutationAuthority },
  ): boolean {
    const now = new Date().toISOString();
    const failCard = options?.failCard !== false;
    return this.db.transaction(() => {
      const authority = options?.authority;
      if (authority) {
        if (authority.projectCardId !== projectCardId) {
          emitProjectAuthorityRejection("project_block", authority, "missing_authority", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("project_block", authority, rejection, { cardId: projectCardId });
          return false;
        }
      }
      const sets = ["state = 'blocked'", "blocked_reason = ?", "updated_at = ?"];
      const vals: unknown[] = [reason.slice(0, 500), now];
      if (extraSets) {
        for (const [k, v] of Object.entries(extraSets)) {
          sets.push(`${k} = ?`);
          vals.push(v);
        }
      }
      vals.push(projectCardId);
      if (authority) vals.push(authority.projectGeneration);
      const state = this.db.prepare(`
        UPDATE project_supervision SET ${sets.join(", ")}
        WHERE project_card_id = ?
          ${authority ? "AND generation = ?" : ""}
          AND state IN ('awaiting_contract','executing','review_ready','review_requested','reviewing','repair_planned','repairing','needs_input')
      `).run(...vals);
      if (state.changes !== 1) return false;

      this.invalidateOwnershipInTransaction(projectCardId, "", now);

      if (failCard) {
        const outcome = kanbanTransition({
          cardId: projectCardId,
          from: ["queued", "running"],
          to: projectStateToKanban("blocked"),
          actor: "project_acceptance",
          reason: "project blocked",
          fields: {
            error: `blocked: ${reason}`.slice(0, 1000),
            completed_at: sqliteNow(),
            next_retry_at: null,
          },
          emit: false,
        }, this.db);
        if (outcome.kind !== "applied") {
          throw new Error(`project ${projectCardId} kanban settlement lost: observed ${outcome.observed ?? "missing"}`);
        }
      }
      return true;
    });
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
    authority?: ProjectMutationAuthority,
  ): boolean {
    return this.db.transaction(() => {
      if (authority) {
        if (authority.projectCardId !== projectCardId) {
          emitProjectAuthorityRejection("coverage_round_claim", authority, "missing_authority", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("coverage_round_claim", authority, rejection, { cardId: projectCardId });
          return false;
        }
      }
      const result = this.db.prepare(`
        UPDATE project_supervision
           SET coverage_signature = ?, coverage_uncovered_ids = ?,
               coverage_rounds = coverage_rounds + 1, updated_at = ?
         WHERE project_card_id = ? AND state = 'executing'
           ${authority ? "AND generation = ?" : ""}
           AND (coverage_signature IS NULL OR coverage_signature != ?)
           AND coverage_rounds < ?
      `).run(
        signature,
        JSON.stringify(uncoveredIds),
        new Date().toISOString(),
        projectCardId,
        ...(authority ? [authority.projectGeneration] : []),
        signature,
        maxRounds,
      );
      return result.changes === 1;
    });
  }

  /** Record a clean coverage evaluation before the review_ready transition. */
  recordCoverageClear(projectCardId: number, signature: string, authority?: ProjectMutationAuthority): boolean {
    return this.db.transaction(() => {
      if (authority) {
        if (authority.projectCardId !== projectCardId) {
          emitProjectAuthorityRejection("coverage_clear", authority, "missing_authority", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("coverage_clear", authority, rejection, { cardId: projectCardId });
          return false;
        }
      }
      const result = this.db.prepare(`
        UPDATE project_supervision
         SET coverage_uncovered_ids = '[]', coverage_signature = ?, updated_at = ?
         WHERE project_card_id = ? AND state = 'executing'
           ${authority ? "AND generation = ?" : ""}
      `).run(signature, new Date().toISOString(), projectCardId, ...(authority ? [authority.projectGeneration] : []));
      return result.changes === 1;
    });
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
    authority?: ProjectMutationAuthority,
  ): boolean {
    return this.db.transaction(() => {
      if (authority) {
        if (authority.projectCardId !== projectCardId) {
          emitProjectAuthorityRejection("coverage_reviewable", authority, "missing_authority", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("coverage_reviewable", authority, rejection, { cardId: projectCardId });
          return false;
        }
      }
      const result = this.db.prepare(`
        UPDATE project_supervision
         SET coverage_signature = ?, coverage_uncovered_ids = ?, updated_at = ?
         WHERE project_card_id = ? AND state = 'executing'
           ${authority ? "AND generation = ?" : ""}
           AND (coverage_signature = ? OR coverage_signature IS NULL)
      `).run(
        signature,
        JSON.stringify(uncoveredIds),
        new Date().toISOString(),
        projectCardId,
        ...(authority ? [authority.projectGeneration] : []),
        signature,
      );
      return result.changes === 1;
    });
  }

  // ── Review requests ────────────────────────────────────────────────────

  insertReviewRequest(projectCardId: number, reviewCaseId: string, generation: number, deadlineAt?: string, authority?: ProjectMutationAuthority): { id: string } {
    const id = `rr_${projectCardId}_${Date.now()}`;
    const now = new Date().toISOString();
    const write = (): boolean => {
      if (authority) {
        if (authority.projectCardId !== projectCardId || authority.projectGeneration !== generation) {
          emitProjectAuthorityRejection("review_request_creation", authority, "generation_mismatch", { cardId: projectCardId });
          return false;
        }
        const rejection = authorizeActiveProjectWork(this.db, authority);
        if (rejection) {
          emitProjectAuthorityRejection("review_request_creation", authority, rejection, { cardId: projectCardId });
          return false;
        }
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO project_review_requests (id, project_card_id, review_case_id, generation, deadline_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectCardId, reviewCaseId, generation, deadlineAt ?? null, now, now);
      return true;
    };
    const written = authority ? this.db.transaction(write) : write();
    if (!written) return { id: "" };
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
    authority?: ProjectMutationAuthority,
  ): InvalidProposalRecord {
    const result = this.db.transaction((): InvalidProposalRecord => {
      const request = this.db.prepare(`
        SELECT id, project_card_id, generation, invalid_proposals, status
        FROM project_review_requests WHERE review_case_id = ?
      `).get(reviewCaseId) as { id: string; project_card_id: number; generation: number; invalid_proposals: number; status: string } | undefined;
      const reviewCase = this.db.prepare(`
        SELECT project_card_id, generation, status FROM project_review_cases WHERE id = ?
      `).get(reviewCaseId) as { project_card_id: number; generation: number; status: ReviewCaseStatus } | undefined;
      const supervision = this.db.prepare(`
        SELECT generation, state FROM project_supervision WHERE project_card_id = ?
      `).get(cardId) as { generation: number; state: string } | undefined;

      if (!request || !reviewCase || request.project_card_id !== cardId || reviewCase.project_card_id !== cardId ||
          request.generation !== reviewCase.generation || supervision?.generation !== reviewCase.generation ||
          (request.status !== "pending" && request.status !== "dispatched") || reviewCase.status !== "open") {
        return { kind: "ignored", total: request?.invalid_proposals ?? 0, requestId: request?.id ?? "" };
      }
      this.assertReviewMutationAuthorityInTransaction(cardId, reviewCaseId, authority);

      const now = new Date().toISOString();
      if (request.invalid_proposals >= maxInvalidProposals) {
        this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, decisionId, now, authority);
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

      this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, decisionId, now, authority);
      return { kind: "blocked", total: updated.invalid_proposals, requestId: request.id, decisionId };
    });

    if (result.kind === "blocked") {
      logSwarmTrace({ event: "project_blocked", project: cardId, reviewCase: reviewCaseId, decision: result.decisionId, reason: blockerClass });
    }
    return result;
  }

  /** #1644: contract-authoring validation is a project mutation even before
   * a contract exists. Count it under the bound generation, and terminalize
   * the exhausted admission in the same transaction as the winning count. */
  recordInvalidContractProposal(
    cardId: number,
    expectedGeneration: number,
    maxInvalidProposals: number,
    decision: unknown,
    blockerClass: string,
    decisionId: string,
    authority: ProjectMutationAuthority,
  ): InvalidProposalRecord {
    const result = this.db.transaction((): InvalidProposalRecord => {
      if (authority.projectCardId !== cardId || authority.projectGeneration !== expectedGeneration) {
        emitProjectAuthorityRejection("contract_authoring", authority, "generation_mismatch", { cardId });
        return { kind: "ignored", total: 0, requestId: "" };
      }
      const rejection = authorizeActiveProjectWork(this.db, authority);
      if (rejection) {
        emitProjectAuthorityRejection("contract_authoring", authority, rejection, { cardId });
        return { kind: "ignored", total: 0, requestId: "" };
      }
      const current = this.db.prepare(`
        SELECT generation, state, invalid_contract_proposals
        FROM project_supervision WHERE project_card_id = ?
      `).get(cardId) as { generation: number; state: string; invalid_contract_proposals: number } | undefined;
      if (!current || current.generation !== expectedGeneration || current.state !== "awaiting_contract") {
        return { kind: "ignored", total: current?.invalid_contract_proposals ?? 0, requestId: "" };
      }
      const now = new Date().toISOString();
      const incremented = this.db.prepare(`
        UPDATE project_supervision
        SET invalid_contract_proposals = invalid_contract_proposals + 1, updated_at = ?
        WHERE project_card_id = ? AND generation = ? AND state = 'awaiting_contract'
          AND invalid_contract_proposals < ?
      `).run(now, cardId, expectedGeneration, maxInvalidProposals);
      if (incremented.changes !== 1) {
        const reread = this.db.prepare(`SELECT invalid_contract_proposals FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { invalid_contract_proposals: number } | undefined;
        return { kind: "ignored", total: reread?.invalid_contract_proposals ?? current.invalid_contract_proposals, requestId: "" };
      }
      const updated = this.db.prepare(`SELECT invalid_contract_proposals FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { invalid_contract_proposals: number };
      if (updated.invalid_contract_proposals < maxInvalidProposals) {
        return { kind: "counted", total: updated.invalid_contract_proposals, requestId: "" };
      }
      this.settleBlockedInTransaction(
        cardId,
        "contract_admission",
        decision,
        blockerClass,
        undefined,
        decisionId,
        now,
        authority,
      );
      return { kind: "blocked", total: updated.invalid_contract_proposals, requestId: "", decisionId };
    });
    if (result.kind === "blocked") {
      logSwarmTrace({ event: "project_blocked", project: cardId, decision: result.decisionId, reason: blockerClass });
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

  clearInputNotice(projectCardId: number, authority?: ProjectMutationAuthority): void {
    if (!authority) {
      this.db.prepare(`
        UPDATE kanban_board SET error = NULL, updated_at = datetime('now')
        WHERE id = ? AND error LIKE 'needs_input:%'
      `).run(projectCardId);
      return;
    }
    this.db.transaction(() => {
      if (authority.projectCardId !== projectCardId) {
        emitProjectAuthorityRejection("input_notice_clear", authority, "missing_authority", { cardId: projectCardId });
        return;
      }
      const rejection = authorizeActiveProjectWork(this.db, authority);
      if (rejection) {
        emitProjectAuthorityRejection("input_notice_clear", authority, rejection, { cardId: projectCardId });
        return;
      }
      this.db.prepare(`
        UPDATE kanban_board SET error = NULL, updated_at = datetime('now')
        WHERE id = ? AND error LIKE 'needs_input:%'
      `).run(projectCardId);
    });
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
    authority?: ProjectMutationAuthority,
  ): { decisionId: string } {
    const decisionId = acceptanceId ?? `rd_settle_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_${cardId}_${reviewCaseId}_${Date.now()}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.assertReviewMutationAuthorityInTransaction(cardId, reviewCaseId, authority);
      // Insert decision
      this.db.prepare(`
        INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decisionId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

      // Set supervision to accepted only while the project is live. An abort
      // freezes it in blocked state before cancelling executors, so a late Orc
      // result cannot reverse a terminal scheduled outcome.
      const state = authority
        ? this.db.prepare(`
          UPDATE project_supervision SET state = 'accepted', accepted_decision_id = ?, updated_at = ?
          WHERE project_card_id = ? AND generation = ? AND state NOT IN ('accepted', 'blocked')
        `).run(decisionId, now, cardId, authority.projectGeneration)
        : this.db.prepare(`
          UPDATE project_supervision SET state = 'accepted', accepted_decision_id = ?, updated_at = ?
          WHERE project_card_id = ? AND state NOT IN ('accepted', 'blocked')
        `).run(decisionId, now, cardId);
      if (state.changes !== 1) throw new Error(`project ${cardId} is already terminal`);

      // #1644: acceptance is terminal — invalidate every stale owner for the
      // terminal root in the same transaction, including owners from older
      // generations. The supervision row (just CAS'd by this settlement) is
      // the authoritative current generation.
      const settledSupervision = this.db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { generation: number } | undefined;
      this.invalidateOwnershipInTransaction(cardId, reviewCaseId, now);

      // Update kanban card via projectStateToKanban mapping — #1590: through
      // the transition helper inside this transaction. The service layer fires
      // card:done after commit, so emit is disabled here.
      // #1626: a coordinator-owned root may still be `queued` (retry backoff)
      // while its durable review supervision is live; settlement must
      // terminalize from either legal live status. Only `applied` is success —
      // `done` is not in the from-set, so a missing/already-terminal card
      // yields `no_op` and throws, rolling back every settlement write.
      const outcome = kanbanTransition({
        cardId,
        from: ["queued", "running"],
        to: projectStateToKanban("accepted"),
        actor: "project_acceptance",
        reason: "project accepted",
        fields: {
          result_summary: synthesis.slice(0, 4000),
          completed_at: sqliteNow(),
          error: null,
          next_retry_at: null,
        },
        emit: false,
      }, this.db);
      if (outcome.kind !== "applied") {
        throw new Error(
          `project ${cardId} kanban settlement lost: observed ${outcome.observed ?? "missing"}`,
        );
      }

      // Close the case and request in the same transaction as acceptance. If
      // settlement fails, the open case remains retryable instead of being
      // left superseded with no accepted decision.
      this.db.prepare(`
      UPDATE project_review_cases SET status = 'accepted'
      WHERE id = ? AND project_card_id = ? AND generation = ? AND status = 'open'
      `).run(reviewCaseId, cardId, settledSupervision?.generation ?? 1);
      this.db.prepare(`
        UPDATE project_review_requests SET status = 'settled', updated_at = ?
        WHERE project_card_id = ? AND generation = ? AND review_case_id = ? AND status IN ('pending', 'dispatched')
      `).run(now, cardId, settledSupervision?.generation ?? 1, reviewCaseId);

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
    authority?: ProjectMutationAuthority,
  ): { decisionId: string } {
    const settledId = decisionId ?? `rd_block_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db.transaction(() => this.settleBlockedInTransaction(cardId, reviewCaseId, decision, blockerClass, peerEvent, settledId, now, authority));

    logSwarmTrace({ event: "project_blocked", project: cardId, reviewCase: reviewCaseId, decision: settledId, reason: blockerClass });

    return { decisionId: settledId };
  }

  /**
   * #1644: terminal settlement invalidates every stale owner durably, in the
   * settlement's own transaction. Supersedes all active Orc runs for the
   * terminal root, abandons other open review ownership across generations,
   * and marks active descendant attempts cancellation-requested (pending ones cancelled) so no
   * stale callback can later reactivate ownership or be accepted. In-process
   * process cancellation happens after commit and is best-effort cleanup, not
   * the correctness boundary. Runs only against tables that exist on the
   * caller's database (partial test databases skip the cleanup statements;
   * production always has them).
   */
  private invalidateOwnershipInTransaction(projectCardId: number, reviewCaseId: string, now: string): void {
    const tableExists = (name: string): boolean => {
      const row = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
      return row !== undefined;
    };

    if (tableExists("orc_project_runs")) {
      // Supersede every live Orc run for the terminal root — a released stale
      // turn from any older generation can no longer claim, bind, or validate.
      this.db.prepare(`
        UPDATE orc_project_runs
        SET state = 'superseded', outcome = 'project_terminal', released_at = ?, updated_at = ?
        WHERE project_card_id = ? AND state IN ('scheduled','dispatching','running')
      `).run(now, now, projectCardId);
    }

    // Close all open review ownership for the terminal root, except the
    // settling request itself (the caller marks it settled).
    this.db.prepare(`
      UPDATE project_review_requests SET status = 'abandoned', updated_at = ?, last_error = 'project terminal'
      WHERE project_card_id = ? AND status IN ('pending','dispatched') AND review_case_id != ?
    `).run(now, projectCardId, reviewCaseId);
    this.db.prepare(`
      UPDATE project_review_cases SET status = 'superseded', superseded_at = ?
      WHERE project_card_id = ? AND status = 'open' AND id != ?
    `).run(now, projectCardId, reviewCaseId);

    if (tableExists("worker_attempts")) {
      // Durable cancellation marks for every live descendant attempt. The
      // executor layer observes cancel_requested and stops the
      // processes best-effort; even if it never does, the attempts can no
      // longer be claimed or accepted. The recursive descendant set also
      // catches legacy attempts whose immutable lineage is NULL; those rows
      // are deliberately treated as stale rather than left running.
      this.db.prepare(`
        UPDATE worker_attempts SET lifecycle = 'cancel_requested', cancel_reason = 'project_terminal'
        WHERE card_id IN (
          WITH RECURSIVE descendants(id, path) AS (
            SELECT id, printf('/%d/', id) FROM kanban_board WHERE id = ?
            UNION ALL
            SELECT child.id, descendants.path || printf('%d/', child.id)
            FROM kanban_board child
            JOIN descendants ON child.parent_id = descendants.id
            WHERE instr(descendants.path, printf('/%d/', child.id)) = 0
          )
          SELECT id FROM descendants WHERE id != ?
        )
        AND lifecycle IN ('claimed','starting','running')
      `).run(projectCardId, projectCardId);
      this.db.prepare(`
        UPDATE worker_attempts SET lifecycle = 'cancelled', status = 'cancelled', cancel_reason = 'project_terminal', settled_at = ?
        WHERE card_id IN (
          WITH RECURSIVE descendants(id, path) AS (
            SELECT id, printf('/%d/', id) FROM kanban_board WHERE id = ?
            UNION ALL
            SELECT child.id, descendants.path || printf('%d/', child.id)
            FROM kanban_board child
            JOIN descendants ON child.parent_id = descendants.id
            WHERE instr(descendants.path, printf('/%d/', child.id)) = 0
          )
          SELECT id FROM descendants WHERE id != ?
        )
        AND lifecycle = 'pending'
      `).run(now, projectCardId, projectCardId);
    }
  }

  private settleBlockedInTransaction(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    blockerClass: string,
    peerEvent: { peer: string; payload: unknown } | undefined,
    settledId: string,
    now: string,
    authority?: ProjectMutationAuthority,
  ): void {
    this.assertReviewMutationAuthorityInTransaction(cardId, reviewCaseId, authority);
    const decisionDigest = `sd_blk_${cardId}_${reviewCaseId}_${Date.now()}`;
    this.db.prepare(`
      INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(settledId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

    const state = authority
      ? this.db.prepare(`
        UPDATE project_supervision SET state = 'blocked', blocked_reason = ?, accepted_decision_id = ?, updated_at = ?
        WHERE project_card_id = ? AND generation = ? AND state NOT IN ('accepted', 'blocked')
      `).run(blockerClass, settledId, now, cardId, authority.projectGeneration)
      : this.db.prepare(`
        UPDATE project_supervision SET state = 'blocked', blocked_reason = ?, accepted_decision_id = ?, updated_at = ?
        WHERE project_card_id = ? AND state NOT IN ('accepted', 'blocked')
      `).run(blockerClass, settledId, now, cardId);
    if (state.changes !== 1) throw new Error(`project ${cardId} is already terminal`);

    // #1644: blocked is terminal — invalidate every stale owner for the
    // terminal root in the same transaction, including owners from older
    // generations. The supervision row (just CAS'd by this settlement) is
    // the authoritative current generation.
    const settledSupervision = this.db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(cardId) as { generation: number } | undefined;
    this.invalidateOwnershipInTransaction(cardId, reviewCaseId, now);

    // #1590: through the transition helper inside this transaction. The
    // service layer fires card:failed after commit, so emit is disabled.
    // #1626: settle from either legal live status (queued|running) and require
    // the CAS to apply — `failed` is not in the from-set, so a lost CAS or
    // missing/already-terminal card throws and rolls back the whole settlement.
    const outcome = kanbanTransition({
      cardId,
      from: ["queued", "running"],
      to: projectStateToKanban("blocked"),
      actor: "project_acceptance",
      reason: "project blocked",
      fields: {
        error: `blocked: ${blockerClass}`.slice(0, 1000),
        completed_at: sqliteNow(),
        next_retry_at: null,
      },
      emit: false,
    }, this.db);
    if (outcome.kind !== "applied") {
      throw new Error(
        `project ${cardId} kanban settlement lost: observed ${outcome.observed ?? "missing"}`,
      );
    }

    this.db.prepare(`
      UPDATE project_review_cases SET status = 'superseded', superseded_at = ?
      WHERE id = ? AND project_card_id = ? AND generation = ? AND status = 'open'
    `).run(now, reviewCaseId, cardId, settledSupervision?.generation ?? 1);
    this.db.prepare(`
      UPDATE project_review_requests SET status = 'settled', updated_at = ?
      WHERE project_card_id = ? AND generation = ? AND review_case_id = ? AND status IN ('pending', 'dispatched')
    `).run(now, cardId, settledSupervision?.generation ?? 1, reviewCaseId);

    // #1618: a failed terminal event row lands in the same transaction that
    // wins the blocked settlement — duplicate settlement cannot create a
    // second row (outbox is UNIQUE per project_card_id).
    // #1630: auto-derive the failed terminal event when the caller did not
    // supply one, so a blocked peer-origin root always terminates the
    // requester's contribution. An explicitly supplied rich event always wins.
    let effectivePeerEvent = peerEvent;
    if (!effectivePeerEvent) {
      effectivePeerEvent = buildPeerTerminalEvent({
        cardId,
        decisionId: settledId,
        kind: "failed",
        summary: `Project blocked: ${blockerClass}`,
        failureReason: typeof (decision as { reason?: unknown })?.reason === "string"
          ? (decision as { reason: string }).reason
          : undefined,
      });
      if (!effectivePeerEvent) {
        if (kanbanGetCard(cardId)?.source_peer) {
          logDebug("project-review-store", `auto-derived terminal event unavailable for peer project ${cardId}`);
        }
      }
    }
    if (effectivePeerEvent) {
      const payload = effectivePeerEvent.payload && typeof effectivePeerEvent.payload === "object"
        ? { ...(effectivePeerEvent.payload as Record<string, unknown>), acceptance_id: settledId }
        : effectivePeerEvent.payload;
      this.db.prepare(`
        INSERT OR IGNORE INTO project_acceptance_outbox
          (id, project_card_id, peer, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(`ao_${settledId}`, cardId, effectivePeerEvent.peer, JSON.stringify(payload), now, now);
    }
  }

  /** Atomically persist a repair decision, advance its generation, and close the review turn. */
  settleRepair(
    cardId: number,
    reviewCaseId: string,
    decision: unknown,
    expectedGeneration: number,
    additionalTokens: number,
    authority?: ProjectMutationAuthority,
  ): { decisionId: string } {
    const decisionId = `rd_repair_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_repair_${cardId}_${reviewCaseId}_${Date.now()}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.assertReviewMutationAuthorityInTransaction(cardId, reviewCaseId, authority);
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
        UPDATE project_review_cases SET status = 'superseded', superseded_at = ?
        WHERE id = ? AND project_card_id = ? AND generation = ? AND status = 'open'
      `).run(now, reviewCaseId, cardId, expectedGeneration);
      this.db.prepare(`
        UPDATE project_review_requests SET status = 'settled', updated_at = ?
        WHERE project_card_id = ? AND generation = ? AND review_case_id = ? AND status IN ('pending', 'dispatched')
      `).run(now, cardId, expectedGeneration, reviewCaseId);
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
    authority?: ProjectMutationAuthority,
  ): { decisionId: string } {
    const decisionId = `rd_input_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const decisionDigest = `sd_input_${cardId}_${reviewCaseId}_${Date.now()}`;
    const inputId = `ir_${cardId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.assertReviewMutationAuthorityInTransaction(cardId, reviewCaseId, authority);
      this.db.prepare(`
        INSERT INTO project_review_decisions (id, review_case_id, decision_json, decision_digest, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decisionId, reviewCaseId, JSON.stringify(decision), decisionDigest, now);

      const state = authority
        ? this.db.prepare(`
          UPDATE project_supervision SET state = 'needs_input', active_review_case_id = ?, updated_at = ?
          WHERE project_card_id = ? AND generation = ? AND state IN ('review_ready', 'review_requested', 'reviewing')
        `).run(reviewCaseId, now, cardId, authority.projectGeneration)
        : this.db.prepare(`
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

      if (authority) {
        this.db.prepare(`
          UPDATE project_review_cases SET status = 'superseded', superseded_at = ?
          WHERE id = ? AND project_card_id = ? AND generation = ? AND status = 'open'
        `).run(now, reviewCaseId, cardId, authority.projectGeneration);
        this.db.prepare(`
          UPDATE project_review_requests SET status = 'settled', updated_at = ?
          WHERE project_card_id = ? AND generation = ? AND review_case_id = ? AND status IN ('pending', 'dispatched')
        `).run(now, cardId, authority.projectGeneration, reviewCaseId);
      } else {
        this.db.prepare(`
          UPDATE project_review_cases SET status = 'superseded', superseded_at = ? WHERE id = ? AND status = 'open'
        `).run(now, reviewCaseId);
        this.db.prepare(`
          UPDATE project_review_requests SET status = 'settled', updated_at = ?
          WHERE review_case_id = ? AND status IN ('pending', 'dispatched')
        `).run(now, reviewCaseId);
      }
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
