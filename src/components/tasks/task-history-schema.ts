/**
 * task-history-schema.ts — #1568: bounded, indexed scheduled-task run history.
 *
 * `task_run_history` holds the durable pre-settlement terminal event per run —
 * the same payload the legacy JSONL carried — as indexed rows in the shared
 * task database. The one-time JSONL import runs inside this module's init so
 * it cannot race a reader: the table and indexes are created first, valid rows
 * are imported in file order in a single transaction with first-valid-row-wins
 * run_id uniqueness, and the source file is renamed (never deleted) to a
 * non-overwriting `.migrated` backup after commit.
 *
 * Retention is bounded by age (90 days) and a global eligible-row ceiling
 * (10,000), with the same exclusion in both passes: a history row for an
 * unfinished `task_runs` reservation is settlement-repair evidence and is
 * never a victim.
 */

import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo, logWarn } from "../logger.js";
import type { TaskRunEvent } from "./task-history-store.js";
import type { TaskKind } from "./task-types.js";
import type { TaskOutcome } from "./task-history-store.js";

const TAG = "task-history-schema";

export const TASK_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const TASK_HISTORY_MAX_ROWS = 10_000;

/** Minimal structural db handle; satisfied by kanban-board's TaskDatabase. */
export interface TaskHistoryDb {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export const TASK_HISTORY_DDL = `
CREATE TABLE IF NOT EXISTS task_run_history (
  run_id          TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK(kind IN ('reminder','system','script','agent')),
  trigger         TEXT NOT NULL CHECK(trigger IN ('schedule','manual','retry')),
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER NOT NULL,
  outcome         TEXT NOT NULL CHECK(outcome IN (
                    'success','failed','noop','deferred','skipped','cancelled',
                    'definition_failed','timed_out','unknown'
                  )),
  exit_code       INTEGER,
  detail          TEXT,
  delivery_text   TEXT,
  result_path     TEXT,
  kanban_card_id  INTEGER,
  group_id        TEXT,
  diagnostic_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_run_history_task_finished
  ON task_run_history(task_id, finished_at DESC, run_id DESC);

CREATE INDEX IF NOT EXISTS idx_task_run_history_task_outcome_finished
  ON task_run_history(task_id, outcome, finished_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_run_history_finished
  ON task_run_history(finished_at DESC, run_id DESC);
`;

const KINDS = new Set(["reminder", "system", "script", "agent"]);
const TRIGGERS = new Set(["schedule", "manual", "retry"]);
const OUTCOMES = new Set([
  "success", "failed", "noop", "deferred", "skipped", "cancelled",
  "definition_failed", "timed_out", "unknown",
]);

/** Live-write INSERT — also the migration import statement. */
export const INSERT_TASK_RUN_HISTORY = `
  INSERT INTO task_run_history (
    run_id, task_id, kind, trigger, started_at, finished_at, outcome,
    exit_code, detail, delivery_text, result_path, kanban_card_id, group_id, diagnostic_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(run_id) DO NOTHING
`;

/** Encode a TaskRunEvent into the 14 bound parameters of INSERT_TASK_RUN_HISTORY. */
export function eventToRow(event: TaskRunEvent): Array<string | number | null> {
  return [
    event.runId,
    event.taskId,
    event.kind,
    event.trigger,
    event.startedAt,
    event.finishedAt,
    event.outcome,
    event.exitCode ?? null,
    event.detail ?? null,
    event.deliveryText ?? null,
    event.resultPath ?? null,
    event.kanbanCardId ?? null,
    event.groupId ?? null,
    event.diagnostic === undefined ? null : JSON.stringify(event.diagnostic),
  ];
}

/** Decode a SELECT row into a TaskRunEvent. Optional columns map from SQL
 * NULL to `undefined`; a bad stored diagnostic must not discard the otherwise
 * readable event. */
export function rowToEvent(row: Record<string, unknown>): TaskRunEvent {
  let diagnostic: TaskRunEvent["diagnostic"];
  const rawDiagnostic = row.diagnostic_json;
  if (rawDiagnostic != null) {
    try {
      const parsed = JSON.parse(String(rawDiagnostic));
      if (parsed !== null && typeof parsed === "object") diagnostic = parsed as TaskRunEvent["diagnostic"];
    } catch {
      // Defensive: an unparseable stored diagnostic is dropped, never the event.
    }
  }
  return {
    runId: String(row.run_id),
    taskId: String(row.task_id),
    kind: row.kind as TaskKind,
    trigger: row.trigger as TaskRunEvent["trigger"],
    startedAt: Number(row.started_at),
    finishedAt: Number(row.finished_at),
    outcome: row.outcome as TaskOutcome,
    ...(row.exit_code == null ? {} : { exitCode: Number(row.exit_code) }),
    ...(row.detail == null ? {} : { detail: String(row.detail) }),
    ...(row.delivery_text == null ? {} : { deliveryText: String(row.delivery_text) }),
    ...(row.result_path == null ? {} : { resultPath: String(row.result_path) }),
    ...(row.kanban_card_id == null ? {} : { kanbanCardId: Number(row.kanban_card_id) }),
    ...(row.group_id == null ? {} : { groupId: String(row.group_id) }),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  };
}

function historyPath(): string {
  return join(abtarsHome(), "tasks", "task-history.jsonl");
}

/**
 * #1568: create the history table/indexes, import any legacy
 * `task-history.jsonl` exactly once, then run bounded retention. Idempotent by
 * construction: the import is skipped when the file is absent, and re-running
 * after a partial commit cannot duplicate rows (the insert ignores only a
 * conflicting run_id).
 * The rename happens after the transaction commits; a crash before commit
 * leaves the JSONL intact for a clean retry.
 */
export function initTaskHistorySchema(db: TaskHistoryDb): void {
  db.exec(TASK_HISTORY_DDL);
  importLegacyJsonl(db);
  try {
    pruneTaskRunHistory(db, Date.now());
  } catch (err) {
    logAndSwallow(TAG, "retention after history init", err);
  }
}

function importLegacyJsonl(db: TaskHistoryDb): void {
  const p = historyPath();
  if (!existsSync(p)) return;
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    logAndSwallow(TAG, "read legacy task-history.jsonl", err);
    return;
  }
  const lines = splitLines(raw);

