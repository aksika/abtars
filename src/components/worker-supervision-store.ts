import { kanbanTransition, requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "./worker-contract.js";
import { ExecutorLeaseStore } from "./executor-lease-store.js";
import { addColumnIfMissing } from "../utils/sqlite-migrate.js";
import { logSwarmTrace } from "./swarm-trace.js";
import {
  authorizeActiveProjectWork,
  cardIsSupervisedProjectChild,
  emitProjectAuthorityRejection,
  type ProjectAuthorityRejection,
  type ProjectMutationAuthority,
} from "./project-acceptance/project-review-store.js";
import {
  isExecutorKind,
  normalizeLegacyExecutorId,
  normalizeLegacyExecutorKind,
  type ExecutorKind,
} from "./worker-executor-identity.js";

export type { ExecutorKind } from "./worker-executor-identity.js";

/** #1720 — hard cap for late-completion settlement grace. */
const MAX_COMPLETION_GRACE_MS = 5_000;
/** #1720 — grace fallback when the attempt's contract carries no usable duration. */
const FALLBACK_COMPLETION_GRACE_MS = 1_000;

export type AttemptLifecycle =
  | "pending"
  | "claimed"
  | "starting"
  | "running"
  | "cancel_requested"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface ContractRow {
  id: string;
  card_id: number;
  revision: number;
  root_contract_id: string;
  parent_contract_id: string | null;
  source_attempt_id: string | null;
  schema_version: number;
  contract_json: string;
  contract_digest: string;
  created_at: string;
}

export interface AttemptRow {
  id: string;
  card_id: number;
  contract_id: string;
  ordinal: number;
  executor_kind: ExecutorKind;
  executor_id: string;
  generation: number;
  lifecycle: AttemptLifecycle;
  remote_task_id: number | null;
  status: string;
  claimed_at: string | null;
  started_at: string;
  settled_at: string | null;
  hard_deadline_at: string | null;
  cancel_reason: string | null;
  source_attempt_id: string | null;
  retry_directive_id: string | null;
  earliest_claim_at: string | null;
  reserved_tokens: number;
  input_tokens: number | null;
  output_tokens: number | null;
  charged_tokens: number;
  usage_charged_at: string | null;
  /** #1638: durable executor-neutral runtime binding (Pi run id/generation). */
  executor_resource_id: string | null;
  executor_resource_generation: number | null;
  execution_continuity: string | null;
  /** #1644: immutable root project authority captured at attempt creation. */
  root_project_card_id: number | null;
  root_project_generation: number | null;
  scheduled_run_id: string | null;
}

export interface ReservationRow {
  source_attempt_id: string;
  target_attempt_id: string;
  reserved_attempts: number;
  reserved_tokens: number;
  reserved_cost: number;
  reserved_switches: number;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ResultRow {
  attempt_id: string;
  envelope_json: string;
  envelope_digest: string;
  created_at: string;
}

export interface ExecutionClaim {
  attemptId: string;
  cardId: number;
  contractId: string;
  executorKind: ExecutorKind;
  executorId: string;
  generation: number;
  claimedAt: string;
  hardDeadlineAt?: string;
}

export class WorkerSupervisionStore {
  readonly db: TaskDatabase;

  private static readonly EXECUTOR_IDENTITY_MIGRATION = "1637_executor_identity";

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    const db = this.db;

    // Migration: rename old single-contract-per-card table before creating new revisioned one.
    const migrationDone = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='worker_contracts_old'`).get();
    if (!migrationDone) {
      const oldSchema = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='worker_contracts'`).get() as { sql: string } | undefined;
      const needsMigration = oldSchema && oldSchema.sql.includes("card_id INTEGER UNIQUE");
      if (needsMigration) {
        db.exec(`ALTER TABLE worker_contracts RENAME TO worker_contracts_old`);
        // Drop the old UNIQUE index that conflicts with the new table
        db.exec(`DROP INDEX IF EXISTS sqlite_autoindex_worker_contracts_1`);
      }
    }

    // Now create (or recreate) the revisioned table safely
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_contracts (
        id TEXT PRIMARY KEY,
        card_id INTEGER NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        root_contract_id TEXT NOT NULL,
        parent_contract_id TEXT,
        source_attempt_id TEXT,
        schema_version INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(card_id, revision),
        UNIQUE(card_id, contract_digest),
        UNIQUE(source_attempt_id)
      );

      CREATE TABLE IF NOT EXISTS worker_attempts (
        id TEXT PRIMARY KEY,
        card_id INTEGER NOT NULL,
        contract_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        generation INTEGER DEFAULT 1,
        lifecycle TEXT NOT NULL DEFAULT 'pending' CHECK(lifecycle IN ('pending','claimed','starting','running','cancel_requested','completed','failed','cancelled','timed_out')),
        remote_task_id INTEGER,
        status TEXT NOT NULL,
        claimed_at TEXT,
        started_at TEXT NOT NULL,
        settled_at TEXT,
        hard_deadline_at TEXT,
        cancel_reason TEXT,
        source_attempt_id TEXT,
        retry_directive_id TEXT,
        earliest_claim_at TEXT,
        UNIQUE(card_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS worker_results (
        attempt_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS retry_budget_reservations (
        source_attempt_id TEXT PRIMARY KEY,
        target_attempt_id TEXT UNIQUE NOT NULL,
        reserved_attempts INTEGER NOT NULL CHECK(reserved_attempts = 1),
        reserved_tokens INTEGER NOT NULL,
        reserved_cost REAL NOT NULL,
        reserved_switches INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','claimed','released','consumed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    // Migration markers keep one-time data migrations out of the hot path.
    // WorkerSupervisionStore is constructed by several lifecycle/read paths;
    // without this marker #1637 would rescan and parse every worker result on
    // each construction after the first upgrade.
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_supervision_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Migrate old rows to revision 1 if worker_contracts_old exists and has data
    try {
      const oldExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='worker_contracts_old'`).get();
      if (!oldExists) throw new Error("no old table");
      const oldRows = db.prepare(`SELECT count(*) AS cnt FROM worker_contracts_old`).get() as { cnt: number };
      if (oldRows && oldRows.cnt > 0) {
        db.transaction(() => {
          const rows = db.prepare(`SELECT * FROM worker_contracts_old`).all() as Array<{
            id: string; card_id: number; schema_version: number;
            contract_json: string; contract_digest: string; created_at: string;
          }>;
          for (const row of rows) {
            const existing = db.prepare(`SELECT 1 FROM worker_contracts WHERE id = ?`).get(row.id);
            if (existing) continue;
            db.prepare(`
              INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, parent_contract_id, source_attempt_id, schema_version, contract_json, contract_digest, created_at)
              VALUES (?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?)
            `).run(row.id, row.card_id, row.id, row.schema_version, row.contract_json, row.contract_digest, row.created_at);
          }
          const newCount = (db.prepare(`SELECT count(*) AS cnt FROM worker_contracts`).get() as { cnt: number }).cnt;
          if (newCount !== oldRows.cnt) throw new Error(`migration count mismatch: old=${oldRows.cnt} new=${newCount}`);
        });
      }
    } catch { /* worker_contracts_old does not exist or is empty — skip migration */ }

    // Safe migration: add columns if they don't exist (duplicate-column failures are expected)
    addColumnIfMissing(db, "worker_attempts", "generation INTEGER DEFAULT 1");
    addColumnIfMissing(db, "worker_attempts", "lifecycle TEXT NOT NULL DEFAULT 'pending'");
    addColumnIfMissing(db, "worker_attempts", "claimed_at TEXT");
    addColumnIfMissing(db, "worker_attempts", "hard_deadline_at TEXT");
    addColumnIfMissing(db, "worker_attempts", "cancel_reason TEXT");
    addColumnIfMissing(db, "worker_attempts", "source_attempt_id TEXT");
    addColumnIfMissing(db, "worker_attempts", "retry_directive_id TEXT");
    addColumnIfMissing(db, "worker_attempts", "earliest_claim_at TEXT");
    // #1510: Add budget and usage columns
    addColumnIfMissing(db, "worker_attempts", "reserved_tokens INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "worker_attempts", "input_tokens INTEGER");
    addColumnIfMissing(db, "worker_attempts", "output_tokens INTEGER");
    addColumnIfMissing(db, "worker_attempts", "charged_tokens INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(db, "worker_attempts", "usage_charged_at TEXT");
    // #1638: executor-neutral runtime resource binding (Pi run id/generation).
    // execution_continuity stays a plain TEXT column — SQLite cannot add a
    // CHECK via ADD COLUMN; its 'initial'|'resumed'|'fresh' domain is enforced
    // in the typed store operations below.
    addColumnIfMissing(db, "worker_attempts", "executor_resource_id TEXT");
    addColumnIfMissing(db, "worker_attempts", "executor_resource_generation INTEGER");
    addColumnIfMissing(db, "worker_attempts", "execution_continuity TEXT");
    // #1644: immutable root project authority (card id, supervision generation,
    // scheduled run id) captured when the attempt is created and copied verbatim
    // to every retry/repair successor. Legacy rows stay NULL; they cannot be
    // claimed or settled as live supervised project work without authority.
    addColumnIfMissing(db, "worker_attempts", "root_project_card_id INTEGER");
    addColumnIfMissing(db, "worker_attempts", "root_project_generation INTEGER");
    addColumnIfMissing(db, "worker_attempts", "scheduled_run_id TEXT");
    db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_attempt_runtime_generation
        ON worker_attempts(executor_kind, executor_resource_id, executor_resource_generation)
        WHERE executor_resource_id IS NOT NULL
      `);

    // Backfill lifecycle for rows created before the #1364 state machine.
    db.exec(`
      UPDATE worker_attempts
      SET lifecycle = CASE
        WHEN status IN ('settled', 'completed') THEN 'completed'
        WHEN status = 'failed' THEN 'failed'
        WHEN status = 'cancelled' THEN 'cancelled'
        WHEN status = 'timed_out' THEN 'timed_out'
        WHEN status = 'running' THEN 'running'
        ELSE lifecycle
      END
      WHERE lifecycle = 'pending' AND status <> 'pending'
    `);

    // #1637: one durable executor identity. Normalize the two legacy attempt
    // synonyms (local_worker -> agent, remote_worker -> remote) and the
    // built-in Spin ID (spin -> spin-local), then normalize the embedded
    // envelope JSON and recompute its digest — all in one transaction so the
    // attempt row and its audit envelope can never advance contradictory.
    // The marker makes this genuinely one-time and the in-transaction check
    // keeps concurrent store construction idempotent.
    db.transaction(() => {
      const applied = db.prepare(`
        SELECT 1 FROM worker_supervision_migrations WHERE name = ?
      `).get(WorkerSupervisionStore.EXECUTOR_IDENTITY_MIGRATION);

      const legacyKindRows = db.prepare(`
        SELECT id, executor_kind, executor_id, lifecycle FROM worker_attempts
        WHERE executor_kind IN ('local_worker', 'remote_worker')
           OR executor_id = 'spin'
      `).all() as Array<{ id: string; executor_kind: string; executor_id: string; lifecycle: string }>;

      // The marker avoids parsing every result after the first upgrade. The
      // small attempt query still lets a migration fixture or an older writer
      // inserted after the marker self-heal without scanning worker_results.
      if (applied && legacyKindRows.length === 0) return;

      for (const row of legacyKindRows) {
        const kind = normalizeLegacyExecutorKind(row.executor_kind);
        if (!kind) continue;
        const id = normalizeLegacyExecutorId(kind, row.executor_id);
        db.prepare(`
          UPDATE worker_attempts SET executor_kind = ?, executor_id = ?
          WHERE id = ?
        `).run(kind, id, row.id);
      }

      // The expensive envelope rewrite and the marker insert run only on the
      // first upgrade; a later legacy attempt row self-heals through the query
      // above without rescanning worker_results.
      if (applied) return;
      this.migrateLegacyEnvelopes();

      db.prepare(`
        INSERT OR IGNORE INTO worker_supervision_migrations (name) VALUES (?)
      `).run(WorkerSupervisionStore.EXECUTOR_IDENTITY_MIGRATION);
    });
  }

  /** #1637: rewrite legacy executor synonyms inside stored envelope JSON and
   * recompute the digest from the exact updated JSON. Throws (rolling back
   * the caller's transaction) when a targeted envelope cannot be parsed. */
  private migrateLegacyEnvelopes(): void {
    const rows = this.db.prepare(`SELECT attempt_id, envelope_json, envelope_digest FROM worker_results`).all() as Array<{ attempt_id: string; envelope_json: string; envelope_digest: string }>;
    for (const row of rows) {
      let parsed: { attempt?: { executor_kind?: string; executor_id?: string } };
      try {
        parsed = JSON.parse(row.envelope_json) as { attempt?: { executor_kind?: string; executor_id?: string } };
      } catch (err) {
        throw new Error(`migration aborted: worker_results.${row.attempt_id} envelope is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      const attempt = parsed.attempt;
      if (!attempt || typeof attempt !== "object") continue;
      const kind = normalizeLegacyExecutorKind(attempt.executor_kind);
      if (!kind && !(attempt.executor_kind === "agent" && attempt.executor_id === "spin")) continue;
      const newKind = kind ?? (attempt.executor_kind as "agent");
      attempt.executor_kind = newKind;
      if (typeof attempt.executor_id === "string") {
        attempt.executor_id = normalizeLegacyExecutorId(newKind, attempt.executor_id);
      }
      const updatedJson = JSON.stringify(parsed);
      const updatedDigest = this.computeEnvelopeDigest(updatedJson);
      this.db.prepare(`
        UPDATE worker_results SET envelope_json = ?, envelope_digest = ?
        WHERE attempt_id = ?
      `).run(updatedJson, updatedDigest, row.attempt_id);
    }
  }

  insertContract(contract: WorkerAcceptanceContractV1, cardId: number): void {
    const rev = contract.revision_meta;
    const revision = rev?.revision ?? 1;
    const rootContractId = rev?.root_contract_id ?? contract.id;
    this.db.prepare(`
      INSERT INTO worker_contracts (id, card_id, revision, root_contract_id, parent_contract_id, source_attempt_id, schema_version, contract_json, contract_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(contract.id, cardId, revision, rootContractId, rev?.parent_contract_id ?? null, rev?.source_attempt_id ?? null, contract.schema_version, JSON.stringify(contract), contract.digest, new Date().toISOString());
  }

  getContract(contractId: string): ContractRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_contracts WHERE id = ?`).get(contractId) as ContractRow | undefined;
  }

  getLatestContractForCard(cardId: number): ContractRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_contracts WHERE card_id = ? ORDER BY revision DESC LIMIT 1`).get(cardId) as ContractRow | undefined;
  }

  getContractByCardId(cardId: number): ContractRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_contracts WHERE card_id = ?`).get(cardId) as ContractRow | undefined;
  }

  contractExists(cardId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM worker_contracts WHERE card_id = ? LIMIT 1`).get(cardId);
    return row !== undefined;
  }

  getNextRevision(cardId: number): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(revision), 0) + 1 AS next_rev FROM worker_contracts WHERE card_id = ?`).get(cardId) as { next_rev: number } | undefined;
    return row?.next_rev ?? 1;
  }

  insertAttempt(attempt: {
    id: string;
    card_id: number;
    contract_id: string;
    ordinal: number;
    executor_kind: ExecutorKind;
    executor_id: string;
    remote_task_id?: number;
    status: string;
    started_at: string;
    /** #1644: immutable root project lineage; required for supervised project attempts. */
    root_project_card_id?: number | null;
    root_project_generation?: number | null;
    scheduled_run_id?: string | null;
  }): void {
    const lifecycle: AttemptLifecycle = attempt.status === "running"
      ? "running"
      : attempt.status === "settled" || attempt.status === "completed"
        ? "completed"
        : attempt.status === "failed"
          ? "failed"
          : attempt.status === "cancelled"
            ? "cancelled"
            : "pending";
    this.db.prepare(`
      INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, remote_task_id, status, lifecycle, started_at, root_project_card_id, root_project_generation, scheduled_run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(attempt.id, attempt.card_id, attempt.contract_id, attempt.ordinal, attempt.executor_kind, attempt.executor_id, attempt.remote_task_id ?? null, attempt.status, lifecycle, attempt.started_at, attempt.root_project_card_id ?? null, attempt.root_project_generation ?? null, attempt.scheduled_run_id ?? null);
  }

  getAttempt(attemptId: string): AttemptRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_attempts WHERE id = ?`).get(attemptId) as AttemptRow | undefined;
  }

  getAttemptsForCard(cardId: number): AttemptRow[] {
    return this.db.prepare(`SELECT * FROM worker_attempts WHERE card_id = ? ORDER BY ordinal ASC`).all(cardId) as unknown as AttemptRow[];
  }

  getLatestAttempt(cardId: number): AttemptRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_attempts WHERE card_id = ? ORDER BY ordinal DESC LIMIT 1`).get(cardId) as AttemptRow | undefined;
  }

  // ── #1644: attempt-bound project authority ─────────────────────────────

  /**
   * Resolve the immutable root authority an attempt row carries. Attempts
   * created after #1644 always carry lineage; legacy rows under a supervised
   * project root fail closed as `missing` — authority is never inferred later;
   * standalone (non-project) attempts are unaffected.
   */
  projectAuthorityForAttempt(
    attempt: Pick<AttemptRow, "card_id" | "root_project_card_id" | "root_project_generation" | "scheduled_run_id">,
  ): { kind: "authority"; authority: ProjectMutationAuthority } | { kind: "missing" } | { kind: "not_project" } {
    if (attempt.root_project_card_id != null && attempt.root_project_generation != null) {
      return {
        kind: "authority",
        authority: {
          projectCardId: attempt.root_project_card_id,
          projectGeneration: attempt.root_project_generation,
          scheduledRunId: attempt.scheduled_run_id ?? undefined,
        },
      };
    }
    if (cardIsSupervisedProjectChild(this.db, attempt.card_id)) return { kind: "missing" };
    return { kind: "not_project" };
  }

  /**
   * #1644: active-work authorization for one attempt on the caller's
   * connection — callers invoke it inside their transaction so the predicate
   * and the mutation are decided atomically. Emits exactly one bounded
   * rejection trace when the attempt is stale for its project root.
   */
  authorizeAttemptForProjectWork(
    attempt: Pick<AttemptRow, "card_id" | "root_project_card_id" | "root_project_generation" | "scheduled_run_id">,
    operation: string,
  ): ProjectAuthorityRejection | null {
    const resolved = this.projectAuthorityForAttempt(attempt);
    if (resolved.kind === "not_project") return null;
    if (resolved.kind === "missing") {
      emitProjectAuthorityRejection(operation, undefined, "missing_authority", { cardId: attempt.card_id });
      return "missing_authority";
    }
    const rejection = authorizeActiveProjectWork(this.db, resolved.authority);
    if (rejection) {
      emitProjectAuthorityRejection(operation, resolved.authority, rejection, { cardId: attempt.card_id });
    }
    return rejection;
  }

  // ── #1364: Lifecycle and claim operations ──────────────────────────────

  lifecycleTransition(
    attemptId: string,
    fromLifecycles: readonly AttemptLifecycle[],
    toLifecycle: AttemptLifecycle,
    extraSets?: Record<string, string | null>,
  ): boolean {
    const sets = ["lifecycle = ?"];
    const vals: unknown[] = [toLifecycle];
    if (extraSets) {
      for (const [k, v] of Object.entries(extraSets)) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    vals.push(attemptId);
    const placeholders = fromLifecycles.map(() => "?").join(",");
    const sql = `UPDATE worker_attempts SET ${sets.join(", ")} WHERE id = ? AND lifecycle IN (${placeholders})`;
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...vals, ...fromLifecycles);
    return result.changes > 0;
  }

  /** #1644: lifecycle mutations that can keep project work alive or accept a
   * result must decide authority and the CAS on the same database transaction. */
  private authorizedLifecycleTransition(
    attemptId: string,
    fromLifecycles: readonly AttemptLifecycle[],
    toLifecycle: AttemptLifecycle,
    operation: string,
    extraSets?: Record<string, string | null>,
  ): boolean {
    return this.db.transaction(() => {
      const attempt = this.getAttempt(attemptId);
      if (!attempt || !fromLifecycles.includes(attempt.lifecycle)) return false;
      if (this.authorizeAttemptForProjectWork(attempt, operation) !== null) return false;
      return this.lifecycleTransition(attemptId, fromLifecycles, toLifecycle, extraSets);
    });
  }

  claimAttempt(
    cardId: number,
    contractId: string,
    executorKind: ExecutorKind,
    executorId: string,
    generation: number,
    hardDeadlineAt?: string,
  ): ExecutionClaim | null {
    return this.db.transaction(() => {
      const latest = this.getLatestAttempt(cardId);
      if (!latest) return null;
      if (latest.lifecycle !== "pending") return null;
      // #1637: the pending attempt owns its executor identity. Claim validates
      // the stored pair and never rewrites either column with dispatch-resolved
      // values — dispatch or retry must not silently reroute an accepted contract.
      if (latest.executor_kind !== executorKind || latest.executor_id !== executorId) return null;
      // #1644: a supervised project attempt is claimable only while its root
      // project is live at its immutable generation/run.
      if (this.authorizeAttemptForProjectWork(latest, "attempt_claim") !== null) return null;

      const attemptId = latest.id;

      const claimedAt = new Date().toISOString();
      const claim: ExecutionClaim = {
        attemptId,
        cardId,
        contractId,
        executorKind,
        executorId,
        generation,
        claimedAt,
        hardDeadlineAt,
      };

      const updated = this.lifecycleTransition(attemptId, ["pending"], "claimed", {
        generation: String(generation),
        claimed_at: claimedAt,
        hard_deadline_at: hardDeadlineAt ?? null,
      });

      if (updated) {
        logSwarmTrace({ event: "attempt_claimed", card: cardId, attempt: attemptId, generation, executor: executorId });
      }

      return updated ? claim : null;
    });
  }

  /** Claim a scheduled retry and its budget reservation atomically. */
  claimRetryAttempt(
    cardId: number,
    attemptId: string,
    contractId: string,
    executorKind: ExecutorKind,
    executorId: string,
    generation: number,
    sourceAttemptId: string,
    hardDeadlineAt?: string,
  ): ExecutionClaim | null {
    try {
      return this.db.transaction(() => {
        const attempt = this.db.prepare(`
          SELECT id, card_id, contract_id, executor_kind, executor_id, lifecycle, source_attempt_id,
                 root_project_card_id, root_project_generation, scheduled_run_id
          FROM worker_attempts
          WHERE id = ? AND card_id = ?
            AND id = (SELECT id FROM worker_attempts WHERE card_id = ? ORDER BY ordinal DESC LIMIT 1)
        `).get(attemptId, cardId, cardId) as {
          id: string; card_id: number; contract_id: string; executor_kind: string; executor_id: string;
          lifecycle: AttemptLifecycle; source_attempt_id: string | null;
          root_project_card_id: number | null; root_project_generation: number | null; scheduled_run_id: string | null;
        } | undefined;
        if (!attempt || attempt.lifecycle !== "pending" ||
            attempt.contract_id !== contractId ||
            attempt.executor_kind !== executorKind ||
            attempt.executor_id !== executorId ||
            attempt.source_attempt_id !== sourceAttemptId) return null;
        // #1644: retries are claimable only while the root project is live at
        // the immutable generation/run the lineage carries.
        if (this.authorizeAttemptForProjectWork(attempt, "retry_claim") !== null) return null;

        const claimedAt = new Date().toISOString();
        const updated = this.db.prepare(`
          UPDATE worker_attempts
          SET lifecycle = 'claimed', claimed_at = ?, generation = ?, hard_deadline_at = ?
          WHERE id = ? AND lifecycle = 'pending'
        `).run(claimedAt, generation, hardDeadlineAt ?? null, attemptId);
        if (updated.changes !== 1) return null;

        const reservation = this.db.prepare(`
          UPDATE retry_budget_reservations
          SET status = 'claimed', updated_at = ?
          WHERE source_attempt_id = ? AND target_attempt_id = ? AND status = 'active'
        `).run(claimedAt, sourceAttemptId, attemptId);
        if (reservation.changes !== 1) throw new Error("retry reservation was not active");

        return { attemptId, cardId, contractId, executorKind, executorId, generation, claimedAt, hardDeadlineAt };
      });
    } catch {
      return null;
    }
  }

  markAttemptStartObservable(attemptId: string): boolean {
    return this.authorizedLifecycleTransition(attemptId, ["claimed"], "starting", "attempt_start");
  }

  // ── #1638: executor-neutral runtime resource binding ─────────────────────

  /** Durable (attempt, generation) -> (resource id, resource generation)
   * mapping. Requires the latest attempt with matching generation and
   * executor kind in claimed|starting. An exact repeated bind is idempotent;
   * any different tuple for an already-bound attempt conflicts. */
  bindExecutorResource(input: {
    attemptId: string;
    expectedAttemptGeneration: number;
    executorKind: ExecutorKind;
    resourceId: string;
    resourceGeneration: number;
    continuity: "initial" | "resumed" | "fresh";
  }): "bound" | "idempotent" | "stale" | "conflict" {
    return this.db.transaction(() => {
      const attempt = this.db.prepare(`SELECT id, card_id, generation, executor_kind, lifecycle, executor_resource_id, executor_resource_generation, root_project_card_id, root_project_generation, scheduled_run_id FROM worker_attempts WHERE id = ?`).get(input.attemptId) as {
        id: string; card_id: number; generation: number; executor_kind: string; lifecycle: AttemptLifecycle;
        executor_resource_id: string | null; executor_resource_generation: number | null;
        root_project_card_id: number | null; root_project_generation: number | null; scheduled_run_id: string | null;
      } | undefined;
      if (!attempt) return "stale";
      if (attempt.generation !== input.expectedAttemptGeneration) return "stale";
      if (attempt.executor_kind !== input.executorKind) return "conflict";
      if (attempt.lifecycle !== "claimed" && attempt.lifecycle !== "starting") return "stale";
      if (attempt.executor_resource_id !== null && attempt.executor_resource_generation !== null) {
        return attempt.executor_resource_id === input.resourceId
          && attempt.executor_resource_generation === input.resourceGeneration
          ? "idempotent" : "conflict";
      }
      if (this.authorizeAttemptForProjectWork(attempt, "executor_resource_bind") !== null) return "stale";
      const updated = this.db.prepare(`
        UPDATE worker_attempts
        SET executor_resource_id = ?, executor_resource_generation = ?, execution_continuity = ?
        WHERE id = ? AND generation = ? AND lifecycle IN ('claimed', 'starting') AND executor_resource_id IS NULL
      `).run(input.resourceId, input.resourceGeneration, input.continuity, input.attemptId, input.expectedAttemptGeneration);
      return updated.changes === 1 ? "bound" : "conflict";
    });
  }

  getExecutorResourceBinding(attemptId: string): { resourceId: string; resourceGeneration: number; continuity: "initial" | "resumed" | "fresh" } | undefined {
    const row = this.db.prepare(`
      SELECT executor_resource_id, executor_resource_generation, execution_continuity
      FROM worker_attempts WHERE id = ?
    `).get(attemptId) as { executor_resource_id: string | null; executor_resource_generation: number | null; execution_continuity: string | null } | undefined;
    if (!row || row.executor_resource_id === null || row.executor_resource_generation === null) return undefined;
    const continuity = row.execution_continuity === "resumed" ? "resumed" as const
      : row.execution_continuity === "fresh" ? "fresh" as const : "initial" as const;
    return { resourceId: row.executor_resource_id, resourceGeneration: row.executor_resource_generation, continuity };
  }

  getAttemptForExecutorResource(kind: ExecutorKind, id: string, generation: number): AttemptRow | undefined {
    return this.db.prepare(`
      SELECT * FROM worker_attempts
      WHERE executor_kind = ? AND executor_resource_id = ? AND executor_resource_generation = ?
      ORDER BY generation DESC LIMIT 1
    `).get(kind, id, generation) as AttemptRow | undefined;
  }

  markAttemptRunning(attemptId: string): boolean {
    const ok = this.authorizedLifecycleTransition(attemptId, ["claimed", "starting"], "running", "attempt_running");
    if (ok) {
      const attempt = this.getAttempt(attemptId);
      if (attempt) logSwarmTrace({ event: "attempt_running", card: attempt.card_id, attempt: attemptId, generation: attempt.generation, executor: attempt.executor_id });
    }
    return ok;
  }

  requestCancel(attemptId: string, reason: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running"], "cancel_requested", {
      cancel_reason: reason,
    });
  }

  /** #1644: cancel_worker owns both the child lifecycle and its card CAS.
   * The bound project authority is checked on this connection before either
   * mutation, so an Orc turn cannot fail a child after the root is terminal. */
  cancelProjectChild(
    cardId: number,
    authority: ProjectMutationAuthority,
    reason: string,
  ): boolean {
    return this.db.transaction(() => {
      const card = this.db.prepare(`SELECT parent_id, type, status FROM kanban_board WHERE id = ?`).get(cardId) as {
        parent_id: number | null;
        type: string | null;
        status: string;
      } | undefined;
      if (!card || card.parent_id !== authority.projectCardId || card.type !== "W") return false;
      if (card.status !== "queued" && card.status !== "running") return false;
      const rootRejection = authorizeActiveProjectWork(this.db, authority);
      if (rootRejection) {
        emitProjectAuthorityRejection("cancel_worker", authority, rootRejection, { cardId });
        return false;
      }

      const attempt = this.getLatestAttempt(cardId);
      if (!attempt) return false;
      if (this.authorizeAttemptForProjectWork(attempt, "cancel_worker") !== null) return false;

      if (attempt.lifecycle === "pending") {
        if (!this.cancelPendingAttempt(attempt.id, reason)) return false;
      } else if (attempt.lifecycle === "claimed" || attempt.lifecycle === "starting" || attempt.lifecycle === "running") {
        if (!this.requestCancel(attempt.id, reason)) return false;
      } else if (attempt.lifecycle !== "cancel_requested") {
        return false;
      }

      const outcome = kanbanTransition({
        cardId,
        from: ["queued", "running"],
        to: "failed",
        actor: "settle_failed",
        reason: reason.slice(0, 300),
        fields: { error: reason.slice(0, 1000), completed_at: new Date().toISOString() },
        emit: false,
      }, this.db);
      return outcome.kind === "applied" || outcome.kind === "reasserted";
    });
  }

  /** Cancel work that has not been claimed yet so it can never be dispatched. */
  cancelPendingAttempt(attemptId: string, reason: string): boolean {
    return this.lifecycleTransition(attemptId, ["pending"], "cancelled", {
      status: "cancelled",
      cancel_reason: reason,
      settled_at: new Date().toISOString(),
    });
  }

  completeAttempt(attemptId: string): boolean {
    const ok = this.authorizedLifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "completed", "attempt_complete", {
      status: "settled",
      settled_at: new Date().toISOString(),
    });
    if (ok) {
      const attempt = this.getAttempt(attemptId);
      if (attempt) {
        logSwarmTrace({ event: "attempt_completed", card: attempt.card_id, attempt: attemptId, generation: attempt.generation, to: "completed" });
      }
    }
    return ok;
  }

  failAttempt(attemptId: string): boolean {
    const ok = this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "failed", {
      status: "failed",
      settled_at: new Date().toISOString(),
    });
    if (ok) {
      const attempt = this.getAttempt(attemptId);
      if (attempt) {
        logSwarmTrace({ event: "attempt_failed", card: attempt.card_id, attempt: attemptId, generation: attempt.generation, to: "failed" });
      }
    }
    return ok;
  }

  cancelAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "cancelled", {
      status: "cancelled",
      settled_at: new Date().toISOString(),
    });
  }

  timeoutAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "timed_out", {
      status: "timed_out",
      settled_at: new Date().toISOString(),
    });
  }

  isAttemptTerminal(lifecycle: AttemptLifecycle): boolean {
    return lifecycle === "completed" || lifecycle === "failed" || lifecycle === "cancelled" || lifecycle === "timed_out";
  }

  hasLiveClaim(cardId: number): boolean {
    const latest = this.getLatestAttempt(cardId);
    if (!latest) return false;
    if (latest.lifecycle === "pending") return false;
    return !this.isAttemptTerminal(latest.lifecycle);
  }

  // ── Result persistence ─────────────────────────────────────────────────

  insertResult(attemptId: string, envelope: WorkerResultEnvelopeV1): void {
    const envelopeJson = JSON.stringify(envelope);
    const envelopeDigest = this.computeEnvelopeDigest(envelopeJson);
    this.db.prepare(`
      INSERT INTO worker_results (attempt_id, envelope_json, envelope_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(attemptId, envelopeJson, envelopeDigest, new Date().toISOString());
  }

  getResult(attemptId: string): ResultRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_results WHERE attempt_id = ?`).get(attemptId) as ResultRow | undefined;
  }

  getResultByAttempt(attemptId: string): { envelope: WorkerResultEnvelopeV1; envelopeDigest: string } | undefined {
    const row = this.getResult(attemptId);
    if (!row) return undefined;
    return { envelope: JSON.parse(row.envelope_json) as WorkerResultEnvelopeV1, envelopeDigest: row.envelope_digest };
  }

  replayResult(attemptId: string, envelopeDigest: string): { envelope: WorkerResultEnvelopeV1 } | "conflict" | undefined {
    const existing = this.getResult(attemptId);
    if (!existing) return undefined;
    if (existing.envelope_digest !== envelopeDigest) return "conflict";
    return { envelope: JSON.parse(existing.envelope_json) as WorkerResultEnvelopeV1 };
  }

  nextOrdinal(cardId: number): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal FROM worker_attempts WHERE card_id = ?`).get(cardId) as { next_ordinal: number } | undefined;
    return row?.next_ordinal ?? 1;
  }

  cardHasSettledAttempts(cardId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM worker_attempts WHERE card_id = ? AND status IN ('settled','failed') LIMIT 1`).get(cardId);
    return row !== undefined;
  }

  // ── Retry budget reservations ───────────────────────────────────────────

  insertReservation(reservation: {
    source_attempt_id: string;
    target_attempt_id: string;
    reserved_tokens: number;
    reserved_cost: number;
    reserved_switches: number;
  }): boolean {
    const now = new Date().toISOString();
    try {
      this.db.prepare(`
        INSERT INTO retry_budget_reservations (source_attempt_id, target_attempt_id, reserved_attempts, reserved_tokens, reserved_cost, reserved_switches, status, created_at, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, 'active', ?, ?)
      `).run(reservation.source_attempt_id, reservation.target_attempt_id, reservation.reserved_tokens, reservation.reserved_cost, reservation.reserved_switches, now, now);
      return true;
    } catch {
      return false;
    }
  }

  getReservation(sourceAttemptId: string): ReservationRow | undefined {
    return this.db.prepare(`SELECT * FROM retry_budget_reservations WHERE source_attempt_id = ?`).get(sourceAttemptId) as ReservationRow | undefined;
  }

  updateReservationStatus(sourceAttemptId: string, status: string): boolean {
    const result = this.db.prepare(`UPDATE retry_budget_reservations SET status = ?, updated_at = ? WHERE source_attempt_id = ?`).run(status, new Date().toISOString(), sourceAttemptId);
    return result.changes > 0;
  }

  getActiveReservationsForCard(cardId: number): ReservationRow[] {
    const attemptIds = this.db.prepare(`SELECT id FROM worker_attempts WHERE card_id = ?`).all(cardId) as Array<{ id: string }>;
    if (attemptIds.length === 0) return [];
    const ids = attemptIds.map(a => a.id);
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(`SELECT * FROM retry_budget_reservations WHERE source_attempt_id IN (${placeholders}) AND status IN ('active','claimed')`).all(...ids) as unknown as ReservationRow[];
  }

  private computeEnvelopeDigest(envelopeJson: string): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(envelopeJson, "utf-8").digest("hex");
  }

  /** #1588: a minimal result envelope for a non-completed terminal settlement. */
  private buildAbsenceEnvelope(attempt: AttemptRow, outcome: "failed" | "cancelled" | "timed_out", now: number): WorkerResultEnvelopeV1 {
    const contractRow = this.getContract(attempt.contract_id);
    let criteria: Array<{ criterion_id: string; status: "not_run"; evidence_ids: readonly string[] }> = [];
    if (contractRow) {
      try {
        const contract = JSON.parse(contractRow.contract_json) as unknown;
        if (typeof contract === "object" && contract !== null && Array.isArray((contract as { criteria?: unknown })["criteria"])) {
          criteria = ((contract as { criteria: unknown[] })["criteria"])
            .filter((criterion): criterion is { id: string } =>
              typeof criterion === "object" && criterion !== null && typeof (criterion as { id?: unknown })["id"] === "string")
            .map((c) => ({ criterion_id: c.id, status: "not_run" as const, evidence_ids: [] }));
        }
      } catch { /* contract unreadable — empty criteria */ }
    }
    return {
      schema_version: 1,
      attempt: {
        id: attempt.id,
        ordinal: attempt.ordinal,
        contract_id: attempt.contract_id,
        contract_digest: contractRow?.contract_digest ?? "",
        executor_kind: attempt.executor_kind,
        executor_id: attempt.executor_id,
        started_at: attempt.started_at,
        finished_at: new Date(now).toISOString(),
      },
      outcome,
      criteria,
      checks: [],
      artifacts: [],
      worker_report: { summary: `settled ${outcome} without a worker result`, claims: [], unresolved_risks: [] },
    };
  }

  // ── #1510: Atomic capacity-and-budget-guarded claim ─────────────────────

  // ── #1638: proven-no-start deferral ─────────────────────────────────────

  /**
   * #1638 — Atomically return a `starting` attempt to `pending` after the
   * adapter proved no process was started (typed `provesNoStart` observation).
   * CAS requires the latest matching attempt generation in `starting`, then:
   * - returns lifecycle/status to `pending`;
   * - clears claimed_at, hard_deadline_at, and reservation accounting;
   * - closes the executor lease with `deferred:<reason>`;
   * - flips this attempt's retry reservation `claimed` -> `active` if one
   *   exists (state hygiene, not budget accounting — the attempt is never
   *   settled, so retry budget is preserved by non-settlement);
   * - leaves the card queued and attempt ordinal/generation unchanged.
   * Never settles the attempt; never consumes retry budget.
   */
  deferClaimAfterProvenNoStart(input: {
    attemptId: string;
    expectedGeneration: number;
    reason: "capacity" | "resource_busy";
  }): "deferred" | "stale" | "conflict" {
    try {
      return this.db.transaction(() => {
        const attempt = this.db.prepare(`SELECT * FROM worker_attempts WHERE id = ?`).get(input.attemptId) as AttemptRow | undefined;
        if (!attempt) return "stale";
        const latest = this.db.prepare(`SELECT id FROM worker_attempts WHERE card_id = ? ORDER BY ordinal DESC LIMIT 1`).get(attempt.card_id) as { id: string } | undefined;
        if (!latest || latest.id !== input.attemptId) return "stale";
        if (attempt.generation !== input.expectedGeneration) return "stale";
        if (attempt.lifecycle !== "starting") return "stale";
        // Returning a live claim to pending is still project work. A terminal
        // root must win before this requeue mutation, otherwise a stale
        // adapter could create a fresh dispatch opportunity after invalidation.
        if (this.authorizeAttemptForProjectWork(attempt, "attempt_defer") !== null) return "stale";

        const updated = this.db.prepare(`
          UPDATE worker_attempts
          SET lifecycle = 'pending', status = 'pending',
              claimed_at = NULL, hard_deadline_at = NULL,
              reserved_tokens = 0, earliest_claim_at = NULL
          WHERE id = ? AND lifecycle = 'starting'
        `).run(input.attemptId);
        if (updated.changes !== 1) return "conflict";

        const leaseStore = new ExecutorLeaseStore(this.db);
        leaseStore.closeLease(input.attemptId, attempt.generation, `deferred:${input.reason}`);

        if (attempt.source_attempt_id) {
          this.db.prepare(`
            UPDATE retry_budget_reservations SET status = 'active', updated_at = datetime('now')
            WHERE source_attempt_id = ? AND target_attempt_id = ? AND status = 'claimed'
          `).run(attempt.source_attempt_id, input.attemptId);
        }

        logSwarmTrace({ event: "attempt_deferred", card: attempt.card_id, attempt: input.attemptId, generation: attempt.generation, reason: input.reason });
        return "deferred";
      });
    } catch {
      return "conflict";
    }
  }

  getActiveAttemptCountForExecutor(executorKind: ExecutorKind, executorId: string): number {
    const sql = `
      SELECT COUNT(*) AS cnt FROM worker_attempts
      WHERE executor_kind = ? AND executor_id = ?
        AND lifecycle IN ('claimed','starting','running','cancel_requested')
    `;
    const row = this.db.prepare(sql).get(executorKind, executorId) as { cnt: number };
    return row?.cnt ?? 0;
  }

  getActiveAttemptsForExecutor(executorKind: ExecutorKind, executorId: string): AttemptRow[] {
    return this.db.prepare(`
      SELECT * FROM worker_attempts
      WHERE executor_kind = ? AND executor_id = ?
        AND lifecycle IN ('claimed','starting','running','cancel_requested')
      ORDER BY ordinal ASC
    `).all(executorKind, executorId) as unknown as AttemptRow[];
  }

  getActiveReservedTokensForProject(projectId: number): number {
    const sql = `
      SELECT COALESCE(SUM(wa.reserved_tokens), 0) AS total
      FROM kanban_board k
      JOIN worker_attempts wa ON wa.card_id = k.id
      WHERE k.parent_id = ? AND wa.lifecycle IN ('claimed','starting','running','cancel_requested')
    `;
    const row = this.db.prepare(sql).get(projectId) as { total: number };
    return row?.total ?? 0;
  }

  getActiveAttemptsForProject(projectId: number): AttemptRow[] {
    return this.db.prepare(`
      SELECT wa.* FROM worker_attempts wa
      JOIN kanban_board k ON k.id = wa.card_id
      WHERE k.parent_id = ? AND wa.lifecycle IN ('claimed','starting','running','cancel_requested')
      ORDER BY wa.ordinal ASC
    `).all(projectId) as unknown as AttemptRow[];
  }

  isCardLatestAttempt(cardId: number, attemptId: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 FROM worker_attempts
      WHERE card_id = ? AND id = ? AND ordinal = (SELECT MAX(ordinal) FROM worker_attempts WHERE card_id = ?)
    `).get(cardId, attemptId, cardId);
    return row !== undefined;
  }

  getProjectCard(projectId: number): { max_tokens: number | null; tokens_used: number; status: string } | undefined {
    const row = this.db.prepare(`
      SELECT max_tokens, COALESCE(tokens_used, 0) AS tokens_used, status
      FROM kanban_board WHERE id = ?
    `).get(projectId) as { max_tokens: number | null; tokens_used: number; status: string } | undefined;
    return row;
  }

  claimAttemptWithinLimits(input: {
    cardId: number;
    attemptId: string;
    contractId: string;
    executorKind: ExecutorKind;
    executorId: string;
    generation: number;
    executorMax: number;
    hardDeadlineAt?: string;
    reservedTokens: number;
    projectId: number;
    sourceAttemptId?: string;
  }): { kind: "claimed"; claim: ExecutionClaim } | { kind: string; reason: string } {
    try {
      return this.db.transaction(() => {
        const attempt = this.db.prepare(`
          SELECT id, card_id, lifecycle, ordinal, executor_kind, executor_id,
                 root_project_card_id, root_project_generation, scheduled_run_id
          FROM worker_attempts
          WHERE id = ? AND card_id = ?
        `).get(input.attemptId, input.cardId) as { id: string; card_id: number; lifecycle: AttemptLifecycle; ordinal: number; executor_kind: string; executor_id: string; root_project_card_id: number | null; root_project_generation: number | null; scheduled_run_id: string | null } | undefined;
        if (!attempt) return { kind: "stale", reason: "attempt not found" };
        if (attempt.lifecycle !== "pending") return { kind: "stale", reason: `attempt lifecycle is ${attempt.lifecycle}` };
        if (!this.isCardLatestAttempt(input.cardId, input.attemptId)) return { kind: "stale", reason: "not latest attempt" };
        // #1644: a supervised project attempt is claimable only while its root
        // project is live at its immutable generation/run.
        const authorityRejection = this.authorizeAttemptForProjectWork(attempt, "attempt_claim");
        if (authorityRejection !== null) return { kind: "stale", reason: authorityRejection };
        // #1637: the pending attempt owns its executor identity. Claim
        // validates the stored pair; dispatch resolution is never permission
        // to rewrite the attempt's executor kind or ID.
        if (!isExecutorKind(attempt.executor_kind) ||
            attempt.executor_kind !== input.executorKind ||
            attempt.executor_id !== input.executorId) {
          return { kind: "executor_mismatch", reason: `attempt is ${attempt.executor_kind}/${attempt.executor_id}, requested ${input.executorKind}/${input.executorId}` };
        }

        const card = this.db.prepare(`
          SELECT status, parent_id FROM kanban_board WHERE id = ?
        `).get(input.cardId) as { status: string; parent_id: number | null } | undefined;
        if (!card || card.status !== "queued") return { kind: "card_not_queued", reason: `card status is ${card?.status}` };

        if (card.parent_id !== input.projectId) return { kind: "project_mismatch", reason: "card parent is not expected project" };

        const project = this.getProjectCard(input.projectId);
        if (!project || project.status !== "running") return { kind: "project_not_running", reason: `project status is ${project?.status}` };

        let supervision: { state: string } | undefined;
        try {
          supervision = this.db.prepare(`
            SELECT state FROM project_supervision WHERE project_card_id = ?
          `).get(input.projectId) as { state: string } | undefined;
        } catch {
          // Older/test databases do not have project supervision yet. The
          // project status and contract admission checks remain authoritative
          // for those databases.
        }
        if (supervision && supervision.state !== "executing" && supervision.state !== "repairing") {
          return { kind: "project_supervision_not_dispatchable", reason: `project supervision state is ${supervision.state}` };
        }

        const activeCount = this.getActiveAttemptCountForExecutor(input.executorKind, input.executorId);
        if (activeCount >= input.executorMax) return { kind: "capacity_full", reason: `active ${activeCount} >= max ${input.executorMax}` };

        if (input.hardDeadlineAt && new Date(input.hardDeadlineAt).getTime() <= Date.now()) return { kind: "deadline_expired", reason: "hard deadline already passed" };

        if (project.max_tokens != null) {
          if (!Number.isFinite(input.reservedTokens) || input.reservedTokens <= 0) {
            return { kind: "budget_reservation_missing", reason: "capped project requires a positive worker token reservation" };
          }
          const activeReserved = this.getActiveReservedTokensForProject(input.projectId);
          const committed = project.tokens_used;
          if (committed >= project.max_tokens) return { kind: "budget_exhausted", reason: `committed ${committed} >= cap ${project.max_tokens}` };
          if (committed + activeReserved + input.reservedTokens > project.max_tokens) return { kind: "budget_wait", reason: `committed ${committed} + active ${activeReserved} + candidate ${input.reservedTokens} > cap ${project.max_tokens}` };
        }

        if (input.sourceAttemptId) {
          const reservation = this.db.prepare(`
            SELECT status FROM retry_budget_reservations
            WHERE source_attempt_id = ? AND target_attempt_id = ? AND status = 'active'
          `).get(input.sourceAttemptId, input.attemptId) as { status: string } | undefined;
          if (!reservation) return { kind: "retry_reservation_missing", reason: "retry reservation not active" };
        }

        const claimedAt = new Date().toISOString();
        const updated = this.db.prepare(`
          UPDATE worker_attempts
          SET lifecycle = 'claimed', claimed_at = ?, generation = ?,
              hard_deadline_at = ?, reserved_tokens = ?
          WHERE id = ? AND lifecycle = 'pending'
        `).run(claimedAt, input.generation,
              input.hardDeadlineAt ?? null, input.reservedTokens, input.attemptId);
        if (updated.changes !== 1) return { kind: "claim_failed", reason: "update did not match" };

        if (input.sourceAttemptId) {
          this.db.prepare(`
            UPDATE retry_budget_reservations SET status = 'claimed', updated_at = ?
            WHERE source_attempt_id = ? AND target_attempt_id = ? AND status = 'active'
          `).run(claimedAt, input.sourceAttemptId, input.attemptId);
        }

        const claim: ExecutionClaim = {
          attemptId: input.attemptId,
          cardId: input.cardId,
          contractId: input.contractId,
          executorKind: input.executorKind,
          executorId: input.executorId,
          generation: input.generation,
          claimedAt,
          hardDeadlineAt: input.hardDeadlineAt,
        };
        logSwarmTrace({ event: "attempt_claimed", card: input.cardId, attempt: input.attemptId, generation: input.generation, executor: input.executorId });
        return { kind: "claimed", claim };
      });
    } catch {
      return { kind: "internal_error", reason: "transaction failed" };
    }
  }

  // ── #1510: Single terminal settlement primitive ─────────────────────────

  /** Public terminal-settlement wrapper — opens one transaction around the
   * canonical body. */
  /** #1720 — Bounded tolerance for completions that reach settlement just
   * past their hard deadline. Workers pace to the announced budget, so
   * genuine completions cluster at the boundary; event-loop jitter must not
   * discard paid-for evidence. Proportional to the lane's own contract
   * budget and capped; falls back small when no usable duration exists. */
  private completionGraceMs(attempt: AttemptRow): number {
    try {
      const row = this.getContract(attempt.contract_id);
      const parsed = row ? JSON.parse(row.contract_json) as { limits?: { max_duration_ms?: unknown } } | null : null;
      const duration = parsed?.limits?.max_duration_ms;
      if (typeof duration !== "number" || !Number.isFinite(duration) || !Number.isInteger(duration) || duration <= 0) {
        return FALLBACK_COMPLETION_GRACE_MS;
      }
      return Math.min(duration * 0.01, MAX_COMPLETION_GRACE_MS);
    } catch {
      return FALLBACK_COMPLETION_GRACE_MS;
    }
  }

  terminalSettlement(input: {
    attemptId: string;
    expectedGeneration: number;
    desiredState: "completed" | "failed" | "cancelled" | "timed_out";
    stableReason: string;
    normalizedUsage?: { input: number; output: number; trustworthy: boolean };
    envelope?: WorkerResultEnvelopeV1;
    now?: number;
    terminalCause?: "input_requested";
  }): { kind: "settled" | "replayed" | "stale" | "conflict" | "budget_violation"; lifecycle?: AttemptLifecycle; chargedTokens?: number } {
    try {
      return this.db.transaction(() => this.settleAttemptInTransaction(input));
    } catch {
      return { kind: "conflict" };
    }
  }

  /** #1638 — The canonical single terminal-settlement body. Runs INSIDE an
   * already-open transaction (the public wrapper or the supervised Pi
   * settlement coordinator). Owns every attempt terminal transition, charge,
   * result persistence, lease close, and card token rollup. When the caller
   * supplies a valid envelope on a non-completed outcome, it is persisted;
   * the evidence-of-absence envelope remains the fallback. */
  settleAttemptInTransaction(input: {
    attemptId: string;
    expectedGeneration: number;
    desiredState: "completed" | "failed" | "cancelled" | "timed_out";
    stableReason: string;
    normalizedUsage?: { input: number; output: number; trustworthy: boolean };
    envelope?: WorkerResultEnvelopeV1;
    now?: number;
    /** #1638: semantic terminal cause. `input_requested` always charges zero
     * tokens and releases the reservation — never a caller-selected billing
     * policy. */
    terminalCause?: "input_requested";
  }): { kind: "settled" | "replayed" | "stale" | "conflict" | "budget_violation"; lifecycle?: AttemptLifecycle; chargedTokens?: number } {
    const attempt = this.db.prepare(`SELECT * FROM worker_attempts WHERE id = ?`).get(input.attemptId) as AttemptRow | undefined;
    if (!attempt) return { kind: "stale" };
    const latest = this.db.prepare(`SELECT id FROM worker_attempts WHERE card_id = ? ORDER BY ordinal DESC LIMIT 1`).get(attempt.card_id) as { id: string } | undefined;
    if (!latest || latest.id !== input.attemptId) return { kind: "stale" };
    if (attempt.generation !== input.expectedGeneration) return { kind: "stale" };

    const terminalLifecycles: AttemptLifecycle[] = ["completed", "failed", "cancelled", "timed_out"];
    if (terminalLifecycles.includes(attempt.lifecycle)) {
      if (input.envelope) {
        const existing = this.db.prepare(`SELECT envelope_digest FROM worker_results WHERE attempt_id = ?`).get(input.attemptId) as { envelope_digest: string } | undefined;
        if (!existing) return { kind: "stale", lifecycle: attempt.lifecycle };
        if (existing) {
          const newDigest = this.computeEnvelopeDigest(JSON.stringify(input.envelope));
          if (existing.envelope_digest !== newDigest) return { kind: "conflict" };
        }
      }
      return { kind: "replayed", lifecycle: attempt.lifecycle, chargedTokens: attempt.charged_tokens };
    }

    // #1644: a supervised project attempt is ACCEPTED only while its root
    // project is live at its immutable generation/run. A late completed result
    // for a terminal root is rejected before usage charging, result insertion,
    // lease closure, or any card mutation. Replays of an already-terminal
    // attempt are inert and intentionally bypass this fence (idempotent,
    // cannot alter state). Cleanup settlements (failed/cancelled/timed_out)
    // are not fenced: they cannot accept a result or resurrect the root, and
    // the abort path must be able to cancel live children after the root
    // freezes terminal (R3).
    if (input.desiredState === "completed") {
      if (this.authorizeAttemptForProjectWork(attempt, "attempt_settlement") !== null) {
        return { kind: "stale", lifecycle: attempt.lifecycle };
      }
    }

    const allowedFrom: AttemptLifecycle[] = input.desiredState === "timed_out" || input.desiredState === "cancelled"
      ? ["pending", "claimed", "starting", "running", "cancel_requested"]
      : ["claimed", "starting", "running", "cancel_requested"];
    if (!allowedFrom.includes(attempt.lifecycle)) return { kind: "stale" };

    let effectiveState = input.desiredState;
    const now = input.now ?? Date.now();

    if (input.desiredState === "completed" && attempt.hard_deadline_at) {
      // #1720: a completion that reaches settlement just past its hard
      // deadline is real, evidenced work; discard it only beyond a bounded
      // grace window. Without an envelope there is no grace at any lateness.
      const latenessMs = now - new Date(attempt.hard_deadline_at).getTime();
      const withinGrace = input.envelope !== undefined && latenessMs <= this.completionGraceMs(attempt);
      if (latenessMs >= 0 && !withinGrace) {
        effectiveState = "timed_out";
      }
    }

    const usage = input.normalizedUsage
      && Number.isFinite(input.normalizedUsage.input) && input.normalizedUsage.input >= 0
      && Number.isFinite(input.normalizedUsage.output) && input.normalizedUsage.output >= 0
      ? input.normalizedUsage
      : undefined;
    let chargeTokens = 0;
    let budgetViolation = false;

    // #1638: input_requested is semantic — the worker stopped to ask a live
    // question; it always charges zero and releases its reservation.
    if (input.terminalCause === "input_requested") {
      chargeTokens = 0;
    } else if (attempt.reserved_tokens > 0) {
      if (usage && usage.trustworthy) {
        chargeTokens = usage.input + usage.output;
        if (chargeTokens > attempt.reserved_tokens) {
          chargeTokens = usage.input + usage.output;
          budgetViolation = true;
        }
      } else {
        chargeTokens = attempt.reserved_tokens;
      }
    } else if (usage && usage.trustworthy) {
      chargeTokens = usage.input + usage.output;
    }

    if (budgetViolation && effectiveState === "completed") {
      effectiveState = "failed";
    }

    const settledAt = new Date(now).toISOString();

    if (attempt.usage_charged_at == null) {
      this.db.prepare(`
        UPDATE worker_attempts
        SET input_tokens = ?, output_tokens = ?, charged_tokens = ?, usage_charged_at = ?
        WHERE id = ? AND usage_charged_at IS NULL
      `).run(usage?.input ?? null, usage?.output ?? null, chargeTokens, settledAt, input.attemptId);

      const card = this.db.prepare(`SELECT parent_id FROM kanban_board WHERE id = ?`).get(attempt.card_id) as { parent_id: number | null } | undefined;
      this.db.prepare(`
        UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(chargeTokens, attempt.card_id);
      if (card?.parent_id) {
        this.db.prepare(`
          UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now')
          WHERE id = ? AND type = 'O'
        `).run(chargeTokens, card.parent_id);
      }
    }

    const durableStatus = effectiveState === "completed" ? "settled" : effectiveState;
    this.db.prepare(`
      UPDATE worker_attempts
      SET lifecycle = ?, status = ?, settled_at = ?, cancel_reason = ?
      WHERE id = ? AND lifecycle = ?
    `).run(effectiveState, durableStatus, settledAt,
          budgetViolation ? `token_budget_exceeded: ${input.stableReason}`
            : effectiveState !== input.desiredState ? `late_completion_timed_out: ${input.stableReason}` : input.stableReason,
          input.attemptId, attempt.lifecycle);

    const leaseStore = new ExecutorLeaseStore(this.db);
    leaseStore.closeLease(input.attemptId, attempt.generation, `terminal:${effectiveState}`);

    // A terminal attempt can no longer hold retry budget. In particular,
    // input_requested must release the reservation without consuming it;
    // ordinary terminal outcomes consume the reservation exactly once.
    this.db.prepare(`
      UPDATE retry_budget_reservations
      SET status = ?, updated_at = datetime('now')
      WHERE target_attempt_id = ? AND status IN ('active', 'claimed')
    `).run(input.terminalCause === "input_requested" ? "released" : "consumed", input.attemptId);

    if (effectiveState === "completed" && input.envelope) {
      const existingResult = this.db.prepare(`SELECT 1 FROM worker_results WHERE attempt_id = ?`).get(input.attemptId);
      if (!existingResult) {
        this.insertResult(input.attemptId, input.envelope);
      }
    } else if (effectiveState === "failed" || effectiveState === "cancelled" || effectiveState === "timed_out") {
      // #1588/#1638: persist genuine failure evidence when the caller
      // supplied a valid envelope (e.g. a Pi input request); the absence
      // envelope remains the fallback so results are never empty. The
      // reviewer can distinguish "no evidence" from "evidence says failed".
      const existingResult = this.db.prepare(`SELECT 1 FROM worker_results WHERE attempt_id = ?`).get(input.attemptId);
      if (!existingResult) {
        this.insertResult(input.attemptId, input.envelope ?? this.buildAbsenceEnvelope(attempt, effectiveState, now));
      }
    }

    logSwarmTrace({ event: `attempt_${effectiveState}`, card: attempt.card_id, attempt: input.attemptId, generation: attempt.generation, to: effectiveState, reason: input.stableReason });

    const violationResult = budgetViolation
      ? { kind: "budget_violation" as const, lifecycle: effectiveState, chargedTokens: chargeTokens, cardId: attempt.card_id }
      : { kind: "settled" as const, lifecycle: effectiveState, chargedTokens: chargeTokens, cardId: attempt.card_id };
    return violationResult;
  }

  getActiveSupervisedAttempts(): AttemptRow[] {
    return this.db.prepare(`
      SELECT wa.* FROM worker_attempts wa
      JOIN kanban_board k ON k.id = wa.card_id
      WHERE k.type IS NOT NULL AND k.type != 'O'
        AND wa.lifecycle IN ('claimed','starting','running','cancel_requested')
      ORDER BY wa.card_id, wa.ordinal
    `).all() as unknown as AttemptRow[];
  }

  /**
   * #1551 — Prune telemetry for attempts that settled more than
   * `olderThanDays` ago, restricted to the tables this store owns
   * (worker_attempts, worker_results, retry_budget_reservations).
   * worker_attempts.lifecycle + settled_at is the single terminality
   * predicate (#1510); worker_results and retry_budget_reservations are
   * keyed off an attempt id, so one terminal-attempt-id subquery drives
   * every delete here. RetryStore.pruneTerminalAttempts is the companion
   * for the retry_* tables it owns — see prunePiCommands's caller in
   * heartbeat-housekeeping.ts for why the two are not merged into one method.
   *
   * First DELETE statements ever run against these tables — deliberately
   * conservative (age-gated, terminal-only) rather than a blanket sweep.
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
    deleted += this.db.prepare(`DELETE FROM worker_results WHERE attempt_id IN (${terminalAttempts})`).run().changes;
    deleted += this.db.prepare(`
      DELETE FROM retry_budget_reservations
      WHERE status IN ('released','consumed')
        AND updated_at < ${cutoff}
        AND (source_attempt_id IN (${terminalAttempts}) OR target_attempt_id IN (${terminalAttempts}))
    `).run().changes;
    // Attempts themselves prune last so the subqueries above still resolve them.
    deleted += this.db.prepare(`DELETE FROM worker_attempts WHERE id IN (${terminalAttempts})`).run().changes;
    return deleted;
  }
}
