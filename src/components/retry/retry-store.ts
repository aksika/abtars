import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import type { RetryPolicyDecision } from "./retry-policy.js";
import type { RetryDirectiveV1 } from "./retry-directive.js";

export interface ClassificationRow {
  id: string;
  attempt_id: string;
  input_digest: string;
  classification_json: string;
  created_at: string;
}

export interface DecisionRow {
  id: string;
  source_attempt_id: string;
  decision_json: string;
  status: string;
  updated_at: string;
}

export interface DirectiveRow {
  id: string;
  source_attempt_id: string;
  target_attempt_id: string | null;
  directive_json: string;
  directive_digest: string;
  created_at: string;
}

export type DecisionStatus = "review_required" | "needs_input" | "scheduled" | "consumed" | "stopped";

export class RetryStore {
  private db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_failure_classifications (
        id TEXT PRIMARY KEY,
        attempt_id TEXT UNIQUE NOT NULL,
        input_digest TEXT NOT NULL,
        classification_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retry_policy_decisions (
        id TEXT PRIMARY KEY,
        source_attempt_id TEXT UNIQUE NOT NULL,
        decision_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'review_required',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retry_directives (
        id TEXT PRIMARY KEY,
        source_attempt_id TEXT UNIQUE NOT NULL,
        target_attempt_id TEXT UNIQUE,
        directive_json TEXT NOT NULL,
        directive_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  insertClassification(classification: FailureClassificationV1): boolean {
    try {
      const existing = this.db.prepare(`SELECT id FROM attempt_failure_classifications WHERE attempt_id = ?`).get(classification.attempt_id);
      if (existing) {
        const existingRow = existing as { id: string };
        if (existingRow.id === classification.id) return true;
        return false;
      }
      this.db.prepare(`
        INSERT INTO attempt_failure_classifications (id, attempt_id, input_digest, classification_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(classification.id, classification.attempt_id, classification.input_digest, JSON.stringify(classification), classification.created_at);
      return true;
    } catch {
      return false;
    }
  }

  getClassification(attemptId: string): FailureClassificationV1 | undefined {
    const row = this.db.prepare(`SELECT classification_json FROM attempt_failure_classifications WHERE attempt_id = ?`).get(attemptId) as { classification_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.classification_json) as FailureClassificationV1;
  }

  insertDecision(decision: RetryPolicyDecision, status: DecisionStatus): boolean {
    try {
      const existing = this.db.prepare(`SELECT status FROM retry_policy_decisions WHERE source_attempt_id = ?`).get(decision.sourceAttemptId) as { status: string } | undefined;
      if (existing) {
        if (existing.status === "consumed" || existing.status === "stopped") return false;
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO retry_policy_decisions (id, source_attempt_id, decision_json, status, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(decision.sourceAttemptId, decision.sourceAttemptId, JSON.stringify(decision), status, decision.created_at);
      return true;
    } catch {
      return false;
    }
  }

  getDecision(sourceAttemptId: string): { decision: RetryPolicyDecision; status: string } | undefined {
    const row = this.db.prepare(`SELECT decision_json, status FROM retry_policy_decisions WHERE source_attempt_id = ?`).get(sourceAttemptId) as { decision_json: string; status: string } | undefined;
    if (!row) return undefined;
    return { decision: JSON.parse(row.decision_json) as RetryPolicyDecision, status: row.status };
  }

  updateDecisionStatus(sourceAttemptId: string, status: DecisionStatus): boolean {
    const result = this.db.prepare(`UPDATE retry_policy_decisions SET status = ?, updated_at = ? WHERE source_attempt_id = ?`).run(status, new Date().toISOString(), sourceAttemptId);
    return result.changes > 0;
  }

  insertDirective(
    directive: RetryDirectiveV1,
    targetAttemptId?: string,
  ): boolean {
    try {
      this.db.prepare(`
        INSERT INTO retry_directives (id, source_attempt_id, target_attempt_id, directive_json, directive_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(directive.id, directive.source_attempt_id, targetAttemptId ?? null, JSON.stringify(directive), directive.semantic_change_fingerprint, directive.created_at);
      return true;
    } catch {
      return false;
    }
  }

  getDirective(sourceAttemptId: string): RetryDirectiveV1 | undefined {
    const row = this.db.prepare(`SELECT directive_json FROM retry_directives WHERE source_attempt_id = ?`).get(sourceAttemptId) as { directive_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.directive_json) as RetryDirectiveV1;
  }

  getDirectiveById(directiveId: string): RetryDirectiveV1 | undefined {
    const row = this.db.prepare(`SELECT directive_json FROM retry_directives WHERE id = ?`).get(directiveId) as { directive_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.directive_json) as RetryDirectiveV1;
  }

  getLineage(attemptId: string): { classification?: FailureClassificationV1; decision?: { decision: RetryPolicyDecision; status: string }; directive?: RetryDirectiveV1 } {
    const classification = this.getClassification(attemptId);
    const decision = this.getDecision(attemptId);
    const directive = this.getDirective(attemptId);
    return { classification, decision, directive };
  }

  getPendingReviewDecisions(): Array<{ attemptId: string; status: string }> {
    const rows = this.db.prepare(`SELECT source_attempt_id AS attemptId, status FROM retry_policy_decisions WHERE status IN ('review_required', 'needs_input')`).all() as Array<{ attemptId: string; status: string }>;
    return rows;
  }
}
