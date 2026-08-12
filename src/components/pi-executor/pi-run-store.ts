import { randomUUID } from "node:crypto";
import type { PiRunRecord, PiRunStatus, PiRunView, PiRunOrigin, PiPendingRequestType, ResumeCapability, PendingUiClaim, PendingUiSetResult } from "./types.js";
import type { UiReplyOutcome } from "./types.js";
import { MAX_PROGRESS_ENTRIES } from "./types.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { kanbanTransition, sqliteNow } from "../tasks/kanban-board.js";
import { completePendingRequestInTransaction, ensureRequestLedgerSchema } from "../pi-request-ledger.js";
import { validatePersistedSession, type SessionProof } from "./config.js";

export type RpcDelivery = "not_written" | "written_unacknowledged";

export interface PiRunStoreDeps {
  db: TaskDatabase;
  /** Configured Pi session storage root — the store validates persisted
   * session targets authoritatively (resume admission, boot recovery). */
  sessionStorageRoot: string;
}

/**
 * #1358 review — In-transaction lifecycle event emission seam (mechanism A).
 *
 * The store calls `emitTransitionInTx` INSIDE the same transaction that
 * applies a public run transition, for delegated runs (origin_peer set).
 * If the transaction aborts, neither the transition nor the event exists;
 * if it commits, the event is durable before the caller can observe the
 * transition. This is the durability contract of spec #1358: snapshot
 * scanning is projection repair only and is never the event-durability
 * mechanism.
 *
 * The callback must be synchronous and must not open its own transaction
 * (it runs inside the caller's). It may read run state through the store —
 * the same connection sees the transaction's uncommitted writes.
 */
export interface RemotePiTransitionEmitter {
  emitTransitionInTx(input: {
    runId: string;
    fromStatus: string | undefined;
    toStatus: string;
    /** Set when the transition bumps execution_generation (resume). */
    newGeneration?: number;
  }): void;
}

// #1393 — Input for atomic card+run creation.
export interface CreatePiRunInput {
  runId: string;
  sessionId: string;
  title: string;
  goal: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  workspaceAlias: string;
  ownerPrincipalId: string;
  origin: PiRunOrigin;
  originPlatform?: string;
  originChatId?: string;
  originPeer?: string;
  originRequestId?: string;
  deliveryPolicy?: "leave_remote" | "patch_artifact" | "commit_push";
  modelProvider?: string;
  modelId?: string;
  thinking?: string;
  idempotency?: {
    clientId: string;
    operation: string;
    requestId: string;
    requestHash: string;
  };
}

// #1396 — Canonical terminal outcome mapping
export type PiTerminalOutcome = "completed" | "failed" | "cancelled";

export interface PiTerminalMetadata {
  resultSummary?: string;
  changedFilesSummary?: string;
  usageJson?: string;
  error?: string;
  piSessionId?: string;
}

export type PiTerminalSettlement =
  | { committed: true; outcome: PiTerminalOutcome; cardId: number }
  | { committed: false; reason: "stale_generation" | "wrong_status" | "missing" | "card_mismatch" };

export type PiStartClaim =
  | { claimed: true; runId: string; generation: number }
  | { claimed: false; reason: "missing" | "not_queued" | "card_mismatch" | "busy" | "not_startable" };

/** #1638 — result of the shared canonical-workspace claim. */
export type PiWorkspaceClaim =
  | { kind: "claimed"; runId: string; generation: number }
  | { kind: "idempotent"; runId: string; generation: number }
  | { kind: "busy"; holderRunId: string }
  | { kind: "stale"; reason: string };

export type PiReleaseResult =
  | { released: true; runId: string; generation: number; canonicalPath: string; restoredQueued?: boolean }
  | { released: false; reason: "missing" | "not_holder" | "stale" };

export type PiResumeCommit =
  | { committed: true; runId: string; newGeneration: number; cardId: number }
  | { committed: false; reason: "stale" | "not_resumable" | "session_missing" | "card_mismatch" };

/** #1647 — result of the paired standalone interruption transaction. */
export type PiInterruptionResult =
  | { committed: true; runId: string; generation: number; cardId: number }
  | { committed: false; reason: "missing" | "stale_generation" | "wrong_status" | "card_mismatch" | "supervised" };

/** Internal sentinel: roll back the enclosing transaction after a mutation
 * outcome (card CAS, run count) failed. Never escapes the store boundary. */
const ROLLBACK_SENTINEL = Symbol("pi_run_store_rollback");

export class PiRunStore {
  private readonly db: TaskDatabase;
  private readonly sessionStorageRoot: string;
  private remoteEmitter: RemotePiTransitionEmitter | null = null;

  constructor(deps: PiRunStoreDeps) {
    this.db = deps.db;
    this.sessionStorageRoot = deps.sessionStorageRoot;
    this.migrate();
    ensureRequestLedgerSchema(this.db);
  }

