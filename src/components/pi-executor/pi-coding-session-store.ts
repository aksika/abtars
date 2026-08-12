/**
 * pi-coding-session-store.ts — #1635 durable interactive Pi coding sessions.
 *
 * One row per interactive session; turns advance `runtime_generation` on the
 * row, they never create rows and never touch `pi_runs` or `kanban_board`.
 * The row is keyed by the abTARS Spin session id (the durable C envelope that
 * spans all turn generations).
 *
 * State is a typed union enforced in store operations, never a DDL CHECK.
 */

import type { TaskDatabase } from "../tasks/kanban-board.js";
import type { PiPendingRequestType, ResumeCapability } from "./types.js";

export type PiCodingState =
  | "creating" | "idle" | "starting" | "running" | "awaiting_input"
  | "suspended" | "resuming" | "interrupted" | "ended";

export type PiCodingLeaseFrontend = "telegram-rpc" | "native-tui";

export interface PiCodingLease {
  frontend: PiCodingLeaseFrontend;
  owner: string;
  generation: number;
  acquiredAt: string;
}

export interface PiCodingSessionRecord {
  sessionId: string;
  ownerPrincipal: string;
  workspaceAlias: string;
  canonicalPath: string;
  piSessionId?: string;
  piSessionFile?: string;
  modelProvider?: string;
  modelId?: string;
  thinking?: string;
  memoryMode: "none" | "abmind";
  state: PiCodingState;
  runtimeGeneration: number;
  generationIntent: "initial" | "resume";
  resumeCapability: ResumeCapability;
  leaseFrontend?: PiCodingLeaseFrontend;
  leaseOwner?: string;
  leaseGeneration?: number;
  leaseAcquiredAt?: string;
  leaseLastObservedAt?: string;
  observedPid?: number;
  pendingRequestId?: string;
  pendingRequestType?: PiPendingRequestType;
  usageJson?: string;
  changedFilesSummary?: string;
  lastActivityAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type PiCodingTransitionUpdates = Partial<{
  piSessionId: string | null;
  piSessionFile: string | null;
  modelProvider: string | null;
  modelId: string | null;
  thinking: string | null;
  memoryMode: "none" | "abmind";
  resumeCapability: ResumeCapability;
  leaseFrontend: PiCodingLeaseFrontend | null;
  leaseOwner: string | null;
  leaseGeneration: number | null;
  leaseAcquiredAt: string | null;
  leaseLastObservedAt: string | null;
  observedPid: number | null;
  pendingRequestId: string | null;
  pendingRequestType: PiPendingRequestType | null;
  usageJson: string | null;
  changedFilesSummary: string | null;
  lastActivityAt: string | null;
}>;

export type PiCodingCasResult =
  | { applied: true; record: PiCodingSessionRecord }
  | { applied: false; reason: "missing" | "wrong_state" | "stale_generation" };

export interface CreatePiCodingSessionInput {
  sessionId: string;
  ownerPrincipal: string;
  workspaceAlias: string;
  canonicalPath: string;
  modelProvider?: string;
  modelId?: string;
  thinking?: string;
}

export class PiCodingSessionStore {
  private readonly db: TaskDatabase;

  constructor(db: TaskDatabase) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS pi_coding_sessions (
      session_id TEXT PRIMARY KEY,
      owner_principal TEXT NOT NULL,
      workspace_alias TEXT NOT NULL,
      canonical_path TEXT NOT NULL,
      pi_session_id TEXT,
      pi_session_file TEXT,
      model_provider TEXT,
      model_id TEXT,
      thinking TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'none',
      state TEXT NOT NULL DEFAULT 'creating',
      runtime_generation INTEGER NOT NULL DEFAULT 1,
      generation_intent TEXT NOT NULL DEFAULT 'initial',
      resume_capability TEXT NOT NULL DEFAULT 'never_started',
      lease_frontend TEXT,
      lease_owner TEXT,
      lease_generation INTEGER,
      lease_acquired_at TEXT,
      lease_last_observed_at TEXT,
      observed_pid INTEGER,
      pending_request_id TEXT,
      pending_request_type TEXT,
      usage_json TEXT,
      changed_files_summary TEXT,
      last_activity_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_coding_sessions_owner ON pi_coding_sessions(owner_principal, updated_at DESC)`);
  }

  /**
   * #1635 — Create the durable row. The caller has already allocated the Spin
   * C envelope; the row starts `creating` and the service transitions it to
   * `idle` after the envelope is fully established. Idempotent on the session
   * id — a crash between envelope allocation and row creation never leaves a
   * duplicated row.
   */
  create(input: CreatePiCodingSessionInput): PiCodingSessionRecord {
    const existing = this.db.prepare(`SELECT session_id FROM pi_coding_sessions WHERE session_id = ?`).get(input.sessionId);
    if (existing) return this.get(input.sessionId)!;
    this.db.prepare(`INSERT INTO pi_coding_sessions (
      session_id, owner_principal, workspace_alias, canonical_path,
      model_provider, model_id, thinking,
      memory_mode, state, runtime_generation, generation_intent, resume_capability
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 'creating', 1, 'initial', 'never_started')`).run(
      input.sessionId, input.ownerPrincipal, input.workspaceAlias, input.canonicalPath,
      input.modelProvider ?? null, input.modelId ?? null, input.thinking ?? null,
    );
    return this.get(input.sessionId)!;
  }

  get(sessionId: string): PiCodingSessionRecord | null {
    const row = this.db.prepare(`SELECT * FROM pi_coding_sessions WHERE session_id = ?`).get(sessionId);
    if (!row) return null;
    return this.rowToRecord(row);
  }

  /** #1635 — Run a caller-supplied body inside one transaction (used by the
   * service for atomic turn-start: advance + CAS + claim acquire). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  listForOwner(ownerPrincipal: string): PiCodingSessionRecord[] {
    return (this.db.prepare(
      `SELECT * FROM pi_coding_sessions WHERE owner_principal = ? AND state != 'ended' ORDER BY updated_at DESC`
    ).all(ownerPrincipal) as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  /** Most recently active non-ended session for an owner, if any. */
  getMostRecentForOwner(ownerPrincipal: string): PiCodingSessionRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM pi_coding_sessions WHERE owner_principal = ? AND state != 'ended' ORDER BY updated_at DESC LIMIT 1`
    ).get(ownerPrincipal);
    return row ? this.rowToRecord(row) : null;
  }

