import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";
import type { ProjectAcceptanceContractV1 } from "./project-contract.js";

// ── Project supervision states ────────────────────────────────────────────────

export type ProjectState =
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
  "executing", "review_ready", "review_requested", "reviewing",
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

export interface ReviewDecisionRow {
  id: string;
  review_case_id: string;
  decision_json: string;
  decision_digest: string;
  created_at: string;
}

// ── Action types (used by Kanban projection) ──────────────────────────────────

export type KanbanProjection = "running" | "failed" | "done";

export function projectStateToKanban(state: ProjectState): KanbanProjection {
  switch (state) {
    case "blocked": return "failed";
    case "accepted": return "done";
    default: return "running";
  }
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
        state TEXT NOT NULL DEFAULT 'executing' CHECK(state IN ('executing','review_ready','review_requested','reviewing','repair_planned','repairing','needs_input','blocked','accepted')),
        generation INTEGER NOT NULL DEFAULT 1,
        review_round INTEGER NOT NULL DEFAULT 0,
        repair_round INTEGER NOT NULL DEFAULT 0,
        active_review_case_id TEXT,
        accepted_decision_id TEXT,
        blocked_reason TEXT,
        updated_at TEXT NOT NULL
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
  }

  // ── Root contracts ────────────────────────────────────────────────────

  insertContract(contract: ProjectAcceptanceContractV1): void {
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

  initializeSupervision(projectCardId: number, contractId: string): void {
    this.db.prepare(`
      INSERT INTO project_supervision (project_card_id, contract_id, state, updated_at)
      VALUES (?, ?, 'executing', ?)
    `).run(projectCardId, contractId, new Date().toISOString());
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

  getDecision(decisionId: string): ReviewDecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_decisions WHERE id = ?`).get(decisionId) as ReviewDecisionRow | undefined;
  }

  getDecisionByCaseId(reviewCaseId: string): ReviewDecisionRow | undefined {
    return this.db.prepare(`SELECT * FROM project_review_decisions WHERE review_case_id = ?`).get(reviewCaseId) as ReviewDecisionRow | undefined;
  }

  hasDecisionForCase(reviewCaseId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM project_review_decisions WHERE review_case_id = ?`).get(reviewCaseId);
    return row !== undefined;
  }
}