  /**
   * #1358 review — Wire the in-transaction lifecycle event emitter (the
   * RemotePiEventProducer). Must be called before any delegated run
   * transitions; boot wires it right after construction.
   */
  setRemoteEventEmitter(emitter: RemotePiTransitionEmitter): void {
    this.remoteEmitter = emitter;
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_runs (
      id TEXT PRIMARY KEY,
      card_id INTEGER UNIQUE NOT NULL REFERENCES kanban_board(id),
      workspace_alias TEXT NOT NULL,
      operational_goal TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'user',
      origin_platform TEXT,
      origin_chat_id TEXT,
      origin_peer TEXT,
      origin_request_id TEXT,
      delivery_policy TEXT NOT NULL DEFAULT 'leave_remote',
      execution_generation INTEGER NOT NULL DEFAULT 1,
      current_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      resume_capability TEXT NOT NULL DEFAULT 'available',
      pi_session_id TEXT,
      pi_session_file TEXT,
      observed_pid INTEGER,
      model_provider TEXT,
      model_id TEXT,
      thinking TEXT,
      pending_request_id TEXT,
      pending_request_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_rpc_activity_at TEXT,
      result_summary TEXT,
      changed_files_summary TEXT,
      usage_json TEXT,
      error TEXT
    )`);
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN origin_request_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN delivery_policy TEXT NOT NULL DEFAULT 'leave_remote'`); } catch {}
    // #1647 — explicit reason the current generation starts. New writes are
    // always 'initial'; queueResumeGeneration() is the only path that writes
    // 'resume'. Never derived from the generation number or nullable fields.
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN generation_intent TEXT NOT NULL DEFAULT 'initial'`); } catch {}
    // #1647 — one-time backfill: a standalone generation > 1 could only have
    // advanced through queueResumeGeneration(); supervised rows (which advance
    // through queueSupervisedGeneration) stay 'initial'. Idempotent: after the
    // first pass the predicate is already satisfied. Runtime code never
    // repeats this inference.
    try {
      this.db.exec(`
        UPDATE pi_runs SET generation_intent = 'resume'
        WHERE execution_generation > 1
          AND origin != 'supervised'
          AND generation_intent = 'initial'
      `);
    } catch { /* column may not exist on an exotic prior schema */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pi_runs_status ON pi_runs(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pi_runs_card_id ON pi_runs(card_id)`);
    // #1395 — diagnostic reply-outcome columns (idempotent)
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN last_ui_reply_request_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN last_ui_reply_generation INTEGER`); } catch {}
    try { this.db.exec(`ALTER TABLE pi_runs ADD COLUMN last_ui_reply_outcome TEXT`); } catch {}
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_run_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES pi_runs(id),
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_progress_run_id ON pi_run_progress(run_id)`);

    // #1358 — Remote Pi lifecycle event outbox. The card identifier is the
    // OWNER's local Pi card, namespaced as remote_card_id so it can never be
    // mistaken for an origin-side local card reference.
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_events (
      run_id TEXT NOT NULL,
      remote_card_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      content_sha256 TEXT NOT NULL,
      origin_peer TEXT NOT NULL,
      origin_request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      projection_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      PRIMARY KEY (run_id, sequence)
    )`);
    // Migration for databases created before the namespacing fix (#1358 review):
    // the owner-local card column is renamed so no bare `card_id` survives on
    // the event path.
    try { this.db.exec(`ALTER TABLE remote_pi_events RENAME COLUMN card_id TO remote_card_id`); } catch { /* column already named correctly */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_origin_peer ON remote_pi_events(origin_peer)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_acknowledged ON remote_pi_events(acknowledged_at) WHERE acknowledged_at IS NULL`);

    // #1358 — Persisted round-robin drain cursor for the remote-pi-drain
    // heartbeat task (no peer starves behind a noisy one; survives restarts).
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_drain_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // #1358 — Remote Pi command ledger for idempotency
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_commands (
      origin_peer TEXT NOT NULL,
      command_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (origin_peer, command_id)
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_commands_run_id ON remote_pi_commands(run_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_commands_state ON remote_pi_commands(state)`);

    // #1358 — Consumed resume approvals (single-use enforcement)
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_approvals_consumed (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      origin_peer TEXT NOT NULL,
      command_id TEXT NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_approvals_run ON remote_pi_approvals_consumed(run_id)`);

    // #1638 — Shared canonical-workspace claim. At most one process-holding
    // run generation per canonical path across standalone and supervised Pi
    // lanes. The canonical path is an equality key only — never shown raw in
    // Orc output. Alias synonyms resolve to the same key and therefore
    // contend on the same claim.
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_workspace_claims (
      canonical_path TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      execution_generation INTEGER NOT NULL,
      owner_kind TEXT NOT NULL CHECK(owner_kind IN ('standalone','supervised')),
      acquired_at TEXT NOT NULL,
      UNIQUE(run_id, execution_generation)
    )`);
  }

  /**
   * #1393/#1357 — Create a Pi card/run and, when supplied, complete the
   * idempotency reservation in the same durable transaction. Fires no Nerve
   * event so an observer never sees a committed card without its run.
   */
  createPiCardAndRun(input: CreatePiRunInput): { runId: string; cardId: number; sessionId: string; responseJson?: string } {
    return this.db.transaction<{ runId: string; cardId: number; sessionId: string; responseJson?: string }>(() => {
      const cardResult = this.db.prepare(
        `INSERT INTO kanban_board (title, source, source_id, priority, type, notes, delivery_mode)
         VALUES (?, 'pi', ?, ?, 'pi', ?, 'silent')`
      ).run(input.title, input.runId, input.priority ?? "MEDIUM", input.goal);
      const cardId = Number(cardResult.lastInsertRowid);
      if (!cardId || cardId < 1) throw new Error("Failed to allocate card ID for Pi run");

      this.db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
        origin, origin_platform, origin_chat_id, origin_peer, origin_request_id, delivery_policy,
        execution_generation, generation_intent, current_session_id, status, resume_capability,
        model_provider, model_id, thinking)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'initial', ?, 'queued', 'never_started', ?, ?, ?)`).run(
        input.runId, cardId, input.workspaceAlias, input.goal,
        input.ownerPrincipalId, input.origin, input.originPlatform ?? null,
        input.originChatId ?? null, input.originPeer ?? null, input.originRequestId ?? null,
        input.deliveryPolicy ?? "leave_remote",
        input.sessionId,
        input.modelProvider ?? null, input.modelId ?? null, input.thinking ?? null,
      );

      // #1358 review — mechanism A: creation facts (accepted, queued) commit
      // in the same transaction as the run row for delegated runs. A crash
      // before commit creates neither the run nor the events.
      if (this.remoteEmitter && input.originPeer) {
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: undefined,
          toStatus: "accepted",
        });
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: undefined,
          toStatus: "queued",
        });
      }

      if (!input.idempotency) return { runId: input.runId, cardId, sessionId: input.sessionId };

      const responseJson = JSON.stringify({
        task_id: cardId,
        status: "queued",
        executor: "pi",
        run_id: input.runId,
        generation: 1,
        session_id: input.sessionId,
      });
      const completed = completePendingRequestInTransaction(this.db, {
        ...input.idempotency,
        responseJson,
      });
      if (!completed) throw new Error("Pi idempotency reservation was not pending");

      return { runId: input.runId, cardId, sessionId: input.sessionId, responseJson };
    });
  }

  generateId(): string {
    return randomUUID().slice(0, 12);
  }

  get(id: string): PiRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM pi_runs WHERE id = ?`).get(id);
    if (!row) return null;
    return this.rowToRecord(row);
  }

  getByCardId(cardId: number): PiRunRecord | null {
    const row = this.db.prepare(`SELECT * FROM pi_runs WHERE card_id = ?`).get(cardId);
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /**
   * #1638 — Idempotently create the single subordinate Pi run row for a
   * supervised W card. Never touches the W card or creates a Pi card: the
   * Worker attempt owns the card lifecycle. Repeated creation for the same
   * card returns the existing run. Initial execution starts at generation 1;
   * retries advance the same row via queueSupervisedGeneration().
   */
  createSupervisedRun(input: {
    cardId: number;
    workspaceAlias: string;
    goal: string;
    ownerPrincipalId: string;
    sessionId: string;
  }): { runId: string; generation: number; created: boolean } {
    const existing = this.db.prepare(`SELECT id, execution_generation FROM pi_runs WHERE card_id = ?`).get(input.cardId) as { id: string; execution_generation: number } | undefined;
    if (existing) return { runId: existing.id, generation: existing.execution_generation, created: false };
    const runId = `pirun_sup_${randomUUID().slice(0, 12)}`;
    this.db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
      origin, origin_platform, origin_chat_id, origin_peer, origin_request_id, delivery_policy,
      execution_generation, generation_intent, current_session_id, status, resume_capability,
      model_provider, model_id, thinking)
      VALUES (?, ?, ?, ?, ?, 'supervised', NULL, NULL, NULL, NULL, 'leave_remote', 1, 'initial', ?, 'queued', 'never_started', NULL, NULL, NULL)`).run(
      runId, input.cardId, input.workspaceAlias, input.goal,
      input.ownerPrincipalId, input.sessionId,
    );
    return { runId, generation: 1, created: true };
  }

  list(filter?: { status?: PiRunStatus; ownerPrincipalId?: string }): PiRunRecord[] {
    let sql = `SELECT * FROM pi_runs`;
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (filter?.status) { clauses.push(`status = ?`); params.push(filter.status); }
    if (filter?.ownerPrincipalId) { clauses.push(`owner_principal_id = ?`); params.push(filter.ownerPrincipalId); }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    sql += ` ORDER BY created_at DESC`;
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  casTransition(id: string, fromStatus: PiRunStatus | PiRunStatus[], toStatus: PiRunStatus, updates?: Partial<{
    executionGeneration: number; currentSessionId: string; piSessionId: string;
    piSessionFile: string; observedPid: number; modelProvider: string; modelId: string;
    thinking: string; pendingRequestId: string | null; pendingRequestType: PiPendingRequestType | null;
    resultSummary: string; changedFilesSummary: string; usageJson: string;
    error: string; resumeCapability: ResumeCapability;
  }>): boolean {
    const fromArr = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    const setClauses = [`status = ?`, `updated_at = datetime('now')`];
    const params: unknown[] = [toStatus];
    if (updates) {
      if (updates.executionGeneration !== undefined) { setClauses.push(`execution_generation = ?`); params.push(updates.executionGeneration); }
      if (updates.currentSessionId !== undefined) { setClauses.push(`current_session_id = ?`); params.push(updates.currentSessionId); }
      if (updates.piSessionId !== undefined) { setClauses.push(`pi_session_id = ?`); params.push(updates.piSessionId); }
      if (updates.piSessionFile !== undefined) { setClauses.push(`pi_session_file = ?`); params.push(updates.piSessionFile); }
      if (updates.observedPid !== undefined) { setClauses.push(`observed_pid = ?`); params.push(updates.observedPid); }
      if (updates.modelProvider !== undefined) { setClauses.push(`model_provider = ?`); params.push(updates.modelProvider); }
      if (updates.modelId !== undefined) { setClauses.push(`model_id = ?`); params.push(updates.modelId); }
      if (updates.thinking !== undefined) { setClauses.push(`thinking = ?`); params.push(updates.thinking); }
      if (updates.pendingRequestId !== undefined) { setClauses.push(`pending_request_id = ?`); params.push(updates.pendingRequestId); }
      if (updates.pendingRequestType !== undefined) { setClauses.push(`pending_request_type = ?`); params.push(updates.pendingRequestType); }
      if (updates.resultSummary !== undefined) { setClauses.push(`result_summary = ?`); params.push(updates.resultSummary); }
      if (updates.changedFilesSummary !== undefined) { setClauses.push(`changed_files_summary = ?`); params.push(updates.changedFilesSummary); }
      if (updates.usageJson !== undefined) { setClauses.push(`usage_json = ?`); params.push(updates.usageJson); }
      if (updates.error !== undefined) { setClauses.push(`error = ?`); params.push(updates.error); }
      if (updates.resumeCapability !== undefined) { setClauses.push(`resume_capability = ?`); params.push(updates.resumeCapability); }
    }
    params.push(id, ...fromArr);
    // #1358 review — mechanism A: the transition and its outbox event commit
    // together. If the event append fails, the transition rolls back with it.
    const fn = (): boolean => {
      // Read the current generation so a `resumed` fact is emitted only for a
      // REAL generation bump, never for a same-value executionGeneration set.
      const preGen = updates?.executionGeneration !== undefined
        ? (this.db.prepare(`SELECT execution_generation FROM pi_runs WHERE id = ?`).get(id) as { execution_generation: number } | undefined)?.execution_generation
        : undefined;
      const result = this.db.prepare(`UPDATE pi_runs SET ${setClauses.join(", ")} WHERE id = ? AND status IN (${fromArr.map(() => "?").join(",")})`).run(...params);
      if (result.changes > 0 && this.remoteEmitter) {
        this.remoteEmitter.emitTransitionInTx({
          runId: id,
          fromStatus: fromArr.length === 1 ? fromArr[0] : undefined,
          toStatus,
          newGeneration:
            updates?.executionGeneration !== undefined && preGen !== updates.executionGeneration
              ? updates.executionGeneration
              : undefined,
        });
      }
      return result.changes > 0;
    };
    return this.db.transaction(fn);
  }

  /**
   * #1396/#1647 — Atomically transition a Pi run to its terminal outcome,
   * update the linked Kanban card, and release the exact generation's
   * workspace claim in ONE transaction. Predicates on run id,
   * execution_generation, and expected statuses so that only one concurrent
   * contender wins. The card transition outcome and the run update count are
   * mandatory predicates: if either loses, neither durable record changes
   * (rollback). Publishes no Nerve event — the caller fires the mapped event
   * only after commit.
   */
  settleTerminal(input: {
    runId: string;
    generation: number;
    expectedStatuses: PiRunStatus[];
    outcome: PiTerminalOutcome;
    metadata: PiTerminalMetadata;
  }): PiTerminalSettlement {
    const fn = (): PiTerminalSettlement => {
      // Read current run (within the transaction)
      const runRow = this.db.prepare(
        `SELECT card_id, execution_generation, status FROM pi_runs WHERE id = ?`
      ).get(input.runId);
      if (!runRow) return { committed: false, reason: "missing" };

      const row = runRow as { card_id: number; execution_generation: number; status: string };
      if (row.execution_generation !== input.generation) return { committed: false, reason: "stale_generation" };
      if (!input.expectedStatuses.includes(row.status as PiRunStatus)) return { committed: false, reason: "wrong_status" };
      const cardId = row.card_id;

      // Build run update — #1395 also clears pending fields on terminal settlement
      const runSet = [`status = ?`, `updated_at = datetime('now')`, `pending_request_id = NULL`, `pending_request_type = NULL`];
      const runParams: unknown[] = [input.outcome];
      if (input.metadata.resultSummary !== undefined) { runSet.push(`result_summary = ?`); runParams.push(input.metadata.resultSummary); }
      if (input.metadata.changedFilesSummary !== undefined) { runSet.push(`changed_files_summary = ?`); runParams.push(input.metadata.changedFilesSummary); }
      if (input.metadata.usageJson !== undefined) { runSet.push(`usage_json = ?`); runParams.push(input.metadata.usageJson); }
      if (input.metadata.error !== undefined) { runSet.push(`error = ?`); runParams.push(input.metadata.error); }
      if (input.metadata.piSessionId !== undefined) { runSet.push(`pi_session_id = ?`); runParams.push(input.metadata.piSessionId); }

      const runResult = this.db.prepare(
        `UPDATE pi_runs SET ${runSet.join(", ")} WHERE id = ? AND execution_generation = ? AND status IN (${input.expectedStatuses.map(() => "?").join(",")})`
      ).run(...runParams, input.runId, input.generation, ...input.expectedStatuses);

      if (runResult.changes === 0) return { committed: false, reason: "wrong_status" };

      // #1358 review — mechanism A: terminal transition and its outbox event
      // commit in this same transaction. Emitted after the run UPDATE so the
      // projection builder reads the settled fields.
      if (this.remoteEmitter) {
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: row.status as string,
          toStatus: input.outcome,
        });
      }

      // Update linked kanban card — #1590: through the single transition
      // helper, inside the same transaction. Events fire at the executor
      // layer after commit, so emit is disabled here (no double fire).
      // #1647: a lost card CAS rolls back the run update — the run and its
      // card always settle as one generation.
      const cardOutcome = input.outcome === "completed"
        ? kanbanTransition({
            cardId, from: ["running"], to: "done", actor: "pi_run_settle",
            reason: "pi run settled",
            attemptId: input.runId,
            claimGeneration: input.generation,
            fields: { result_summary: input.metadata.resultSummary?.slice(0, 4000) ?? null, completed_at: sqliteNow() },
            emit: false,
          }, this.db)
        : kanbanTransition({
            cardId, from: ["running"], to: "failed", actor: "pi_run_settle",
            reason: "pi run failed",
            attemptId: input.runId,
            claimGeneration: input.generation,
            fields: { error: input.metadata.error?.slice(0, 1000) ?? input.outcome, completed_at: sqliteNow() },
            emit: false,
          }, this.db);
      if (cardOutcome.kind !== "applied") throw ROLLBACK_SENTINEL;

      // #1647 — release the exact generation's workspace claim in the same
      // transaction (exact (run_id, execution_generation) fence).
      this.db.prepare(`
        DELETE FROM pi_workspace_claims
        WHERE run_id = ? AND execution_generation = ?
      `).run(input.runId, input.generation);

      return { committed: true, outcome: input.outcome, cardId };
    };
    try {
      return this.db.transaction(fn);
    } catch (err) {
      if (err === ROLLBACK_SENTINEL) return { committed: false, reason: "card_mismatch" };
      throw err;
    }
  }

  /**
   * #1647 — Paired standalone interruption. One transaction:
   *   run: starting|running|awaiting_input|cancelling -> interrupted
   *   card: running -> failed
   * plus cleared PID/pending-input authority, the truthful resume
   * capability/session proof, generation-fenced workspace release, and the
   * durable interrupted fact. A card CAS loss rolls back the run update;
   * duplicate or stale interruption mutates nothing. Supervised runs are
   * refused here — the Worker attempt owns the W card (see
   * interruptSupervisedRun).
   */
  interruptGeneration(input: {
    runId: string;
    generation: number;
    continuity: SessionProof;
  }): PiInterruptionResult {
    const fn = (): PiInterruptionResult => {
      const runRow = this.db.prepare(
        `SELECT id, card_id, execution_generation, status, origin, pi_session_id, pi_session_file
         FROM pi_runs WHERE id = ?`
      ).get(input.runId) as Record<string, unknown> | undefined;
      if (!runRow) return { committed: false, reason: "missing" };
      if ((runRow.execution_generation as number) !== input.generation) return { committed: false, reason: "stale_generation" };
      const status = runRow.status as string;
      if (!["starting", "running", "awaiting_input", "cancelling"].includes(status)) return { committed: false, reason: "wrong_status" };
      if ((runRow.origin as string) === "supervised") return { committed: false, reason: "supervised" };
      const cardId = runRow.card_id as number;

      // Persist the truthful proof identity/capability. A non-available proof
      // keeps the historical identity fields but records the derived
      // capability — the generation cannot claim resumability.
      const proof = input.continuity.ok
        ? { piSessionId: input.continuity.sessionId, piSessionFile: input.continuity.canonicalFile }
        : { piSessionId: (runRow.pi_session_id as string | null) ?? undefined, piSessionFile: (runRow.pi_session_file as string | null) ?? undefined };
      const capability: ResumeCapability = input.continuity.ok ? "available" : input.continuity.capability;

      const runResult = this.db.prepare(`
        UPDATE pi_runs
        SET status = 'interrupted',
            observed_pid = NULL,
            pending_request_id = NULL,
            pending_request_type = NULL,
            pi_session_id = ?,
            pi_session_file = ?,
            resume_capability = ?,
            updated_at = datetime('now')
        WHERE id = ? AND execution_generation = ? AND status IN ('starting', 'running', 'awaiting_input', 'cancelling')
      `).run(proof.piSessionId ?? null, proof.piSessionFile ?? null, capability, input.runId, input.generation);
      if (runResult.changes !== 1) return { committed: false, reason: "wrong_status" };

      // Paired card: running -> failed. A lost CAS rolls back the interruption.
      const cardOutcome = kanbanTransition({
        cardId, from: ["running"], to: "failed", actor: "pi_interrupt",
        reason: "run interrupted",
        attemptId: input.runId,
        claimGeneration: input.generation,
        fields: { error: "interrupted" },
        emit: false,
      }, this.db);
      if (cardOutcome.kind !== "applied") throw ROLLBACK_SENTINEL;

      // Generation-fenced workspace release inside the same transaction.
      this.db.prepare(`
        DELETE FROM pi_workspace_claims
        WHERE run_id = ? AND execution_generation = ?
      `).run(input.runId, input.generation);

      // #1358 review — mechanism A: interruption and its fact commit together.
      if (this.remoteEmitter) {
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: status,
          toStatus: "interrupted",
        });
      }

      return { committed: true, runId: input.runId, generation: input.generation, cardId };
    };
    try {
      return this.db.transaction(fn);
    } catch (err) {
      if (err === ROLLBACK_SENTINEL) return { committed: false, reason: "card_mismatch" };
      throw err;
    }
  }

  /**
   * #1647 — Run-row-only interruption for a SUPERVISED Pi generation. Never
   * touches any card: the Worker attempt owns the W card. Must run inside the
   * coordinator's transaction (same pattern as settleSupervisedRunInTransaction).
   */
  interruptSupervisedRun(input: {
    runId: string;
    generation: number;
    continuity: SessionProof;
  }): boolean {
    const runRow = this.db.prepare(
      `SELECT id, execution_generation, status, pi_session_id, pi_session_file FROM pi_runs WHERE id = ? AND origin = 'supervised'`
    ).get(input.runId) as Record<string, unknown> | undefined;
    if (!runRow) return false;
    if ((runRow.execution_generation as number) !== input.generation) return false;
    const status = runRow.status as string;
    if (!["starting", "running", "awaiting_input", "cancelling"].includes(status)) return false;

    const proof = input.continuity.ok
      ? { piSessionId: input.continuity.sessionId, piSessionFile: input.continuity.canonicalFile }
      : { piSessionId: (runRow.pi_session_id as string | null) ?? undefined, piSessionFile: (runRow.pi_session_file as string | null) ?? undefined };
    const capability: ResumeCapability = input.continuity.ok ? "available" : input.continuity.capability;

    const runResult = this.db.prepare(`
      UPDATE pi_runs
      SET status = 'interrupted',
          observed_pid = NULL,
          pending_request_id = NULL,
          pending_request_type = NULL,
          pi_session_id = ?,
          pi_session_file = ?,
          resume_capability = ?,
          updated_at = datetime('now')
      WHERE id = ? AND execution_generation = ? AND status IN ('starting', 'running', 'awaiting_input', 'cancelling')
    `).run(proof.piSessionId ?? null, proof.piSessionFile ?? null, capability, input.runId, input.generation);
    if (runResult.changes !== 1) return false;

    if (this.remoteEmitter) {
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: status,
        toStatus: "interrupted",
      });
    }
    return true;
  }

  /**
   * #1638 — Terminal transition for a SUPERVISED Pi run: updates the run row
   * only, never the W card. Must run inside the supervised settlement
   * coordinator's transaction (never standalone). Revalidates generation and
   * status; returns committed|stale|conflict so the coordinator can abort.
   */
  settleSupervisedRunInTransaction(input: {
    runId: string;
    generation: number;
    expectedStatuses: PiRunStatus[];
    outcome: PiTerminalOutcome;
    metadata: PiTerminalMetadata;
  }): { committed: boolean; reason?: "stale_generation" | "wrong_status" | "missing" } {
    const runRow = this.db.prepare(
      `SELECT execution_generation, status FROM pi_runs WHERE id = ?`
    ).get(input.runId) as { execution_generation: number; status: string } | undefined;
    if (!runRow) return { committed: false, reason: "missing" };
    if (runRow.execution_generation !== input.generation) return { committed: false, reason: "stale_generation" };
    if (!input.expectedStatuses.includes(runRow.status as PiRunStatus)) return { committed: false, reason: "wrong_status" };

    const runSet = [`status = ?`, `updated_at = datetime('now')`, `pending_request_id = NULL`, `pending_request_type = NULL`];
    const runParams: unknown[] = [input.outcome];
    if (input.metadata.resultSummary !== undefined) { runSet.push(`result_summary = ?`); runParams.push(input.metadata.resultSummary); }
    if (input.metadata.changedFilesSummary !== undefined) { runSet.push(`changed_files_summary = ?`); runParams.push(input.metadata.changedFilesSummary); }
    if (input.metadata.usageJson !== undefined) { runSet.push(`usage_json = ?`); runParams.push(input.metadata.usageJson); }
    if (input.metadata.error !== undefined) { runSet.push(`error = ?`); runParams.push(input.metadata.error); }
    if (input.metadata.piSessionId !== undefined) { runSet.push(`pi_session_id = ?`); runParams.push(input.metadata.piSessionId); }

    const runResult = this.db.prepare(
      `UPDATE pi_runs SET ${runSet.join(", ")} WHERE id = ? AND execution_generation = ? AND status IN (${input.expectedStatuses.map(() => "?").join(",")})`
    ).run(...runParams, input.runId, input.generation, ...input.expectedStatuses);
    if (runResult.changes === 0) return { committed: false, reason: "wrong_status" };

    if (this.remoteEmitter) {
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: runRow.status,
        toStatus: input.outcome,
      });
    }

    return { committed: true };
  }

  /**
   * #1638 — Advance ONLY the subordinate Pi run to a new execution
   * generation for a supervised retry. Validates the old generation and
   * resumability, clears transient run fields, and NEVER touches the W card
   * (unlike queueResumeGeneration). The retry attempt owns Worker card
   * queueing through the retry store.
   */
  queueSupervisedGeneration(input: {
    runId: string;
    expectedGeneration: number;
    newSessionId: string;
    sessionFile?: string;
    continuity: "resumed" | "fresh";
  }): { committed: boolean; newGeneration?: number; reason?: "stale" | "not_resumable" | "missing" } {
    return this.db.transaction(() => {
      const row = this.db.prepare(
        `SELECT id, execution_generation, status, resume_capability FROM pi_runs WHERE id = ?`
      ).get(input.runId) as { id: string; execution_generation: number; status: string; resume_capability: string } | undefined;
      if (!row) return { committed: false, reason: "missing" };
      if (row.execution_generation !== input.expectedGeneration) return { committed: false, reason: "stale" };
      if ((row.status as string) !== "interrupted" && (row.status as string) !== "failed") return { committed: false, reason: "not_resumable" };
      if (input.continuity === "resumed" && (row.resume_capability as string) !== "available") return { committed: false, reason: "not_resumable" };

      const newGen = input.expectedGeneration + 1;
      const nextSessionFile = input.continuity === "fresh" ? null : (input.sessionFile ?? null);
      const runResult = this.db.prepare(`
        UPDATE pi_runs
        SET status = 'queued',
            execution_generation = ?,
            current_session_id = ?,
            pi_session_file = CASE WHEN ? = 'fresh' THEN NULL ELSE COALESCE(?, pi_session_file) END,
            pi_session_id = CASE WHEN ? = 'fresh' THEN NULL ELSE pi_session_id END,
            resume_capability = CASE WHEN ? = 'fresh' THEN 'never_started' ELSE resume_capability END,
            observed_pid = NULL,
            pending_request_id = NULL,
            pending_request_type = NULL,
            result_summary = NULL,
            changed_files_summary = NULL,
            usage_json = NULL,
            error = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND execution_generation = ? AND status IN ('interrupted', 'failed')
      `).run(
        newGen,
        input.newSessionId,
        input.continuity,
        nextSessionFile,
        input.continuity,
        input.continuity,
        input.runId,
        input.expectedGeneration,
      );
      if (runResult.changes === 0) return { committed: false, reason: "stale" };

      // #1358 review — mechanism A: the supervised generation bump commits
      // with its fact; the origin never sees a W-card transition here.
      if (this.remoteEmitter) {
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: row.status as string,
          toStatus: "queued",
          newGeneration: newGen,
        });
      }

      return { committed: true, newGeneration: newGen };
    });
  }

  /** #1638 — resolve the durable session continuity decision for a retry:
   * reuse the session file when durable and compatible, else fresh. */
  resolveSessionContinuity(runId: string): { continuity: "resumed" | "fresh"; sessionId: string; sessionFile?: string } {
    const run = this.get(runId);
    if (run?.piSessionFile && run.resumeCapability === "available") {
      return { continuity: "resumed", sessionId: run.currentSessionId ?? `s_${Date.now()}`, sessionFile: run.piSessionFile };
    }
    return { continuity: "fresh", sessionId: `s_${Date.now()}` };
  }

  touchActivity(id: string): void {
    this.db.prepare(`UPDATE pi_runs SET last_rpc_activity_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  // #1395 — Claim a pending UI request atomically.
  // Transitions awaiting_input → running, clears both pending columns, records the
  // claim outcome.  Exactly one contender wins.
  claimPendingUi(input: {
    runId: string;
    generation: number;
    requestId: string;
  }): PendingUiClaim {
    // Read current request type within transaction
    const row = this.db.prepare(
      `SELECT pending_request_type FROM pi_runs WHERE id = ? AND execution_generation = ? AND status = 'awaiting_input' AND pending_request_id = ? AND pending_request_type IS NOT NULL`
    ).get(input.runId, input.generation, input.requestId) as { pending_request_type: string } | undefined;
    if (!row) {
      // Determine why it failed — check generation and consumed first
      const existing = this.db.prepare(`SELECT status, execution_generation, pending_request_id, pending_request_type, last_ui_reply_request_id FROM pi_runs WHERE id = ?`).get(input.runId) as Record<string, unknown> | undefined;
      if (!existing) return { claimed: false, reason: "missing" };
      if (existing.execution_generation !== input.generation) return { claimed: false, reason: "wrong_generation" };
      if (existing.pending_request_id === null || existing.pending_request_id === undefined) {
        if (existing.last_ui_reply_request_id === input.requestId) return { claimed: false, reason: "already_consumed" };
        return { claimed: false, reason: "wrong_status" };
      }
      if (existing.pending_request_id !== input.requestId) return { claimed: false, reason: "request_mismatch" };
      return { claimed: false, reason: "already_consumed" };
    }

    const changed = this.db.prepare(`
      UPDATE pi_runs
      SET status = 'running',
          pending_request_id = NULL,
          pending_request_type = NULL,
          last_ui_reply_request_id = ?,
          last_ui_reply_generation = ?,
          last_ui_reply_outcome = 'claimed',
          updated_at = datetime('now')
      WHERE id = ?
        AND execution_generation = ?
        AND status = 'awaiting_input'
        AND pending_request_id = ?
        AND pending_request_type IS NOT NULL
    `).run(input.requestId, input.generation, input.runId, input.generation, input.requestId);

    if (changed.changes === 0) return { claimed: false, reason: "already_consumed" };

    // #1358 review — mechanism A: awaiting_input → running (input_cleared)
    // commits with its outbox event.
    if (this.remoteEmitter) {
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: "awaiting_input",
        toStatus: "running",
      });
    }
    return { claimed: true, requestType: row.pending_request_type as PiPendingRequestType };
  }

  // #1395 — Restore a pending UI request after provable pre-write failure.
  // Narrowly predicates on generation, status='running', both pending fields NULL,
  // matching last claimed request, and outcome='claimed'.
  restorePendingUi(input: {
    runId: string;
    generation: number;
    requestId: string;
    requestType: PiPendingRequestType;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE pi_runs
      SET status = 'awaiting_input',
          pending_request_id = ?,
          pending_request_type = ?,
          last_ui_reply_outcome = NULL,
          updated_at = datetime('now')
      WHERE id = ?
        AND execution_generation = ?
        AND status = 'running'
        AND pending_request_id IS NULL
        AND pending_request_type IS NULL
        AND last_ui_reply_request_id = ?
        AND last_ui_reply_outcome = 'claimed'
    `).run(input.requestId, input.requestType, input.runId, input.generation, input.requestId);
    if (result.changes > 0 && this.remoteEmitter) {
      // #1358 review — mechanism A: running → awaiting_input (restored claim).
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: "running",
        toStatus: "awaiting_input",
      });
    }
    return result.changes > 0;
  }

  // #1395 — Record the outcome of a UI reply RPC.
  // Only updates if the outcome is still 'claimed'.
  recordUiReplyOutcome(input: {
    runId: string;
    generation: number;
    requestId: string;
    outcome: "delivery_unknown";
  }): boolean {
    const result = this.db.prepare(`
      UPDATE pi_runs
      SET last_ui_reply_outcome = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND execution_generation = ?
        AND last_ui_reply_request_id = ?
        AND last_ui_reply_outcome = 'claimed'
    `).run(input.outcome, input.runId, input.generation, input.requestId);
    return result.changes > 0;
  }

  // #1395 — Guarded set of a pending UI request from an incoming Pi event.
  // Requires: run is running for the correct generation, no existing different
  // pending request, and the (generation, requestId) is not a duplicate of a
  // consumed reply.
  setPendingUi(input: {
    runId: string;
    generation: number;
    requestId: string;
    requestType: PiPendingRequestType;
  }): PendingUiSetResult {
    const row = this.db.prepare(
      `SELECT status, execution_generation, pending_request_id, pending_request_type, last_ui_reply_request_id FROM pi_runs WHERE id = ?`
    ).get(input.runId) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: "missing" };
    if (row.execution_generation !== input.generation) return { ok: false, reason: "wrong_generation" };
    if (row.pending_request_id !== null && row.pending_request_id !== undefined) return { ok: false, reason: "busy" };
    if (row.pending_request_type !== null && row.pending_request_type !== undefined) return { ok: false, reason: "busy" };
    if (row.status !== "running") return { ok: false, reason: "wrong_status" };
    if (row.last_ui_reply_request_id === input.requestId) return { ok: false, reason: "duplicate_request" };

    const changed = this.db.prepare(`
      UPDATE pi_runs
      SET status = 'awaiting_input',
          pending_request_id = ?,
          pending_request_type = ?,
          updated_at = datetime('now')
      WHERE id = ?
        AND execution_generation = ?
        AND status = 'running'
        AND pending_request_id IS NULL
        AND pending_request_type IS NULL
        AND (last_ui_reply_request_id IS NULL OR last_ui_reply_request_id != ?)
    `).run(input.requestId, input.requestType, input.runId, input.generation, input.requestId);
    if (changed.changes === 0) return { ok: false, reason: "wrong_status" };
    // #1358 review — mechanism A: running → awaiting_input (dialog enter)
    // commits with its outbox event.
    if (this.remoteEmitter) {
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: "running",
        toStatus: "awaiting_input",
      });
    }
    return { ok: true };
  }

  addProgress(runId: string, kind: string, payload: string): void {
    this.db.prepare(`INSERT INTO pi_run_progress (run_id, kind, payload) VALUES (?, ?, ?)`).run(runId, kind, payload);
    const count = this.db.prepare(`SELECT COUNT(*) as cnt FROM pi_run_progress WHERE run_id = ?`).get(runId) as { cnt: number } | undefined;
    if (count && count.cnt > MAX_PROGRESS_ENTRIES) {
      this.db.prepare(`DELETE FROM pi_run_progress WHERE id IN (SELECT id FROM pi_run_progress WHERE run_id = ? ORDER BY id ASC LIMIT ?)`).run(runId, count.cnt - MAX_PROGRESS_ENTRIES);
    }
  }

  /**
   * #1358 — Get the most recent "ui" progress payload for a run. Used by the
   * event producer to attach title/prompt/options to the awaiting_input
   * public projection. Returns the parsed JSON object or null if no UI
   * request is currently active.
   *
   * The executor writes the "ui" progress row BEFORE entering awaiting_input
   * (see `_onUiRequest`), so the latest row always describes the active
   * request when the in-transaction emitter reads it.
   */
  getLatestUiRequest(runId: string): Record<string, unknown> | null {
    const row = this.db.prepare(
      `SELECT payload FROM pi_run_progress
       WHERE run_id = ? AND kind = 'ui'
       ORDER BY id DESC LIMIT 1`
    ).get(runId) as { payload: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.payload);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fall through */ }
    return null;
  }

  // ── #1405: atomic lifecycle operations ──────────────────────────────────────

  /**
   * #1638 — The single transactional body for claiming a canonical workspace
   * before a Pi process start. Both standalone and supervised lanes call this.
   * Inside one SQLite transaction it:
   *   1. validates run ID, expected Pi generation and a pre-start run status;
   *   2. inserts `pi_workspace_claims` using the canonical path primary key;
   *   3. treats the exact same (run,generation) holder as idempotent;
   *   4. advances the Pi run to `starting` only after the insert wins.
   * A primary-key conflict returns `busy`; no process has started. The card
   * transition (standalone) or the Worker attempt (supervised) is handled by
   * the caller, never here.
   */
  private claimWorkspaceForStartInTx(input: {
    runId: string;
    expectedGeneration: number;
    canonicalPath: string;
    ownerKind: "standalone" | "supervised";
  }): PiWorkspaceClaim {
    const runRow = this.db.prepare(
      `SELECT id, execution_generation, status FROM pi_runs WHERE id = ?`
    ).get(input.runId) as Record<string, unknown> | undefined;
    if (!runRow) return { kind: "stale", reason: "missing" };
    if ((runRow.execution_generation as number) !== input.expectedGeneration) return { kind: "stale", reason: "generation" };
    if ((runRow.status as string) !== "queued" && (runRow.status as string) !== "starting") return { kind: "stale", reason: "not_queued" };

    // The exact same (run,generation) holder is idempotent — even when the
    // run already advanced to starting by an earlier claim.
    const exactHolder = this.db.prepare(`
      SELECT run_id FROM pi_workspace_claims WHERE canonical_path = ? AND run_id = ? AND execution_generation = ?
    `).get(input.canonicalPath, input.runId, input.expectedGeneration) as { run_id: string } | undefined;
    if (exactHolder) return { kind: "idempotent", runId: input.runId, generation: input.expectedGeneration };

    try {
      this.db.prepare(`
        INSERT INTO pi_workspace_claims (canonical_path, run_id, execution_generation, owner_kind, acquired_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `).run(input.canonicalPath, input.runId, input.expectedGeneration, input.ownerKind);
    } catch {
      const holder = this.db.prepare(`
        SELECT run_id, execution_generation FROM pi_workspace_claims WHERE canonical_path = ?
      `).get(input.canonicalPath) as { run_id: string; execution_generation: number } | undefined;
      if (holder && holder.run_id === input.runId && holder.execution_generation === input.expectedGeneration) {
        return { kind: "idempotent", runId: input.runId, generation: input.expectedGeneration };
      }
      return { kind: "busy", holderRunId: holder?.run_id ?? "unknown" };
    }

    const runChanged = this.db.prepare(
      `UPDATE pi_runs SET status = 'starting', updated_at = datetime('now') WHERE id = ? AND status = 'queued'`
    ).run(input.runId);
    if (runChanged.changes === 0) {
      this.db.prepare(`
        DELETE FROM pi_workspace_claims WHERE canonical_path = ? AND run_id = ? AND execution_generation = ?
      `).run(input.canonicalPath, input.runId, input.expectedGeneration);
      return { kind: "stale", reason: "run_claim_lost" };
    }

    // #1358 review — mechanism A: queued → starting commits with its outbox
    // event (emitted only when an emitter is wired, i.e. remote-delegated).
    if (this.remoteEmitter) {
      this.remoteEmitter.emitTransitionInTx({
        runId: input.runId,
        fromStatus: "queued",
        toStatus: "starting",
      });
    }

    return { kind: "claimed", runId: input.runId, generation: input.expectedGeneration };
  }

  /**
   * #1638 — Generation-fenced release of a workspace claim. Deletes only the
   * exact (canonical_path, run_id, execution_generation) holder, so a late
   * generation can never release a newer holder. Safe to repeat.
   */
  releaseWorkspaceClaim(input: {
    canonicalPath: string;
    runId: string;
    generation: number;
    /** Capacity was proven unavailable before launch. Return this generation
     * to queued so a later dispatch can claim it again. Other release paths
     * intentionally leave the run terminal/starting state unchanged. */
    restoreQueued?: boolean;
  }): PiReleaseResult {
    const result = this.db.prepare(`
      DELETE FROM pi_workspace_claims
      WHERE canonical_path = ? AND run_id = ? AND execution_generation = ?
    `).run(input.canonicalPath, input.runId, input.generation);
    if (result.changes === 0) {
      const anyHolder = this.db.prepare(`
        SELECT run_id FROM pi_workspace_claims WHERE canonical_path = ?
      `).get(input.canonicalPath) as { run_id: string } | undefined;
      return { released: false, reason: anyHolder ? "not_holder" : "missing" };
    }
    let restoredQueued = false;
    if (input.restoreQueued) {
      const reset = this.db.prepare(`
        UPDATE pi_runs
        SET status = 'queued', updated_at = datetime('now')
        WHERE id = ? AND execution_generation = ? AND status = 'starting'
      `).run(input.runId, input.generation);
      restoredQueued = reset.changes === 1;
    }
    return { released: true, runId: input.runId, generation: input.generation, canonicalPath: input.canonicalPath, restoredQueued };
  }

  /** Release a holder when its alias can no longer be resolved. The run ID
   * and execution generation are still an exact fence, so a late terminal
   * observation cannot free a newer generation's claim. */
  releaseWorkspaceClaimForGeneration(input: { runId: string; generation: number }): boolean {
    const result = this.db.prepare(`
      DELETE FROM pi_workspace_claims
      WHERE run_id = ? AND execution_generation = ?
    `).run(input.runId, input.generation);
    return result.changes === 1;
  }

  /** #1638 — List every currently held canonical workspace claim. */
  listWorkspaceClaims(): Array<{ canonicalPath: string; runId: string; generation: number; ownerKind: "standalone" | "supervised" }> {
    return (this.db.prepare(`
      SELECT canonical_path, run_id, execution_generation, owner_kind FROM pi_workspace_claims
    `).all() as Array<{ canonical_path: string; run_id: string; execution_generation: number; owner_kind: "standalone" | "supervised" }>).map(r => ({
      canonicalPath: r.canonical_path,
      runId: r.run_id,
      generation: r.execution_generation,
      ownerKind: r.owner_kind,
    }));
  }

  /**
   * #1405 — Atomically claim a queued Pi run and its linked card.
   * Transitions run queued→starting, card queued→running in one transaction,
   * but ONLY after the shared canonical-workspace claim succeeds. If the
   * shared cap/workspace is busy, both run and card remain queued (paired
   * waiting state) and nothing is acquired.
   */
  claimQueuedGeneration(cardId: number, canonicalPath: string): PiStartClaim {
    return this.db.transaction<PiStartClaim>(() => {
      const runRow = this.db.prepare(
        `SELECT id, execution_generation, status FROM pi_runs WHERE card_id = ? AND status = 'queued'`
      ).get(cardId) as Record<string, unknown> | undefined;
      if (!runRow) return { claimed: false, reason: "missing" };

      const runId = runRow.id as string;
      const gen = runRow.execution_generation as number;

      const wsClaim = this.claimWorkspaceForStartInTx({
        runId, expectedGeneration: gen, canonicalPath, ownerKind: "standalone",
      });
      if (wsClaim.kind === "busy") return { claimed: false, reason: "busy" };
      if (wsClaim.kind === "stale") return { claimed: false, reason: "not_startable" };

      // Card queued → running — #1590: through the transition helper.
      const cardOutcome = kanbanTransition({
        cardId, from: ["queued"], to: "running", actor: "pi_run_dispatch",
        reason: "pi dispatch claim",
        attemptId: runId,
        claimGeneration: gen,
        emit: false,
      }, this.db);
      if (cardOutcome.kind !== "applied") {
        this.releaseWorkspaceClaim({ canonicalPath, runId, generation: gen });
        this.db.prepare(`UPDATE pi_runs SET status = 'queued', updated_at = datetime('now') WHERE id = ?`).run(runId);
        return { claimed: false, reason: "card_mismatch" };
      }

      return { claimed: true, runId, generation: gen };
    });
  }

  /**
   * #1638 — Supervised variant of the shared workspace claim. Acquires the
   * canonical workspace and advances the subordinate Pi run queued→starting
   * WITHOUT touching the W card. Returns the claim for the adapter to map to
   * StartObservation.deferred on busy.
   */
  claimSupervisedGeneration(input: {
    runId: string;
    expectedGeneration: number;
    canonicalPath: string;
  }): PiWorkspaceClaim {
    return this.db.transaction<PiWorkspaceClaim>(() => {
      return this.claimWorkspaceForStartInTx({
        runId: input.runId,
        expectedGeneration: input.expectedGeneration,
        canonicalPath: input.canonicalPath,
        ownerKind: "supervised",
      });
    });
  }

  /**
   * #1647 — Atomic resume admission. The single transaction that advances a
   * standalone Pi run to a new resume generation:
   *
   * 1. verifies run id, expected generation, status `interrupted|failed`, and
   *    `resume_capability='available'`;
   * 2. revalidates the PERSISTED session target (row's pi_session_id/file)
   *    inside the store boundary, so direct callers cannot bypass validation
   *    or supply a replacement target;
   * 3. updates exactly one pi_runs row to generation N+1, queued, with
   *    `generation_intent='resume'` while preserving the verified target;
   * 4. applies exactly one linked-card transition `failed|done -> queued`;
   * 5. appends the durable remote `resumed` transition fact with the bump.
   *
   * Any run-update count other than one, or a card outcome other than
   * `applied`, rolls back the whole transaction (both durable records stay
   * unchanged). The caller compensates the preallocated external C session.
   */
  queueResumeGeneration(input: {
    runId: string;
    expectedGeneration: number;
    newSessionId: string;
  }): PiResumeCommit {
    const fn = (): PiResumeCommit => {
      const row = this.db.prepare(
        `SELECT id, execution_generation, status, card_id, resume_capability, origin,
                pi_session_id, pi_session_file FROM pi_runs WHERE id = ?`
      ).get(input.runId) as Record<string, unknown> | undefined;
      if (!row) return { committed: false, reason: "stale" };
      if ((row.execution_generation as number) !== input.expectedGeneration) return { committed: false, reason: "stale" };
      if ((row.status as string) !== "interrupted" && (row.status as string) !== "failed") return { committed: false, reason: "not_resumable" };
      if ((row.resume_capability as string) !== "available") return { committed: false, reason: "not_resumable" };

      // Authoritative in-store revalidation of the persisted target — no
      // caller-supplied file, no path-existence shortcut.
      const proof = validatePersistedSession({
        sessionStorageRoot: this.sessionStorageRoot,
        expectedSessionId: (row.pi_session_id as string | null) ?? undefined,
        sessionFile: (row.pi_session_file as string | null) ?? undefined,
      });
      if (!proof.ok) {
        return { committed: false, reason: "session_missing" };
      }

      const cardId = row.card_id as number;
      const newGen = input.expectedGeneration + 1;

      // Update run — exactly one row. Keep the verified Pi target, set the
      // explicit resume intent, clear only generation-terminal fields.
      const runResult = this.db.prepare(`
        UPDATE pi_runs
        SET status = 'queued',
            execution_generation = ?,
            generation_intent = 'resume',
            current_session_id = ?,
            pi_session_id = ?,
            pi_session_file = ?,
            observed_pid = NULL,
            pending_request_id = NULL,
            pending_request_type = NULL,
            result_summary = NULL,
            changed_files_summary = NULL,
            usage_json = NULL,
            error = NULL,
            resume_capability = 'available',
            updated_at = datetime('now')
        WHERE id = ? AND execution_generation = ? AND status IN ('interrupted', 'failed')
      `).run(newGen, input.newSessionId, proof.sessionId, proof.canonicalFile, input.runId, input.expectedGeneration);
      if (runResult.changes !== 1) throw ROLLBACK_SENTINEL;

      // Update card — #1590: through the transition helper (failed|done →
      // queued is legal; the service layer fires card:queued after commit, so
      // emit is disabled here). A lost CAS rolls back the generation bump.
      const cardOutcome = kanbanTransition({
        cardId,
        from: ["failed", "done"],
        to: "queued",
        actor: "pi_resume_generation",
        reason: "resume generation",
        attemptId: input.runId,
        claimGeneration: newGen,
        fields: { completed_at: null, error: null, result_summary: null },
        emit: false,
      }, this.db);
      if (cardOutcome.kind !== "applied") throw ROLLBACK_SENTINEL;

      // #1358 review — mechanism A: the generation bump and its `resumed`
      // fact commit together. The origin may advance generations only through
      // this authenticated fact, so it must never be lost to a crash.
      if (this.remoteEmitter) {
        this.remoteEmitter.emitTransitionInTx({
          runId: input.runId,
          fromStatus: row.status as string,
          toStatus: "queued",
          newGeneration: newGen,
        });
      }

      return { committed: true, runId: input.runId, newGeneration: newGen, cardId };
    };
    try {
      return this.db.transaction(fn);
    } catch (err) {
      if (err === ROLLBACK_SENTINEL) return { committed: false, reason: "card_mismatch" };
      throw err;
    }
  }

  /**
   * #1405/#1647 — Recover all non-terminal Pi runs at boot.
   * - queued runs: preserved as-is (generation_intent intact); a queued
   *   `resume` generation is revalidated and refused (capability recorded)
   *   when its target disappeared before dispatch; return their card IDs for
   *   post-registration wakeup.
   * - active runs (starting/running/awaiting_input/cancelling): interrupted
   *   with the SAME paired run/card predicates as graceful shutdown — the
   *   capability is derived from the bounded session proof, never from
   *   `pi_session_id IS NOT NULL`. A card conflict rolls back that row's
   *   mutation. Supervised rows never get their W card touched; they are
   *   returned for Worker-owned settlement.
   * - terminal runs: unchanged.
   * Returns queued card IDs that should be woken after Pi service registration.
   */
  recoverNonterminal(): { interrupted: number; queuedCardIds: number[]; supervisedInterruptedRunIds: string[] } {
    const fn = (): { interrupted: number; queuedCardIds: number[]; supervisedInterruptedRunIds: string[] } => {
      const runs = this.db.prepare(
        `SELECT id, status, card_id, origin, execution_generation, pi_session_id, pi_session_file,
                generation_intent, resume_capability FROM pi_runs WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
      ).all() as Record<string, unknown>[];

      const activeStatuses = ["starting", "running", "awaiting_input", "cancelling"];
      const queuedCardIds: number[] = [];
      const supervisedInterruptedRunIds: string[] = [];
      let interrupted = 0;

      for (const run of runs) {
        const runId = run.id as string;
        const cardId = run.card_id as number;
        const status = run.status as string;
        const generation = run.execution_generation as number;

        if (status === "queued") {
          queuedCardIds.push(cardId);
          // Clear stale observed PID — fenced to the exact generation.
          this.db.prepare(`UPDATE pi_runs SET observed_pid = NULL, updated_at = datetime('now')
            WHERE id = ? AND execution_generation = ?`).run(runId, generation);
          // #1647 — a queued resume generation whose target vanished before
          // dispatch must fail closed: record the derived capability without
          // rewriting the explicit intent.
          if ((run.generation_intent as string) === "resume") {
            const proof = validatePersistedSession({
              sessionStorageRoot: this.sessionStorageRoot,
              expectedSessionId: (run.pi_session_id as string | null) ?? undefined,
              sessionFile: (run.pi_session_file as string | null) ?? undefined,
            });
            if (!proof.ok && (run.resume_capability as string) === "available") {
              this.db.prepare(`UPDATE pi_runs SET resume_capability = ?, updated_at = datetime('now')
                WHERE id = ? AND execution_generation = ?`).run(proof.capability, runId, generation);
            }
          }
        } else if (activeStatuses.includes(status)) {
          // #1647 — capability from bounded session proof, never ID presence.
          const proof = validatePersistedSession({
            sessionStorageRoot: this.sessionStorageRoot,
            expectedSessionId: (run.pi_session_id as string | null) ?? undefined,
            sessionFile: (run.pi_session_file as string | null) ?? undefined,
          });
          const capability: ResumeCapability = proof.ok ? "available" : proof.capability;

          if (run.origin === "supervised") {
            // Worker supervision owns the W-card terminal transition. Interrupt
            // the run row only (with truthful capability) and return the run to
            // boot so the coordinator settles the attempt through the canonical
            // Worker transaction.
            const runResult = this.db.prepare(`
              UPDATE pi_runs
              SET status = 'interrupted',
                  observed_pid = NULL,
                  pending_request_id = NULL,
                  pending_request_type = NULL,
                  resume_capability = ?,
                  updated_at = datetime('now')
              WHERE id = ? AND execution_generation = ? AND status IN ('starting', 'running', 'awaiting_input', 'cancelling')
            `).run(capability, runId, generation);
            if (runResult.changes === 1) {
              this.db.prepare(`
                DELETE FROM pi_workspace_claims
                WHERE run_id = ? AND execution_generation = ?
              `).run(runId, generation);
              if (this.remoteEmitter) {
                this.remoteEmitter.emitTransitionInTx({ runId, fromStatus: status, toStatus: "interrupted" });
              }
              supervisedInterruptedRunIds.push(runId);
              interrupted++;
            }
            continue;
          }

          // Standalone: paired run/card interruption — a lost card CAS rolls
          // back this row's mutation rather than committing disagreement.
          const runResult = this.db.prepare(`
            UPDATE pi_runs
            SET status = 'interrupted',
                observed_pid = NULL,
                pending_request_id = NULL,
                pending_request_type = NULL,
                resume_capability = ?,
                updated_at = datetime('now')
            WHERE id = ? AND execution_generation = ? AND status IN ('starting', 'running', 'awaiting_input', 'cancelling')
          `).run(capability, runId, generation);
          if (runResult.changes !== 1) continue;
          const cardOutcome = kanbanTransition({
            cardId, from: ["queued", "running"], to: "failed", actor: "restart_recovery",
            reason: "interrupted by bridge restart",
            fields: { error: "interrupted by bridge restart" },
            emit: false,
          }, this.db);
          if (cardOutcome.kind !== "applied") throw ROLLBACK_SENTINEL;
          // Release the stale exact-generation workspace claim in the winning
          // transaction.
          this.db.prepare(`
            DELETE FROM pi_workspace_claims
            WHERE run_id = ? AND execution_generation = ?
          `).run(runId, generation);
          // #1358 review — mechanism A: boot interruption is a public
          // transition; its `interrupted` fact commits with the status change
          // so the origin sees it (and can later resume) after a restart.
          if (this.remoteEmitter) {
            this.remoteEmitter.emitTransitionInTx({ runId, fromStatus: status, toStatus: "interrupted" });
          }
          interrupted++;
        }
      }

      return { interrupted, queuedCardIds, supervisedInterruptedRunIds };
    };
    try {
      return this.db.transaction(fn);
    } catch (err) {
      if (err === ROLLBACK_SENTINEL) return { interrupted: 0, queuedCardIds: [], supervisedInterruptedRunIds: [] };
      throw err;
    }
  }

  /** Query all queued Pi card IDs (for Reconciler lookup). */
  findQueuedPiCardIds(): number[] {
    return (this.db.prepare(
      `SELECT card_id FROM pi_runs WHERE status = 'queued' ORDER BY created_at ASC`
    ).all() as { card_id: number }[]).map(r => r.card_id);
  }

  findNonTerminal(): PiRunRecord[] {
    return (this.db.prepare(`SELECT * FROM pi_runs WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted') ORDER BY created_at ASC`).all() as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  toView(record: PiRunRecord, callerPrincipalId: string): PiRunView {
    return {
      runId: record.id,
      cardId: record.cardId,
      sessionId: record.currentSessionId,
      status: record.status,
      resumeCapability: record.resumeCapability,
      workspaceAlias: record.workspaceAlias,
      owner: {
        principalId: record.ownerPrincipalId,
        origin: record.origin,
        platform: record.originPlatform,
        chatId: record.originChatId,
        peer: record.originPeer,
      },
      modelProvider: record.modelProvider,
      modelId: record.modelId,
      thinking: record.thinking,
      pendingRequestId: callerPrincipalId === record.ownerPrincipalId ? record.pendingRequestId : undefined,
      pendingRequestType: callerPrincipalId === record.ownerPrincipalId ? record.pendingRequestType : undefined,
      lastUiReplyOutcome: callerPrincipalId === record.ownerPrincipalId ? record.lastUiReplyOutcome : undefined,
      generation: record.executionGeneration,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastRpcActivityAt: record.lastRpcActivityAt,
      resultSummary: record.resultSummary,
      changedFilesSummary: record.changedFilesSummary,
      error: record.error,
    };
  }

  private rowToRecord(row: Record<string, unknown>): PiRunRecord {
    return {
      id: row.id as string,
      cardId: row.card_id as number,
      workspaceAlias: row.workspace_alias as string,
      operationalGoal: row.operational_goal as string,
      ownerPrincipalId: row.owner_principal_id as string,
      origin: row.origin as PiRunOrigin,
      originPlatform: (row.origin_platform as string | null) ?? undefined,
      originChatId: (row.origin_chat_id as string | null) ?? undefined,
      originPeer: (row.origin_peer as string | null) ?? undefined,
      originRequestId: (row.origin_request_id as string | null) ?? undefined,
      deliveryPolicy: (row.delivery_policy as "leave_remote" | "patch_artifact" | "commit_push" | null) ?? "leave_remote",
      executionGeneration: row.execution_generation as number,
      generationIntent: (row.generation_intent as PiRunRecord["generationIntent"] | null) ?? "initial",
      currentSessionId: (row.current_session_id as string | null) ?? undefined,
      status: row.status as PiRunStatus,
      resumeCapability: row.resume_capability as ResumeCapability,
      piSessionId: (row.pi_session_id as string | null) ?? undefined,
      piSessionFile: (row.pi_session_file as string | null) ?? undefined,
      observedPid: (row.observed_pid as number | null) ?? undefined,
      modelProvider: (row.model_provider as string | null) ?? undefined,
      modelId: (row.model_id as string | null) ?? undefined,
      thinking: (row.thinking as string | null) ?? undefined,
      pendingRequestId: (row.pending_request_id as string | null) ?? undefined,
      pendingRequestType: (row.pending_request_type as PiPendingRequestType | null) ?? undefined,
      lastUiReplyRequestId: (row.last_ui_reply_request_id as string | null) ?? undefined,
      lastUiReplyGeneration: (row.last_ui_reply_generation as number | null) ?? undefined,
      lastUiReplyOutcome: (row.last_ui_reply_outcome as UiReplyOutcome | null) ?? undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      lastRpcActivityAt: (row.last_rpc_activity_at as string | null) ?? undefined,
      resultSummary: (row.result_summary as string | null) ?? undefined,
      changedFilesSummary: (row.changed_files_summary as string | null) ?? undefined,
      usageJson: (row.usage_json as string | null) ?? undefined,
      error: (row.error as string | null) ?? undefined,
    };
  }

  // ── #1358: Remote Pi event outbox and command ledger ─────────────────────

  /**
   * Allocate the next sequence number for a run.
   * Thread-safe via SQLite's auto-increment and transactional isolation.
   */
  allocateNextSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
    ).get(runId) as { max_seq: number } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /**
   * Atomically allocate the next sequence AND insert the event in one
   * transaction. This is the only safe way to produce an event: the separate
   * allocateNextSequence + appendEvent pair has a race window where two
   * concurrent producers can both compute the same sequence and one of them
   * silently drops its event when the INSERT hits a UNIQUE violation.
   *
   * The `computeFields` callback receives the freshly-allocated sequence and
   * returns the derived `eventId` and `contentSha256`. The callback runs
   * inside the transaction so the row is inserted with the same sequence the
   * caller used to compute the hash.
   *
   * Returns { sequence, idempotent } on success. If a row already exists for
   * (run_id, sequence) with the same content_sha256, the call is treated as
   * an idempotent retry and returns the existing sequence.
   */
  appendEventAuto(input: {
    runId: string;
    cardId: number;
    generation: number;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
    computeFields: (sequence: number) => { eventId: string; contentSha256: string };
  }): { sequence: number; idempotent: boolean } {
    return this.db.transaction(() => this.appendEventAutoInTx(input));
  }

  /**
   * #1358 review — Same append logic as `appendEventAuto` but WITHOUT opening
   * a transaction: intended to run inside the caller's transition transaction
   * (mechanism A). Sequence allocation reads MAX within the same transaction,
   * so a rollback releases the reservation too.
   */
  appendEventAutoInTx(input: {
    runId: string;
    cardId: number;
    generation: number;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
    computeFields: (sequence: number) => { eventId: string; contentSha256: string };
  }): { sequence: number; idempotent: boolean } {
    const fn = (): { sequence: number; idempotent: boolean } => {
      // Step 1: read MAX inside the transaction. SQLite serializes writes, so
      // the MAX we read here is stable until our transaction commits.
      const row = this.db.prepare(
        `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
      ).get(input.runId) as { max_seq: number };
      const sequence = row.max_seq + 1;

      // Step 2: ask the caller to derive eventId and content_sha256 from
      // the allocated sequence. Both fields depend on the sequence, so they
      // must be computed AFTER allocation.
      const { eventId, contentSha256 } = input.computeFields(sequence);

      // Step 3: INSERT. If (run_id, sequence) already exists (because a prior
      // idempotent retry lost its return value), compare content.
      try {
        this.db.prepare(`
          INSERT INTO remote_pi_events
            (run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          input.runId, input.cardId, input.generation, sequence, eventId,
          contentSha256, input.originPeer, input.originRequestId,
          input.kind, input.projectionJson, input.occurredAt,
        );
        return { sequence, idempotent: false };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint")) {
          const existing = this.db.prepare(
            `SELECT content_sha256 FROM remote_pi_events WHERE run_id = ? AND sequence = ?`
          ).get(input.runId, sequence) as { content_sha256: string } | undefined;
          if (existing && existing.content_sha256 === contentSha256) {
            return { sequence, idempotent: true };
          }
          // Conflicting content for the same sequence — surface as a retryable
          // conflict so the caller can either rebuild with a fresh timestamp
          // or escalate. We do NOT swallow this; the producer must know.
          throw new Error(
            `Event conflict for run ${input.runId} sequence ${sequence}: ` +
            `existing content_sha256 differs from new`,
          );
        }
        throw err;
      }
    };
    return fn();
  }

  /**
   * Append a lifecycle event to the durable outbox.
   * Returns false if an event with the same (run_id, sequence) already exists with different content.
   */
  appendEvent(input: {
    runId: string;
    cardId: number;
    generation: number;
    sequence: number;
    eventId: string;
    contentSha256: string;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_events
          (run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        input.runId,
        input.cardId,
        input.generation,
        input.sequence,
        input.eventId,
        input.contentSha256,
        input.originPeer,
        input.originRequestId,
        input.kind,
        input.projectionJson,
        input.occurredAt,
      );
      return true;
    } catch (err: unknown) {
      // UNIQUE constraint violation means duplicate event_id or (run_id, sequence)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        // Check if it's the same content (idempotent)
        const existing = this.db.prepare(
          `SELECT content_sha256 FROM remote_pi_events WHERE run_id = ? AND sequence = ?`
        ).get(input.runId, input.sequence) as { content_sha256: string } | undefined;
        if (existing && existing.content_sha256 === input.contentSha256) {
          return true; // Idempotent duplicate
        }
        return false; // Conflicting content
      }
      throw err;
    }
  }

  /**
   * Get events for a run after a given sequence (for catch-up).
   */
  getEventsAfter(input: { runId: string; afterSequence: number; limit: number }): Array<{
    run_id: string;
    remote_card_id: number;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    occurred_at: string;
    created_at: string;
    acknowledged_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at, acknowledged_at
      FROM remote_pi_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(input.runId, input.afterSequence, input.limit) as any;
  }

  /**
   * Get unacknowledged events for a run (for push delivery).
   */
  getUnacknowledgedEvents(runId: string, limit: number): Array<{
    run_id: string;
    remote_card_id: number;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    occurred_at: string;
    created_at: string;
  }> {
    return this.db.prepare(`
      SELECT run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at
      FROM remote_pi_events
      WHERE run_id = ? AND acknowledged_at IS NULL
      ORDER BY sequence ASC
      LIMIT ?
    `).all(runId, limit) as any;
  }

  /**
   * Acknowledge events up to a sequence.
   * Returns the number of events acknowledged.
   */
  acknowledgeEvents(runId: string, upToSequence: number): number {
    const result = this.db.prepare(`
      UPDATE remote_pi_events
      SET acknowledged_at = datetime('now')
      WHERE run_id = ? AND sequence <= ? AND acknowledged_at IS NULL
    `).run(runId, upToSequence);
    return result.changes;
  }

  /**
   * Get the latest acknowledged sequence for a run.
   */
  getLatestAcknowledgedSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ? AND acknowledged_at IS NOT NULL`
    ).get(runId) as { max_seq: number } | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * Get the maximum sequence for a run (acknowledged or not).
   */
  getMaxSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
    ).get(runId) as { max_seq: number } | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * Compact old progress events for a run, retaining state/input/terminal events.
   * Keeps at most N progress events and all critical events.
   */
  compactProgressEvents(runId: string, maxProgressToRetain: number): number {
    const criticalKinds = ['awaiting_input', 'input_cleared', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled', 'accepted', 'queued', 'starting', 'running'];
    const placeholders = criticalKinds.map(() => '?').join(',');
    // First find progress events to keep (most recent N)
    const toKeep = this.db.prepare(`
      SELECT sequence FROM remote_pi_events
      WHERE run_id = ? AND kind NOT IN (${placeholders})
      ORDER BY sequence DESC
      LIMIT ?
    `).all(runId, ...criticalKinds, maxProgressToRetain) as Array<{ sequence: number }>;
    const keepSequences = toKeep.map(r => r.sequence);
    if (keepSequences.length === 0) {
      // Delete all acknowledged progress events
      const result = this.db.prepare(`
        DELETE FROM remote_pi_events
        WHERE run_id = ? AND kind NOT IN (${placeholders}) AND acknowledged_at IS NOT NULL
      `).run(runId, ...criticalKinds);
      return result.changes;
    }
    // Delete progress events that are acknowledged and not in the keep set
    const keepList = keepSequences.map(() => '?').join(',');
    const result = this.db.prepare(`
      DELETE FROM remote_pi_events
      WHERE run_id = ?
        AND kind NOT IN (${placeholders})
        AND acknowledged_at IS NOT NULL
        AND sequence NOT IN (${keepList})
    `).run(runId, ...criticalKinds, ...keepSequences);
    return result.changes;
  }

  /**
   * Reserve a command slot for idempotency.
   *
   * Returns the reservation result:
   * - 'new': slot was created, caller may proceed
   * - 'replay_completed': identical payload already has a final response — return it
   * - 'replay_dispatch_started': identical payload was dispatched but outcome unknown
   *   (crash between dispatch and response persistence). Caller must return
   *   outcome_unknown and MUST NOT re-dispatch.
   * - 'conflict': different payload with same (peer, command_id) — reject
   */
  reserveCommand(input: {
    originPeer: string;
    commandId: string;
    runId: string;
    payloadHash: string;
  }): { result: "new" | "replay_completed" | "replay_dispatch_started" | "conflict"; state?: string } {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_commands (origin_peer, command_id, run_id, payload_hash, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'received', datetime('now'), datetime('now'))
      `).run(input.originPeer, input.commandId, input.runId, input.payloadHash);
      return { result: "new" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        const existing = this.db.prepare(
          `SELECT state, payload_hash FROM remote_pi_commands WHERE origin_peer = ? AND command_id = ?`
        ).get(input.originPeer, input.commandId) as { state: string; payload_hash: string } | undefined;
        if (!existing) return { result: "conflict" };
        if (existing.payload_hash !== input.payloadHash) {
          return { result: "conflict", state: existing.state };
        }
        // Same payload — return based on current state
        if (existing.state === "completed" || existing.state === "rejected" || existing.state === "outcome_unknown") {
          return { result: "replay_completed", state: existing.state };
        }
        if (existing.state === "dispatch_started" || existing.state === "received") {
          // dispatch_started = crash before response persisted → outcome unknown
          // received = concurrent retry before we started → outcome unknown
          return { result: "replay_dispatch_started", state: existing.state };
        }
        return { result: "conflict", state: existing.state };
      }
      throw err;
    }
  }

  /**
   * Update command state and response.
   */
  updateCommand(input: {
    originPeer: string;
    commandId: string;
    state: string;
    responseJson?: string;
  }): boolean {
    const setClauses = ["state = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [input.state];
    if (input.responseJson !== undefined) {
      setClauses.push("response_json = ?");
      params.push(input.responseJson);
    }
    params.push(input.originPeer, input.commandId);
    const result = this.db.prepare(`
      UPDATE remote_pi_commands
      SET ${setClauses.join(', ')}
      WHERE origin_peer = ? AND command_id = ?
    `).run(...params);
    return result.changes > 0;
  }

  /**
   * Get a command record.
   */
  getCommand(originPeer: string, commandId: string): {
    run_id: string;
    payload_hash: string;
    state: string;
    response_json: string | null;
    created_at: string;
    updated_at: string;
  } | null {
    const row = this.db.prepare(
      `SELECT run_id, payload_hash, state, response_json, created_at, updated_at FROM remote_pi_commands WHERE origin_peer = ? AND command_id = ?`
    ).get(originPeer, commandId) as any;
    return row ?? null;
  }

  /**
   * Clean up old command records (completed/rejected).
   */
  cleanupOldCommands(olderThanHours: number): number {
    const result = this.db.prepare(`
      DELETE FROM remote_pi_commands
      WHERE state IN ('completed', 'rejected', 'outcome_unknown')
        AND updated_at < datetime('now', '-' || ? || ' hours')
    `).run(olderThanHours);
    return result.changes;
  }

  /**
   * #1551 — Consumed approval markers are one-shot idempotency guards; once
   * consumed they have no further purpose, so pure age is a safe predicate
   * (no "in-flight" state to protect, unlike cleanupOldCommands above).
   */
  cleanupConsumedApprovals(olderThanHours: number): number {
    const result = this.db.prepare(`
      DELETE FROM remote_pi_approvals_consumed
      WHERE consumed_at < datetime('now', '-' || ? || ' hours')
    `).run(olderThanHours);
    return result.changes;
  }

  /**
   * Atomically consume a resume approval.
   * Returns true if the approval was newly consumed (first use),
   * false if it was already consumed by a different command.
   *
   * If the same (approval_id, command_id) is replayed, returns true
   * (idempotent — the command ledger handles that case separately).
   */
  consumeApproval(input: {
    approvalId: string;
    runId: string;
    originPeer: string;
    commandId: string;
  }): { consumed: true; firstUse: boolean } | { consumed: false; reason: string } {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_approvals_consumed (approval_id, run_id, origin_peer, command_id)
        VALUES (?, ?, ?, ?)
      `).run(input.approvalId, input.runId, input.originPeer, input.commandId);
      return { consumed: true, firstUse: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        // Already consumed — check if it's the same command (idempotent replay)
        const existing = this.db.prepare(
          `SELECT command_id FROM remote_pi_approvals_consumed WHERE approval_id = ?`
        ).get(input.approvalId) as { command_id: string } | undefined;
        if (existing && existing.command_id === input.commandId) {
          return { consumed: true, firstUse: false };
        }
        return { consumed: false, reason: "Approval already consumed by a different command" };
      }
      throw err;
    }
  }

  /**
   * Check if an approval has been consumed.
   */
  isApprovalConsumed(approvalId: string): boolean {
    const row = this.db.prepare(
      `SELECT approval_id FROM remote_pi_approvals_consumed WHERE approval_id = ?`
    ).get(approvalId) as { approval_id: string } | undefined;
    return !!row;
  }

  /**
   * Get runs with unacknowledged events (for outbox draining).
   */
  findRunsWithUnacknowledgedEvents(): Array<{ run_id: string; origin_peer: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.run_id, r.origin_peer
      FROM remote_pi_events e
      JOIN pi_runs r ON e.run_id = r.id
      WHERE e.acknowledged_at IS NULL
    `).all() as Array<{ run_id: string; origin_peer: string }>;
  }

  /**
   * #1358 review — Persisted round-robin drain cursor for remote-pi-drain.
   * Survives restarts so no peer starves behind a noisy one.
   */
  getDrainCursor(): number {
    const row = this.db.prepare(
      `SELECT value FROM remote_pi_drain_state WHERE key = 'peer_cursor'`
    ).get() as { value: string } | undefined;
    const parsed = row ? Number(row.value) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  setDrainCursor(value: number): void {
    this.db.prepare(`
      INSERT INTO remote_pi_drain_state (key, value) VALUES ('peer_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(value));
  }

  /**
   * Get the underlying database (for advanced queries).
   */
  getDb(): TaskDatabase {
    return this.db;
  }
}