  /** #1635 — rows in live states (a live process may have existed at crash
   * time). Used by boot reconciliation to mark them interrupted. */
  listLive(): PiCodingSessionRecord[] {
    return (this.db.prepare(
      `SELECT * FROM pi_coding_sessions WHERE state IN ('starting','running','awaiting_input','resuming')`
    ).all() as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  /** #1635 — rows carrying a stale writer lease outside the live states
   * (a crash between process exit and lease clear). */
  listStaleLeases(): PiCodingSessionRecord[] {
    return (this.db.prepare(
      `SELECT * FROM pi_coding_sessions
       WHERE lease_generation IS NOT NULL AND state NOT IN ('starting','running','awaiting_input','resuming')`
    ).all() as Record<string, unknown>[]).map(r => this.rowToRecord(r));
  }

  /**
   * #1635 — CAS state transition with typed updates. Enforces expected state
   * and, when provided, an exact generation fence (a stale runtime may never
   * mutate a newer generation's row).
   */
  casTransition(
    sessionId: string,
    fromState: PiCodingState | PiCodingState[],
    toState: PiCodingState,
    updates?: PiCodingTransitionUpdates,
    expectedGeneration?: number,
  ): PiCodingCasResult {
    const fromArr = Array.isArray(fromState) ? fromState : [fromState];
    const placeholders = fromArr.map(() => "?").join(", ");
    const setClauses: string[] = ["state = ?", `updated_at = datetime('now')`];
    const params: unknown[] = [toState];

    const genClause = expectedGeneration !== undefined ? ` AND runtime_generation = ?` : "";

    if (updates) {
      const colMap: Record<keyof PiCodingTransitionUpdates, string> = {
        piSessionId: "pi_session_id",
        piSessionFile: "pi_session_file",
        modelProvider: "model_provider",
        modelId: "model_id",
        thinking: "thinking",
        memoryMode: "memory_mode",
        resumeCapability: "resume_capability",
        leaseFrontend: "lease_frontend",
        leaseOwner: "lease_owner",
        leaseGeneration: "lease_generation",
        leaseAcquiredAt: "lease_acquired_at",
        leaseLastObservedAt: "lease_last_observed_at",
        observedPid: "observed_pid",
        pendingRequestId: "pending_request_id",
        pendingRequestType: "pending_request_type",
        usageJson: "usage_json",
        changedFilesSummary: "changed_files_summary",
        lastActivityAt: "last_activity_at",
      };
      for (const [key, value] of Object.entries(updates)) {
        setClauses.push(`${colMap[key as keyof PiCodingTransitionUpdates]} = ?`);
        params.push(value ?? null);
      }
    }

    // Bind order must mirror the SQL: SET clauses, then session_id, state IN,
    // then the optional generation fence.
    const result = this.db.prepare(
      `UPDATE pi_coding_sessions SET ${setClauses.join(", ")}
       WHERE session_id = ? AND state IN (${placeholders})${genClause}`
    ).run(...params, sessionId, ...fromArr, ...(expectedGeneration !== undefined ? [expectedGeneration] : []));
    if (result.changes !== 1) {
      const row = this.db.prepare(`SELECT state, runtime_generation FROM pi_coding_sessions WHERE session_id = ?`).get(sessionId);
      if (!row) return { applied: false, reason: "missing" };
      if (expectedGeneration !== undefined && (row.runtime_generation as number) !== expectedGeneration) {
        return { applied: false, reason: "stale_generation" };
      }
      return { applied: false, reason: "wrong_state" };
    }
    return { applied: true, record: this.get(sessionId)! };
  }

  /**
   * #1635 — Advance to a new turn generation with the explicit intent, in one
   * statement. Fenced on the expected current generation.
   */
  advanceGeneration(sessionId: string, expectedGeneration: number, intent: "initial" | "resume"): boolean {
    const result = this.db.prepare(
      `UPDATE pi_coding_sessions
       SET runtime_generation = runtime_generation + 1, generation_intent = ?, updated_at = datetime('now')
       WHERE session_id = ? AND runtime_generation = ?`
    ).run(intent, sessionId, expectedGeneration);
    return result.changes === 1;
  }

  /** #1635 — Set the exclusive writer lease for the exact generation. */
  setLease(sessionId: string, lease: PiCodingLease, expectedGeneration: number): boolean {
    const result = this.db.prepare(
      `UPDATE pi_coding_sessions SET
         lease_frontend = ?, lease_owner = ?, lease_generation = ?,
         lease_acquired_at = ?, lease_last_observed_at = ?,
         updated_at = datetime('now')
       WHERE session_id = ? AND runtime_generation = ? AND lease_generation IS NULL`
    ).run(lease.frontend, lease.owner, lease.generation, lease.acquiredAt, lease.acquiredAt, sessionId, expectedGeneration);
    return result.changes === 1;
  }

  /** #1635 — Clear the writer lease; fenced on the exact lease generation so
   * a stale generation can never release a newer holder. */
  clearLease(sessionId: string, expectedGeneration: number): boolean {
    const result = this.db.prepare(
      `UPDATE pi_coding_sessions SET
         lease_frontend = NULL, lease_owner = NULL, lease_generation = NULL,
         lease_acquired_at = NULL, lease_last_observed_at = NULL,
         updated_at = datetime('now')
       WHERE session_id = ? AND lease_generation = ?`
    ).run(sessionId, expectedGeneration);
    return result.changes === 1;
  }

  /** #1635 — Observe the lease holder is still alive (bounded keepalive). */
  touchLease(sessionId: string, expectedGeneration: number): void {
    this.db.prepare(
      `UPDATE pi_coding_sessions SET lease_last_observed_at = datetime('now'), updated_at = datetime('now')
       WHERE session_id = ? AND lease_generation = ?`
    ).run(sessionId, expectedGeneration);
  }

  /** #1635 — Record the proof-derived capability; the transition applies in
   * any non-terminal state and never bumps generation. */
  recordResumeCapability(sessionId: string, capability: ResumeCapability): void {
    this.db.prepare(
      `UPDATE pi_coding_sessions SET resume_capability = ?, updated_at = datetime('now') WHERE session_id = ?`
    ).run(capability, sessionId);
  }

  touchActivity(sessionId: string): void {
    this.db.prepare(
      `UPDATE pi_coding_sessions SET last_activity_at = datetime('now'), updated_at = datetime('now') WHERE session_id = ?`
    ).run(sessionId);
  }

  /** #1635 — Terminal transition: the owner explicitly ended the session. The
   * row stays as the durable record; the Pi transcript is never touched. */
  markEnded(sessionId: string): boolean {
    const result = this.db.prepare(
      `UPDATE pi_coding_sessions SET state = 'ended', updated_at = datetime('now') WHERE session_id = ?`
    ).run(sessionId);
    return result.changes === 1;
  }

  private rowToRecord(row: Record<string, unknown>): PiCodingSessionRecord {
    const opt = <T>(v: unknown): T | undefined => (v === null || v === undefined ? undefined : (v as T));
    return {
      sessionId: row.session_id as string,
      ownerPrincipal: row.owner_principal as string,
      workspaceAlias: row.workspace_alias as string,
      canonicalPath: row.canonical_path as string,
      piSessionId: opt<string>(row.pi_session_id),
      piSessionFile: opt<string>(row.pi_session_file),
      modelProvider: opt<string>(row.model_provider),
      modelId: opt<string>(row.model_id),
      thinking: opt<string>(row.thinking),
      memoryMode: (row.memory_mode as "none" | "abmind") ?? "none",
      state: row.state as PiCodingState,
      runtimeGeneration: row.runtime_generation as number,
      generationIntent: row.generation_intent as "initial" | "resume",
      resumeCapability: row.resume_capability as ResumeCapability,
      leaseFrontend: opt<PiCodingLeaseFrontend>(row.lease_frontend),
      leaseOwner: opt<string>(row.lease_owner),
      leaseGeneration: opt<number>(row.lease_generation),
      leaseAcquiredAt: opt<string>(row.lease_acquired_at),
      leaseLastObservedAt: opt<string>(row.lease_last_observed_at),
      observedPid: opt<number>(row.observed_pid),
      pendingRequestId: opt<string>(row.pending_request_id),
      pendingRequestType: opt<PiPendingRequestType>(row.pending_request_type),
      usageJson: opt<string>(row.usage_json),
      changedFilesSummary: opt<string>(row.changed_files_summary),
      lastActivityAt: opt<string>(row.last_activity_at),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
