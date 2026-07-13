/**
 * peer-nonce-store.ts — Durable SQLite-backed peer request nonce store (#1390).
 *
 * Replaces the in-memory nonce cache in peer-auth.ts with a restart-proof
 * store using the canonical kanban DB. Maintains the same 60s TTL window
 * and uses idempotent CREATE TABLE IF NOT EXISTS.
 */

import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";

const TABLE = "peer_request_nonces";
const NONCE_TTL_MS = 60_000;

export class PeerNonceStore {
  private db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        nonce TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    );
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_nonces_expires ON ${TABLE}(expires_at)`);
    } catch { /* best effort */ }
  }

  /** True if the nonce was already seen (replay). Prunes expired entries first. */
  isSeen(nonce: string): boolean {
    this.prune();
    const row = this.db.prepare(`SELECT 1 FROM ${TABLE} WHERE nonce = ?`).get(nonce);
    return row !== undefined;
  }

  /** Record a nonce with its expiry. Silent no-op if already present. */
  record(nonce: string): void {
    const now = Date.now();
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO ${TABLE} (nonce, seen_at, expires_at) VALUES (?, ?, ?)`
      ).run(nonce, now, now + NONCE_TTL_MS);
    } catch { /* best effort — nonce already recorded */ }
  }

  /** Remove expired entries. Called before every isSeen check and periodically. */
  prune(): void {
    try {
      this.db.prepare(`DELETE FROM ${TABLE} WHERE expires_at < ?`).run(Date.now());
    } catch { /* best effort */ }
  }
}
