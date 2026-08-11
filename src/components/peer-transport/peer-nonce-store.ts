/**
 * peer-nonce-store.ts — Durable SQLite-backed peer request nonce store (#1390).
 *
 * Two tables:
 *   peer_request_nonces      — HTTP request domain (legacy, global nonce)
 *   peer_ws_request_nonces   — WSS request v1 domain (peer-scoped atomic claim)
 *
 * The WSS table uses a composite primary key (peer_id, nonce) so the insert
 * itself is the atomic arbitration — exactly one concurrent claimant succeeds.
 */

import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";

const HTTP_TABLE = "peer_request_nonces";
const WSS_TABLE = "peer_ws_request_nonces";
const NONCE_TTL_MS = 60_000;

export class PeerNonceStore {
  private db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${HTTP_TABLE} (
        nonce TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${WSS_TABLE} (
        peer_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, nonce)
      )`
    );
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_peer_nonces_expires ON ${HTTP_TABLE}(expires_at)`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ws_nonces_expires ON ${WSS_TABLE}(expires_at)`);
    } catch { /* best effort */ }
  }

  /** True if the nonce was already seen (replay). Prunes expired entries first. */
  isSeen(nonce: string): boolean {
    this.prune();
    const row = this.db.prepare(`SELECT 1 FROM ${HTTP_TABLE} WHERE nonce = ?`).get(nonce);
    return row !== undefined;
  }

  /** Record a nonce with its expiry. Silent no-op if already present. */
  record(nonce: string): void {
    const now = Date.now();
    try {
      this.db.prepare(
        `INSERT OR IGNORE INTO ${HTTP_TABLE} (nonce, seen_at, expires_at) VALUES (?, ?, ?)`
      ).run(nonce, now, now + NONCE_TTL_MS);
    } catch { /* best effort — nonce already recorded */ }
  }

  /**
   * Atomically claim (peer_id, nonce) in the WSS table.
   * Called only AFTER signature verification — nonce store failures never
   * permit dispatch.
   *
   * Returns:
   *   { ok: true }                         — first claim, entry inserted
   *   { ok: false, reason: "replay" }      — duplicate (peer_id, nonce)
   *   { ok: false, reason: "store_error" } — database error
   */
  claim(peerId: string, nonce: string, nowMs?: number): { ok: true } | { ok: false; reason: "replay" | "store_error" } {
    try {
      this.db.prepare(`DELETE FROM ${WSS_TABLE} WHERE expires_at < ?`).run(Date.now());
    } catch {
      return { ok: false, reason: "store_error" };
    }

    const now = nowMs ?? Date.now();
    try {
      this.db.prepare(
        `INSERT INTO ${WSS_TABLE} (peer_id, nonce, seen_at, expires_at) VALUES (?, ?, ?, ?)`
      ).run(peerId, nonce, now, now + NONCE_TTL_MS);
      return { ok: true };
    } catch (err: any) {
      if (err?.code === "SQLITE_CONSTRAINT" || err?.message?.includes("UNIQUE")) {
        return { ok: false, reason: "replay" };
      }
      return { ok: false, reason: "store_error" };
    }
  }

  /** Remove expired entries from both tables. */
  prune(): void {
    try { this.db.prepare(`DELETE FROM ${HTTP_TABLE} WHERE expires_at < ?`).run(Date.now()); } catch { /* best effort */ }
    try { this.db.prepare(`DELETE FROM ${WSS_TABLE} WHERE expires_at < ?`).run(Date.now()); } catch { /* best effort */ }
  }
}
