/**
 * sha-incident-store.ts — durable SHA incident episodes, source events,
 * transition journal, and policy cooldown state (#1688 Task 3).
 *
 * Owns exactly the four `sha_*` tables on the canonical TaskDatabase. All
 * mutating multi-row operations run in one `BEGIN IMMEDIATE` transaction.
 * Identity rules (R4):
 *  - one active episode per fingerprint (database-enforced partial unique index);
 *  - replaying the same event key is a no-op that never increments counts;
 *  - a different event with the same fingerprint increments the active episode;
 *  - a terminal episode permits a later event to allocate a new episode;
 *  - every state transition is compare-and-set on `version` and appends a
 *    journal row in the same transaction.
 */
import type { TaskDatabase } from "../tasks/kanban-board.js";
import type { ShaIncidentState } from "./sha-types.js";
import { isTerminalShaIncidentState } from "./sha-types.js";
import type { TaskKind } from "../tasks/task-types.js";

export const SHA_INCIDENT_STATES: readonly ShaIncidentState[] = [
  "provisioning", "rca", "design", "solution", "review",
  "known_fix_running", "known_fix_verified", "known_fix_unverified", "known_fix_failed",
  "investigation_complete", "accepted", "blocked",
];

export const MAX_DIAGNOSTIC_JSON_BYTES = 8192;

export type ShaWorkflowKind = "project" | "known_fix";
export type ShaSourceKind = "scheduled" | "log";

export interface IncidentRow {
  id: number;
  fingerprint: string;
  episode: number;
  workflowKind: ShaWorkflowKind;
  source: ShaSourceKind;
  sourceScope: string;
  taskKind: TaskKind | null;
  mode: "investigation" | "full";
  state: ShaIncidentState;
  version: number;
  occurrenceCount: number;
  rootCardId: number | null;
  currentStageCardId: number | null;
  evidenceRoot: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  terminalAt: string | null;
  terminalReason: string | null;
}

export interface IncidentSummary {
  id: number;
  fingerprintPrefix: string;
  episode: number;
  workflowKind: ShaWorkflowKind;
  source: ShaSourceKind;
  sourceScope: string;
  mode: "investigation" | "full";
  state: ShaIncidentState;
  occurrenceCount: number;
  rootCardId: number | null;
  currentStageCardId: number | null;
  lastSeenAt: string;
  terminalAt: string | null;
  terminalReason: string | null;
}

export type AdmitResult =
  | { kind: "duplicate_event" }
  | { kind: "attached"; incidentId: number; occurrenceCount: number; rootCardId: number | null }
  | { kind: "created"; incidentId: number; episode: number; rootCardId: null };

export type CooldownAdmitResult = AdmitResult | { kind: "cooldown"; remainingMs: number };

export type TransitionResult =
  | { ok: true; toState: ShaIncidentState; version: number }
  | { ok: false; kind: "stale" | "illegal"; reason: string };

export interface FaultStateRow {
  policyKey: string;
  scope: string;
  attempts: number;
  totalRuns: number;
  lastAttemptAt: string | null;
  lastResult: string | null;
  lastError: string | null;
  lastRunAt: string | null;
}

function isValidState(value: unknown): value is ShaIncidentState {
  return typeof value === "string" && (SHA_INCIDENT_STATES as readonly string[]).includes(value);
}

export function parseIncidentState(raw: unknown): ShaIncidentState | null {
  return isValidState(raw) ? raw : null;
}

