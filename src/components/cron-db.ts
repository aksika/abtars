/**
 * cron-db.ts — SQLite-backed cron entry storage.
 * Replaces cron.json with a table in memory.db.
 * Handles migration from cron.json on first use.
 */

import Database from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CronEntry } from "../cli/agentbridge-task.js";

const DB_PATH = (): string => join(homedir(), ".agentbridge", "memory", "memory.db");
const JSON_PATH = (): string => join(homedir(), ".agentbridge", "memory", "cron.json");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH());
  _db.pragma("journal_mode = WAL");
  _db.exec(`CREATE TABLE IF NOT EXISTS cron_entries (
    id TEXT PRIMARY KEY,
    fire_at INTEGER NOT NULL,
    message TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    type TEXT NOT NULL DEFAULT 'task',
    executor TEXT,
    schedule TEXT,
    priority TEXT,
    task_file TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_ran_at INTEGER,
    retry_after INTEGER,
    retrying INTEGER NOT NULL DEFAULT 0,
    history TEXT NOT NULL DEFAULT '[]'
  )`);
  migrate();
  return _db;
}

function migrate(): void {
  const jsonPath = JSON_PATH();
  if (!existsSync(jsonPath)) return;
  const db = _db!;
  const count = (db.prepare("SELECT COUNT(*) as n FROM cron_entries").get() as { n: number }).n;
  if (count > 0) return; // already migrated

  try {
    const entries: CronEntry[] = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const insert = db.prepare(`INSERT OR IGNORE INTO cron_entries
      (id, fire_at, message, chat_id, type, executor, schedule, priority, task_file, paused, fired, created_at, last_ran_at, retry_after, retrying, history)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      for (const e of entries) {
        insert.run(e.id, e.fireAt, e.message, e.chatId, e.type, e.executor ?? null, e.schedule ?? null,
          e.priority ?? null, e.taskFile ?? null, e.paused ? 1 : 0, e.fired ? 1 : 0, e.createdAt,
          e.lastRanAt ?? null, e.retryAfter ?? null, e._retrying ? 1 : 0, JSON.stringify(e.history ?? []));
      }
    });
    tx();
    renameSync(jsonPath, jsonPath + ".migrated");
  } catch { /* migration is best-effort */ }
}

function rowToEntry(row: any): CronEntry {
  return {
    id: row.id, fireAt: row.fire_at, message: row.message, chatId: row.chat_id,
    type: row.type, fired: !!row.fired, createdAt: row.created_at,
    ...(row.executor ? { executor: row.executor } : {}),
    ...(row.schedule ? { schedule: row.schedule } : {}),
    ...(row.priority ? { priority: row.priority } : {}),
    ...(row.task_file ? { taskFile: row.task_file } : {}),
    ...(row.paused ? { paused: true } : {}),
    ...(row.last_ran_at ? { lastRanAt: row.last_ran_at } : {}),
    ...(row.retry_after ? { retryAfter: row.retry_after } : {}),
    ...(row.retrying ? { _retrying: true } : {}),
    history: JSON.parse(row.history || "[]"),
  };
}

export function readEntries(): CronEntry[] {
  return getDb().prepare("SELECT * FROM cron_entries").all().map(rowToEntry);
}

export function readEntry(id: string): CronEntry | null {
  const row = getDb().prepare("SELECT * FROM cron_entries WHERE id = ?").get(id);
  return row ? rowToEntry(row) : null;
}

export function writeEntry(e: CronEntry): void {
  getDb().prepare(`INSERT OR REPLACE INTO cron_entries
    (id, fire_at, message, chat_id, type, executor, schedule, priority, task_file, paused, fired, created_at, last_ran_at, retry_after, retrying, history)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(e.id, e.fireAt, e.message, e.chatId, e.type, e.executor ?? null, e.schedule ?? null,
      e.priority ?? null, e.taskFile ?? null, e.paused ? 1 : 0, e.fired ? 1 : 0, e.createdAt,
      e.lastRanAt ?? null, e.retryAfter ?? null, e._retrying ? 1 : 0, JSON.stringify(e.history ?? []));
}

export function removeEntry(id: string): boolean {
  return getDb().prepare("DELETE FROM cron_entries WHERE id = ?").run(id).changes > 0;
}

export function recordRun(entryId: string, exitCode?: number): void {
  const db = getDb();
  const row = db.prepare("SELECT history FROM cron_entries WHERE id = ?").get(entryId) as { history: string } | undefined;
  if (!row) return;
  const history: { ts: number; exitCode?: number }[] = JSON.parse(row.history || "[]");
  history.push({ ts: Date.now(), ...(exitCode !== undefined ? { exitCode } : {}) });
  if (history.length > 10) history.splice(0, history.length - 10);
  db.prepare("UPDATE cron_entries SET history = ? WHERE id = ?").run(JSON.stringify(history), entryId);
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}
