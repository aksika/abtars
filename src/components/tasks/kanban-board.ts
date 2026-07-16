/**
 * kanban-board.ts — Local Kanban board backed by SQLite.
 *
 * Workers write completion; main agent polls and delivers.
 * DB lives at ~/.abtars/kanban/kanban.db
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { resolveNativeDep } from "../../utils/lazy-require.js";
import { logWarn } from "../logger.js";
import { isValidSessionType } from "../spin-profiles.js";

// better-sqlite3 is external (native module, resolved from ~/.local/lib/node_modules/)
type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void; transaction<T>(fn: () => T): () => T };

/** #1393 — Typed capability for components that need durable SQLite access alongside kanban. */
export interface TaskDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

/** #1393 — Get the canonical task database. Throws if unavailable (fail-explicit for Pi). */
export function requireTaskDatabase(): TaskDatabase {
  const d = db();
  if (!d) throw new Error("Kanban database unavailable — better-sqlite3 not installed");
  return {
    prepare(sql: string) {
      const stmt = d.prepare(sql);
      return {
          run(...params: unknown[]) { return stmt.run(...params); },
          get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
          all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { d.exec(sql); },
    transaction<T>(fn: () => T): T { return d.transaction(fn)(); },
  };
}

export interface KanbanCard {
  id: number;
  title: string;
  source: string;
  source_id: string | null;
  assignee: string;
  priority: string;
  status: string;
  type: string | null;
  goal: string | null;
  notes: string | null;
  result_summary: string | null;
  result_path: string | null;
  error: string | null;
  delivery_attempts: number;
  approval: string | null;
  due_at: string | null;
  labels: string | null;
  parent_id: number | null;
  blocked_by: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  delivered_at: string | null;
  max_tokens: number | null;
  tokens_used: number | null;
  delivery_mode: string;
  chat_id: string | null;
  source_peer: string | null;
}

let _db: SqliteDb | null = null;
let _dbAttempted = false;

function db(): SqliteDb | null {
  if (_dbAttempted) return _db;
  _dbAttempted = true;
  const dir = join(abtarsHome(), "kanban");
  mkdirSync(dir, { recursive: true });
  try {
    const Database = resolveNativeDep("better-sqlite3");
    _db = new Database(join(dir, "kanban.db")) as SqliteDb;
    _db.pragma("journal_mode = WAL");
    _db.exec(`CREATE TABLE IF NOT EXISTS kanban_board (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      assignee TEXT DEFAULT 'local',
      priority TEXT NOT NULL DEFAULT 'MEDIUM' CHECK(priority IN ('CRITICAL','HIGH','MEDIUM','LOW')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','done','failed','delivering','delivered')),
      type TEXT,
      notes TEXT,
      result_summary TEXT,
      result_path TEXT,
      error TEXT,
      delivery_attempts INTEGER DEFAULT 0,
      approval TEXT CHECK(approval IS NULL OR approval IN ('pending','approved','rejected')),
      due_at TEXT,
      labels TEXT,
      parent_id INTEGER REFERENCES kanban_board(id),
      blocked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      delivered_at TEXT
    )`);
    // Migrations — safe to re-run (silently skip if column exists)
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN max_tokens INTEGER`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN tokens_used INTEGER DEFAULT 0`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN progress TEXT`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN delivery_mode TEXT DEFAULT 'deliver'`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN retry_count INTEGER DEFAULT 0`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN next_retry_at TEXT`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN chat_id TEXT`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN source_peer TEXT`); } catch {}
    try { _db.exec(`ALTER TABLE kanban_board ADD COLUMN goal TEXT`); } catch {}
  } catch {
    logWarn("kanban", "better-sqlite3 not available — kanban features disabled (run: abtars deps install)");
    _db = null;
  }
  return _db;
}

import { nerve } from "../nerve.js";

/** Return db or null (with warning logged once). */
function dbOrNull(): SqliteDb | null {
  return db();
}

import type { Delivery } from "./task-types.js";

