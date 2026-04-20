/**
 * cron-store.ts — JSON-backed cron entry storage.
 * Replaces cron-db.ts (SQLite in memory.db) with ~/.agentbridge/state/cron.json.
 * Same API surface for callers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CronEntry } from "../../cli/agentbridge-task.js";
import { agentBridgeHome } from "../../paths.js";
import { logInfo } from "../logger.js";

const storePath = (): string => join(agentBridgeHome(), "state", "cron.json");

function readAll(): CronEntry[] {
  const p = storePath();
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf-8")); }
  catch { return []; }
}

function writeAll(entries: CronEntry[]): void {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function readEntries(): CronEntry[] {
  return readAll();
}

export function readEntry(id: string): CronEntry | null {
  return readAll().find(e => e.id === id) ?? null;
}

export function writeEntry(e: CronEntry): void {
  const entries = readAll();
  const idx = entries.findIndex(x => x.id === e.id);
  if (idx >= 0) entries[idx] = e; else entries.push(e);
  writeAll(entries);
}

export function removeEntry(id: string): boolean {
  const entries = readAll();
  const before = entries.length;
  const filtered = entries.filter(e => e.id !== id);
  if (filtered.length === before) return false;
  writeAll(filtered);
  return true;
}

export function recordRun(entryId: string, exitCode?: number): void {
  const entries = readAll();
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  const history: { ts: number; exitCode?: number }[] = entry.history ?? [];
  history.push({ ts: Date.now(), ...(exitCode !== undefined ? { exitCode } : {}) });
  if (history.length > 10) history.splice(0, history.length - 10);
  entry.history = history;
  writeAll(entries);
}

/** No-op — kept for API compat with tests that called closeDb() on the old SQLite store. */
export function closeDb(): void { /* JSON store has no connection to close */ }

/** Migrate from SQLite (memory.db cron_entries table) if JSON doesn't exist yet. */
export async function migrateFromSqlite(): Promise<void> {
  if (existsSync(storePath())) return;

  const dbFile = join(agentBridgeHome(), "memory", "memory.db");
  if (!existsSync(dbFile)) { writeAll([]); return; }

  try {
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(dbFile, { readonly: false });
    try {
      const rows = db.prepare("SELECT * FROM cron_entries").all() as Record<string, unknown>[];
      if (rows.length === 0) { writeAll([]); return; }

      const entries: CronEntry[] = rows.map(r => ({
        id: r.id as string,
        fireAt: r.fire_at as number,
        message: r.message as string,
        chatId: r.chat_id as number,
        type: r.type as "reminder" | "task",
        fired: !!(r.fired as number),
        createdAt: r.created_at as number,
        ...(r.executor ? { executor: r.executor as "agent" | "script" } : {}),
        ...(r.schedule ? { schedule: r.schedule as string } : {}),
        ...(r.priority ? { priority: r.priority as "high" | "medium" | "low" } : {}),
        ...(r.task_file ? { taskFile: r.task_file as string } : {}),
        ...(r.paused ? { paused: true } : {}),
        ...(r.last_ran_at ? { lastRanAt: r.last_ran_at as number } : {}),
        ...(r.retry_after ? { retryAfter: r.retry_after as number } : {}),
        ...(r.retrying ? { _retrying: true } : {}),
        history: JSON.parse((r.history as string) || "[]"),
      }));

      writeAll(entries);
      db.exec("DROP TABLE IF EXISTS cron_entries");
      logInfo("cron", `Migrated ${entries.length} entries from memory.db → state/cron.json`);
    } finally { db.close(); }
  } catch {
    writeAll([]);
  }
}
