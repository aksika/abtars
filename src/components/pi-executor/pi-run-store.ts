import { randomUUID } from "node:crypto";
import type { PiRunRecord, PiRunStatus, PiRunView, PiRunOrigin, PiPendingRequestType, ResumeCapability, PendingUiClaim, PendingUiSetResult } from "./types.js";
import type { UiReplyOutcome } from "./types.js";
import { MAX_PROGRESS_ENTRIES } from "./types.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { completePendingRequestInTransaction, ensureRequestLedgerSchema } from "../pi-request-ledger.js";

export type RpcDelivery = "not_written" | "written_unacknowledged" | "acknowledged";

export interface PiRunStoreDeps {
  db: TaskDatabase;
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
  | { committed: false; reason: "stale_generation" | "wrong_status" | "missing" };

export type PiStartClaim =
  | { claimed: true; runId: string; generation: number }
  | { claimed: false; reason: "missing" | "not_queued" | "card_mismatch" };

export type PiResumeCommit =
  | { committed: true; runId: string; newGeneration: number; cardId: number }
  | { committed: false; reason: "stale" | "not_resumable" | "card_mismatch" };

export class PiRunStore {
  private readonly db: TaskDatabase;

  constructor(deps: PiRunStoreDeps) {
    this.db = deps.db;
    this.migrate();
    ensureRequestLedgerSchema(this.db);
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

    // #1358 — Remote Pi lifecycle event outbox
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_events (
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      content_sha256 TEXT NOT NULL,
      origin_peer TEXT NOT NULL,
      origin_request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      projection_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_at TEXT,
      PRIMARY KEY (run_id, sequence)
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_origin_peer ON remote_pi_events(origin_peer)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_acknowledged ON remote_pi_events(acknowledged_at) WHERE acknowledged_at IS NULL`);

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
        origin, origin_platform, origin_chat_id, origin_peer, execution_generation, current_session_id, status,
        model_provider, model_id, thinking)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'queued', ?, ?, ?)`).run(
        input.runId, cardId, input.workspaceAlias, input.goal,
        input.ownerPrincipalId, input.origin, input.originPlatform ?? null,
        input.originChatId ?? null, input.originPeer ?? null,
        input.sessionId,
        input.modelProvider ?? null, input.modelId ?? null, input.thinking ?? null,
      );

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
    const result = this.db.prepare(`UPDATE pi_runs SET ${setClauses.join(", ")} WHERE id = ? AND status IN (${fromArr.map(() => "?").join(",")})`).run(...params);
    return result.changes > 0;
  }

  /**
   * #1396 — Atomically transition a Pi run to its terminal outcome and update
   * the linked Kanban card in one transaction.  Predicates on run id,
   * execution_generation, and expected statuses so that only one concurrent
   * contender wins.  Publishes no Nerve event — the caller fires the mapped
   * event only after commit.
   */
  settleTerminal(input: {
    runId: string;
    generation: number;
    expectedStatuses: PiRunStatus[];
    outcome: PiTerminalOutcome;
    metadata: PiTerminalMetadata;
  }): PiTerminalSettlement {
    return this.db.transaction<PiTerminalSettlement>(() => {
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

      // Update linked kanban card
      if (input.outcome === "completed") {
        this.db.prepare(
          `UPDATE kanban_board SET status = 'done', result_summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).run(input.metadata.resultSummary?.slice(0, 4000) ?? null, cardId);
      } else {
        // failed or cancelled → kanban_board status = 'failed'
        this.db.prepare(
          `UPDATE kanban_board SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
        ).run(input.metadata.error?.slice(0, 1000) ?? input.outcome, cardId);
      }

      return { committed: true, outcome: input.outcome, cardId };
    });
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
    return result.changes > 0;
  }