export function kanbanEnqueue(title: string, source: string, sourceId?: string, opts?: { priority?: string; type?: string; goal?: string; labels?: string; due_at?: string; parent_id?: number; notes?: string; deliveryMode?: "silent" | "deliver" | "announce"; delivery?: Delivery; blocked_by?: string; chatId?: string; sourcePeer?: string }): number {
  const d = dbOrNull();
  if (!d) return 0;
  const raw = opts?.delivery ?? opts?.deliveryMode ?? "deliver";
  const deliveryMode = raw === "report" ? "deliver" : raw;
  const stmt = d.prepare(
    `INSERT INTO kanban_board (title, source, source_id, priority, type, goal, labels, due_at, parent_id, notes, delivery_mode, blocked_by, chat_id, source_peer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(title, source, sourceId ?? null, opts?.priority ?? "MEDIUM", opts?.type ?? null, opts?.goal ?? null, opts?.labels ?? null, opts?.due_at ?? null, opts?.parent_id ?? null, opts?.notes ?? null, deliveryMode, opts?.blocked_by ?? null, opts?.chatId ?? null, opts?.sourcePeer ?? null);
  const id = Number(result.lastInsertRowid);
  nerve.fire("card:queued", id);
  return id;
}

export interface CreateCardInput {
  type?: string;
  title: string;
  goal?: string;
  source?: string;
  sourceId?: string;
  priority?: string;
  labels?: string;
  deliveryMode?: "silent" | "deliver" | "announce";
  chatId?: string;
  sourcePeer?: string;
}

/** #955 — Shared create operation for dispatchable cards. Validates SessionType,
 *  applies bounds, requires goal for B cards. Returns card ID or error. */
export function createDispatchableCard(input: CreateCardInput): { cardId: number; status: "queued" } | { error: string } {
  const { type, title, goal } = input;
  if (!title || !title.trim()) return { error: "title required" };
  const titleBytes = Buffer.byteLength(title, "utf-8");
  if (titleBytes > 160) return { error: `title exceeds 160 bytes (${titleBytes})` };
  if (type && !isValidSessionType(type)) {
    return { error: `invalid type "${type}": must be a SessionType (A/B/C/T/P/S/O/W/D/H)` };
  }
  if (type === "B" && (!goal || !goal.trim())) {
    return { error: "goal is required for type B (Browsie) cards" };
  }
  if (goal) {
    const goalBytes = Buffer.byteLength(goal, "utf-8");
    if (goalBytes > 32768) return { error: `goal exceeds 32 KiB (${goalBytes} bytes)` };
  }
  const cardId = kanbanEnqueue(title, input.source || "agent", input.sourceId, {
    priority: input.priority,
    type,
    goal,
    labels: input.labels,
    deliveryMode: input.deliveryMode,
    chatId: input.chatId,
    sourcePeer: input.sourcePeer,
  });
  if (cardId === 0) return { error: "kanban database unavailable" };
  return { cardId, status: "queued" };
}

export function kanbanRunning(id: number): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(`UPDATE kanban_board SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(id);
  nerve.fire("card:running", id);
}

export function kanbanComplete(id: number, resultPath: string | null, summary: string): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(
    `UPDATE kanban_board SET status = 'done', result_path = ?, result_summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(resultPath, summary.slice(0, 4000), id);
  nerve.fire("card:done", id);
}

export function kanbanFail(id: number, error: string): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(
    `UPDATE kanban_board SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(error.slice(0, 1000), id);
  nerve.fire("card:failed", id);
}

const MAX_RETRIES = 3;

/** Fail with retry logic — exponential backoff (10s→20s→40s, cap 5min). After MAX_RETRIES → permanent fail. */
export function kanbanRetryOrFail(id: number, error: string): "retrying" | "failed" {
  const d = dbOrNull();
  if (!d) return "failed";
  const card = d.prepare("SELECT retry_count FROM kanban_board WHERE id = ?").get(id) as { retry_count: number } | undefined;
  const retryCount = (card?.retry_count ?? 0) + 1;
  if (retryCount > MAX_RETRIES) {
    kanbanFail(id, `${error} (after ${MAX_RETRIES} retries)`);
    return "failed";
  }
  const backoffMs = Math.min(10_000 * Math.pow(2, retryCount - 1), 300_000);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  d.prepare(
    `UPDATE kanban_board SET status = 'queued', retry_count = ?, next_retry_at = ?, error = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(retryCount, nextRetryAt, error.slice(0, 1000), id);
  nerve.fire("card:queued", id);
  return "retrying";
}

export function kanbanPending(): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE status = 'done' AND delivery_attempts < 3 ORDER BY priority = 'CRITICAL' DESC, priority = 'HIGH' DESC, created_at ASC`
  ).all() as KanbanCard[];
}

export function kanbanSetDelivering(id: number): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(`UPDATE kanban_board SET status = 'delivering', updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function kanbanMarkDelivered(id: number): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(
    `UPDATE kanban_board SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  nerve.fire("card:delivered", id);
}


/** #1298: Cross-field LIKE search across title/status/source/priority/labels/type. */
export function kanbanSearch(term: string): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  const safe = term.replace(/[%_]/g, ""); // strip LIKE wildcards to avoid user-controlled patterns
  const like = `%${safe}%`;
  return d.prepare(
    `SELECT * FROM kanban_board
     WHERE title LIKE ? OR status LIKE ? OR source LIKE ? OR priority LIKE ? OR labels LIKE ? OR type LIKE ?
     ORDER BY created_at DESC LIMIT 50`
  ).all(like, like, like, like, like, like) as KanbanCard[];
}


