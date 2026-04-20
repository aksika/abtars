/**
 * cron-store.ts — JSON-backed cron entry storage.
 * Replaces cron-db.ts (SQLite in memory.db) with ~/.agentbridge/state/cron.json.
 * Same API surface for callers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import type { CronEntry } from "../../cli/agentbridge-task.js";
import { agentBridgeHome } from "../../paths.js";

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