  const insert = db.prepare(INSERT_TASK_RUN_HISTORY);
  let imported = 0;
  let duplicate = 0;
  let malformed = 0;
  try {
    db.transaction(() => {
      for (const line of lines) {
        const event = parseLegacyLine(line);
        if (event === null) {
          malformed++;
          continue;
        }
        const result = insert.run(...eventToRow(event));
        if (result.changes === 1) imported++;
        else duplicate++;
      }
    });
  } catch (err) {
    logAndSwallow(TAG, "import legacy task-history.jsonl", err);
    logWarn(TAG, `Legacy task-history.jsonl left intact for manual recovery: ${p}`);
    return;
  }

  renameWithBackup(p);
  logInfo(TAG, `Imported legacy task-history.jsonl (${imported} imported, ${duplicate} duplicate, ${malformed} malformed)`);
}

/** Split legacy content into lines, tolerating a truncated final line exactly
 * like the old reader (a non-empty final line not ending in `}` is dropped). */
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] !== "" && !lines[lines.length - 1]!.endsWith("}")) {
    lines.pop();
  }
  return lines.filter(l => l.trim().length > 0);
}

/** Parse and validate one legacy JSONL line; null for malformed/truncated. */
function parseLegacyLine(line: string): TaskRunEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const e = parsed as Record<string, unknown>;
  if (typeof e.runId !== "string" || e.runId.length === 0) return null;
  if (typeof e.taskId !== "string" || e.taskId.length === 0) return null;
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) return null;
  if (typeof e.trigger !== "string" || !TRIGGERS.has(e.trigger)) return null;
  if (typeof e.startedAt !== "number" || !Number.isFinite(e.startedAt)) return null;
  if (typeof e.finishedAt !== "number" || !Number.isFinite(e.finishedAt)) return null;
  if (typeof e.outcome !== "string" || !OUTCOMES.has(e.outcome)) return null;
  return {
    runId: e.runId,
    taskId: e.taskId,
    kind: e.kind as TaskKind,
    trigger: e.trigger as TaskRunEvent["trigger"],
    startedAt: e.startedAt,
    finishedAt: e.finishedAt,
    outcome: e.outcome as TaskOutcome,
    ...(typeof e.exitCode === "number" ? { exitCode: e.exitCode } : {}),
    ...(typeof e.detail === "string" ? { detail: e.detail } : {}),
    ...(typeof e.deliveryText === "string" ? { deliveryText: e.deliveryText } : {}),
    ...(typeof e.resultPath === "string" ? { resultPath: e.resultPath } : {}),
    ...(typeof e.kanbanCardId === "number" ? { kanbanCardId: e.kanbanCardId } : {}),
    ...(typeof e.groupId === "string" ? { groupId: e.groupId } : {}),
    ...(e.diagnostic !== undefined && e.diagnostic !== null && typeof e.diagnostic === "object"
      ? { diagnostic: e.diagnostic as TaskRunEvent["diagnostic"] }
      : {}),
  };
}

