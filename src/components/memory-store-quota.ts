/**
 * memory-store-quota.ts — #1552: durable, atomic per-user quota for the
 * memory_store tool. Main (A) may store at most `MAIN_MEMORY_STORE_LIMIT`
 * memories per user per rolling 24h window; Dreamy (D) is exempt; every
 * other session type never reaches this service (tool filter + execution
 * guard deny them earlier).
 *
 * State lives in its own runtime SQLite database under
 * `~/.abtars/state/memory-store-quota.db`. It never touches abmind's memory
 * database. Pending reservations consume capacity until they are committed,
 * released, or expire after 24h — a crash between reservation and outcome
 * recording fails closed instead of letting a restart bypass the quota.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { abtarsHome } from "../paths.js";
import { logWarn } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";
import { resolveNativeDep } from "../utils/lazy-require.js";

const TAG = "memory-store-quota";

export const MAIN_MEMORY_STORE_LIMIT = 20;
export const MEMORY_STORE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface MemoryStoreQuotaOptions {
  dbPath?: string;
  now?: () => number;
  limit?: number;
  windowMs?: number;
}

export type QuotaReservation = {
  kind: "reserved";
  id: string;
  userId: string;
  reservedAt: number;
};

export type QuotaReserveResult =
  | QuotaReservation
  | { kind: "limited"; used: number; limit: number; retryAfter: number }
  | { kind: "unavailable"; reason: string };

/** #1552: late-bound memory-tool dependencies shared by every Pi transport. */
export interface MemoryToolDependencies {
  runtime: import("./memory-runtime.js").AbtarsMemoryRuntime;
  quota: MemoryStoreQuota;
}

export interface MemoryToolDependenciesHolder {
  current: MemoryToolDependencies | null;
}

export function defaultQuotaDbPath(): string {
  return join(abtarsHome(), "state", "memory-store-quota.db");
}

type QuotaDb = import("better-sqlite3").Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_store_quota_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  reserved_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','committed'))
);
CREATE INDEX IF NOT EXISTS idx_memory_store_quota_user_time
  ON memory_store_quota_reservations(user_id, reserved_at_ms);
`;

export class MemoryStoreQuota {
  private db: QuotaDb | null = null;
  private readonly now: () => number;
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly dbPath: string;

  constructor(opts: MemoryStoreQuotaOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.limit = opts.limit ?? MAIN_MEMORY_STORE_LIMIT;
    this.windowMs = opts.windowMs ?? MEMORY_STORE_WINDOW_MS;
    this.dbPath = opts.dbPath ?? defaultQuotaDbPath();
    try {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      const Database = resolveNativeDep("better-sqlite3") as new (path: string) => QuotaDb;
      const db = new Database(this.dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("busy_timeout = 5000");
      db.exec(SCHEMA);
      this.db = db;
    } catch (err) {
      // #1552 R3: an unopenable quota database must never run unmetered.
      const msg = err instanceof Error ? err.message : String(err);
      logWarn(TAG, `Quota database unavailable at ${this.dbPath} — Main memory stores will fail closed (${msg.slice(0, 200)})`);
      this.db = null;
    }
  }

  /**
   * #1552 R3: prune expired rows, count the user's live rows, and insert a
   * pending reservation only when below the limit — all in one immediate
   * transaction so concurrent calls at count 19 cannot both become the 20th.
   */
  reserve(userId: string): QuotaReserveResult {
    const db = this.db;
    if (!db) return { kind: "unavailable", reason: "quota database unavailable" };
    const now = this.now();
    const cutoff = now - this.windowMs;
    const id = randomUUID();
    try {
      const run = db.transaction((): { limited: boolean; used: number; oldest: number | null } => {
        db.prepare("DELETE FROM memory_store_quota_reservations WHERE reserved_at_ms <= ?").run(cutoff);
        const row = db.prepare(
          "SELECT COUNT(*) AS used, MIN(reserved_at_ms) AS oldest FROM memory_store_quota_reservations WHERE user_id = ? AND reserved_at_ms > ?",
        ).get(userId, cutoff) as { used: number; oldest: number | null };
        if (row.used >= this.limit) {
          return { limited: true, used: row.used, oldest: row.oldest };
        }
        db.prepare(
          "INSERT INTO memory_store_quota_reservations (id, user_id, reserved_at_ms, state) VALUES (?, ?, ?, 'pending')",
        ).run(id, userId, now);
        return { limited: false, used: row.used, oldest: row.oldest };
      });
      const result = (run as unknown as { immediate: () => { limited: boolean; used: number; oldest: number | null } }).immediate();
      if (result.limited) {
        return {
          kind: "limited",
          used: result.used,
          limit: this.limit,
          retryAfter: (result.oldest ?? now) + this.windowMs,
        };
      }
      return { kind: "reserved", id, userId, reservedAt: now };
    } catch (err) {
      logAndSwallow(TAG, "reserve", err);
      return { kind: "unavailable", reason: "quota reservation failed" };
    }
  }

  /** Mark a pending reservation committed after a successful store. */
  commit(reservationId: string): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      const result = db.prepare(
        "UPDATE memory_store_quota_reservations SET state = 'committed' WHERE id = ? AND state = 'pending'",
      ).run(reservationId);
      if (result.changes !== 1) logWarn(TAG, `commit: reservation ${reservationId.slice(0, 8)}… missing or not pending — invariant fault`);
      return result.changes === 1;
    } catch (err) {
      logAndSwallow(TAG, "commit", err);
      return false;
    }
  }

  /** Delete a pending reservation after a definitively unsuccessful store. */
  release(reservationId: string): boolean {
    const db = this.db;
    if (!db) return false;
    try {
      const result = db.prepare(
        "DELETE FROM memory_store_quota_reservations WHERE id = ? AND state = 'pending'",
      ).run(reservationId);
      if (result.changes !== 1) logWarn(TAG, `release: reservation ${reservationId.slice(0, 8)}… missing or not pending — invariant fault`);
      return result.changes === 1;
    } catch (err) {
      logAndSwallow(TAG, "release", err);
      return false;
    }
  }

  /** #1552: idempotent close; the next boot opens the same durable DB. */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch (err) {
      logAndSwallow(TAG, "close", err);
    }
    this.db = null;
  }
}
