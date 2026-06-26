/**
 * kanban-channel.ts — Agent Communication Platform (#891 Phase 1).
 * Card-scoped messaging for workers, Orc, and master.
 * Same DB as kanban-board (kanban.db).
 */

import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../../paths.js";
import { nerve } from "../nerve.js";
import { logInfo, logWarn } from "../logger.js";

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
    // #949: remote sync columns
    try { _db.exec(`ALTER TABLE agent_channel ADD COLUMN remote_peer TEXT DEFAULT NULL`); } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE agent_channel ADD COLUMN synced INTEGER DEFAULT 1`); } catch { /* already exists */ }
    try { _db.exec(`ALTER TABLE agent_channel ADD COLUMN msg_type TEXT DEFAULT 'progress'`); } catch { /* already exists */ }
    // #949: dedup index only enforced via INSERT OR IGNORE in channelPostFromRemote
    try { _db.exec(`CREATE INDEX IF NOT EXISTS idx_ac_dedup ON agent_channel(card_id, from_agent, created_at)`); } catch { /* already exists */ }
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
  remote_peer: string | null;
  msg_type: string;
}

const MAX_MESSAGE_LEN = 1000;

export function channelPost(cardId: number, from: string, to: string, message: string, directive = false, msgType = "progress"): number {
  if (message.length > MAX_MESSAGE_LEN) message = message.slice(0, MAX_MESSAGE_LEN) + "…";
  const stmt = db().prepare("INSERT INTO agent_channel (card_id, from_agent, to_agent, message, directive, msg_type) VALUES (?, ?, ?, ?, ?, ?)");
  const result = stmt.run(cardId, from, to || "ALL", message, directive ? 1 : 0, msgType);
  nerve.fire("channel:message", cardId, { from, to: to || "ALL", message });
  logInfo("channel", `[${from}→${to || "ALL"}] card:${cardId} (${message.length} chars${directive ? ", directive" : ""})`);
  return result.lastInsertRowid as number;
}

export function channelRead(cardId: number, opts?: { since?: string; from?: string }): ChannelMessage[] {
  let sql = "SELECT id, card_id, from_agent, to_agent, message, directive, created_at, remote_peer, msg_type FROM agent_channel WHERE card_id = ?";
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

/** #949: Insert a message pushed from a remote peer. Dedup via existence check. */
export function channelPostFromRemote(cardId: number, from: string, message: string, createdAt: string, peer: string): boolean {
  if (message.length > MAX_MESSAGE_LEN) message = message.slice(0, MAX_MESSAGE_LEN) + "…";
  try {
    const exists = db().prepare("SELECT 1 FROM agent_channel WHERE card_id = ? AND from_agent = ? AND created_at = ?").get(cardId, from, createdAt);
    if (exists) return true; // already have it
    db().prepare("INSERT INTO agent_channel (card_id, from_agent, to_agent, message, created_at, remote_peer, synced) VALUES (?, ?, 'ALL', ?, ?, ?, 1)")
      .run(cardId, from, message, createdAt, peer);
    nerve.fire("channel:message", cardId, { from, to: "ALL", message });
    return true;
  } catch { return false; }
}

/** #949: Get messages since a given timestamp (for pull catch-up). */
export function channelGetSince(cardId: number, since: string): ChannelMessage[] {
  return db().prepare("SELECT id, card_id, from_agent, to_agent, message, directive, created_at FROM agent_channel WHERE card_id = ? AND created_at > ? ORDER BY created_at ASC")
    .all(cardId, since) as ChannelMessage[];
}

/** #949: Push channel messages to remote Orc when card has source_peer. */
export function initChannelSync(): void {
  nerve.on("channel:message", (cardId: number, meta?: { from: string; to: string; message: string }) => {
    if (!meta) return;
    // Lazy import to avoid circular deps
    const { kanbanGetCard } = require("./kanban-board.js") as typeof import("./kanban-board.js");
    const card = kanbanGetCard(cardId);
    if (!card?.source_peer) return;
    // Don't push messages that came from remote (avoid echo loop)
    const lastRow = db().prepare("SELECT remote_peer FROM agent_channel WHERE card_id = ? ORDER BY id DESC LIMIT 1").get(cardId) as { remote_peer: string | null } | undefined;
    if (lastRow?.remote_peer) return;
    // Push to source peer
    pushToRemote(card.source_peer, cardId, meta.from, meta.message).catch(err =>
      logWarn("channel-sync", `Push to ${card.source_peer} failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  });
}

async function pushToRemote(peer: string, cardId: number, from: string, message: string): Promise<void> {
  const { getPeerTransport } = await import("../peer-transport/index.js");
  const transport = getPeerTransport();
  const createdAt = new Date().toISOString().replace("T", " ").slice(0, 19);
  await transport.pushChannelMessage(peer, cardId, from, message, createdAt);
  db().prepare("UPDATE agent_channel SET synced = 1 WHERE card_id = ? AND synced = 0").run(cardId);
}
