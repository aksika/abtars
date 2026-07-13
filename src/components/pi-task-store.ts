/**
 * pi-task-store.ts — Durable Pi task ownership and atomic creation (#1407).
 *
 * pi_task_ownership table links Kanban cards to Pi client+request identities.
 * Authorization is by exact SQL equality, never prefix/suffix matching.
 */

import type { TaskDatabase } from "./tasks/kanban-board.js";
import { completeRequest, failRequest } from "./pi-request-ledger.js";
import { logInfo } from "./logger.js";

const TAG = "pi-task-store";

// ── Schema ─────────────────────────────────────────────────────────────────────

export const PI_TASK_OWNERSHIP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pi_task_ownership (
    card_id INTEGER PRIMARY KEY REFERENCES kanban_board(id),
    client_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(client_id, request_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pi_task_owner_client
    ON pi_task_ownership(client_id, card_id);
`;

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CreateOwnedPiTaskInput {
  clientId: string;
  requestId: string;
  requestHash: string;
  title: string;
  goal: string;
  priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  deliveryMode: "silent" | "deliver" | "announce";
}

export type CreateOwnedPiTaskResult =
  | { created: true; cardId: number; responseJson: string }
  | { created: false; reason: "ledger_not_pending" | "ledger_mismatch" };

export interface OwnedPiTaskView {
  id: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
  resultSummary: string | null;
  error: string | null;
}

export interface PiTaskBackfillSummary {
  restored: number;
  skipped: number;
  errors: number;
}

// ── Store ──────────────────────────────────────────────────────────────────────

let _instance: PiTaskStore | null = null;
let _taskDbCache: TaskDatabase | null = null;

async function getTaskDb(): Promise<TaskDatabase> {
  if (!_taskDbCache) {
    const { requireTaskDatabase } = await import("./tasks/kanban-board.js");
    _taskDbCache = requireTaskDatabase();
  }
  return _taskDbCache;
}

export async function getPiTaskStore(): Promise<PiTaskStore> {
  if (!_instance) {
    const db = await getTaskDb();
    db.exec(PI_TASK_OWNERSHIP_SCHEMA);
    _instance = new PiTaskStore(db);
    const summary = _instance.backfillProvenLegacyOwnership();
    if (summary.restored > 0 || summary.skipped > 0) {
      logInfo(TAG, `Legacy Pi task ownership backfill: restored=${summary.restored} skipped=${summary.skipped} errors=${summary.errors}`);
    }
  }
  return _instance;
}

export function resetPiTaskStoreForTests(): void {
  _instance = null;
  _taskDbCache = null;
}

export class PiTaskStore {
  private readonly db: TaskDatabase;

  constructor(db: TaskDatabase) {
    this.db = db;
    this.db.exec(PI_TASK_OWNERSHIP_SCHEMA);
  }

  /**
   * #1407 — Atomically create a Pi task card and insert ownership in one
   * transaction. Card + ownership are committed together. The ledger
   * completion is a separate idempotent call after commit — if the process
   * crashes between, the pending ledger entry on retry returns outcome_unknown
   * and prevents duplicate execution.
   */
  createAndComplete(input: CreateOwnedPiTaskInput): CreateOwnedPiTaskResult {
    let cardId: number;
    try {
      const result = this.db.transaction<number>(() => {
        // 1. Insert kanban card
        const cardResult = this.db.prepare(
          `INSERT INTO kanban_board (title, source, source_id, priority, type, notes, delivery_mode, status)
           VALUES (?, 'pi', ?, ?, 'task', ?, ?, 'queued')`,
        ).run(input.title, input.requestId, input.priority, input.goal, input.deliveryMode);
        const id = Number(cardResult.lastInsertRowid);
        if (!id || id < 1) throw new Error("Failed to allocate Pi task card ID");

        // 2. Insert ownership row (same transaction)
        this.db.prepare(
          `INSERT INTO pi_task_ownership (card_id, client_id, request_id) VALUES (?, ?, ?)`,
        ).run(id, input.clientId, input.requestId);

        return id;
      });
      cardId = result;
    } catch (err) {
      return { created: false, reason: "ledger_not_pending" };
    }

    // 3. Complete the ledger entry (separate connection, idempotent)
    const responseJson = JSON.stringify({ ok: true, task_id: cardId, status: "queued" });
    try {
      completeRequest(input.clientId, "task:create", input.requestId, responseJson);
    } catch {
      // Ledger update failed — card+ownership exist but ledger stayed pending.
      // The ownership row is the authorization boundary; the caller must ensure
      // request_id uniqueness to prevent duplicates.
      try { failRequest(input.clientId, "task:create", input.requestId, responseJson); } catch { /* best effort */ }
    }

    return { created: true, cardId, responseJson };
  }

  /**
   * #1407 — Look up a task by card ID with exact client ownership.
   * Returns null if the card does not exist, is not a Pi card, or is
   * owned by a different client.
   */
  getOwned(cardId: number, clientId: string): OwnedPiTaskView | null {
    const row = this.db.prepare(`
      SELECT k.id, k.status, k.created_at AS createdAt,
             k.completed_at AS completedAt, k.result_summary AS resultSummary,
             k.error
      FROM kanban_board k
      JOIN pi_task_ownership o ON o.card_id = k.id
      WHERE k.id = ?
        AND o.client_id = ?
        AND k.source = 'pi'
    `).get(cardId, clientId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      status: row.status as string,
      createdAt: row.createdAt as string,
      completedAt: (row.completedAt as string | null) ?? null,
      resultSummary: (row.resultSummary as string | null) ?? null,
      error: (row.error as string | null) ?? null,
    };
  }

  /**
   * #1407 — Backfill ownership for legacy Pi-created cards from completed
   * task:create ledger rows. Idempotent and bounded.
   */
  backfillProvenLegacyOwnership(): PiTaskBackfillSummary {
    let restored = 0;
    let skipped = 0;
    let errors = 0;

    // Query from the ledger table (same DB connection, different table)
    const rows = this.db.prepare(`
      SELECT client_id AS clientId, request_id AS requestId, response_json AS responseJson
      FROM pi_api_requests
      WHERE operation = 'task:create' AND state = 'completed'
        AND response_json IS NOT NULL
      ORDER BY rowid ASC
    `).all() as Array<{ clientId: string; requestId: string; responseJson: string }>;

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.responseJson) as Record<string, unknown>;
        if (parsed.ok !== true) { skipped++; continue; }
        const taskId = Number(parsed.task_id);
        if (!Number.isInteger(taskId) || taskId < 1) { skipped++; continue; }

        // atomically insert only if the card exists with matching provenance
        const insertResult = this.db.prepare(`
          INSERT OR IGNORE INTO pi_task_ownership (card_id, client_id, request_id)
          SELECT ?, ?, ?
          FROM kanban_board
          WHERE id = ? AND source = 'pi' AND source_id = ?
        `).run(taskId, row.clientId, row.requestId, taskId, row.requestId);

        if (insertResult.changes > 0) {
          restored++;
        } else {
          // Check if the row exists with exact same values (OR IGNORE benign duplicate)
          const existing = this.db.prepare(
            `SELECT client_id, request_id FROM pi_task_ownership WHERE card_id = ?`
          ).get(taskId) as Record<string, unknown> | undefined;
          if (existing && existing.client_id === row.clientId && existing.request_id === row.requestId) {
            restored++;
          } else {
            skipped++;
          }
        }
      } catch {
        errors++;
      }
    }

    return { restored, skipped, errors };
  }
}
