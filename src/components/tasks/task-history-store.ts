/**
 * task-history-store.ts — Durable terminal events for scheduled-task runs
 * (#1568). Reads and appends are indexed SQL over the shared task database's
 * `task_run_history` table; the legacy JSONL representation is migration input
 * only (see task-history-schema.ts).
 */

import { randomUUID } from "node:crypto";
import { requireTaskDatabase, type TaskDatabase } from "./kanban-board.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { eventToRow, INSERT_TASK_RUN_HISTORY, pruneTaskRunHistory, rowToEvent } from "./task-history-schema.js";
import type { TaskKind } from "./task-types.js";
import type { TaskFailureDiagnosticV1 } from "./task-failure.js";

const TAG = "task_history_store";

export type TaskOutcome = "success" | "failed" | "noop" | "deferred" | "skipped" | "cancelled" | "definition_failed" | "timed_out" | "unknown";

export interface TaskRunEvent {
  runId: string;
  taskId: string;
  kind: TaskKind;
  trigger: "schedule" | "manual" | "retry";
  startedAt: number;
  finishedAt: number;
  outcome: TaskOutcome;
  exitCode?: number;
  /** #1610: short operational context for diagnostics and task status. */
  detail?: string;
  /** #1610: bounded user-facing payload for successful scheduled one-shot
   * announce runs. Populates the Kanban `result_summary`; never conflated with
   * operational `detail`. Absent for non-agent and non-announce runs. */
  deliveryText?: string;
  resultPath?: string;
  kanbanCardId?: number;
  /** #1502 Task 9: groups attempts 1 and 2 without relying on retrying alone. */
  groupId?: string;
  /** #1520: structured failure data. Legacy string-only records remain readable. */
  diagnostic?: TaskFailureDiagnosticV1;
}

/** #1568: explicit read-limit ceiling; callers request at most 50 today. */
const MAX_READ_LIMIT = 100;

/** Normalize a requested limit to a non-negative integer <= 100. Non-finite
 * values keep the function's existing default of 10. */
function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  return Math.min(MAX_READ_LIMIT, Math.max(0, Math.trunc(limit)));
}

/**
 * Append a terminal event. Idempotent for an explicit duplicate run ID: the
 * existing row wins and the ID is returned without creating a second row.
 * Serialization and database errors propagate — a storage outage must never
 * look like a settled run.
 */
export function appendRun(event: Omit<TaskRunEvent, "runId"> & { runId?: string }): string {
  const runId = event.runId ?? randomUUID().slice(0, 12);
  const db = requireTaskDatabase();
  const result = db.prepare(INSERT_TASK_RUN_HISTORY).run(...eventToRow({ ...event, runId }));
  if (result.changes === 1) runRetentionBestEffort(db);
  return runId;
}

/** Best-effort cleanup after an authoritative insert; never changes the
 * insert result, never runs on a duplicate. */
function runRetentionBestEffort(db: TaskDatabase): void {
  try {
    pruneTaskRunHistory(db, Date.now());
  } catch (err) {
    logAndSwallow(TAG, "prune task_run_history after insert", err);
  }
}

/**
 * Append exactly once: one atomic insert with a run_id-only conflict target
 * owns run-ID uniqueness.
 * Returns the winning run ID, or null when the run is already recorded.
 * Only a uniqueness conflict maps to null — all database and serialization
 * failures propagate so settlement never mistakes a storage outage for an
 * already-recorded terminal event.
 */
export function appendRunOnce(event: Omit<TaskRunEvent, "runId"> & { runId?: string }): string | null {
  const runId = event.runId ?? randomUUID().slice(0, 12);
  const db = requireTaskDatabase();
  const result = db.prepare(INSERT_TASK_RUN_HISTORY).run(...eventToRow({ ...event, runId }));
  if (result.changes !== 1) return null;
  runRetentionBestEffort(db);
  return runId;
}

/** Newest `limit` (0..100) terminal events for a task, deterministic
 * `finishedAt DESC, runId DESC` order. Zero returns an empty array without
 * querying. */
export function recentRuns(taskId: string, limit: number = 10): TaskRunEvent[] {
  const bounded = normalizeLimit(limit);
  if (bounded === 0) return [];
  const db = requireTaskDatabase();
  const rows = db.prepare(
    `SELECT * FROM task_run_history
     WHERE task_id = ?
     ORDER BY finished_at DESC, run_id DESC
     LIMIT ?`
  ).all(taskId, bounded);
  return rows.map(rowToEvent);
}

export function todaySuccessCount(taskId: string, now: number = Date.now()): number {
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const db = requireTaskDatabase();
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM task_run_history
     WHERE task_id = ? AND outcome = 'success' AND finished_at >= ?`
  ).get(taskId, todayStart) as { count: number };
  return Number(row.count);
}

export function hasRun(runId: string): boolean {
  return getRun(runId) !== undefined;
}

/** Return the durable terminal event for a run, when one exists. */
export function getRun(runId: string): TaskRunEvent | undefined {
  return getRunFromDatabase(requireTaskDatabase(), runId);
}

/** Read one history event from an already-open task database. Acceptance
 * harnesses use this to inspect an isolated bridge home without changing the
 * process-global database singleton used by normal callers. */
export function getRunFromDatabase(db: TaskDatabase, runId: string): TaskRunEvent | undefined {
  const row = db.prepare(`SELECT * FROM task_run_history WHERE run_id = ?`).get(runId);
  return row ? rowToEvent(row) : undefined;
}

/** One retained terminal event per task — newest first with a deterministic
 * run_id tie-breaker, in a single window-function pass. */
export function latestOutcomeByTask(_now: number = Date.now()): Map<string, TaskRunEvent> {
  const db = requireTaskDatabase();
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT h.*, ROW_NUMBER() OVER (
         PARTITION BY task_id ORDER BY finished_at DESC, run_id DESC
       ) AS position
       FROM task_run_history h
     )
     WHERE position = 1`
  ).all();
  const latest = new Map<string, TaskRunEvent>();
  for (const row of rows) {
    const event = rowToEvent(row);
    latest.set(event.taskId, event);
  }
  return latest;
}