function rowToIncident(row: Record<string, unknown>): IncidentRow {
  const state = parseIncidentState(row["state"]);
  if (!state) throw new Error(`sha_incidents row ${String(row["id"])} has invalid state ${String(row["state"])}`);
  return {
    id: Number(row["id"]),
    fingerprint: String(row["fingerprint"]),
    episode: Number(row["episode"]),
    workflowKind: (row["workflow_kind"] as ShaWorkflowKind),
    source: (row["source"] as ShaSourceKind),
    sourceScope: String(row["source_scope"]),
    taskKind: (row["task_kind"] as TaskKind | null) ?? null,
    mode: (row["mode"] as "investigation" | "full"),
    state,
    version: Number(row["version"]),
    occurrenceCount: Number(row["occurrence_count"]),
    rootCardId: row["root_card_id"] === null || row["root_card_id"] === undefined ? null : Number(row["root_card_id"]),
    currentStageCardId: row["current_stage_card_id"] === null || row["current_stage_card_id"] === undefined ? null : Number(row["current_stage_card_id"]),
    evidenceRoot: (row["evidence_root"] as string | null) ?? null,
    firstSeenAt: String(row["first_seen_at"]),
    lastSeenAt: String(row["last_seen_at"]),
    terminalAt: (row["terminal_at"] as string | null) ?? null,
    terminalReason: (row["terminal_reason"] as string | null) ?? null,
  };
}

export class ShaIncidentStore {
  constructor(private readonly db: TaskDatabase) {
    this.ensureSchema();
  }

  /** Idempotent DDL — exact design §3 representation. */
  ensureSchema(): void {
    this.db.exec(`
CREATE TABLE IF NOT EXISTS sha_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  episode INTEGER NOT NULL,
  workflow_kind TEXT NOT NULL CHECK(workflow_kind IN ('project','known_fix')),
  source TEXT NOT NULL CHECK(source IN ('scheduled','log')),
  source_scope TEXT NOT NULL,
  task_kind TEXT,
  mode TEXT NOT NULL CHECK(mode IN ('investigation','full')),
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  root_card_id INTEGER UNIQUE REFERENCES kanban_board(id),
  current_stage_card_id INTEGER REFERENCES kanban_board(id),
  evidence_root TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  terminal_at TEXT,
  terminal_reason TEXT,
  UNIQUE(fingerprint, episode)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sha_one_active_fingerprint
  ON sha_incidents(fingerprint) WHERE terminal_at IS NULL;

CREATE TABLE IF NOT EXISTS sha_incident_events (
  event_key TEXT PRIMARY KEY,
  incident_id INTEGER NOT NULL REFERENCES sha_incidents(id),
  occurred_at TEXT NOT NULL,
  diagnostic_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sha_incident_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES sha_incidents(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  from_version INTEGER NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sha_fault_state (
  policy_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  total_runs INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_result TEXT,
  last_error TEXT,
  last_run_at TEXT,
  PRIMARY KEY(policy_key, scope)
);
`);
  }

  /**
   * R4: create-or-attach in one BEGIN IMMEDIATE transaction. The partial
   * unique index on (fingerprint WHERE terminal_at IS NULL) is the final race
   * guard. `admitEventInTx` is the same body without transaction control, for
   * composition inside the coordinator's provisioning transaction (better-
   * sqlite3 nests it via savepoints).
   */
  admitEvent(params: {
    eventKey: string;
    fingerprint: string;
    workflowKind: ShaWorkflowKind;
    source: ShaSourceKind;
    sourceScope: string;
    taskKind?: TaskKind;
    mode: "investigation" | "full";
    diagnosticJson: string;
    occurredAt: number;
  }): AdmitResult {
    return this.db.transactionImmediate(() => this.admitEventInTx(params));
  }

  /**
   * #1688 R8: known-fix admission plus cooldown reservation in one
   * BEGIN IMMEDIATE transaction. Duplicate/replayed events and events that
   * attach to an already-active episode do not consume a new attempt. A new
   * episode is created only after the cooldown gate has admitted it.
   */
  admitEventWithCooldown(params: {
    eventKey: string;
    fingerprint: string;
    workflowKind: ShaWorkflowKind;
    source: ShaSourceKind;
    sourceScope: string;
    taskKind?: TaskKind;
    mode: "investigation" | "full";
    diagnosticJson: string;
    occurredAt: number;
  }, policyKey: string, scope: string, cooldownMin: number, at = new Date().toISOString()): CooldownAdmitResult {
    return this.db.transactionImmediate(() => this.admitEventWithCooldownInTx(params, policyKey, scope, cooldownMin, at));
  }

