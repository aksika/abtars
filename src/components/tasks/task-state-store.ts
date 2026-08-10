import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import { requireTaskDatabase, type TaskDatabase } from "./kanban-board.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo } from "../logger.js";
import { currentProcessStartTime } from "./run-liveness.js";
import type { ScheduledTask } from "./task-types.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "task_state_store";

export type TaskRunPhase =
  | "reserved"
  | "preflight"
  | "queued"
  | "executing"
  | "cancelling"
  | "validating"
  | "settling"
  | "delivery_pending";

export interface ActiveTaskRun {
  runId: string;
  groupId: string;
  attempt: 1 | 2;
  trigger: "schedule" | "manual" | "retry";
  occurrenceAt: number;
  reservedAt: number;
  deadlineAt: number;
  phase: TaskRunPhase;
  lastProgressAt: number;
  cardId?: number;
  sessionId?: string;
  executionId?: string;
  /** #1539: monotonic meaningful-progress sequence; bounded, never per token. */
  progressSequence?: number;
  /** #1539: the first durable terminal request for this occurrence. */
  terminalRequest?: RunTerminalRequest;
}

/** #1539: durable terminal request. Cancellation recorded before a deadline
 * stays cancellation; a deadline may fill an absent request but never replaces
 * an earlier cancellation. */
export interface RunTerminalRequest {
  kind: "cancelled" | "deadline_exceeded";
  requestedAt: number;
  reason: string;
}

/** #1539: phase rank. cancelling is a terminal-request branch: nothing advances past it. */
const PHASE_RANK: Record<TaskRunPhase, number> = {
  reserved: 0,
  preflight: 1,
  queued: 2,
  executing: 3,
  cancelling: 4,
  validating: 5,
  settling: 6,
  delivery_pending: 7,
};

export interface TaskRuntimeState {
  nextRunAt: number | null;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  retryAt?: number;
  retrying?: boolean;
  completed?: boolean;
  /** #1502 Task 9: durable identity for the one retry belonging to a run group. */
  retryGroupId?: string;
  retryAttempt?: 1 | 2;
  consecutiveFailures: number;
  consecutiveDeferrals: number;
  autoPaused: boolean;
  /** #1502: Failure diagnostic from the first attempt, carried to retry. */
  priorFailure?: string;
  /** #1505: Active run reservation — exclusive occurrence ownership. */
  activeRun?: ActiveTaskRun;
  /** #1520: latest structured incident; preserved across resume. */
  lastIncident?: TaskFailureDiagnosticV1;
  /** #1520: when the task auto-paused (epoch ms). */
  pausedAt?: number;
  /** #1609: automatic resumes since the last successful run; 0 after success.
   * Not a lifetime counter. */
  autoResumeCount: number;
  /** #1609: durable admission time of the last paused-task WARN record —
   * the per-hour warning ceiling survives process restarts. */
  lastPauseWarnAt?: number;
  /** #1520: bounded admission deferral for the current occurrence. */
  deferredAdmission?: DeferredAdmission;
}

/** #1520: durable bounded admission deferral — same occurrence across restarts. */
export interface DeferredAdmission {
  groupId: string;
  occurrenceAt: number;
  deadlineAt: number;
  attempts: number;
  retryAt: number;
  diagnostic: TaskFailureDiagnosticV1;
}

// ── #1601: SQL substrate ──────────────────────────────────────────────────────
//
// Every transition is a conditional statement whose affected-row count is the
// compare-and-set. `rowcount !== 1` means another writer (in this process or
// another process) already moved the row.

type CasOutcome = "won" | "lost";

function cas(db: TaskDatabase, sql: string, ...params: unknown[]): CasOutcome {
  return db.prepare(sql).run(...params).changes === 1 ? "won" : "lost";
}

type TaskRow = Record<string, unknown> & {
  task_id: string;
  next_run_at: number | null;
  last_started_at: number | null;
  last_finished_at: number | null;
  retry_at: number | null;
  retrying: number;
  completed: number;
  retry_group_id: string | null;
  retry_attempt: number | null;
  consecutive_failures: number;
  consecutive_deferrals: number;
  auto_paused: number;
  paused_at: number | null;
  auto_resume_count: number;
  last_pause_warn_at: number | null;
  prior_failure: string | null;
  last_incident_json: string | null;
  deferred_admission_json: string | null;
};

