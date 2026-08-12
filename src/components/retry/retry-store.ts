import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";
import { kanbanTransition } from "../tasks/kanban-board.js";
import type { FailureClassificationV1 } from "./failure-classifier.js";
import type { RetryPolicyDecision } from "./retry-policy.js";
import type { RetryDirectiveV1 } from "./retry-directive.js";
import type { WorkerAcceptanceContractV1 } from "../worker-contract.js";
import type { ExecutorKind } from "../worker-executor-identity.js";
import {
  cardIsSupervisedProjectChild,
  emitProjectAuthorityRejection,
  authorizeActiveProjectWork,
  type ProjectAuthorityRejection,
  type ProjectMutationAuthority,
} from "../project-acceptance/project-review-store.js";

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
  proposal_digest: string;
  review_deadline_at: string | null;
  updated_at: string;
}

const REVIEW_DEADLINE_MS = 30 * 60 * 1000;

export interface DirectiveRow {
  id: string;
  source_attempt_id: string;
  target_attempt_id: string | null;
  directive_json: string;
  directive_digest: string;
  created_at: string;
}

export type DecisionStatus = "review_required" | "needs_input" | "scheduled" | "consumed" | "stopped";

export type AcceptRetryOutcome =
  | { kind: "created" }
  | { kind: "idempotent" }
  | { kind: "conflict" }
  | { kind: "stale_source" }
  | { kind: "budget_exhausted" }
  | { kind: "ineligible_executor" };

const ALLOWED_TRANSITIONS: Record<string, readonly string[]> = {
  review_required: ["scheduled", "stopped", "needs_input"],
  needs_input: ["review_required", "stopped"],
  scheduled: ["consumed", "stopped"],
  stopped: [],
  consumed: [],
};

