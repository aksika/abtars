/**
 * pi-request-ledger.ts — Durable idempotency ledger for Pi API requests (#1313).
 *
 * Stores request IDs in the Kanban SQLite database to ensure at-most-once
 * semantics for mutating Pi API operations.
 *
 * Schema:
 *   CREATE TABLE IF NOT EXISTS pi_api_requests (
 *     client_id   TEXT NOT NULL,
 *     operation   TEXT NOT NULL,
 *     request_id  TEXT NOT NULL,
 *     request_hash TEXT NOT NULL,
 *     state       TEXT NOT NULL DEFAULT 'pending',
 *     response_json TEXT,
 *     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
 *     updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
 *     PRIMARY KEY (client_id, operation, request_id)
 *   )
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { abtarsHome } from "../paths.js";
import { resolveNativeDep } from "../utils/lazy-require.js";

type Database = import("better-sqlite3").Database;

let _db: Database | null = null;

function db(): Database {
  if (!_db) {
    const Database = resolveNativeDep("better-sqlite3");
    const dir = join(abtarsHome(), "kanban");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "kanban.db");
    _db = new Database(path);
    _db.pragma("journal_mode = WAL");
    ensureSchema(_db);
  }
  return _db;
}

function ensureSchema(d: Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS pi_api_requests (
    client_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK(state IN ('pending','completed','failed','unknown')),
    response_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (client_id, operation, request_id)
  )`);
}

/** Compute a canonical hash from validated JSON (not raw whitespace). */
export function hashCanonicalJson(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(data, Object.keys(data).sort());
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

export type LedgerState = "pending" | "completed" | "failed" | "unknown";

export interface LedgerEntry {
  clientId: string;
  operation: string;
  requestId: string;
  requestHash: string;
  state: LedgerState;
  responseJson?: string;
}

export type ReserveResult =
  | { ok: true; entry: LedgerEntry }
  | { ok: false; code: "duplicate_same" | "duplicate_conflict" | "outcome_unknown"; previous?: LedgerEntry };

/**
 * Reserve an idempotency slot for a mutating Pi operation.
 *
 * - If no prior entry: inserts `pending` and returns `{ ok: true }`.
 * - If same key + hash completed/failed: returns stored response with
 *   `duplicate` flag set on the response.
 * - If same key + different hash: returns 409.
 * - If pending/unknown: never re-execute, return 409.
 */
export function reserveRequest(
  clientId: string,
  operation: string,
  requestId: string,
  requestHash: string,
): ReserveResult {
  const d = db();

  const existing = d.prepare(
    `SELECT client_id AS clientId, operation, request_id AS requestId, request_hash AS requestHash, state, response_json AS responseJson
     FROM pi_api_requests
     WHERE client_id = ? AND operation = ? AND request_id = ?`,
  ).get(clientId, operation, requestId) as LedgerEntry | undefined;

  if (existing) {
    if (existing.requestHash === requestHash) {
      if (existing.state === "completed" || existing.state === "failed") {
        return { ok: true, entry: existing };
      }
      return { ok: false, code: "outcome_unknown", previous: existing };
    }
    return { ok: false, code: "duplicate_conflict", previous: existing };
  }

  d.prepare(
    `INSERT INTO pi_api_requests (client_id, operation, request_id, request_hash, state)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(clientId, operation, requestId, requestHash);

  return {
    ok: true,
    entry: { clientId, operation, requestId, requestHash, state: "pending" },
  };
}

/** Complete a pending request with the result JSON. */
export function completeRequest(
  clientId: string,
  operation: string,
  requestId: string,
  responseJson: string,
): void {
  db().prepare(
    `UPDATE pi_api_requests
     SET state = 'completed', response_json = ?, updated_at = datetime('now')
     WHERE client_id = ? AND operation = ? AND request_id = ? AND state = 'pending'`,
  ).run(responseJson, clientId, operation, requestId);
}

/** Mark a pending request as failed. */
export function failRequest(
  clientId: string,
  operation: string,
  requestId: string,
  responseJson?: string,
): void {
  db().prepare(
    `UPDATE pi_api_requests
     SET state = 'failed', response_json = ?, updated_at = datetime('now')
     WHERE client_id = ? AND operation = ? AND request_id = ? AND state = 'pending'`,
  ).run(responseJson ?? null, clientId, operation, requestId);
}

/** Prune completed/failed entries older than N days. */
export function pruneLedger(olderThanDays: number = 30): number {
  const result = db().prepare(
    `DELETE FROM pi_api_requests
     WHERE state IN ('completed','failed')
       AND datetime(updated_at) < datetime('now', '-' || ? || ' days')`,
  ).run(olderThanDays);
  return result.changes;
}