type RunRow = Record<string, unknown> & {
  run_id: string;
  task_id: string;
  group_id: string;
  attempt: number;
  trigger: string;
  occurrence_at: number;
  reserved_at: number;
  deadline_at: number;
  phase: string;
  last_progress_at: number;
  progress_sequence: number;
  card_id: number | null;
  session_id: string | null;
  execution_id: string | null;
  terminal_request_json: string | null;
  owner_pid: number;
  owner_started_at: number | null;
  finished_at: number | null;
  outcome: string | null;
};

function parseJson<T>(raw: string | null | undefined): T | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function taskStateFromRow(row: TaskRow): TaskRuntimeState {
  return {
    nextRunAt: row.next_run_at,
    ...(row.last_started_at !== null ? { lastStartedAt: row.last_started_at } : {}),
    ...(row.last_finished_at !== null ? { lastFinishedAt: row.last_finished_at } : {}),
    ...(row.retry_at !== null ? { retryAt: row.retry_at } : {}),
    ...(row.retrying === 1 ? { retrying: true } : {}),
    ...(row.completed === 1 ? { completed: true } : {}),
    ...(row.retry_group_id !== null ? { retryGroupId: row.retry_group_id } : {}),
    ...(row.retry_attempt !== null ? { retryAttempt: row.retry_attempt as 1 | 2 } : {}),
    consecutiveFailures: row.consecutive_failures,
    consecutiveDeferrals: row.consecutive_deferrals,
    autoPaused: row.auto_paused === 1,
    autoResumeCount: row.auto_resume_count,
    ...(row.last_pause_warn_at !== null ? { lastPauseWarnAt: row.last_pause_warn_at } : {}),
    ...(row.prior_failure !== null ? { priorFailure: row.prior_failure } : {}),
    ...(row.paused_at !== null ? { pausedAt: row.paused_at } : {}),
    ...(parseJson<TaskFailureDiagnosticV1>(row.last_incident_json) !== undefined ? { lastIncident: parseJson<TaskFailureDiagnosticV1>(row.last_incident_json) } : {}),
    ...(parseJson<DeferredAdmission>(row.deferred_admission_json) !== undefined ? { deferredAdmission: parseJson<DeferredAdmission>(row.deferred_admission_json) } : {}),
  };
}

function activeRunFromRow(row: RunRow): ActiveTaskRun {
  return {
    runId: row.run_id,
    groupId: row.group_id,
    attempt: row.attempt as 1 | 2,
    trigger: row.trigger as ActiveTaskRun["trigger"],
    occurrenceAt: row.occurrence_at,
    reservedAt: row.reserved_at,
    deadlineAt: row.deadline_at,
    phase: row.phase as TaskRunPhase,
    lastProgressAt: row.last_progress_at,
    ...(row.progress_sequence !== 0 ? { progressSequence: row.progress_sequence } : {}),
    ...(row.card_id !== null ? { cardId: row.card_id } : {}),
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    ...(row.execution_id !== null ? { executionId: row.execution_id } : {}),
    ...(parseJson<RunTerminalRequest>(row.terminal_request_json) !== undefined ? { terminalRequest: parseJson<RunTerminalRequest>(row.terminal_request_json) } : {}),
  };
}

export function readState(taskId: string): TaskRuntimeState | null {
  try {
    const db = requireTaskDatabase();
    const row = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(taskId) as TaskRow | undefined;
    if (!row) return null;
    const state = taskStateFromRow(row);
    const runRow = db.prepare("SELECT * FROM task_runs WHERE task_id = ? AND finished_at IS NULL").get(taskId) as RunRow | undefined;
    if (runRow) state.activeRun = activeRunFromRow(runRow);
    return state;
  } catch (err) {
    logAndSwallow(TAG, "readState", err, "warn");
    return null;
  }
}

/** All task_state column values implied by a partial TaskRuntimeState patch.
 * Key-presence is the contract: `{ lastIncident: undefined }` means CLEAR the
 * column, an absent key means leave it untouched — exactly the spread
 * semantics of the old whole-file rewrite. */