function isValidTransition(from: string, to: string): boolean {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

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
        proposal_digest TEXT NOT NULL DEFAULT '',
        review_deadline_at TEXT,
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
    try { this.db.exec(`ALTER TABLE retry_policy_decisions ADD COLUMN proposal_digest TEXT NOT NULL DEFAULT ''`); } catch {}
    try { this.db.exec(`ALTER TABLE retry_policy_decisions ADD COLUMN review_deadline_at TEXT`); } catch {}
  }

  // ── Classifications ────────────────────────────────────────────────────

  insertClassification(classification: FailureClassificationV1): "created" | "idempotent" | "conflict" {
    try {
      const existing = this.db.prepare(`SELECT id, input_digest FROM attempt_failure_classifications WHERE attempt_id = ?`).get(classification.attempt_id) as { id: string; input_digest: string } | undefined;
      if (existing) {
        if (existing.input_digest === classification.input_digest) return "idempotent";
        return "conflict";
      }
      this.db.prepare(`
        INSERT INTO attempt_failure_classifications (id, attempt_id, input_digest, classification_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(classification.id, classification.attempt_id, classification.input_digest, JSON.stringify(classification), classification.created_at);
      return "created";
    } catch {
      return "conflict";
    }
  }

  getClassification(attemptId: string): FailureClassificationV1 | undefined {
    const row = this.db.prepare(`SELECT classification_json FROM attempt_failure_classifications WHERE attempt_id = ?`).get(attemptId) as { classification_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.classification_json) as FailureClassificationV1;
  }

  // ── Decisions (compare-and-set, no INSERT OR REPLACE) ──────────────────

  insertDecision(decision: RetryPolicyDecision, status: DecisionStatus, proposalDigest?: string): "created" | "idempotent" | "conflict" {
    try {
      const existing = this.db.prepare(`SELECT status, proposal_digest, review_deadline_at FROM retry_policy_decisions WHERE source_attempt_id = ?`).get(decision.sourceAttemptId) as { status: string; proposal_digest: string; review_deadline_at: string | null } | undefined;
      if (existing) {
        if (existing.status === "consumed" || existing.status === "stopped") return "conflict";
        if (existing.proposal_digest && existing.proposal_digest === (proposalDigest ?? "")) return "idempotent";
        if (existing.proposal_digest && existing.proposal_digest !== (proposalDigest ?? "")) return "conflict";
      }
      const digest = proposalDigest ?? "";
      const deadlineAt = status === "review_required" ? new Date(Date.now() + REVIEW_DEADLINE_MS).toISOString() : null;
      this.db.prepare(`
        INSERT INTO retry_policy_decisions (id, source_attempt_id, decision_json, status, proposal_digest, review_deadline_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_attempt_id) DO UPDATE SET
          decision_json = excluded.decision_json,
          status = excluded.status,
          proposal_digest = CASE WHEN retry_policy_decisions.proposal_digest = '' THEN excluded.proposal_digest ELSE retry_policy_decisions.proposal_digest END,
          review_deadline_at = excluded.review_deadline_at,
          updated_at = excluded.updated_at
        WHERE retry_policy_decisions.status NOT IN ('consumed', 'stopped')
      `).run(decision.sourceAttemptId, decision.sourceAttemptId, JSON.stringify(decision), status, digest, deadlineAt, decision.created_at);
      return "created";
    } catch {
      return "conflict";
    }
  }

  getDecision(sourceAttemptId: string): { decision: RetryPolicyDecision; status: string; proposalDigest: string; reviewDeadlineAt: string | null } | undefined {
    const row = this.db.prepare(`SELECT decision_json, status, proposal_digest, review_deadline_at FROM retry_policy_decisions WHERE source_attempt_id = ?`).get(sourceAttemptId) as { decision_json: string; status: string; proposal_digest: string; review_deadline_at: string | null } | undefined;
    if (!row) return undefined;
    return { decision: JSON.parse(row.decision_json) as RetryPolicyDecision, status: row.status, proposalDigest: row.proposal_digest, reviewDeadlineAt: row.review_deadline_at };
  }

  compareAndSetDecisionStatus(sourceAttemptId: string, fromStatus: DecisionStatus, toStatus: DecisionStatus): boolean {
    if (!isValidTransition(fromStatus, toStatus)) return false;
    const result = this.db.prepare(`
      UPDATE retry_policy_decisions SET status = ?, updated_at = ?
      WHERE source_attempt_id = ? AND status = ?
    `).run(toStatus, new Date().toISOString(), sourceAttemptId, fromStatus);
    return result.changes > 0;
  }

  // ── Directives ─────────────────────────────────────────────────────────

  insertDirective(directive: RetryDirectiveV1, targetAttemptId?: string): "created" | "idempotent" | "conflict" {
    try {
      const existing = this.db.prepare(`SELECT id FROM retry_directives WHERE source_attempt_id = ?`).get(directive.source_attempt_id) as { id: string } | undefined;
      if (existing) {
        if (existing.id === directive.id) return "idempotent";
        return "conflict";
      }
      this.db.prepare(`
        INSERT INTO retry_directives (id, source_attempt_id, target_attempt_id, directive_json, directive_digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(directive.id, directive.source_attempt_id, targetAttemptId ?? null, JSON.stringify(directive), directive.semantic_change_fingerprint, directive.created_at);
      return "created";
    } catch {
      return "conflict";
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

  // ── Atomic successor allocation ────────────────────────────────────────

  acceptDirectiveAndAllocateTarget(
    sourceAttemptId: string,
    cardId: number,
    _classification: FailureClassificationV1,
    decision: RetryPolicyDecision,
    directive: RetryDirectiveV1,
    revisedContract: WorkerAcceptanceContractV1,
    targetAttemptId: string,
    _executorKind: ExecutorKind,
    _executorId: string,
    _earliestClaimAt: string,
    budgetReservation: { tokens: number; cost: number; switches: number },
    attemptInsert: { id: string; card_id: number; contract_id: string; ordinal: number; executor_kind: ExecutorKind; executor_id: string; status: string; started_at: string; source_attempt_id: string; earliest_claim_at: string },
  ): AcceptRetryOutcome {
    try {
      return this.db.transaction((): AcceptRetryOutcome => {
        // 1. Reload source attempt — must be terminal
        const source = this.db.prepare(`SELECT lifecycle, status, root_project_card_id, root_project_generation, scheduled_run_id FROM worker_attempts WHERE id = ?`).get(sourceAttemptId) as { lifecycle: string; status: string; root_project_card_id: number | null; root_project_generation: number | null; scheduled_run_id: string | null } | undefined;
        if (!source) return { kind: "stale_source" };
        if (!["completed", "failed", "cancelled", "timed_out"].includes(source.lifecycle)) return { kind: "stale_source" };

        // #1644: a supervised project attempt cannot allocate a successor once
        // its root is terminal or its immutable generation/run no longer
        // authorizes active work. Retries inherit the source lineage verbatim.
        if (source.root_project_card_id != null) {
          const rejection = this.authorizeAttemptForProjectWork({
            card_id: cardId,
            root_project_card_id: source.root_project_card_id,
            root_project_generation: source.root_project_generation,
            scheduled_run_id: source.scheduled_run_id,
          }, "retry_allocation");
          if (rejection) return { kind: "stale_source" };
        } else if (cardIsSupervisedProjectChild(this.db, cardId)) {
          emitProjectAuthorityRejection("retry_allocation", undefined, "missing_authority", { cardId });
          return { kind: "stale_source" };
        }

        // 2. Verify no existing directive/target/reservation for this source
        const existingDirective = this.db.prepare(`SELECT target_attempt_id, directive_digest FROM retry_directives WHERE source_attempt_id = ?`).get(sourceAttemptId) as { target_attempt_id: string | null; directive_digest: string } | undefined;
        if (existingDirective) {
          return existingDirective.directive_digest === directive.semantic_change_fingerprint
            ? { kind: "idempotent", targetAttemptId: existingDirective.target_attempt_id ?? "" } as AcceptRetryOutcome
            : { kind: "conflict" };
        }

        const existingTarget = this.db.prepare(`SELECT id FROM worker_attempts WHERE source_attempt_id = ?`).get(sourceAttemptId) as { id: string } | undefined;
        if (existingTarget) return { kind: "idempotent", targetAttemptId: existingTarget.id } as AcceptRetryOutcome;

        const existingReservation = this.db.prepare(`SELECT target_attempt_id FROM retry_budget_reservations WHERE source_attempt_id = ?`).get(sourceAttemptId) as { target_attempt_id: string } | undefined;
        if (existingReservation) return { kind: "idempotent", targetAttemptId: existingReservation.target_attempt_id } as AcceptRetryOutcome;

        // 3. Check the request is for this source and the decision is unresolved
        if (decision.sourceAttemptId !== sourceAttemptId ||
            directive.source_attempt_id !== sourceAttemptId ||
            revisedContract.revision_meta?.source_attempt_id !== sourceAttemptId) {
          return { kind: "conflict" };
        }
        const currentDecision = this.db.prepare(`SELECT status FROM retry_policy_decisions WHERE source_attempt_id = ?`).get(decision.sourceAttemptId) as { status: string } | undefined;
        if (!currentDecision) return { kind: "stale_source" };
        if (currentDecision.status !== "review_required" && currentDecision.status !== "scheduled") return { kind: "stale_source" };

        // 4. Recompute effective budget from durable rows
        const lineageAttempts = this.db.prepare(`SELECT id, lifecycle, executor_id, settled_at FROM worker_attempts WHERE card_id = ? ORDER BY ordinal ASC`).all(cardId) as Array<{ id: string; lifecycle: string; executor_id: string; settled_at: string | null }>;
        const terminalAttempts = lineageAttempts.filter(a => ["completed", "failed", "cancelled", "timed_out"].includes(a.lifecycle));
        const totalAttempts = terminalAttempts.length;

        const activeReservations = this.db.prepare(`SELECT COALESCE(SUM(reserved_attempts), 0) AS cnt FROM retry_budget_reservations WHERE source_attempt_id IN (${lineageAttempts.map(() => "?").join(",")}) AND status IN ('active','claimed')`).all(...lineageAttempts.map(a => a.id)) as Array<{ cnt: number }>;
        const reservedCount = activeReservations.length > 0 ? activeReservations[0]!.cnt : 0;

        if (totalAttempts + reservedCount > 5) return { kind: "budget_exhausted" };

        // 5. Insert contract revision
        this.db.prepare(`
          INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, parent_contract_id, source_attempt_id, schema_version, contract_json, contract_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          revisedContract.id, cardId,
          (revisedContract.revision_meta?.revision ?? 1),
          (revisedContract.revision_meta?.root_contract_id ?? revisedContract.id),
          (revisedContract.revision_meta?.parent_contract_id ?? null),
          sourceAttemptId,
          revisedContract.schema_version,
          JSON.stringify(revisedContract),
          revisedContract.digest,
          new Date().toISOString(),
        );

        // 6. Insert pending successor attempt — lineage copied verbatim from
        // the source so a retry can never bind to a new project generation or
        // scheduled run (#1644).
        this.db.prepare(`
          INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, status, lifecycle, started_at, source_attempt_id, earliest_claim_at, root_project_card_id, root_project_generation, scheduled_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `).run(attemptInsert.id, attemptInsert.card_id, attemptInsert.contract_id, attemptInsert.ordinal, attemptInsert.executor_kind, attemptInsert.executor_id, attemptInsert.status, attemptInsert.started_at, attemptInsert.source_attempt_id, attemptInsert.earliest_claim_at, source.root_project_card_id, source.root_project_generation, source.scheduled_run_id);

        // 7. Insert directive
        this.db.prepare(`
          INSERT INTO retry_directives (id, source_attempt_id, target_attempt_id, directive_json, directive_digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(directive.id, directive.source_attempt_id, targetAttemptId, JSON.stringify(directive), directive.semantic_change_fingerprint, directive.created_at);

        // 8. Insert active budget reservation
        const now = new Date().toISOString();
        this.db.prepare(`
          INSERT INTO retry_budget_reservations (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
          VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)
        `).run(sourceAttemptId, targetAttemptId, budgetReservation.tokens, budgetReservation.cost, budgetReservation.switches, now, now);

        // 9. Transition decision to scheduled
        this.db.prepare(`
          UPDATE retry_policy_decisions SET status = 'scheduled', updated_at = ?
          WHERE source_attempt_id = ? AND status = ?
        `).run(now, sourceAttemptId, currentDecision.status);

        // 10. Project card to queued — through the single permitted status
        // writer; the card was failed by the terminal settlement that made the
        // attempt reviewable, and the retry re-queues it for dispatch.
        const requeue = kanbanTransition({
          cardId,
          from: ["failed", "done"],
          to: "queued",
          actor: "retry_requeue",
          reason: "retry attempt allocated",
          fields: { error: null, next_retry_at: null },
        }, this.db);
        if (requeue.kind !== "applied" && requeue.kind !== "reasserted") {
          return { kind: "stale_source" } as AcceptRetryOutcome;
        }

        return { kind: "created" };
      });
    } catch {
      return { kind: "stale_source" } as AcceptRetryOutcome;
    }
  }

  // ── Lineage and review ─────────────────────────────────────────────────

  /** #1644: active-work authorization for a source attempt's lineage, run on
   * the caller's connection inside the caller's transaction. Emits exactly one
   * bounded rejection trace when the allocation is stale for its project root. */
  private authorizeAttemptForProjectWork(
    attempt: { card_id: number; root_project_card_id: number | null; root_project_generation: number | null; scheduled_run_id: string | null },
    operation: string,
  ): ProjectAuthorityRejection | null {
    const authority: ProjectMutationAuthority = {
      projectCardId: attempt.root_project_card_id!,
      projectGeneration: attempt.root_project_generation!,
      scheduledRunId: attempt.scheduled_run_id ?? undefined,
    };
    const rejection = authorizeActiveProjectWork(this.db, authority);
    if (rejection) {
      emitProjectAuthorityRejection(operation, authority, rejection, { cardId: attempt.card_id });
    }
    return rejection;
  }

  getLineage(attemptId: string): { classification?: FailureClassificationV1; decision?: { decision: RetryPolicyDecision; status: string }; directive?: RetryDirectiveV1 } {
    const classification = this.getClassification(attemptId);
    const decision = this.getDecision(attemptId);
    const directive = this.getDirective(attemptId);
    return { classification, decision, directive };
  }

  getPendingReviewDecisions(): Array<{ attemptId: string; status: string; reviewDeadlineAt: string | null }> {
    const rows = this.db.prepare(`SELECT source_attempt_id AS attemptId, status, review_deadline_at AS reviewDeadlineAt FROM retry_policy_decisions WHERE status IN ('review_required', 'needs_input')`).all() as Array<{ attemptId: string; status: string; reviewDeadlineAt: string | null }>;
    return rows;
  }

  expireOverdueReviews(now: string): Array<{ attemptId: string }> {
    const expired = this.db.prepare(`SELECT source_attempt_id AS attemptId FROM retry_policy_decisions WHERE status = 'review_required' AND review_deadline_at IS NOT NULL AND review_deadline_at < ?`).all(now) as Array<{ attemptId: string }>;
    for (const row of expired) {
      this.db.prepare(`UPDATE retry_policy_decisions SET status = 'stopped', updated_at = ? WHERE source_attempt_id = ? AND status = 'review_required'`).run(now, row.attemptId);
    }
    return expired;
  }

  getLatestTerminalAttemptForCard(cardId: number): { id: string; lifecycle: string; ordinal: number } | undefined {
    return this.db.prepare(`SELECT id, lifecycle, ordinal FROM worker_attempts WHERE card_id = ? AND lifecycle IN ('completed','failed','cancelled','timed_out') ORDER BY ordinal DESC LIMIT 1`).get(cardId) as { id: string; lifecycle: string; ordinal: number } | undefined;
  }

  getFullLineageBudget(cardId: number, forClass?: string): {
    totalAttempts: number;
    sameClassCount: number;
    consecutiveSameExecutorFails: number;
    executorSwitches: number;
    elapsedMs: number;
    totalTokens: number;
    totalCost: number;
    activeReservations: number;
  } {
    const lineageAttempts = this.db.prepare(`SELECT id, lifecycle, executor_id, started_at, settled_at FROM worker_attempts WHERE card_id = ? ORDER BY ordinal ASC`).all(cardId) as Array<{ id: string; lifecycle: string; executor_id: string; started_at: string; settled_at: string | null }>;
    const terminalAttempts = lineageAttempts.filter(a => ["completed", "failed", "cancelled", "timed_out"].includes(a.lifecycle));
    const totalAttempts = terminalAttempts.length;

    const previousExecutors = lineageAttempts.map(a => a.executor_id);
    const lastTerminal = terminalAttempts[terminalAttempts.length - 1];
    let consecutiveSameExecutorFails = 0;
    if (lastTerminal) {
      for (let i = terminalAttempts.length - 1; i >= 0; i--) {
        const attempt = terminalAttempts[i]!;
        if (attempt.executor_id !== lastTerminal.executor_id ||
            !["failed", "cancelled", "timed_out"].includes(attempt.lifecycle)) break;
        consecutiveSameExecutorFails++;
      }
    }
    let executorSwitches = 0;
    for (let i = 1; i < previousExecutors.length; i++) {
      if (previousExecutors[i] !== previousExecutors[i - 1]) executorSwitches++;
    }

    const firstStart = lineageAttempts[0]?.started_at;
    const lastSettle = [...terminalAttempts].reverse()[0]?.settled_at;
    const elapsedMs = firstStart && lastSettle
      ? new Date(lastSettle).getTime() - new Date(firstStart).getTime()
      : 0;

    let totalTokens = 0;
    let totalCost = 0;
    let sameClassCount = 0;
    for (const a of terminalAttempts) {
      const result = this.db.prepare(`SELECT envelope_json FROM worker_results WHERE attempt_id = ?`).get(a.id) as { envelope_json: string } | undefined;
      if (result) {
        const env = JSON.parse(result.envelope_json);
        totalTokens += env?.usage?.total_tokens ?? 0;
        totalCost += env?.usage?.cost ?? 0;
      }
      if (forClass) {
        const classRow = this.db.prepare(`SELECT classification_json FROM attempt_failure_classifications WHERE attempt_id = ?`).get(a.id) as { classification_json: string } | undefined;
        if (classRow) {
          const cf = JSON.parse(classRow.classification_json) as { primary: string };
          if (cf.primary === forClass) sameClassCount++;
        }
      }
    }

    const activeReservations = this.db.prepare(`SELECT COALESCE(SUM(reserved_attempts), 0) AS cnt FROM retry_budget_reservations WHERE source_attempt_id IN (${lineageAttempts.map(() => "?").join(",")}) AND status IN ('active','claimed')`).all(...lineageAttempts.map(a => a.id)) as Array<{ cnt: number }>;
    const reservedAttempts = activeReservations.length > 0 ? activeReservations[0]!.cnt : 0;

    return { totalAttempts, sameClassCount, consecutiveSameExecutorFails, executorSwitches, elapsedMs, totalTokens, totalCost, activeReservations: reservedAttempts };
  }

  /**
   * #1551 — Companion to WorkerSupervisionStore.pruneTerminalAttempts for the
   * three tables this store owns. Reads worker_attempts.lifecycle +
   * settled_at directly (same convention already used above for
   * retry_budget_reservations) rather than duplicating the terminality
   * predicate as a public export — both stores share one TaskDatabase
   * connection, so this is a same-file cross-table query, not a cross-store
   * coupling. retry_policy_decisions excludes status='review_required': those
   * rows are a live review queue regardless of how old the underlying
   * attempt is.
   *
   * First DELETE statements ever run against these tables.
   */
  pruneTerminalAttempts(olderThanDays: number): number {
    const cutoff = `datetime('now', '-' || ${Number(olderThanDays)} || ' days')`;
    const terminalAttempts = `
      SELECT id FROM worker_attempts
      WHERE lifecycle IN ('completed','failed','cancelled','timed_out')
        AND settled_at IS NOT NULL
        AND settled_at < ${cutoff}
    `;
    let deleted = 0;
    deleted += this.db.prepare(`DELETE FROM attempt_failure_classifications WHERE attempt_id IN (${terminalAttempts})`).run().changes;
    deleted += this.db.prepare(`
      DELETE FROM retry_directives
      WHERE source_attempt_id IN (${terminalAttempts}) OR target_attempt_id IN (${terminalAttempts})
    `).run().changes;
    deleted += this.db.prepare(`
      DELETE FROM retry_policy_decisions
      WHERE status != 'review_required'
        AND source_attempt_id IN (${terminalAttempts})
    `).run().changes;
    return deleted;
  }
}
