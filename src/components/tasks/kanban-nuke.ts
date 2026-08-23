/**
 * kanban-nuke.ts — #1707 Task 8: operator-initiated Kanban database reset.
 *
 * Two-step, never pausing the bridge:
 *   1. `/kanban nuke` records `nuke_requested_at` in a lazily created control
 *      table inside the existing Kanban database and returns immediately.
 *   2. On the NEXT bridge start, before any cached connection is opened, a
 *      short-lived SQLite connection reads the marker. A fresh request (younger
 *      than five minutes) closes the connection, removes exactly the canonical
 *      Kanban database files, rebuilds an empty valid database, and continues
 *      boot. Expired, future, malformed, or absent markers are ignored
 *      unchanged.
 *
 * The destructive surface is restricted to `<ABTARS_HOME>/kanban/kanban.db`,
 * `-wal`, and `-shm`. Tasks, configuration, secrets, logs, and supervisor
 * state are never touched.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { resolveNativeDep } from "../../utils/lazy-require.js";
import { logInfo, logWarn } from "../logger.js";
import { ensureKanbanBoardSchema, requireTaskDatabase } from "./kanban-board.js";

const TAG = "kanban-nuke";
const NUKE_KEY = "nuke_requested_at";
/** Requests older than five minutes are ignored unchanged. */
export const KANBAN_NUKE_MAX_AGE_MS = 300_000;

function kanbanDbPath(): string {
  return join(abtarsHome(), "kanban", "kanban.db");
}

/**
 * Step 1 — record the nuke request. Creates the control table lazily; an old
 * database gains it on first use. Returns immediately; never pauses or waits.
 */
export function requestKanbanNuke(): void {
  // The command runs while the bridge is live: use the shared cached
  // connection exactly like every other board write.
  const db = requireTaskDatabase();
  db.exec(`CREATE TABLE IF NOT EXISTS kanban_control (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  const now = Date.now();
  db.prepare(`
    INSERT INTO kanban_control (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(NUKE_KEY, String(now));
  logInfo(TAG, "nuke requested — takes effect on next bridge start");
}

/** Read the raw pending marker through a short-lived connection, or null. */
function readNukeMarker(dbPath: string): { raw: string | null; close: () => void } {
  const Database = resolveNativeDep("better-sqlite3");
  const db = new Database(dbPath) as {
    prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
    exec(sql: string): void;
    close(): void;
  };
  let raw: string | null = null;
  try {
    const row = db.prepare(`SELECT value FROM kanban_control WHERE key = ?`).get(NUKE_KEY) as { value: unknown } | undefined;
    if (row && typeof row.value === "string") raw = row.value;
  } catch {
    // Missing control table (old database) simply has no pending request.
    raw = null;
  }
  return { raw, close: () => db.close() };
}

/**
 * Step 2 — startup preflight. Runs BEFORE the normal cached Kanban connection
 * is opened. Idempotent and non-destructive unless a fresh valid marker is
 * present. Throws only when a requested rebuild fails (fail closed rather
 * than boot against a half-initialized board).
 */
export function runKanbanNukePreflightIfNeeded(now = Date.now()): { performed: boolean; reason?: string } {
  const dbPath = kanbanDbPath();
  if (!existsSync(dbPath)) return { performed: false, reason: "no database" };

  let marker: { raw: string | null; close: () => void };
  try {
    marker = readNukeMarker(dbPath);
  } catch (err) {
    logWarn(TAG, `preflight could not open the database — ignoring (${err instanceof Error ? err.message : String(err)})`);
    return { performed: false, reason: "unreadable" };
  }

  const raw = marker.raw;
  if (raw === null) {
    marker.close();
    return { performed: false, reason: "no marker" };
  }

  const requestedAt = Number(raw);
  const valid = Number.isFinite(requestedAt)
    && requestedAt > 0
    && now >= requestedAt
    && now - requestedAt < KANBAN_NUKE_MAX_AGE_MS;

  if (!valid) {
    // Expired, future, or malformed: ignore the row UNCHANGED (non-destructive).
    marker.close();
    return { performed: false, reason: Number.isFinite(requestedAt) ? "expired-or-future" : "malformed" };
  }

  // Valid request: close the short-lived handle BEFORE deleting so no cached
  // file descriptor survives into the removal.
  marker.close();

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }
  logInfo(TAG, "nuke marker accepted — kanban database files removed");

  // Rebuild and verify an empty valid database before normal boot continues.
  try {
    const Database = resolveNativeDep("better-sqlite3");
    const db = new Database(dbPath) as { exec(sql: string): void; prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined }; pragma(s: string): void; close(): void };
    try {
      db.pragma("journal_mode = WAL");
      ensureKanbanBoardSchema({ exec: (sql: string) => db.exec(sql) });
      const check = db.prepare(`PRAGMA quick_check`).get() as Record<string, unknown>;
      const ok = Object.values(check)[0] === "ok";
      const cards = db.prepare(`SELECT COUNT(*) AS n FROM kanban_board`).get() as { n: number };
      if (!ok || cards.n !== 0) throw new Error(`rebuild verification failed (quick_check=${String(Object.values(check)[0])}, cards=${cards.n})`);
    } finally {
      db.close();
    }
  } catch (err) {
    logWarn(TAG, `rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  logInfo(TAG, "kanban database rebuilt empty and valid");
  return { performed: true };
}
