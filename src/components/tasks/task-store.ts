/**
 * task-store.ts — JSON-backed task entry storage.
 * File: ~/.abtars/tasks/tasks.json
 *
 * Owns reading, validating, and normalizing every entry at the store boundary
 * (#1321). Malformed entries are quarantined (logged + skipped) so an invalid
 * executor can never fall through to agent execution. Same write API for callers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logInfo, logWarn } from "../logger.js";
import { normalize, type CronEntry } from "./task-types.js";

const TAG = "task_store";

const storePath = (): string => join(abtarsHome(), "tasks", "tasks.json");

/**
 * Read + normalize all entries. Malformed entries are logged and skipped — they
 * never reach the checker/queue. This is the single validation boundary: every
 * consumer (checker, queue, CLI, status) sees only normalized, valid entries.
 */
function readAll(): CronEntry[] {
  const p = storePath();
  if (!existsSync(p)) return [];
  let raw: unknown[];
  try {
    raw = JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    logAndSwallow(TAG, "readAll tasks.json", err);
    return [];
  }
  if (!Array.isArray(raw)) {
    logWarn(TAG, "tasks.json is not an array — ignoring");
    return [];
  }

  const valid: CronEntry[] = [];
  for (const item of raw) {
    const result = normalize(item);
    if (result.ok) {
      valid.push(result.entry);
    } else {
      // Quarantine: log with id (if any) but never execute. Do NOT mutate the
      // file here — a write in the read path would risk clobbering user edits
      // under concurrent access. The invalid entry is simply invisible to the
      // scheduler until corrected.
      logWarn(TAG, `Quarantined invalid task entry${result.id ? ` "${result.id}"` : ""}: ${result.error}`);
    }
  }
  return valid;
}

/** Read the raw (un-normalized) array for reconciliation/migration. */
function readAllRaw(): unknown[] {
  const p = storePath();
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch (err) {
    logAndSwallow(TAG, "readAllRaw tasks.json", err);
    return [];
  }
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
  const entries = readAllRaw();
  // Normalize the incoming entry too, so a hand-edited field still gets validated.
  const result = normalize(e);
  const entry = result.ok ? result.entry : e; // trust caller for write; read normalizes
  const idx = entries.findIndex(x => (typeof x === "object" && x !== null && (x as { id?: string }).id === e.id));
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  writeAll(entries as CronEntry[]);
}

export function removeEntry(id: string): boolean {
  const entries = readAllRaw();
  const before = entries.length;
  const filtered = entries.filter(x => !(typeof x === "object" && x !== null && (x as { id?: string }).id === id));
  if (filtered.length === before) return false;
  writeAll(filtered as CronEntry[]);
  return true;
}

export function recordRun(entryId: string, exitCode?: number): void {
  const entries = readAllRaw();
  const entry = entries.find(e => typeof e === "object" && e !== null && (e as { id?: string }).id === entryId) as (Record<string, unknown> | undefined);
  if (!entry) return;
  const history: { ts: number; exitCode?: number }[] = Array.isArray(entry["history"]) ? (entry["history"] as { ts: number; exitCode?: number }[]) : [];
  history.push({ ts: Date.now(), ...(exitCode !== undefined ? { exitCode } : {}) });
  if (history.length > 10) history.splice(0, history.length - 10);
  entry["history"] = history;
  writeAll(entries as CronEntry[]);
}

/**
 * Seed a canonical template entry by stable id only when absent. Never overwrites
 * an existing entry's schedule, pause state, or other user edits. Used by
 * install/update reconciliation for the seeded `sleep-cycle` entry (#1321).
 */
export function seedCanonicalEntry(canonical: object): { seeded: boolean } {
  const entries = readAllRaw();
  const id = (canonical as { id?: string }).id;
  if (!id) return { seeded: false };
  const exists = entries.some(e => typeof e === "object" && e !== null && (e as { id?: string }).id === id);
  if (exists) {
    logInfo(TAG, `Canonical task "${id}" already present — preserving user edits`);
    return { seeded: false };
  }
  entries.push(canonical);
  writeAll(entries as CronEntry[]);
  logInfo(TAG, `Seeded canonical task "${id}"`);
  return { seeded: true };
}

/** No-op — kept for API compat with tests that called closeDb() on the old SQLite store. */
export function closeDb(): void { /* JSON store has no connection to close */ }
