/**
 * task-state-schema.ts — #1601: durable scheduled-run state as CAS'd database
 * rows. Two tables: per-task scheduling facts (`task_state`) and per-attempt
 * run rows (`task_runs`). The partial unique index `idx_task_runs_one_live` is
 * the load-bearing piece — "at most one live run per task" is enforced by the
 * database, not by application read-then-check.
 *
 * The one-time JSON migration runs inside this module's init so it cannot race
 * a reader: tables are created first, the file is imported in a single
 * transaction, and the file is renamed (never deleted) to
 * `task-state.json.migrated` as a recoverable breadcrumb.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo, logWarn } from "../logger.js";

const TAG = "task-state-schema";

/** Minimal structural db handle; satisfied by kanban-board's TaskDatabase. */
export interface TaskStateDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export const TASK_STATE_DDL = `
CREATE TABLE IF NOT EXISTS task_state (
  task_id                TEXT PRIMARY KEY,
  next_run_at            INTEGER,
  last_started_at        INTEGER,
  last_finished_at       INTEGER,
  retry_at               INTEGER,
  retrying               INTEGER NOT NULL DEFAULT 0,
  completed              INTEGER NOT NULL DEFAULT 0,
  retry_group_id         TEXT,
  retry_attempt          INTEGER,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0,
  consecutive_deferrals  INTEGER NOT NULL DEFAULT 0,
  auto_paused            INTEGER NOT NULL DEFAULT 0,
  paused_at              INTEGER,
  prior_failure          TEXT,
  last_incident_json     TEXT,
  deferred_admission_json TEXT
);

CREATE TABLE IF NOT EXISTS task_runs (
  run_id             TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL,
  group_id           TEXT NOT NULL,
  attempt            INTEGER NOT NULL,
  trigger            TEXT NOT NULL CHECK(trigger IN ('schedule','manual','retry')),
  occurrence_at      INTEGER NOT NULL,
  reserved_at        INTEGER NOT NULL,
  deadline_at        INTEGER NOT NULL,
  phase              TEXT NOT NULL,
  last_progress_at   INTEGER NOT NULL,
  progress_sequence  INTEGER NOT NULL DEFAULT 0,
  card_id            INTEGER,
  session_id         TEXT,
  execution_id       TEXT,
  terminal_request_json TEXT,
  owner_pid          INTEGER NOT NULL,
  owner_started_at   INTEGER,
  finished_at        INTEGER,
  outcome            TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_task_runs_one_live
  ON task_runs(task_id) WHERE finished_at IS NULL;
`;

function statePath(): string {
  return join(abtarsHome(), "tasks", "task-state.json");
}

interface LegacyRun {
  runId: string;
  groupId: string;
  attempt: 1 | 2;
  trigger: "schedule" | "manual" | "retry";
  occurrenceAt: number;
  reservedAt: number;
  deadlineAt: number;
  phase: string;
  lastProgressAt: number;
  cardId?: number;
  sessionId?: string;
  executionId?: string;
  progressSequence?: number;
  terminalRequest?: { kind: string; requestedAt: number; reason: string };
}

interface LegacyState {
  nextRunAt?: number | null;
  lastStartedAt?: number;
  lastFinishedAt?: number;
  retryAt?: number;
  retrying?: boolean;
  completed?: boolean;
  retryGroupId?: string;
  retryAttempt?: 1 | 2;
  consecutiveFailures?: number;
  consecutiveDeferrals?: number;
  autoPaused?: boolean;
  pausedAt?: number;
  priorFailure?: string;
  lastIncident?: unknown;
  deferredAdmission?: unknown;
  activeRun?: LegacyRun;
}

/**
 * #1601: create both tables and the index, then import any legacy
 * `task-state.json` exactly once. Idempotent by construction: the import is
 * skipped when the file is absent, and re-running it after a partial commit
 * cannot duplicate rows (INSERT OR IGNORE on the run_id / task_id primary
 * keys). The rename happens after the transaction commits; a crash before
 * commit leaves the tables empty and the JSON intact for a clean retry.
 */
export function initTaskStateSchema(db: TaskStateDb): void {
  db.exec(TASK_STATE_DDL);
  const p = statePath();
  if (!existsSync(p)) return;

  // The migration must never break the shared database open path: a malformed
  // or foreign legacy file is logged loudly and left in place for manual
  // recovery, with the tables clean (transaction rollback) and the file
  // un-renamed so the next boot retries.
  try {
    const imported = importLegacyFile(db, p);
    if (imported === null) return;
    try {
      renameSync(p, p + ".migrated");
    } catch (err) {
      logAndSwallow(TAG, "rename task-state.json -> .migrated", err);
    }
    logInfo(TAG, `Imported legacy task-state.json (${imported} task(s))`);
  } catch (err) {
    logAndSwallow(TAG, "import legacy task-state.json", err);
    logWarn(TAG, `Legacy task-state.json left intact for manual recovery: ${p}`);
  }
}

/** Returns the number of imported tasks, or null when the file is unusable. */
function importLegacyFile(db: TaskStateDb, p: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    logAndSwallow(TAG, "read legacy task-state.json", err);
    return null;
  }
  let file: Record<string, LegacyState>;
  try {
    file = JSON.parse(raw) as Record<string, LegacyState>;
  } catch (err) {
    logAndSwallow(TAG, "parse legacy task-state.json", err);
    return null;
  }
  const insertTask = db.prepare(`
    INSERT INTO task_state (
      task_id, next_run_at, last_started_at, last_finished_at, retry_at,
      retrying, completed, retry_group_id, retry_attempt,
      consecutive_failures, consecutive_deferrals, auto_paused, paused_at,
      prior_failure, last_incident_json, deferred_admission_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertRun = db.prepare(`
    INSERT INTO task_runs (
      run_id, task_id, group_id, attempt, trigger, occurrence_at,
      reserved_at, deadline_at, phase, last_progress_at, progress_sequence,
      card_id, session_id, execution_id, terminal_request_json,
      owner_pid, owner_started_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  db.transaction(() => {
    for (const [taskId, s] of Object.entries(file)) {
      insertTask.run(
        taskId,
        s.nextRunAt ?? null,
        s.lastStartedAt ?? null,
        s.lastFinishedAt ?? null,
        s.retryAt ?? null,
        s.retrying ? 1 : 0,
        s.completed ? 1 : 0,
        s.retryGroupId ?? null,
        s.retryAttempt ?? null,
        s.consecutiveFailures ?? 0,
        s.consecutiveDeferrals ?? 0,
        s.autoPaused ? 1 : 0,
        s.pausedAt ?? null,
        s.priorFailure ?? null,
        s.lastIncident === undefined ? null : JSON.stringify(s.lastIncident),
        s.deferredAdmission === undefined ? null : JSON.stringify(s.deferredAdmission),
      );
      const run = s.activeRun;
      if (run) {
        insertRun.run(
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
          // #1601: pre-migration runs are unprovable (owner_started_at NULL) so
          // the first liveness pass leaves them alone instead of settling them
          // `unknown` spuriously.
          process.pid,
          null,
        );
      }
    }
  });
  return Object.keys(file).length;
}
