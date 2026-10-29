/**
 * reconcile-quarantine-store.ts — durable failure/quarantine state for the
 * reconciler error boundary (#1664).
 *
 * A card that fails its reconcile pass with the same error signature on
 * QUARANTINE_THRESHOLD consecutive passes is quarantined: wakeCard() stops
 * waking it and boot recovery skips it. The counter is durable so a bridge
 * restart cannot silently re-arm a quarantined card into a crash loop.
 */

import { requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";
import { redactSecrets } from "./logger.js";

export interface ReconcileFailureRow {
  cardId: number;
  failureCount: number;
  errorSignature: string;
  lastErrorAt: string;
  quarantinedAt: string | null;
}

export const QUARANTINE_THRESHOLD = 3;

const MAX_ERROR_MESSAGE_LENGTH = 180;
const MAX_ERROR_SIGNATURE_LENGTH = MAX_ERROR_MESSAGE_LENGTH + "Error:".length;

/** Keep every value that reaches an operator-visible signature safe and bounded. */
function normalizeSignatureText(value: string, maxLength: number): string {
  return redactSecrets(value)
    .replace(/[0-9]+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

/**
 * Stable, readable, redacted error identity. Digits are stripped so
 * per-project ids and timestamps do not make every occurrence look like a new
 * failure mode; secrets are redacted before storage so no raw exception text
 * can reach an operator surface.
 */
export function reconcileErrorSignature(err: unknown): string {
  const name = normalizeSignatureText(err instanceof Error ? err.name : typeof err, 64);
  const message = normalizeSignatureText(
    err instanceof Error ? err.message : String(err),
    MAX_ERROR_MESSAGE_LENGTH,
  );
  return `${name}:${message}`.slice(0, MAX_ERROR_SIGNATURE_LENGTH);
}

export class ReconcileQuarantineStore {
  private db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  /** CREATE TABLE only — no ALTER, no CHECK change (#1561 substrate). */
  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconcile_quarantine (
        card_id INTEGER PRIMARY KEY,
        failure_count INTEGER NOT NULL DEFAULT 0,
        error_signature TEXT NOT NULL,
        last_error_at TEXT NOT NULL,
        quarantined_at TEXT
      );
    `);
  }

  /**
   * Records one failed pass. The same signature increments the count; a
   * different signature restarts it at 1 so a transient fault cannot
   * accumulate toward quarantine alongside an unrelated one. Sets
   * `quarantined_at` itself when the count reaches QUARANTINE_THRESHOLD, so
   * the threshold decision lives in one testable place. Returns the row after
   * the write.
   */
  recordFailure(cardId: number, signature: string, now: string): ReconcileFailureRow {
    const safeSignature = normalizeSignatureText(signature, MAX_ERROR_SIGNATURE_LENGTH);
    const existing = this.db.prepare(
      `SELECT failure_count, error_signature FROM reconcile_quarantine WHERE card_id = ?`,
    ).get(cardId) as { failure_count: number; error_signature: string } | undefined;
    const failureCount = existing && existing.error_signature === safeSignature ? existing.failure_count + 1 : 1;
    const quarantinedAt = failureCount >= QUARANTINE_THRESHOLD ? now : null;
    this.db.prepare(`
      INSERT INTO reconcile_quarantine (card_id, failure_count, error_signature, last_error_at, quarantined_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(card_id) DO UPDATE SET
        failure_count = excluded.failure_count,
        error_signature = excluded.error_signature,
        last_error_at = excluded.last_error_at,
        quarantined_at = excluded.quarantined_at
    `).run(cardId, failureCount, safeSignature, now, quarantinedAt);
    return { cardId, failureCount, errorSignature: safeSignature, lastErrorAt: now, quarantinedAt };
  }

  /** Clears the row for a card after a successful pass. Idempotent. */
  clearFailures(cardId: number): void {
    this.db.prepare(`DELETE FROM reconcile_quarantine WHERE card_id = ?`).run(cardId);
  }

  isQuarantined(cardId: number): boolean {
    const row = this.db.prepare(
      `SELECT quarantined_at FROM reconcile_quarantine WHERE card_id = ?`,
    ).get(cardId) as { quarantined_at: string | null } | undefined;
    return row?.quarantined_at != null;
  }

  listQuarantined(): ReconcileFailureRow[] {
    const rows = this.db.prepare(
      `SELECT card_id, failure_count, error_signature, last_error_at, quarantined_at
       FROM reconcile_quarantine WHERE quarantined_at IS NOT NULL ORDER BY card_id`,
    ).all() as Record<string, unknown>[];
    return rows.map(r => ({
      cardId: r["card_id"] as number,
      failureCount: r["failure_count"] as number,
      errorSignature: r["error_signature"] as string,
      lastErrorAt: r["last_error_at"] as string,
      quarantinedAt: r["quarantined_at"] as string | null,
    }));
  }

  /** Operator clear. Returns false when the card was not quarantined. */
  releaseQuarantine(cardId: number): boolean {
    const result = this.db.prepare(
      `DELETE FROM reconcile_quarantine WHERE card_id = ? AND quarantined_at IS NOT NULL`,
    ).run(cardId);
    return result.changes === 1;
  }
}
