/**
 * kanban-board.ts — Local Kanban board backed by SQLite.
 *
 * Workers write completion; main agent polls and delivers.
 * DB lives at ~/.abtars/kanban/kanban.db
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../../paths.js";

// better-sqlite3 is external (native module, available at runtime via abmind)
type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void };

export interface KanbanCard {
  id: number;
  title: string;
  source: string;
  source_id: string | null;
  assignee: string;
  priority: string;
  status: string;
  type: string | null;
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

function db(): SqliteDb {
  if (!_db) {
    const dir = join(abtarsHome(), "kanban");
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    let Database: any;
    try {
      Database = require("better-sqlite3");
    } catch {
      // Self-heal: attempt native rebuild (#1185)
      try {
        const { execSync } = require("node:child_process");
        const modPath = require.resolve("better-sqlite3/package.json").replace("/package.json", "");
        execSync("npx --yes node-gyp rebuild", { cwd: modPath, timeout: 60_000, stdio: "pipe" });
        Database = require("better-sqlite3");
      } catch (e) {
        throw new Error(`better-sqlite3 not available and rebuild failed: ${e instanceof Error ? e.message : e}`);
      }
    }
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
  }
  return _db;
}

import { nerve } from "../nerve.js";

export function kanbanEnqueue(title: string, source: string, sourceId?: string, opts?: { priority?: string; type?: string; labels?: string; due_at?: string; parent_id?: number; notes?: string; deliveryMode?: "silent" | "deliver" | "announce"; blocked_by?: string; chatId?: string; sourcePeer?: string }): number {
  const deliveryMode = opts?.deliveryMode ?? "deliver";
  const stmt = db().prepare(
    `INSERT INTO kanban_board (title, source, source_id, priority, type, labels, due_at, parent_id, notes, delivery_mode, blocked_by, chat_id, source_peer)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(title, source, sourceId ?? null, opts?.priority ?? "MEDIUM", opts?.type ?? null, opts?.labels ?? null, opts?.due_at ?? null, opts?.parent_id ?? null, opts?.notes ?? null, deliveryMode, opts?.blocked_by ?? null, opts?.chatId ?? null, opts?.sourcePeer ?? null);
  const id = Number(result.lastInsertRowid);
  nerve.fire("card:queued", id);
  return id;
}

export function kanbanRunning(id: number): void {
  db().prepare(`UPDATE kanban_board SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(id);
  nerve.fire("card:running", id);
}

export function kanbanComplete(id: number, resultPath: string | null, summary: string): void {
  db().prepare(
    `UPDATE kanban_board SET status = 'done', result_path = ?, result_summary = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(resultPath, summary.slice(0, 4000), id);
  nerve.fire("card:done", id);
}

export function kanbanFail(id: number, error: string): void {
  db().prepare(
    `UPDATE kanban_board SET status = 'failed', error = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(error.slice(0, 1000), id);
  nerve.fire("card:failed", id);
}

const MAX_RETRIES = 3;

/** Fail with retry logic — exponential backoff (10s→20s→40s, cap 5min). After MAX_RETRIES → permanent fail. */
export function kanbanRetryOrFail(id: number, error: string): "retrying" | "failed" {
  const card = db().prepare("SELECT retry_count FROM kanban_board WHERE id = ?").get(id) as { retry_count: number } | undefined;
  const retryCount = (card?.retry_count ?? 0) + 1;
  if (retryCount > MAX_RETRIES) {
    kanbanFail(id, `${error} (after ${MAX_RETRIES} retries)`);
    return "failed";
  }
  const backoffMs = Math.min(10_000 * Math.pow(2, retryCount - 1), 300_000);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  db().prepare(
    `UPDATE kanban_board SET status = 'queued', retry_count = ?, next_retry_at = ?, error = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(retryCount, nextRetryAt, error.slice(0, 1000), id);
  nerve.fire("card:queued", id);
  return "retrying";
}

export function kanbanPending(): KanbanCard[] {
  return db().prepare(
    `SELECT * FROM kanban_board WHERE status = 'done' AND delivery_attempts < 3 ORDER BY priority = 'CRITICAL' DESC, priority = 'HIGH' DESC, created_at ASC`
  ).all() as KanbanCard[];
}

export function kanbanSetDelivering(id: number): void {
  db().prepare(`UPDATE kanban_board SET status = 'delivering', updated_at = datetime('now') WHERE id = ?`).run(id);
}

export function kanbanMarkDelivered(id: number): void {
  db().prepare(
    `UPDATE kanban_board SET status = 'delivered', delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(id);
  nerve.fire("card:delivered", id);
}

export function kanbanDeliveryFailed(id: number): void {
  const card = db().prepare(`SELECT delivery_attempts FROM kanban_board WHERE id = ?`).get(id) as { delivery_attempts: number } | undefined;
  const attempts = (card?.delivery_attempts ?? 0) + 1;
  if (attempts >= 3) {
    db().prepare(`UPDATE kanban_board SET status = 'failed', error = 'delivery failed after 3 attempts', delivery_attempts = ?, updated_at = datetime('now') WHERE id = ?`).run(attempts, id);
  } else {
    db().prepare(`UPDATE kanban_board SET status = 'done', delivery_attempts = ?, updated_at = datetime('now') WHERE id = ?`).run(attempts, id);
  }
}

export function kanbanList(filter?: string, filterKey?: string): KanbanCard[] {
  if (filter === "*") {
    return db().prepare(`SELECT * FROM kanban_board ORDER BY created_at DESC LIMIT 50`).all() as KanbanCard[];
  }
  if (filter && filterKey) {
    if (filterKey === "labels") {
      // LIKE match for comma-separated labels
      return db().prepare(`SELECT * FROM kanban_board WHERE labels LIKE ? ORDER BY created_at DESC LIMIT 50`).all(`%${filter}%`) as KanbanCard[];
    }
    const allowed = new Set(["status", "source", "priority", "type"]);
    if (allowed.has(filterKey)) {
      return db().prepare(`SELECT * FROM kanban_board WHERE ${filterKey} = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
    }
  }
  if (filter) {
    // Bare word = status filter
    return db().prepare(`SELECT * FROM kanban_board WHERE status = ? ORDER BY created_at DESC LIMIT 50`).all(filter) as KanbanCard[];
  }
  return db().prepare(`SELECT * FROM kanban_board WHERE status NOT IN ('delivered') ORDER BY status = 'running' DESC, priority = 'CRITICAL' DESC, created_at DESC LIMIT 50`).all() as KanbanCard[];
}

export function kanbanUpdate(id: number, fields: Partial<Pick<KanbanCard, "title" | "status" | "priority" | "type" | "labels" | "due_at" | "notes" | "parent_id" | "approval">>): void {
  const sets: string[] = ["updated_at = datetime('now')"];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) { sets.push(`${k} = ?`); vals.push(v); }
  }
  vals.push(id);
  db().prepare(`UPDATE kanban_board SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function kanbanCleanup(olderThanDays = 7): number {
  const result = db().prepare(
    `DELETE FROM kanban_board WHERE status = 'delivered' AND delivered_at < datetime('now', '-' || ? || ' days')`
  ).run(olderThanDays);
  return result.changes;
}

export function kanbanGetCard(id: number): KanbanCard | undefined {
  return db().prepare(`SELECT * FROM kanban_board WHERE id = ?`).get(id) as KanbanCard | undefined;
}

export function kanbanGetChildren(parentId: number): KanbanCard[] {
  return db().prepare(`SELECT * FROM kanban_board WHERE parent_id = ? ORDER BY id`).all(parentId) as KanbanCard[];
}

export function kanbanAddTokens(id: number, tokens: number): void {
  db().prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, id);
  const card = kanbanGetCard(id);
  if (card?.parent_id) {
    db().prepare(`UPDATE kanban_board SET tokens_used = COALESCE(tokens_used, 0) + ?, updated_at = datetime('now') WHERE id = ?`).run(tokens, card.parent_id);
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
      db().prepare(`UPDATE kanban_board SET progress = ?, updated_at = datetime('now') WHERE id = ?`).run(JSON.stringify(pending), id);
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