  /**
   * #1708: in-transaction cooldown body for callers already inside the
   * coordinator's atomic project-provisioning transaction (better-sqlite3
   * nests it via savepoints). Event-key replay is checked BEFORE the
   * active-episode/cooldown lookup; cooldown is reserved only when a NEW
   * episode is actually created.
   */
  admitEventWithCooldownInTx(params: {
    eventKey: string;
    fingerprint: string;
    workflowKind: ShaWorkflowKind;
    source: ShaSourceKind;
    sourceScope: string;
    taskKind?: TaskKind;
    mode: "investigation" | "full";
    diagnosticJson: string;
    occurredAt: number;
  }, policyKey: string, scope: string, cooldownMin: number, at = new Date().toISOString()): CooldownAdmitResult {
    // Check the durable event key before the active/terminal episode lookup.
    // This keeps replay idempotent even after the original episode ended.
    const existing = this.db.prepare(
      "SELECT 1 AS present FROM sha_incident_events WHERE event_key = ?",
    ).get(params.eventKey);
    if (existing) return { kind: "duplicate_event" };

    if (this.activeByFingerprint(params.fingerprint)) {
      return this.admitEventInTx(params);
    }

    const remainingMs = this.cooldownRemainingInTx(policyKey, scope, cooldownMin, at);
    if (remainingMs > 0) return { kind: "cooldown", remainingMs };

    const admitted = this.admitEventInTx(params);
    if (admitted.kind === "created") this.recordAttemptInTx(policyKey, scope, at);
    return admitted;
  }

  /**
   * #1708: the store persists only already-validated diagnostic JSON.
   * Character-based slicing could split UTF-8 sequences and produce invalid
   * JSON, and could still exceed the byte cap after re-encoding — so instead
   * of truncating, over-bound or invalid values are REJECTED before insert.
   * Callers own constructing a smaller valid object; the coordinator maps a
   * rejection to a bounded no-write outcome, never a thrown partial
   * provisioning failure.
   */
  private static assertDiagnosticJson(json: string): void {
    if (Buffer.byteLength(json, "utf-8") > MAX_DIAGNOSTIC_JSON_BYTES) {
      throw new Error(`diagnostic JSON exceeds ${MAX_DIAGNOSTIC_JSON_BYTES} UTF-8 bytes`);
    }
    try {
      JSON.parse(json);
    } catch {
      throw new Error("diagnostic JSON is not valid JSON");
    }
  }