  // #1395 — Record the outcome of a UI reply RPC.
  // Only updates if the outcome is still 'claimed'.
  recordUiReplyOutcome(input: {
    runId: string;
    generation: number;
    requestId: string;
    outcome: "acknowledged" | "delivery_unknown";
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
    return { ok: true };
  }

  addProgress(runId: string, kind: string, payload: string): void {
    this.db.prepare(`INSERT INTO pi_run_progress (run_id, kind, payload) VALUES (?, ?, ?)`).run(runId, kind, payload);
    const count = this.db.prepare(`SELECT COUNT(*) as cnt FROM pi_run_progress WHERE run_id = ?`).get(runId) as { cnt: number } | undefined;
    if (count && count.cnt > MAX_PROGRESS_ENTRIES) {
      this.db.prepare(`DELETE FROM pi_run_progress WHERE id IN (SELECT id FROM pi_run_progress WHERE run_id = ? ORDER BY id ASC LIMIT ?)`).run(runId, count.cnt - MAX_PROGRESS_ENTRIES);
    }
  }

  // ── #1405: atomic lifecycle operations ──────────────────────────────────────

  /**
   * #1405 — Atomically claim a queued Pi run and its linked card.
   * Transitions run queued→starting, card queued→running in one transaction.
   * Returns the claim or a typed conflict.
   */
  claimQueuedGeneration(cardId: number): PiStartClaim {
    return this.db.transaction<PiStartClaim>(() => {
      const runRow = this.db.prepare(
        `SELECT id, execution_generation, status FROM pi_runs WHERE card_id = ? AND status = 'queued'`
      ).get(cardId) as Record<string, unknown> | undefined;
      if (!runRow) return { claimed: false, reason: "missing" };

      const runId = runRow.id as string;
      const gen = runRow.execution_generation as number;

      // Run queued → starting
      const runChanged = this.db.prepare(
        `UPDATE pi_runs SET status = 'starting', updated_at = datetime('now') WHERE id = ? AND status = 'queued'`
      ).run(runId);
      if (runChanged.changes === 0) return { claimed: false, reason: "not_queued" };

      // Card queued → running
      const cardChanged = this.db.prepare(
        `UPDATE kanban_board SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'queued'`
      ).run(cardId);
      if (cardChanged.changes === 0) {
        // Compensate — roll back the run transition
        this.db.prepare(`UPDATE pi_runs SET status = 'queued', updated_at = datetime('now') WHERE id = ?`).run(runId);
        return { claimed: false, reason: "card_mismatch" };
      }

      return { claimed: true, runId, generation: gen };
    });
  }

  /**
   * #1405 — Atomically create a new resume generation: increment generation,
   * set run and card to queued, clear terminal fields. Returns the commit or
   * a typed conflict.
   */
  queueResumeGeneration(input: {
    runId: string;
    expectedGeneration: number;
    newSessionId: string;
    sessionFile: string;
  }): PiResumeCommit {
    return this.db.transaction<PiResumeCommit>(() => {
      const row = this.db.prepare(
        `SELECT id, execution_generation, status, card_id, resume_capability FROM pi_runs WHERE id = ?`
      ).get(input.runId) as Record<string, unknown> | undefined;
      if (!row) return { committed: false, reason: "stale" };
      if ((row.execution_generation as number) !== input.expectedGeneration) return { committed: false, reason: "stale" };
      if ((row.status as string) !== "interrupted" && (row.status as string) !== "failed") return { committed: false, reason: "not_resumable" };
      if ((row.resume_capability as string) !== "available") return { committed: false, reason: "not_resumable" };

      const cardId = row.card_id as number;
      const newGen = input.expectedGeneration + 1;

      // Update run
      this.db.prepare(`
        UPDATE pi_runs
        SET status = 'queued',
            execution_generation = ?,
            current_session_id = ?,
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
      `).run(newGen, input.newSessionId, input.sessionFile, input.runId, input.expectedGeneration);

      // Update card
      this.db.prepare(`
        UPDATE kanban_board
        SET status = 'queued',
            completed_at = NULL,
            error = NULL,
            result_summary = NULL,
            updated_at = datetime('now')
        WHERE id = ? AND status IN ('failed', 'done')
      `).run(cardId);

      return { committed: true, runId: input.runId, newGeneration: newGen, cardId };
    });
  }

  /**
   * #1405 — Recover all non-terminal Pi runs at boot.
   * - queued runs: preserved as-is, return their card IDs for post-registration wakeup
   * - active runs (starting/running/awaiting_input/cancelling): interrupted
   * - terminal runs: unchanged
   * Returns queued card IDs that should be woken after Pi service registration.
   */
  recoverNonterminal(): { interrupted: number; queuedCardIds: number[] } {
    return this.db.transaction<{ interrupted: number; queuedCardIds: number[] }>(() => {
      const runs = this.db.prepare(
        `SELECT id, status, card_id FROM pi_runs WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')`
      ).all() as Record<string, unknown>[];

      const activeStatuses = ["starting", "running", "awaiting_input", "cancelling"];
      const queuedCardIds: number[] = [];
      let interrupted = 0;

      for (const run of runs) {
        const runId = run.id as string;
        const cardId = run.card_id as number;
        const status = run.status as string;

        if (status === "queued") {
          queuedCardIds.push(cardId);
          // Clear stale observed PID
          this.db.prepare(`UPDATE pi_runs SET observed_pid = NULL, updated_at = datetime('now') WHERE id = ?`).run(runId);
        } else if (activeStatuses.includes(status)) {
          this.db.prepare(`
            UPDATE pi_runs
            SET status = 'interrupted',
                observed_pid = NULL,
                pending_request_id = NULL,
                pending_request_type = NULL,
                resume_capability = CASE WHEN pi_session_id IS NOT NULL THEN 'available' ELSE 'never_started' END,
                updated_at = datetime('now')
            WHERE id = ? AND status = ?
          `).run(runId, status);
          // Update card to failed/interrupted
          this.db.prepare(`
            UPDATE kanban_board SET status = 'failed', error = 'interrupted by bridge restart', updated_at = datetime('now') WHERE id = ? AND status IN ('queued', 'running')
          `).run(cardId);
          interrupted++;
        }
      }

      return { interrupted, queuedCardIds };
    });
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
      executionGeneration: row.execution_generation as number,
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
   * Append a lifecycle event to the durable outbox.
   * Returns false if an event with the same (run_id, sequence) already exists with different content.
   */
  appendEvent(input: {
    runId: string;
    generation: number;
    sequence: number;
    eventId: string;
    contentSha256: string;
    originPeer: string;
    originRequestId: string;
    kind: string;
    projectionJson: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_events
          (run_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        input.runId,
        input.generation,
        input.sequence,
        input.eventId,
        input.contentSha256,
        input.originPeer,
        input.originRequestId,
        input.kind,
        input.projectionJson,
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
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    created_at: string;
    acknowledged_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT run_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, created_at, acknowledged_at
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
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    created_at: string;
  }> {
    return this.db.prepare(`
      SELECT run_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, created_at
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
   * Returns true if the command is new, false if a conflicting state exists.
   */
  reserveCommand(input: {
    originPeer: string;
    commandId: string;
    runId: string;
    payloadHash: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_commands (origin_peer, command_id, run_id, payload_hash, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'received', datetime('now'), datetime('now'))
      `).run(input.originPeer, input.commandId, input.runId, input.payloadHash);
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        const existing = this.db.prepare(
          `SELECT state, payload_hash FROM remote_pi_commands WHERE origin_peer = ? AND command_id = ?`
        ).get(input.originPeer, input.commandId) as { state: string; payload_hash: string } | undefined;
        if (!existing) return false;
        // Allow replay if payload hash matches and state permits
        if (existing.payload_hash === input.payloadHash) {
          return ['received', 'dispatch_started'].includes(existing.state);
        }
        return false; // Conflicting payload
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
   * Get runs with unacknowledged events (for outbox draining).
   */
  fallsWithUnacknowledgedEvents(): Array<{ run_id: string; origin_peer: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.run_id, r.origin_peer
      FROM remote_pi_events e
      JOIN pi_runs r ON e.run_id = r.id
      WHERE e.acknowledged_at IS NULL
    `).all() as Array<{ run_id: string; origin_peer: string }>;
  }

  /**
   * Get the underlying database (for advanced queries).
   */
  getDb(): TaskDatabase {
    return this.db;
  }
}
