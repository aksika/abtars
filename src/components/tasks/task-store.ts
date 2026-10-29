import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { logWarn } from "../logger.js";
import { normalize, type ScheduledTask } from "./task-types.js";
import { initializeState } from "./task-state-store.js";

const TAG = "task_store";
const MAX_CATALOG_ISSUES = 32;
const MAX_ISSUE_TEXT_LENGTH = 240;

const storePath = (): string => join(abtarsHome(), "tasks", "tasks.json");

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function boundIssueText(value: string): string {
  if (value.length <= MAX_ISSUE_TEXT_LENGTH) return value;
  return `${value.slice(0, MAX_ISSUE_TEXT_LENGTH - 3)}...`;
}

export interface TaskCatalogIssue {
  readonly index: number;
  readonly id?: string;
  readonly error: string;
}

export type TaskCatalogReadResult =
  | { readonly kind: "complete"; readonly entries: ScheduledTask[] }
  | { readonly kind: "partial"; readonly entries: ScheduledTask[]; readonly issues: TaskCatalogIssue[] }
  | { readonly kind: "unavailable"; readonly reason: "read_failed" | "invalid_json" | "wrong_shape" };

export class TaskCatalogUnavailableError extends Error {
  readonly reason: "read_failed" | "invalid_json" | "wrong_shape";
  constructor(reason: "read_failed" | "invalid_json" | "wrong_shape", message?: string, cause?: unknown) {
    super(message ?? reason, cause === undefined ? undefined : { cause });
    this.name = "TaskCatalogUnavailableError";
    this.reason = reason;
  }
}

export function readTaskCatalog(): TaskCatalogReadResult {
  const p = storePath();
  let rawText: string;
  try {
    rawText = readFileSync(p, "utf-8");
  } catch (err) {
    // ENOENT is the only empty-catalog case. Permission, path, and other
    // filesystem failures must remain unavailable so callers cannot mistake
    // an inaccessible catalog for an empty one.
    if (hasErrorCode(err, "ENOENT")) return { kind: "complete", entries: [] };
    logAndSwallow(TAG, "readTaskCatalog tasks.json", err);
    return { kind: "unavailable", reason: "read_failed" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    logAndSwallow(TAG, "readTaskCatalog tasks.json", err);
    return { kind: "unavailable", reason: "invalid_json" };
  }
  if (!Array.isArray(parsed)) {
    logWarn(TAG, "tasks.json is not an array — ignoring");
    return { kind: "unavailable", reason: "wrong_shape" };
  }
  const valid: ScheduledTask[] = [];
  const issues: TaskCatalogIssue[] = [];
  let invalidCount = 0;
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const result = normalize(item);
    if (result.ok) {
      valid.push(result.entry);
    } else {
      invalidCount++;
      const id = result.id ? boundIssueText(result.id) : undefined;
      const error = boundIssueText(result.error);
      if (invalidCount <= MAX_CATALOG_ISSUES) {
        logWarn(TAG, `Quarantined invalid task entry${id ? ` "${id}"` : ""}: ${error}`);
        issues.push({ index: i, ...(id ? { id } : {}), error });
      } else if (invalidCount === MAX_CATALOG_ISSUES + 1) {
        logWarn(TAG, `Additional invalid task entries omitted from catalog diagnostics (limit ${MAX_CATALOG_ISSUES})`);
      }
    }
  }
  if (issues.length === 0) return { kind: "complete", entries: valid };
  return { kind: "partial", entries: valid, issues };
}

function readAllRaw(): unknown[] {
  const p = storePath();
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch (err) {
    if (hasErrorCode(err, "ENOENT")) return [];
    throw new TaskCatalogUnavailableError("read_failed", `tasks.json read failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TaskCatalogUnavailableError("invalid_json", `tasks.json invalid JSON: ${err instanceof Error ? err.message : String(err)}`, err);
  }
  if (!Array.isArray(raw)) {
    throw new TaskCatalogUnavailableError("wrong_shape", "tasks.json is not an array");
  }
  return raw;
}

export function writeEntries(entries: ScheduledTask[]): void {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function readEntries(): ScheduledTask[] {
  const catalog = readTaskCatalog();
  if (catalog.kind === "unavailable") return [];
  initializeState(catalog.entries);
  return catalog.entries;
}

export function readEntry(id: string): ScheduledTask | null {
  const catalog = readTaskCatalog();
  if (catalog.kind === "unavailable") return null;
  initializeState(catalog.entries);
  return catalog.entries.find(e => e.id === id) ?? null;
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