export function kanbanList(filter?: string, filterKey?: string): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  if (filter === "*") {
    return d.prepare(`SELECT * FROM kanban_board ORDER BY created_at DESC LIMIT 50`).all() as KanbanCard[];
  }
  if (filter && filterKey) {
    if (filterKey === "labels") {
      return d.prepare(`SELECT * FROM kanban_board WHERE labels LIKE ? ORDER BY created_at DESC LIMIT 50`).all(`%${filter}%`) as KanbanCard[];
    }
    const allowed = new Set(["status", "source", "priority", "type"]);
    if (allowed.has(filterKey)) {
      return d.prepare(`SELECT * FROM kanban_board WHERE ${filterKey} = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
    }
  }
  if (filter) {
    return d.prepare(`SELECT * FROM kanban_board WHERE status = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
  }
  return d.prepare(`SELECT * FROM kanban_board WHERE status NOT IN ('delivered') ORDER BY status = 'running' DESC, priority = 'CRITICAL' DESC, created_at DESC LIMIT 50`).all() as KanbanCard[];
}

export function kanbanUpdate(id: number, fields: Partial<Pick<KanbanCard, "title" | "status" | "priority" | "type" | "labels" | "due_at" | "notes" | "parent_id" | "approval">>): void {
  const d = dbOrNull();
  if (!d) return;
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
  }
  vals.push(id);
  d.prepare(`UPDATE kanban_board SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function kanbanCleanup(olderThanDays = 7): number {
  const d = dbOrNull();
  if (!d) return 0;
  const result = d.prepare(
    `DELETE FROM kanban_board WHERE status = 'delivered' AND delivered_at < datetime('now', '-' || ? || ' days')`
  ).run(olderThanDays);
  return result.changes;
}

export function kanbanGetCard(id: number): KanbanCard | undefined {
  const d = dbOrNull();
  if (!d) return undefined;
  return d.prepare(`SELECT * FROM kanban_board WHERE id = ?`).get(id) as KanbanCard | undefined;
}

/** Find a durable remote-delegation proxy by its peer-scoped request ID. */
export function kanbanFindRemoteDelegation(peer: string, requestId: string): KanbanCard | undefined {
  const d = dbOrNull();
  if (!d) return undefined;
  return d.prepare(
    `SELECT * FROM kanban_board
     WHERE source = 'peer' AND type = 'remote' AND source_id = ? AND source_peer = ?
     ORDER BY id DESC LIMIT 1`,
  ).get(requestId, peer) as KanbanCard | undefined;
}

/** Test-only: run a raw SQL statement against the kanban DB (avoids direct better-sqlite3 require in tests). */
export function _kanbanExecForTest(sql: string, params: unknown[] = []): void {
  const d = dbOrNull();
  if (!d) throw new Error("kanban DB not initialised");
  d.prepare(sql).run(...params);
}

export function kanbanGetChildren(parentId: number): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(`SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id`).all(parentId) as KanbanCard[];
}

export function kanbanAddTokens(id: number, tokens: number): void {
  const d = dbOrNull();
  if (!d) return;
  d.prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, id);
  const card = kanbanGetCard(id);
  if (card?.parent_id) {
    d.prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, card.parent_id);
  }
}

// #907: Worker progress — 30s debounce per card
const _progressTimers = new Map<number, ReturnType<typeof setTimeout>>();
const _progressPending = new Map<number, Record<string, unknown>>();

export function kanbanProgress(id: number, data: { toolUseCount?: number; tokenCount?: number; lastTool?: string; summary?: string }): void {
  _progressPending.set(id, data);
  if (_progressTimers.has(id)) return;
  _progressTimers.set(id, setTimeout(() => {
    _progressTimers.delete(id);
    const pending = _progressPending.get(id);
    if (pending) {
      const d = dbOrNull();
      if (d) d.prepare(`UPDATE kanban_board SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(pending), id);
      _progressPending.delete(id);
    }
  }, 30_000));
}

