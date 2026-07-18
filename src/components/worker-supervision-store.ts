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
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_contracts (
        id TEXT PRIMARY KEY,
        card_id INTEGER UNIQUE NOT NULL,
        schema_version INTEGER NOT NULL,
        contract_json TEXT NOT NULL,
        contract_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        UNIQUE(card_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS worker_results (
        attempt_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        envelope_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    // Safe migration: add columns if they don't exist
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN generation INTEGER DEFAULT 1`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'pending'`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN claimed_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN hard_deadline_at TEXT`); } catch {}
    try { db.exec(`ALTER TABLE worker_attempts ADD COLUMN cancel_reason TEXT`); } catch {}
  }

  insertContract(contract: WorkerAcceptanceContractV1, cardId: number): void {
    this.db.prepare(`
      INSERT INTO worker_contracts (id, card_id, schema_version, contract_json, contract_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(contract.id, cardId, contract.schema_version, JSON.stringify(contract), contract.digest, new Date().toISOString());
  }

  getContract(contractId: string): ContractRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_contracts WHERE id = ?`).get(contractId) as ContractRow | undefined;
  }

  getContractByCardId(cardId: number): ContractRow | undefined {
    return this.db.prepare(`SELECT * FROM worker_contracts WHERE card_id = ?`).get(cardId) as ContractRow | undefined;
  }

  contractExists(cardId: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM worker_contracts WHERE card_id = ?`).get(cardId);
    return row !== undefined;
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
    this.db.prepare(`
      INSERT INTO worker_attempts (id, card_id, contract_id, ordinal, executor_kind, executor_id, remote_task_id, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(attempt.id, attempt.card_id, attempt.contract_id, attempt.ordinal, attempt.executor_kind, attempt.executor_id, attempt.remote_task_id ?? null, attempt.status, attempt.started_at);
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

  settleAttempt(attemptId: string, status: string): void {
    this.db.prepare(`UPDATE worker_attempts SET status = ?, settled_at = ? WHERE id = ?`).run(status, new Date().toISOString(), attemptId);
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

  completeAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "completed");
  }

  failAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "failed");
  }

  cancelAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "cancelled");
  }

  timeoutAttempt(attemptId: string): boolean {
    return this.lifecycleTransition(attemptId, ["claimed", "starting", "running", "cancel_requested"], "timed_out");
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

  private computeEnvelopeDigest(envelopeJson: string): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    return createHash("sha256").update(envelopeJson, "utf-8").digest("hex");
  }
}

export enum SettlementResult {
  Settled = "settled",
  Replayed = "replayed",
  Conflict = "conflict",
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
    store.insertResult(attemptId, envelope);
    store.settleAttempt(attemptId, status);
    return SettlementResult.Settled;
  });
}
