import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logWarn } from "../logger.js";
import { normalize, type ScheduledTask } from "./task-types.js";
import { initializeState } from "./task-state-store.js";

const TAG = "task_store";

const storePath = (): string => join(abtarsHome(), "tasks", "tasks.json");

function readAll(): ScheduledTask[] {
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

  const valid: ScheduledTask[] = [];
  for (const item of raw) {
    const result = normalize(item);
    if (result.ok) {
      valid.push(result.entry);
    } else {
      logWarn(TAG, `Quarantined invalid task entry${result.id ? ` "${result.id}"` : ""}: ${result.error}`);
    }
  }
  return valid;
}

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

export function writeEntries(entries: ScheduledTask[]): void {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function readEntries(): ScheduledTask[] {
  const entries = readAll();
  initializeState(entries);
  return entries;
}

export function readEntry(id: string): ScheduledTask | null {
  const entries = readAll();
  initializeState(entries);
  return entries.find(e => e.id === id) ?? null;
}

export function writeEntry(e: ScheduledTask): void {
  const entries = readAllRaw();
  const result = normalize(e);
  const entry = result.ok ? result.entry : e;
  const idx = entries.findIndex(x => typeof x === "object" && x !== null && (x as { id?: string }).id === e.id);
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  writeEntries(entries as ScheduledTask[]);
}

export function removeEntry(id: string): boolean {
  const entries = readAllRaw();
  const before = entries.length;
  const filtered = entries.filter(x => !(typeof x === "object" && x !== null && (x as { id?: string }).id === id));
  if (filtered.length === before) return false;
  writeEntries(filtered as ScheduledTask[]);
  return true;
}

export function closeDb(): void {}