  admitEventInTx(params: {
    eventKey: string;
    fingerprint: string;
    workflowKind: ShaWorkflowKind;
    source: ShaSourceKind;
    sourceScope: string;
    taskKind?: TaskKind;
    mode: "investigation" | "full";
    diagnosticJson: string;
    occurredAt: number;
  }): AdmitResult {
    const now = new Date().toISOString();
    const occurred = new Date(params.occurredAt).toISOString();
    ShaIncidentStore.assertDiagnosticJson(params.diagnosticJson);
    const boundedJson = params.diagnosticJson;
    const taskKind = params.taskKind ?? null;

    // Replays of a terminal episode still resolve to the original event and
    // must remain a no-op rather than colliding with the primary key below.
    const existingEvent = this.db.prepare(
      "SELECT 1 AS present FROM sha_incident_events WHERE event_key = ?",
    ).get(params.eventKey);
    if (existingEvent) return { kind: "duplicate_event" };

    const active = this.activeByFingerprint(params.fingerprint);
    if (active) {
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO sha_incident_events (event_key, incident_id, occurred_at, diagnostic_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(params.eventKey, active.id, occurred, boundedJson, now);
      if (insert.changes === 0) {
        return { kind: "duplicate_event" };
      }
      this.db.prepare(
        "UPDATE sha_incidents SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?",
      ).run(now, active.id);
      return {
        kind: "attached",
        incidentId: active.id,
        occurrenceCount: active.occurrenceCount + 1,
        rootCardId: active.rootCardId,
      };
    }

    // New episode: MAX(episode)+1 for this fingerprint.
    const maxRow = this.db.prepare(
      "SELECT MAX(episode) AS m FROM sha_incidents WHERE fingerprint = ?",
    ).get(params.fingerprint);
    const episode = ((maxRow?.["m"] as number | null) ?? 0) + 1;
    const inserted = this.db.prepare(
      `INSERT INTO sha_incidents
         (fingerprint, episode, workflow_kind, source, source_scope, task_kind, mode, state, version,
          occurrence_count, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'provisioning', 1, 1, ?, ?)`,
    ).run(
      params.fingerprint, episode, params.workflowKind, params.source, params.sourceScope,
      taskKind, params.mode, now, now,
    );
    const incidentId = Number(inserted.lastInsertRowid);
    this.db.prepare(
      "INSERT INTO sha_incident_events (event_key, incident_id, occurred_at, diagnostic_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(params.eventKey, incidentId, occurred, boundedJson, now);
    return { kind: "created", incidentId, episode, rootCardId: null };
  }

  /**
   * R5: bind the provisioned root/stage card references onto a freshly
   * created incident (state provisioning, version 1). Part of the admission
   * transaction — callers inside a coordinator transaction must use this,
   * not `transition`.
   */
  bindProvisioned(incidentId: number, rootCardId: number, currentStageCardId: number | null): boolean {
    const result = this.db.prepare(
      "UPDATE sha_incidents SET root_card_id = ?, current_stage_card_id = ? WHERE id = ? AND state = 'provisioning' AND root_card_id IS NULL",
    ).run(rootCardId, currentStageCardId, incidentId);
    return result.changes === 1;
  }

  /**
   * R4: compare-and-set transition plus same-transaction journal append.
   * A lost CAS returns `stale`; the coordinator re-reads and never retries
   * blind. A terminal destination also stamps `terminal_at`/`terminal_reason`.
   */
  transition(params: {
    incidentId: number;
    expectedVersion: number;
    fromStates: readonly ShaIncidentState[];
    toState: ShaIncidentState;
    reason: string;
    fields?: {
      rootCardId?: number;
      currentStageCardId?: number | null;
      evidenceRoot?: string | null;
    };
  }): TransitionResult {
    const now = new Date().toISOString();
    const terminal = isTerminalShaIncidentState(params.toState);
    const updates = ["state = ?", "version = version + 1"];
    if (terminal) updates.push("terminal_at = COALESCE(terminal_at, ?)", "terminal_reason = ?");
    if (params.fields?.rootCardId !== undefined) updates.push("root_card_id = ?");
    if (params.fields?.currentStageCardId !== undefined) updates.push("current_stage_card_id = ?");
    if (params.fields?.evidenceRoot !== undefined) updates.push("evidence_root = ?");

    const placeholders = params.fromStates.map(() => "?").join(", ");
    const args: unknown[] = [
      params.toState,
      ...(terminal ? [now, params.reason.slice(0, 500)] : []),
      ...(params.fields?.rootCardId !== undefined ? [params.fields.rootCardId] : []),
      ...(params.fields?.currentStageCardId !== undefined ? [params.fields.currentStageCardId] : []),
      ...(params.fields?.evidenceRoot !== undefined ? [params.fields.evidenceRoot] : []),
      params.incidentId,
      params.expectedVersion,
      ...params.fromStates,
    ];

    return this.db.transactionImmediate(() => {
      const result = this.db.prepare(
        `UPDATE sha_incidents SET ${updates.join(", ")}
         WHERE id = ? AND version = ? AND state IN (${placeholders})`,
      ).run(...args);
      if (result.changes !== 1) {
        const row = this.db.prepare("SELECT state, version FROM sha_incidents WHERE id = ?").get(params.incidentId);
        if (!row) return { ok: false, kind: "stale", reason: `incident ${params.incidentId} not found` };
        return { ok: false, kind: "stale", reason: `version/state moved (state=${String(row["state"])}, version=${String(row["version"])})` };
      }
      this.db.prepare(
        "INSERT INTO sha_incident_transitions (incident_id, from_state, to_state, from_version, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(params.incidentId, params.fromStates.join("|"), params.toState, params.expectedVersion, params.reason.slice(0, 500), now);
      return { ok: true, toState: params.toState, version: params.expectedVersion + 1 };
    });
  }

  /** R4: durable event replay check (duplicate key is a no-op). */
  eventExists(eventKey: string): boolean {
    return this.db.prepare("SELECT 1 AS present FROM sha_incident_events WHERE event_key = ?").get(eventKey) !== undefined;
  }

  activeByFingerprint(fingerprint: string): IncidentRow | null {
    const row = this.db.prepare(
      "SELECT * FROM sha_incidents WHERE fingerprint = ? AND terminal_at IS NULL ORDER BY id DESC LIMIT 1",
    ).get(fingerprint);
    return row ? rowToIncident(row) : null;
  }

  findById(incidentId: number): IncidentRow | null {
    const row = this.db.prepare("SELECT * FROM sha_incidents WHERE id = ?").get(incidentId);
    return row ? rowToIncident(row) : null;
  }

  /** #1688 R5: the incident owning a stage or root card, if any. */
  findByIdForCard(cardId: number): IncidentRow | null {
    const row = this.db.prepare(
      "SELECT * FROM sha_incidents WHERE root_card_id = ? OR current_stage_card_id = ? LIMIT 1",
    ).get(cardId, cardId);
    return row ? rowToIncident(row) : null;
  }

  /** R5: boot recovery reads — every nonterminal row, newest first. */
  listNonTerminal(): IncidentRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM sha_incidents WHERE terminal_at IS NULL ORDER BY id DESC",
    ).all();
    return rows.map(rowToIncident);
  }

  /** Observable summaries for /healing list and status output (R9). */
  listSummaries(limit = 20): IncidentSummary[] {
    const rows = this.db.prepare(
      "SELECT * FROM sha_incidents ORDER BY id DESC LIMIT ?",
    ).all(limit);
    return rows.map((row) => {
      const incident = rowToIncident(row);
      return {
        id: incident.id,
        fingerprintPrefix: incident.fingerprint.slice(0, 8),
        episode: incident.episode,
        workflowKind: incident.workflowKind,
        source: incident.source,
        sourceScope: incident.sourceScope,
        mode: incident.mode,
        state: incident.state,
        occurrenceCount: incident.occurrenceCount,
        rootCardId: incident.rootCardId,
        currentStageCardId: incident.currentStageCardId,
        lastSeenAt: incident.lastSeenAt,
        terminalAt: incident.terminalAt,
        terminalReason: incident.terminalReason,
      };
    });
  }

  // ── sha_fault_state (mutable policy cooldowns/counters) ──────────────────

  recordAttempt(policyKey: string, scope: string, at = new Date().toISOString()): void {
    this.db.transactionImmediate(() => this.recordAttemptInTx(policyKey, scope, at));
  }

  private recordAttemptInTx(policyKey: string, scope: string, at: string): void {
    this.db.prepare(
      `INSERT INTO sha_fault_state (policy_key, scope, attempts, total_runs, last_attempt_at)
       VALUES (?, ?, 1, 1, ?)
       ON CONFLICT(policy_key, scope) DO UPDATE SET
         attempts = attempts + 1,
         total_runs = total_runs + 1,
         last_attempt_at = excluded.last_attempt_at`,
    ).run(policyKey, scope, at);
  }

  private cooldownRemainingInTx(policyKey: string, scope: string, cooldownMin: number, at: string): number {
    if (cooldownMin <= 0) return 0;
    const row = this.db.prepare(
      "SELECT last_attempt_at FROM sha_fault_state WHERE policy_key = ? AND scope = ?",
    ).get(policyKey, scope);
    const lastAttemptAt = row?.["last_attempt_at"];
    if (typeof lastAttemptAt !== "string") return 0;
    const elapsed = Date.parse(at) - Date.parse(lastAttemptAt);
    if (!Number.isFinite(elapsed) || elapsed < 0) return cooldownMin * 60_000;
    return Math.max(0, cooldownMin * 60_000 - elapsed);
  }

  recordResult(policyKey: string, scope: string, ok: boolean, error?: string, at = new Date().toISOString()): void {
    const errorBounded = error === undefined ? null : error.slice(0, 300);
    if (ok) {
      this.db.prepare(
        `INSERT INTO sha_fault_state (policy_key, scope, attempts, total_runs, last_result, last_run_at)
         VALUES (?, ?, 0, 1, 'ok', ?)
         ON CONFLICT(policy_key, scope) DO UPDATE SET
           attempts = 0,
           total_runs = total_runs + 1,
           last_result = 'ok',
           last_error = NULL,
           last_run_at = excluded.last_run_at`,
      ).run(policyKey, scope, at);
    } else {
      this.db.prepare(
        `INSERT INTO sha_fault_state (policy_key, scope, attempts, total_runs, last_result, last_error, last_run_at)
         VALUES (?, ?, 1, 1, 'failed', ?, ?)
         ON CONFLICT(policy_key, scope) DO UPDATE SET
           attempts = attempts + 1,
           total_runs = total_runs + 1,
           last_result = 'failed',
           last_error = excluded.last_error,
           last_run_at = excluded.last_run_at`,
      ).run(policyKey, scope, errorBounded, at);
    }
  }

  faultState(policyKey: string, scope: string): FaultStateRow | null {
    const row = this.db.prepare(
      "SELECT * FROM sha_fault_state WHERE policy_key = ? AND scope = ?",
    ).get(policyKey, scope);
    if (!row) return null;
    return {
      policyKey: String(row["policy_key"]),
      scope: String(row["scope"]),
      attempts: Number(row["attempts"]),
      totalRuns: Number(row["total_runs"]),
      lastAttemptAt: (row["last_attempt_at"] as string | null) ?? null,
      lastResult: (row["last_result"] as string | null) ?? null,
      lastError: (row["last_error"] as string | null) ?? null,
      lastRunAt: (row["last_run_at"] as string | null) ?? null,
    };
  }

  listFaultState(policyKey?: string): FaultStateRow[] {
    const rows = policyKey === undefined
      ? this.db.prepare("SELECT * FROM sha_fault_state ORDER BY policy_key, scope").all()
      : this.db.prepare("SELECT * FROM sha_fault_state WHERE policy_key = ? ORDER BY scope").all(policyKey);
    return rows.map((row) => ({
      policyKey: String(row["policy_key"]),
      scope: String(row["scope"]),
      attempts: Number(row["attempts"]),
      totalRuns: Number(row["total_runs"]),
      lastAttemptAt: (row["last_attempt_at"] as string | null) ?? null,
      lastResult: (row["last_result"] as string | null) ?? null,
      lastError: (row["last_error"] as string | null) ?? null,
      lastRunAt: (row["last_run_at"] as string | null) ?? null,
    }));
  }

  /** R8: /healing reset — delete matching cooldown rows in one transaction. */
  resetFaultState(policyKey?: string, scope?: string): number {
    return this.db.transactionImmediate(() => {
      let sql = "DELETE FROM sha_fault_state WHERE 1 = 1";
      const args: unknown[] = [];
      if (policyKey !== undefined) { sql += " AND policy_key = ?"; args.push(policyKey); }
      if (scope !== undefined) { sql += " AND scope = ?"; args.push(scope); }
      const result = this.db.prepare(sql).run(...args);
      return result.changes;
    });
  }
}