// ── DAG orchestration (#677) ─────────────────────────────────────────────────

/** Check if all dependencies of a card are satisfied. */
export function isUnblocked(card: KanbanCard): boolean {
  if (!card.blocked_by) return true;
  if (card.blocked_by === "children") {
    const kids = kanbanGetChildren(card.id);
    return kids.length > 0 && kids.every(k => k.status === "done" || k.status === "delivered");
  }
  const depIds = card.blocked_by.split(",").map(Number).filter(n => !isNaN(n));
  if (depIds.length === 0) return true;
  return depIds.every(id => {
    const dep = kanbanGetCard(id);
    return dep?.status === "done" || dep?.status === "delivered";
  });
}

/** Cascade-fail all cards depending (transitively) on a failed card. */
export function cascadeFail(failedId: number, projectCards: KanbanCard[]): void {
  for (const card of projectCards) {
    if (card.status !== "queued") continue;
    if (!card.blocked_by) continue;
    const deps = card.blocked_by.split(",").map(Number).filter(n => !isNaN(n));
    if (deps.includes(failedId)) {
      kanbanFail(card.id, `upstream #${failedId} failed`);
      cascadeFail(card.id, projectCards);
    }
  }
}

const MAX_ANCESTOR_DEPTH = 100;

/**
 * #1319: Walk parent_id chain to find the root card. Returns undefined if the
 * chain exceeds MAX_ANCESTOR_DEPTH or contains a cycle (detected via visited set).
 */
export function resolveRootId(cardId: number): number | undefined {
  const visited = new Set<number>();
  let current: number | undefined = cardId;
  for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
    if (current === undefined || current === null) return undefined;
    if (visited.has(current)) return undefined; // cycle
    visited.add(current);
    const card = kanbanGetCard(current);
    if (!card) return current;
    if (card.parent_id === undefined || card.parent_id === null) return current;
    current = card.parent_id;
  }
  return undefined; // depth exceeded
}

/** #1414: Return IDs of all currently running O-type project cards. */
export function kanbanRunningProjectIds(): number[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT id FROM kanban_board WHERE status = 'running' AND type = 'O' ORDER BY id`
  ).all().map((row: Record<string, unknown>) => Number(row.id));
}

/**
 * #1319: List active (queued/running) direct children of a card, up to `maxCount`.
 * Multi-level descendant resolution is not needed for v1 — Orc's project hierarchy
 * is one level deep (root → direct child cards).
 */
export function resolveActiveDescendants(rootId: number, maxCount = 50): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE parent_id = ? AND status IN ('queued', 'running') ORDER BY id LIMIT ?`,
  ).all(rootId, maxCount) as KanbanCard[];
}

/**
 * #1319: Get the most recent direct children with terminal states,
 * at most `maxCount`.
 */
export function resolveRecentDirectChildren(parentId: number, maxCount = 20): KanbanCard[] {
  const d = dbOrNull();
  if (!d) return [];
  return d.prepare(
    `SELECT * FROM kanban_board WHERE parent_id = ? AND status IN ('done', 'failed', 'delivered') ORDER BY updated_at DESC LIMIT ?`,
  ).all(parentId, maxCount) as KanbanCard[];
}
