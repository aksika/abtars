import { requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";
import type { WorkerAcceptanceContractV1, WorkerResultEnvelopeV1 } from "./worker-contract.js";

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

export type ExecutorKind = "agent" | "pi" | "remote";

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
  executor_kind: string;
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
        try { db.exec(`DROP INDEX IF EXISTS sqlite_autoindex_worker_contracts_1`); } catch {}
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

    // Safe migration: add columns if they don't exist
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN generation INTEGER DEFAULT 1`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'pending'`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN claimed_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN hard_deadline_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN cancel_reason TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN source_attempt_id TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN retry_directive_id TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN earliest_claim_at TEXT`); } catch {}
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
    executor_kind: string;
    executor_id: string;
    remote_task_id?: number;
    status: string;
    started_at: string;
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
      INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, remote_task_id, status, lifecycle, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(attempt.id, attempt.card_id, attempt.contract_id, attempt.ordinal, attempt.executor_kind, attempt.executor_id, attempt.remote_task_id ?? null, attempt.status, lifecycle, attempt.started_at);
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

  settleAttempt(attemptId: string, status: string): boolean {
    if (status === "settled" || status === "completed") return this.completeAttempt(attemptId);
    if (status === "cancelled") return this.cancelAttempt(attemptId);
    if (status === "timed_out") return this.timeoutAttempt(attemptId);
    return this.failAttempt(attemptId);
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

  claimAttempt(
    cardId: number,
    contractId: string,
    executorKind: ExecutorKind,
    executorId: string,
    generation: number,
    hardDeadlineAt?: string,
  ): ExecutionClaim | null {
    const latest = this.getLatestAttempt(cardId);
    if (!latest) return null;
    if (latest.lifecycle !== "pending") return null;

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
      executor_kind: executorKind,
      executor_id: executorId,
      generation: String(generation),
      claimed_at: claimedAt,
      hard_deadline_at: hardDeadlineAt ?? null,
    });

    return updated ? claim : null;
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
          SELECT id, contract_id, executor_kind, executor_id, lifecycle, source_attempt_id
          FROM worker_attempts
          WHERE id = ? AND card_id = ?
            AND id = (SELECT id FROM worker_attempts WHERE card_id = ? ORDER BY ordinal DESC LIMIT 1)
        `).get(attemptId, cardId, cardId) as {
          id: string; contract_id: string; executor_kind: string; executor_id: string;
          lifecycle: AttemptLifecycle; source_attempt_id: string | null;
        } | undefined;
        if (!attempt || attempt.lifecycle !== "pending" ||
            attempt.contract_id !== contractId ||
            attempt.executor_kind !== executorKind ||
            attempt.executor_id !== executorId ||
            attempt.source_attempt_id !== sourceAttemptId) return null;

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
    return this.lifecycleTransition(attemptId, ["claimed"], "starting");
  }

  markAttemptRunning(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting"], "running");
  }

  requestCancel(attemptId: string, reason: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running"], "cancel_requested", {
      cancel_reason: reason,
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
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "completed", {
      status: "settled",
      settled_at: new Date().toISOString(),
    });
  }

  failAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "failed", {
      status: "failed",
      settled_at: new Date().toISOString(),
    });
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
}

export enum SettlementResult {
  Settled = "settled",
  Replayed = "replayed",
  Conflict = "conflict",
  Rejected = "rejected",
}

function envelopeDigest(envelope: WorkerResultEnvelopeV1): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(JSON.stringify(envelope), "utf-8").digest("hex");
}

export function settleResult(
  store: WorkerSupervisionStore,
  attemptId: string,
  envelope: WorkerResultEnvelopeV1,
  status: string,
): SettlementResult {
  return store.db.transaction(() => {
    const existing = store.getResult(attemptId);
    if (existing) {
      const digest = envelopeDigest(envelope);
      const replayed = store.replayResult(attemptId, digest);
      if (replayed === "conflict") return SettlementResult.Conflict;
      return SettlementResult.Replayed;
    }
    const settled = store.settleAttempt(attemptId, status);
    if (!settled) return SettlementResult.Rejected;
    store.insertResult(attemptId, envelope);
    return SettlementResult.Settled;
  });
}
