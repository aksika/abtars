import { logInfo, logWarn } from "./logger.js";
import { ensurePeerCallbackOutboxSchema, requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";

const TAG = "peer-callback-outbox";
/** One boot drain sends at most this many queued callbacks; the queue itself
 * is bounded by one row per card terminal state (INSERT OR IGNORE). */
const DRAIN_LIMIT = 100;

interface PendingCallbackRow {
  id: string;
  card_id: number;
  peer: string;
  payload_json: string;
  attempts: number;
}

function outboxDb(): TaskDatabase | null {
  try {
    const db = requireTaskDatabase();
    ensurePeerCallbackOutboxSchema(db);
    return db;
  } catch {
    return null;
  }
}

function pendingRows(db: TaskDatabase, cardId?: number): PendingCallbackRow[] {
  const rows = (cardId === undefined
    ? db.prepare(`SELECT id, card_id, peer, payload_json, attempts FROM peer_callback_outbox WHERE sent_at IS NULL ORDER BY created_at ASC LIMIT ?`).all(DRAIN_LIMIT)
    : db.prepare(`SELECT id, card_id, peer, payload_json, attempts FROM peer_callback_outbox WHERE sent_at IS NULL AND card_id = ? ORDER BY created_at ASC`).all(cardId)
  ) as unknown as PendingCallbackRow[];
  return rows;
}

/**
 * #675/#1778: deliver one queued peer result callback. Same wire shape as
 * the historical fire-and-forget send — the durability is new, the protocol
 * is unchanged. A resolved send marks the row; any failure keeps it pending
 * with bounded diagnostics for the next drain. Never throws.
 */
async function sendPending(db: TaskDatabase, row: PendingCallbackRow): Promise<boolean> {
  try {
    const { getPeerTransport } = await import("./peer-transport/index.js");
    const transport = getPeerTransport();
    await transport.send(row.peer, { type: "callback", payload: JSON.parse(row.payload_json) });
    const marked = db.prepare(
      `UPDATE peer_callback_outbox SET sent_at = datetime('now') WHERE id = ? AND sent_at IS NULL`,
    ).run(row.id) as unknown as { changes: number };
    if (marked.changes === 1) logInfo(TAG, `Callback drained to ${row.peer} for card:${row.card_id} (${row.id})`);
    return marked.changes === 1;
  } catch (err) {
    const bounded = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    logWarn(TAG, `Callback to ${row.peer} failed (card:${row.card_id}) — kept pending: ${bounded}`);
    db.prepare(
      `UPDATE peer_callback_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND sent_at IS NULL`,
    ).run(bounded, row.id);
    return false;
  }
}

async function drain(cardId?: number): Promise<number> {
  const db = outboxDb();
  if (!db) return 0;
  let sent = 0;
  for (const row of pendingRows(db, cardId)) {
    try {
      if (await sendPending(db, row)) sent++;
    } catch (err) {
      logWarn(TAG, `Callback drain error (card:${row.card_id}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sent;
}

/**
 * #1778: best-effort immediate delivery right after a card terminal commits.
 * Spin calls this after queueing a callback intent in the settlement
 * transaction — the common case delivers on the same tick, exactly like the
 * old inline send. Anything unsent stays queued for the boot drain.
 */
export function drainPeerCallbackForCard(cardId: number): Promise<number> {
  return drain(cardId);
}

/**
 * #1778: bounded recovery drain for every pending callback. The Reconciler
 * boot recovery awaits this once, so a commit/send crash window converges
 * without a new timer or heartbeat job. Never throws.
 */
export function drainPeerCallbackOutbox(): Promise<number> {
  return drain(undefined);
}
