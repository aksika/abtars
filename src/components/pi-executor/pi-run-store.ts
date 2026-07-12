import { randomUUID } from "node:crypto";
import type { PiRunRecord, PiRunStatus, PiRunView, PiRunOrigin, PiPendingRequestType, ResumeCapability } from "./types.js";
import { MAX_PROGRESS_ENTRIES } from "./types.js";

export interface PiRunStoreDeps {
  db: {
    prepare(sql: string): { run(...params: unknown[]): { changes: number }; get(...params: unknown[]): Record<string, unknown> | undefined; all(...params: unknown[]): Record<string, unknown>[] };
    transaction<T>(fn: () => T): T;
  };
}

export class PiRunStore {
  private readonly db: PiRunStoreDeps["db"];

  constructor(deps: PiRunStoreDeps) {
    this.db = deps.db;
    this.migrate();
  }

  private migrate(): void {
    this.db.prepare(`CREATE TABLE IF NOT EXISTS pi_runs (
      id TEXT PRIMARY KEY,
      card_id INTEGER UNIQUE NOT NULL,
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
    )`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_pi_runs_status ON pi_runs(status)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_pi_runs_card_id ON pi_runs(card_id)`).run();
    this.db.prepare(`CREATE TABLE IF NOT EXISTS pi_run_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES pi_runs(id),
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_progress_run_id ON pi_run_progress(run_id)`).run();
  }

  generateId(): string {
    return randomUUID().slice(0, 12);
  }

  insert(input: {
    id: string; cardId: number; workspaceAlias: string; operationalGoal: string;
    ownerPrincipalId: string; origin: PiRunOrigin; originPlatform?: string;
    originChatId?: string; originPeer?: string; modelProvider?: string;
    modelId?: string; thinking?: string;
  }): void {
    this.db.prepare(`INSERT INTO pi_runs (id, card_id, workspace_alias, operational_goal, owner_principal_id,
      origin, origin_platform, origin_chat_id, origin_peer, execution_generation, status,
      model_provider, model_id, thinking)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'queued', ?, ?, ?)`).run(
      input.id, input.cardId, input.workspaceAlias, input.operationalGoal,
      input.ownerPrincipalId, input.origin, input.originPlatform ?? null,
      input.originChatId ?? null, input.originPeer ?? null,
      input.modelProvider ?? null, input.modelId ?? null, input.thinking ?? null,
    );
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
    thinking: string; pendingRequestId: string; pendingRequestType: PiPendingRequestType;
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

  touchActivity(id: string): void {
    this.db.prepare(`UPDATE pi_runs SET last_rpc_activity_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(id);
  }

  addProgress(runId: string, kind: string, payload: string): void {
    this.db.prepare(`INSERT INTO pi_run_progress (run_id, kind, payload) VALUES (?, ?, ?)`).run(runId, kind, payload);
    const count = this.db.prepare(`SELECT COUNT(*) as cnt FROM pi_run_progress WHERE run_id = ?`).get(runId) as { cnt: number } | undefined;
    if (count && count.cnt > MAX_PROGRESS_ENTRIES) {
      this.db.prepare(`DELETE FROM pi_run_progress WHERE id IN (SELECT id FROM pi_run_progress WHERE run_id = ? ORDER BY id ASC LIMIT ?)`).run(runId, count.cnt - MAX_PROGRESS_ENTRIES);
    }
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
      originPlatform: row.origin_platform as string | undefined,
      originChatId: row.origin_chat_id as string | undefined,
      originPeer: row.origin_peer as string | undefined,
      executionGeneration: row.execution_generation as number,
      currentSessionId: row.current_session_id as string | undefined,
      status: row.status as PiRunStatus,
      resumeCapability: row.resume_capability as ResumeCapability,
      piSessionId: row.pi_session_id as string | undefined,
      piSessionFile: row.pi_session_file as string | undefined,
      observedPid: row.observed_pid as number | undefined,
      modelProvider: row.model_provider as string | undefined,
      modelId: row.model_id as string | undefined,
      thinking: row.thinking as string | undefined,
      pendingRequestId: row.pending_request_id as string | undefined,
      pendingRequestType: row.pending_request_type as PiPendingRequestType | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      lastRpcActivityAt: row.last_rpc_activity_at as string | undefined,
      resultSummary: row.result_summary as string | undefined,
      changedFilesSummary: row.changed_files_summary as string | undefined,
      usageJson: row.usage_json as string | undefined,
      error: row.error as string | undefined,
    };
  }
}