function statePatchColumns(update: Partial<TaskRuntimeState>): { sets: string[]; vals: unknown[] } {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`);
    vals.push(value);
  };
  if ("nextRunAt" in update) put("next_run_at", update.nextRunAt);
  if ("lastStartedAt" in update) put("last_started_at", update.lastStartedAt);
  if ("lastFinishedAt" in update) put("last_finished_at", update.lastFinishedAt);
  if ("retryAt" in update) put("retry_at", update.retryAt);
  if ("retrying" in update) put("retrying", update.retrying ? 1 : 0);
  if ("completed" in update) put("completed", update.completed ? 1 : 0);
  if ("retryGroupId" in update) put("retry_group_id", update.retryGroupId ?? null);
  if ("retryAttempt" in update) put("retry_attempt", update.retryAttempt ?? null);
  if ("consecutiveFailures" in update) put("consecutive_failures", update.consecutiveFailures);
  if ("consecutiveDeferrals" in update) put("consecutive_deferrals", update.consecutiveDeferrals);
  if ("autoPaused" in update) put("auto_paused", update.autoPaused ? 1 : 0);
  if ("pausedAt" in update) put("paused_at", update.pausedAt ?? null);
  if ("autoResumeCount" in update) put("auto_resume_count", update.autoResumeCount);
  if ("lastPauseWarnAt" in update) put("last_pause_warn_at", update.lastPauseWarnAt ?? null);
  if ("priorFailure" in update) put("prior_failure", update.priorFailure ?? null);
  if ("lastIncident" in update) put("last_incident_json", update.lastIncident === undefined ? null : JSON.stringify(update.lastIncident));
  if ("deferredAdmission" in update) put("deferred_admission_json", update.deferredAdmission === undefined ? null : JSON.stringify(update.deferredAdmission));
  return { sets, vals };
}

const DEFAULT_STATE_COLUMNS = "next_run_at, consecutive_failures, consecutive_deferrals, auto_paused";

/** INSERT OR IGNORE a default task_state row; safe to call on every write. */
function ensureTaskRow(db: TaskDatabase, taskId: string): void {
  db.prepare(`INSERT OR IGNORE INTO task_state (task_id, ${DEFAULT_STATE_COLUMNS}) VALUES (?, NULL, 0, 0, 0)`).run(taskId);
}

const RUN_COLUMNS = [
  "run_id", "task_id", "group_id", "attempt", "trigger", "occurrence_at",
  "reserved_at", "deadline_at", "phase", "last_progress_at", "progress_sequence",
  "card_id", "session_id", "execution_id", "terminal_request_json",
  "owner_pid", "owner_started_at",
];

function runInsertValues(run: ActiveTaskRun, taskId: string, ownerPid = process.pid, ownerStartedAt: number | null = null): unknown[] {
  return [
    run.runId,
    taskId,
    run.groupId,
    run.attempt,
    run.trigger,
    run.occurrenceAt,
    run.reservedAt,
    run.deadlineAt,
    run.phase,
    run.lastProgressAt,
    run.progressSequence ?? 0,
    run.cardId ?? null,
    run.sessionId ?? null,
    run.executionId ?? null,
    run.terminalRequest === undefined ? null : JSON.stringify(run.terminalRequest),
    ownerPid,
    ownerStartedAt,
  ];
}

export function initializeState(entries: ScheduledTask[]): void {
  try {
    const db = requireTaskDatabase();
    const validIds = new Set(entries.map(e => e.id));
    let changed = false;

    for (const id of validIds) {
      const existing = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(id) as TaskRow | undefined;
      if (!existing) {
        db.prepare(`INSERT OR IGNORE INTO task_state (task_id, ${DEFAULT_STATE_COLUMNS}) VALUES (?, NULL, 0, 0, 0)`).run(id);
        db.prepare("UPDATE task_state SET next_run_at = ? WHERE task_id = ? AND next_run_at IS NULL").run(deriveNextRun(entries.find(e => e.id === id)!), id);
        changed = true;
        continue;
      }
      // #1520 Task 6 / #1609: repair impossible legacy combinations. The only
      // incoherent pause is one without a pause timestamp. A zero-failure
      // pause is now LEGITIMATE (explicit pause starts a fresh 12-hour
      // cooldown and must survive restart), so it is never cleared; a missing
      // timestamp is backfilled so the bounded recovery policy can start its
      // cooldown. Never silently erase a valid incident.
      if (existing.auto_paused === 1 && existing.paused_at === null) {
        db.prepare("UPDATE task_state SET paused_at = ? WHERE task_id = ?").run(Date.now(), id);
        logInfo(TAG, `Self-repair: backfilled pausedAt for "${id}"`);
        changed = true;
      }
      if (existing.retrying === 1 && existing.retry_group_id === null) {
        logInfo(TAG, `Self-repair: clearing legacy retrying without retryGroupId for "${id}"`);
        db.prepare("UPDATE task_state SET retrying = 0, retry_at = NULL, retry_attempt = NULL WHERE task_id = ?").run(id);
        changed = true;
      }
      if (existing.consecutive_deferrals === undefined || existing.consecutive_deferrals === null) {
        db.prepare("UPDATE task_state SET consecutive_deferrals = 0 WHERE task_id = ?").run(id);
        changed = true;
      }
    }

    const orphans = db.prepare("SELECT task_id FROM task_state").all() as { task_id: string }[];
    for (const orphan of orphans) {
      if (!validIds.has(orphan.task_id)) {
        logInfo(TAG, `Removed orphan state for "${orphan.task_id}"`);
        db.prepare("DELETE FROM task_state WHERE task_id = ?").run(orphan.task_id);
        db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(orphan.task_id);
        changed = true;
      }
    }

    if (changed) notifyTaskDueChanged();
  } catch (err) {
    logAndSwallow(TAG, "initializeState", err, "warn");
  }
}

function deriveNextRun(task: ScheduledTask): number | null {
  if (task.schedule) {
    try {
      return CronExpressionParser.parse(task.schedule).next().getTime();
    } catch {
      if (task.at) return Date.parse(task.at);
      return null;
    }
  }
  if (task.at) return Date.parse(task.at);
  return null;
}

export function updateState(taskId: string, update: Partial<TaskRuntimeState>): void {
  try {
    const db = requireTaskDatabase();
    const activeRun = update.activeRun;
    db.transaction(() => {
      ensureTaskRow(db, taskId);
      const { sets, vals } = statePatchColumns({ ...update, activeRun: undefined });
      if (sets.length > 0) {
        const params: unknown[] = [...vals, taskId];
        db.prepare(`UPDATE task_state SET ${sets.join(", ")} WHERE task_id = ?`).run(...params);
      }
      if (activeRun !== undefined) {
        const values = runInsertValues(activeRun, taskId);
        const setCols = RUN_COLUMNS.map(c => `${c} = excluded.${c}`).join(", ");
        db.prepare(`INSERT INTO task_runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
          ON CONFLICT(run_id) DO UPDATE SET ${setCols}`).run(...values);
      }
    });
    notifyTaskDueChanged();
  } catch (err) {
    logAndSwallow(TAG, "updateState", err, "warn");
  }
}

/** Apply a state patch only while the caller's durable predicate still holds. */
export function updateStateIf(
  taskId: string,
  predicate: (state: TaskRuntimeState) => boolean,
  update: Partial<TaskRuntimeState>,
): boolean {
  try {
    const db = requireTaskDatabase();
    let changed = false;
    db.transaction(() => {
      const row = db.prepare("SELECT * FROM task_state WHERE task_id = ?").get(taskId) as TaskRow | undefined;
      if (!row) return;
      const state = taskStateFromRow(row);
      const runRow = db.prepare("SELECT * FROM task_runs WHERE task_id = ? AND finished_at IS NULL").get(taskId) as RunRow | undefined;
      if (runRow) state.activeRun = activeRunFromRow(runRow);
      if (!predicate(state)) return;
      const { sets, vals } = statePatchColumns({ ...update, activeRun: undefined });
      if (update.activeRun !== undefined) {
        db.prepare(`INSERT INTO task_runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})
          ON CONFLICT(run_id) DO UPDATE SET ${RUN_COLUMNS.map(c => `${c} = excluded.${c}`).join(", ")}`).run(...runInsertValues(update.activeRun, taskId));
      }
      if (sets.length > 0) {
        db.prepare(`UPDATE task_state SET ${sets.join(", ")} WHERE task_id = ?`).run(...vals, taskId);
      }
      changed = true;
    });
    if (changed) notifyTaskDueChanged();
    return changed;
  } catch (err) {
    logAndSwallow(TAG, "updateStateIf", err, "warn");
    return false;
  }
}

export function advanceNextRun(taskId: string, schedule?: string): boolean {
  if (!schedule) {
    updateState(taskId, { completed: true });
    return true;
  }
  try {
    const next = CronExpressionParser.parse(schedule).next().getTime();
    updateState(taskId, { nextRunAt: next, completed: undefined });
    return true;
  } catch {
    return false;
  }
}

/** #1520: pure next-run computation for the atomic settler patch. */
export function nextRunFromSchedule(task: Pick<ScheduledTask, "schedule">): { nextRunAt?: number; completed?: boolean } {
  if (!task.schedule) return { completed: true };
  try {
    return { nextRunAt: CronExpressionParser.parse(task.schedule).next().getTime() };
  } catch {
    return {};
  }
}

export function incrementFailures(taskId: string): number {
  try {
    const db = requireTaskDatabase();
    ensureTaskRow(db, taskId);
    db.prepare("UPDATE task_state SET consecutive_failures = consecutive_failures + 1 WHERE task_id = ?").run(taskId);
    const row = db.prepare("SELECT consecutive_failures FROM task_state WHERE task_id = ?").get(taskId) as { consecutive_failures: number } | undefined;
    return row?.consecutive_failures ?? 1;
  } catch (err) {
    logAndSwallow(TAG, "incrementFailures", err, "warn");
    return 0;
  }
}

export function resetFailures(taskId: string): void {
  try {
    const db = requireTaskDatabase();
    db.prepare("UPDATE task_state SET consecutive_failures = 0, consecutive_deferrals = 0 WHERE task_id = ?").run(taskId);
  } catch (err) {
    logAndSwallow(TAG, "resetFailures", err, "warn");
  }
}

export function incrementDeferrals(taskId: string): number {
  try {
    const db = requireTaskDatabase();
    ensureTaskRow(db, taskId);
    db.prepare("UPDATE task_state SET consecutive_deferrals = consecutive_deferrals + 1 WHERE task_id = ?").run(taskId);
    const row = db.prepare("SELECT consecutive_deferrals FROM task_state WHERE task_id = ?").get(taskId) as { consecutive_deferrals: number } | undefined;
    return row?.consecutive_deferrals ?? 1;
  } catch (err) {
    logAndSwallow(TAG, "incrementDeferrals", err, "warn");
    return 0;
  }
}

export function resetDeferrals(taskId: string): void {
  try {
    const db = requireTaskDatabase();
    db.prepare("UPDATE task_state SET consecutive_deferrals = 0 WHERE task_id = ?").run(taskId);
  } catch (err) {
    logAndSwallow(TAG, "resetDeferrals", err, "warn");
  }
}

export function setAutoPaused(taskId: string, paused: boolean): void {
  try {
    const db = requireTaskDatabase();
    // #1609: an explicit pause always refreshes pausedAt to now — a re-pause
    // starts a fresh 12-hour cooldown even when the task was already paused.
    // Unpausing clears the pause marker.
    db.prepare("UPDATE task_state SET auto_paused = ?, paused_at = CASE WHEN ? THEN ? ELSE NULL END WHERE task_id = ?")
      .run(paused ? 1 : 0, paused ? 1 : 0, paused ? Date.now() : 0, taskId);
    notifyTaskDueChanged();
  } catch (err) {
    logAndSwallow(TAG, "setAutoPaused", err, "warn");
  }
}

/**
 * #1609: the single conditional automatic-resume transition. Eligibility is
 * decided by the caller against a fresh read; this SQL predicate is the
 * mandatory race guard: still paused, pause timestamp unchanged, no active
 * run reservation, and the episode cap not exhausted. Only a won CAS clears
 * the pause and increments the durable episode count atomically.
 */
export function claimAutoResume(
  taskId: string,
  opts: { pausedAt: number; nextRunAt: number | null; completed: boolean; maxResumes: number },
): "won" | "lost" {
  try {
    const db = requireTaskDatabase();
    const outcome = cas(db,
      `UPDATE task_state SET
         auto_paused = 0,
         paused_at = NULL,
         consecutive_failures = 0,
         consecutive_deferrals = 0,
         auto_resume_count = auto_resume_count + 1,
         retrying = 0,
         retry_at = NULL,
         retry_group_id = NULL,
         retry_attempt = NULL,
         prior_failure = NULL,
         deferred_admission_json = NULL,
         next_run_at = ?,
         completed = ?
       WHERE task_id = ?
         AND auto_paused = 1
         AND paused_at = ?
         AND auto_resume_count < ?
         AND NOT EXISTS (SELECT 1 FROM task_runs WHERE task_id = ? AND finished_at IS NULL)`,
      opts.nextRunAt, opts.completed ? 1 : 0, taskId, opts.pausedAt, opts.maxResumes, taskId);
    if (outcome === "won") notifyTaskDueChanged();
    return outcome;
  } catch (err) {
    logAndSwallow(TAG, "claimAutoResume", err, "warn");
    return "lost";
  }
}

/**
 * #1609: durable, idempotent admission of a paused-task WARN record. The
 * claim lands only when the previous admission is older than the minimum
 * interval, so at most 12 WARN records per task per rolling hour survive
 * process restarts. A lost claim means the record is rate-limited.
 */
export function claimPauseWarn(taskId: string, now: number, minIntervalMs: number): boolean {
  try {
    const db = requireTaskDatabase();
    const outcome = cas(db,
      `UPDATE task_state SET last_pause_warn_at = ?
       WHERE task_id = ?
         AND (last_pause_warn_at IS NULL OR ? - last_pause_warn_at >= ?)`,
      now, taskId, now, minIntervalMs);
    return outcome === "won";
  } catch (err) {
    logAndSwallow(TAG, "claimPauseWarn", err, "warn");
    return false;
  }
}

export function removeState(taskId: string): void {
  try {
    const db = requireTaskDatabase();
    db.transaction(() => {
      db.prepare("DELETE FROM task_state WHERE task_id = ?").run(taskId);
      db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(taskId);
    });
    notifyTaskDueChanged();
  } catch (err) {
    logAndSwallow(TAG, "removeState", err, "warn");
  }
}

export function setRetrying(taskId: string, retrying: boolean, retryAt?: number): void {
  try {
    const db = requireTaskDatabase();
    if (retryAt !== undefined) {
      db.prepare("UPDATE task_state SET retrying = ?, retry_at = ? WHERE task_id = ?").run(retrying ? 1 : 0, retryAt, taskId);
    } else {
      db.prepare("UPDATE task_state SET retrying = ? WHERE task_id = ?").run(retrying ? 1 : 0, taskId);
    }
    notifyTaskDueChanged();
  } catch (err) {
    logAndSwallow(TAG, "setRetrying", err, "warn");
  }
}

export type ReserveRunResult =
  | { ok: true; run: ActiveTaskRun }
  | { ok: false; active: ActiveTaskRun };

/** Run IDs must remain unique even when two occurrences are reserved in one millisecond. */
export function createRunId(taskId: string): string {
  return `${taskId}_${randomUUID().slice(0, 12)}`;
}

export function reserveRun(taskId: string, candidate: Omit<ActiveTaskRun, "reservedAt" | "phase" | "lastProgressAt">): ReserveRunResult {
  try {
    const db = requireTaskDatabase();
    const now = Date.now();
    const run: ActiveTaskRun = {
      ...candidate,
      reservedAt: now,
      phase: "reserved",
      lastProgressAt: now,
    };
    try {
      db.transaction(() => {
        db.prepare(`INSERT INTO task_runs (${RUN_COLUMNS.join(", ")}) VALUES (${RUN_COLUMNS.map(() => "?").join(", ")})`)
          .run(...runInsertValues(run, taskId, process.pid, currentProcessStartTime()));
        ensureTaskRow(db, taskId);
        db.prepare("UPDATE task_state SET last_started_at = ? WHERE task_id = ?").run(now, taskId);
      });
    } catch (err) {
      // The partial unique index IS the "already active" answer, decided
      // atomically by the database across processes (#1597).
      const live = db.prepare("SELECT * FROM task_runs WHERE task_id = ? AND finished_at IS NULL").get(taskId) as RunRow | undefined;
      if (live) return { ok: false, active: activeRunFromRow(live) };
      logAndSwallow(TAG, "reserveRun", err, "warn");
      return { ok: false, active: run };
    }
    notifyTaskDueChanged();
    return { ok: true, run };
  } catch (err) {
    logAndSwallow(TAG, "reserveRun", err, "warn");
    return { ok: false, active: undefined! };
  }
}

export function updateActiveRun(taskId: string, runId: string, patch: Partial<ActiveTaskRun>): boolean {
  try {
    const db = requireTaskDatabase();
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.cardId !== undefined) { sets.push("card_id = ?"); vals.push(patch.cardId); }
    if (patch.sessionId !== undefined) { sets.push("session_id = ?"); vals.push(patch.sessionId); }
    if (patch.executionId !== undefined) { sets.push("execution_id = ?"); vals.push(patch.executionId); }
    if (patch.terminalRequest !== undefined) { sets.push("terminal_request_json = ?"); vals.push(patch.terminalRequest === undefined ? null : JSON.stringify(patch.terminalRequest)); }
    if (sets.length === 0) return false;
    return cas(db, `UPDATE task_runs SET ${sets.join(", ")} WHERE task_id = ? AND run_id = ? AND finished_at IS NULL`, ...vals, taskId, runId) === "won";
  } catch (err) {
    logAndSwallow(TAG, "updateActiveRun", err, "warn");
    return false;
  }
}

export type AdvanceRunResult = "advanced" | "stale" | "regression";

/**
 * #1539: one atomic monotonic progress write. Validates phase rank (a run
 * never moves to an earlier phase, and nothing advances past `cancelling`),
 * advances `lastProgressAt` only forward, increments `progressSequence` only
 * for a meaningful progress write, and merges bounded attachments.
 *
 * #1600: deliberately does NOT call `notifyTaskDueChanged()`. The run-deadline
 * due source is level-triggered — `wakeDue` re-reads durable state and
 * re-validates both limits before settling — so a timer armed against a
 * now-stale earlier idle instant fires, finds nothing expired, settles
 * nothing, and `armEarliest()` immediately re-arms against the recomputed
 * later instant. Adding the notify here would be write amplification on the
 * hot progress path for zero correctness gain.
 */
export function advanceRun(
  taskId: string,
  runId: string,
  update: { phase?: TaskRunPhase; progressAt?: number; attachments?: { cardId?: number; sessionId?: string; executionId?: string } },
): AdvanceRunResult {
  try {
    const db = requireTaskDatabase();
    const row = db.prepare("SELECT phase, last_progress_at FROM task_runs WHERE run_id = ? AND finished_at IS NULL").get(runId) as { phase: string; last_progress_at: number } | undefined;
    if (!row) return "stale";

    const currentPhase = row.phase as TaskRunPhase;
    if (update.phase !== undefined && update.phase !== currentPhase) {
      if (currentPhase === "cancelling") return "regression";
      const newRank = PHASE_RANK[update.phase] ?? -1;
      const oldRank = PHASE_RANK[currentPhase] ?? -1;
      if (newRank < oldRank) return "regression";
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (update.phase !== undefined) {
      sets.push("phase = ?");
      vals.push(update.phase);
    }
    if (update.progressAt !== undefined) {
      const progressAt = Math.max(0, update.progressAt);
      sets.push("last_progress_at = MAX(last_progress_at, ?)");
      vals.push(progressAt);
      sets.push("progress_sequence = progress_sequence + (? > last_progress_at)");
      vals.push(progressAt);
    }
    const att = update.attachments;
    if (att?.cardId !== undefined) { sets.push("card_id = ?"); vals.push(att.cardId); }
    if (att?.sessionId !== undefined) { sets.push("session_id = ?"); vals.push(att.sessionId); }
    if (att?.executionId !== undefined) { sets.push("execution_id = ?"); vals.push(att.executionId); }
    if (sets.length === 0) return "advanced";

    // The phase read is the CAS guard: the write only lands if the run is
    // still in the phase we validated. `stale` covers any concurrent move.
    const outcome = cas(db, `UPDATE task_runs SET ${sets.join(", ")} WHERE task_id = ? AND run_id = ? AND finished_at IS NULL AND phase = ?`, ...vals, taskId, runId, currentPhase);
    return outcome === "won" ? "advanced" : "stale";
  } catch (err) {
    logAndSwallow(TAG, "advanceRun", err, "warn");
    return "stale";
  }
}

export type TerminalRequestResult = "requested" | "already_requested" | "stale";

/**
 * #1539: record the first durable terminal request. Cancellation always wins
 * over a later deadline; a deadline fills an absent request but never replaces
 * an earlier cancellation. Moving to `cancelling` is part of the request so no
 * code path can write the branch phase without the durable request.
 */
export function requestRunTerminal(
  taskId: string,
  runId: string,
  request: RunTerminalRequest,
): TerminalRequestResult {
  try {
    const db = requireTaskDatabase();
    const row = db.prepare("SELECT terminal_request_json FROM task_runs WHERE task_id = ? AND run_id = ? AND finished_at IS NULL").get(taskId, runId) as { terminal_request_json: string | null } | undefined;
    if (!row) return "stale";

    const current = parseJson<RunTerminalRequest>(row.terminal_request_json);
    if (current) {
      if (current.kind === "cancelled") return "already_requested";
      if (request.kind === "cancelled") {
        // Upgrade a deadline request to a cancellation: CAS on the exact
        // request we read so a concurrent upgrade is not double-applied.
        const outcome = cas(db,
          "UPDATE task_runs SET terminal_request_json = ?, phase = 'cancelling' WHERE task_id = ? AND run_id = ? AND finished_at IS NULL AND terminal_request_json = ?",
          JSON.stringify(request), taskId, runId, row.terminal_request_json);
        if (outcome === "won") { notifyTaskDueChanged(); return "requested"; }
        return alreadyOrStale(db, runId);
      }
      return "already_requested";
    }
    const outcome = cas(db,
      "UPDATE task_runs SET terminal_request_json = ?, phase = 'cancelling' WHERE task_id = ? AND run_id = ? AND finished_at IS NULL AND terminal_request_json IS NULL",
      JSON.stringify(request), taskId, runId);
    if (outcome === "won") { notifyTaskDueChanged(); return "requested"; }
    return alreadyOrStale(db, runId);
  } catch (err) {
    logAndSwallow(TAG, "requestRunTerminal", err, "warn");
    return "stale";
  }
}

/** Label a lost terminal-request CAS by re-reading the row (read-only labeling). */
function alreadyOrStale(db: TaskDatabase, runId: string): TerminalRequestResult {
  const row = db.prepare("SELECT terminal_request_json FROM task_runs WHERE run_id = ? AND finished_at IS NULL").get(runId) as { terminal_request_json: string | null } | undefined;
  if (!row) return "stale";
  return parseJson<RunTerminalRequest>(row.terminal_request_json) ? "already_requested" : "stale";
}

/** #1601: the durable owner identity of a live run, for the liveness pass. */
export function getRunOwner(runId: string): { pid: number; startedAt: number | null } | undefined {
  try {
    const db = requireTaskDatabase();
    const row = db.prepare("SELECT owner_pid, owner_started_at FROM task_runs WHERE run_id = ? AND finished_at IS NULL").get(runId) as { owner_pid: number; owner_started_at: number | null } | undefined;
    if (!row) return undefined;
    return { pid: row.owner_pid, startedAt: row.owner_started_at };
  } catch (err) {
    logAndSwallow(TAG, "getRunOwner", err, "warn");
    return undefined;
  }
}

/** #1539: hook notified after any durable task-state mutation that can change
 * admission/retry/deadline due times. Wired to the lifecycle wake scheduler. */
let taskDueChangedHook: (() => void) | null = null;
export function setTaskDueChangedHook(hook: (() => void) | null): void {
  taskDueChangedHook = hook;
}
export function notifyTaskDueChanged(): void {
  try {
    taskDueChangedHook?.();
  } catch (err) {
    logAndSwallow(TAG, "notifyTaskDueChanged", err);
  }
}

/** #1601: the durable terminal outcome of a settled run. Only terminal rows
 * are writable; the outcome is decided by the single winning settler, so
 * there is no race once the CAS has landed. */
export function setRunOutcome(runId: string, outcome: string): void {
  try {
    const db = requireTaskDatabase();
    db.prepare("UPDATE task_runs SET outcome = ? WHERE run_id = ? AND finished_at IS NOT NULL AND outcome IS NULL").run(outcome, runId);
  } catch (err) {
    logAndSwallow(TAG, "setRunOutcome", err, "warn");
  }
}

export function settleActiveRun(taskId: string, runId: string, statePatch: Partial<TaskRuntimeState>): boolean {
  try {
    const db = requireTaskDatabase();
    const finishedAt = Date.now();
    let won = false;
    db.transaction(() => {
      // The terminal write is the CAS: only one settler can win per run.
      const outcome = cas(db,
        "UPDATE task_runs SET finished_at = ? WHERE run_id = ? AND finished_at IS NULL",
        finishedAt, runId);
      if (outcome !== "won") return;
      won = true;
      ensureTaskRow(db, taskId);
      const { sets, vals } = statePatchColumns(statePatch);
      if (sets.length > 0) {
        db.prepare(`UPDATE task_state SET ${sets.join(", ")} WHERE task_id = ?`).run(...vals, taskId);
      }
    });
    if (won) notifyTaskDueChanged();
    return won;
  } catch (err) {
    logAndSwallow(TAG, "settleActiveRun", err, "warn");
    return false;
  }
}