/** Rename the legacy file to `.migrated` (or the first unused `.migrated.N`
 * suffix); never overwrite an existing backup. A failed rename leaves the
 * original in place — the next open repeats the import and retries. */
function renameWithBackup(p: string): void {
  let target = p + ".migrated";
  let suffix = 0;
  while (existsSync(target)) {
    suffix++;
    target = p + `.migrated.${suffix}`;
  }
  try {
    renameSync(p, target);
  } catch (err) {
    logAndSwallow(TAG, `rename legacy task-history.jsonl -> ${target}`, err);
  }
}

/**
 * #1568: bounded retention in one transaction. Age deletion first (rows
 * strictly older than the window), then — when more eligible rows than the
 * global ceiling remain — deletion of exactly the oldest excess in
 * `(finished_at ASC, run_id ASC)` order. Both passes exclude history whose
 * matching `task_runs` row is unfinished: that event is the sole durable
 * evidence a crash-recovery settlement may still need.
 */
export function pruneTaskRunHistory(db: TaskHistoryDb, now: number = Date.now()): { expired: number; overflow: number } {
  const ageCutoff = now - TASK_HISTORY_RETENTION_MS;
  return db.transaction(() => {
    const expired = db.prepare(
      `DELETE FROM task_run_history
       WHERE finished_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM task_runs r
           WHERE r.run_id = task_run_history.run_id AND r.finished_at IS NULL
         )`
    ).run(ageCutoff).changes;
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM task_run_history h
       WHERE NOT EXISTS (
         SELECT 1 FROM task_runs r
         WHERE r.run_id = h.run_id AND r.finished_at IS NULL
       )`
    ).get() as { n: number };
    const excess = Math.max(0, Number(row.n) - TASK_HISTORY_MAX_ROWS);
    const overflow = excess === 0
      ? 0
      : db.prepare(
          `DELETE FROM task_run_history
           WHERE run_id IN (
             SELECT run_id FROM (
               SELECT run_id
               FROM task_run_history
               WHERE NOT EXISTS (
                 SELECT 1 FROM task_runs r
                 WHERE r.run_id = task_run_history.run_id AND r.finished_at IS NULL
               )
               ORDER BY finished_at ASC, run_id ASC
               LIMIT ?
             )
           )`
        ).run(excess).changes;
    return { expired, overflow };
  });
}
