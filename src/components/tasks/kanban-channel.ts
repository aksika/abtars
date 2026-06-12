/**
 * kanban-channel.ts — Agent Communication Platform (#891 Phase 1).
 * Card-scoped messaging for workers, Orc, and master.
 * Same DB as kanban-board (kanban.db).
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { nerve } from "../nerve.js";
import { logInfo } from "../logger.js";

type SqliteDb = { prepare(sql: string): any; exec(sql: string): void; pragma(s: string): void };

let _db: SqliteDb | null = null;

function db(): SqliteDb {
  if (!_db) {
    const dir = join(abtarsHome(), "kanban");
    mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    _db = new Database(join(dir, "kanban.db")) as SqliteDb;
    _db.pragma("journal_mode = WAL");
    _db.exec(`CREATE TABLE IF NOT EXISTS agent_channel (
      id INTEGER PRIMARY KEY,
      card_id INTEGER NOT NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT DEFAULT 'ALL',
      message TEXT NOT NULL,
      directive INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_by TEXT DEFAULT ''
    )`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_ac_card ON agent_channel(card_id, created_at)`);
    _db.exec(`CREATE INDEX IF NOT EXISTS idx_ac_to ON agent_channel(card_id, to_agent)`);
  }
  return _db;
}

export interface ChannelMessage {
  id: number;
  card_id: number;
  from_agent: string;
  to_agent: string;
  message: string;
  directive: number;
  created_at: string;
}

const MAX_MESSAGE_LEN = 1000;

export function channelPost(cardId: number, from: string, to: string, message: string, directive = false): number {
  if (message.length > MAX_MESSAGE_LEN) message = message.slice(0, MAX_MESSAGE_LEN) + "…";
  const stmt = db().prepare("INSERT INTO agent_channel (card_id, from_agent, to_agent, message, directive) VALUES (?, ?, ?, ?, ?)");
  const result = stmt.run(cardId, from, to || "ALL", message, directive ? 1 : 0);
  nerve.fire("channel:message", cardId, { from, to: to || "ALL", message });
  logInfo("channel", `[${from}→${to || "ALL"}] card:${cardId} (${message.length} chars${directive ? ", directive" : ""})`);
  return result.lastInsertRowid as number;
}

export function channelRead(cardId: number, opts?: { since?: string; from?: string }): ChannelMessage[] {
  let sql = "SELECT id, card_id, from_agent, to_agent, message, directive, created_at FROM agent_channel WHERE card_id = ?";
  const params: any[] = [cardId];
  if (opts?.since) { sql += " AND created_at > ?"; params.push(opts.since); }
  if (opts?.from) { sql += " AND from_agent = ?"; params.push(opts.from); }
  sql += " ORDER BY created_at ASC";
  return db().prepare(sql).all(...params) as ChannelMessage[];
}

/** Get unread messages for an agent (for auto-inject). Marks as seen. */
export function channelUnread(cardId: number, agentName: string): ChannelMessage[] {
  const sql = `SELECT id, card_id, from_agent, to_agent, message, directive, created_at 
    FROM agent_channel 
    WHERE card_id = ? AND to_agent IN ('ALL', ?) AND last_seen_by NOT LIKE ?
    ORDER BY directive DESC, created_at DESC LIMIT 10`;
  const rows = db().prepare(sql).all(cardId, agentName, `%${agentName}%`) as ChannelMessage[];

  // Mark as seen
  if (rows.length > 0) {
    const markStmt = db().prepare("UPDATE agent_channel SET last_seen_by = last_seen_by || ? WHERE id = ?");
    for (const row of rows) markStmt.run(`${agentName},`, row.id);
  }
  return rows;
}

/** GC: delete messages for completed/archived cards. */
export function channelGc(completedCardIds: number[]): number {
  if (completedCardIds.length === 0) return 0;
  const placeholders = completedCardIds.map(() => "?").join(",");
  const result = db().prepare(`DELETE FROM agent_channel WHERE card_id IN (${placeholders})`).run(...completedCardIds);
  return result.changes as number;
}

/** GC: age + row cap enforcement. Only targets non-active cards. */
export function channelRetentionGc(activeCardIds: number[]): number {
  const activeSet = activeCardIds.length ? activeCardIds.map(() => "?").join(",") : "0";
  // Age: 3 days, skip active
  const aged = db().prepare(`DELETE FROM agent_channel WHERE created_at < datetime('now', '-3 days') AND card_id NOT IN (${activeSet})`).run(...activeCardIds);
  // Row cap: keep under 1000
  const count = (db().prepare("SELECT count(*) as c FROM agent_channel").get() as any).c;
  let capped = 0;
  if (count > 1000) {
    const excess = count - 800;
    capped = (db().prepare(`DELETE FROM agent_channel WHERE id IN (SELECT id FROM agent_channel WHERE card_id NOT IN (${activeSet}) ORDER BY created_at ASC LIMIT ?)`).run(...activeCardIds, excess)).changes as number;
  }
  return (aged.changes as number) + capped;
}
