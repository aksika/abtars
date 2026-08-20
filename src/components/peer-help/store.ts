import type { HelpDecision, PeerHelpResponseV1, PeerHelpStatusV1 } from "./contract.js";
import { generateContributionRef } from "./contract.js";
import type { TaskDatabase } from "../tasks/kanban-board.js";

/**
 * #1680: durable receiver terminal identity. Resolved from the accepted help
 * ledger, never from mutable card notes. Card notes remain operator/execution
 * metadata and must never authorize protocol identity.
 */
export interface PeerTerminalIdentity {
  requesterPeer: string;
  requestId: string;
  contributionRef: string;
}

/**
 * #1680: exact accepted-help lookup keyed by the receiver's local card id.
 * Returns a value only when exactly one accepted row exists whose contribution
 * reference is non-empty and whose origin peer matches the card's durable
 * source peer. Zero rows, multiple rows, blank fields, or a mismatched origin
 * peer are invalid for a peer root and yield `undefined`.
 *
 * Database-only and read-only: constructs no store, migrates nothing, and is
 * safe to call inside the caller's transaction.
 */
export function readPeerTerminalIdentity(
  db: TaskDatabase,
  localCardId: number,
): PeerTerminalIdentity | undefined {
  const rows = db.prepare(`
    SELECT p.origin_peer, p.request_id, p.contribution_ref, b.source_peer
      FROM peer_help_requests p
      JOIN kanban_board b ON b.id = p.local_card_id
     WHERE p.local_card_id = ?
       AND p.state = 'accepted'
       AND p.contribution_ref IS NOT NULL AND p.contribution_ref != ''
  `).all(localCardId) as Array<{
    origin_peer: string | null;
    request_id: string | null;
    contribution_ref: string;
    source_peer: string | null;
  }>;
  if (rows.length !== 1) return undefined;
  const row = rows[0]!;
  if (!row.origin_peer || !row.request_id || !row.contribution_ref) return undefined;
  if (row.origin_peer !== row.source_peer) return undefined;
  return {
    requesterPeer: row.origin_peer,
    requestId: row.request_id,
    contributionRef: row.contribution_ref,
  };
}

/** #1680: SQLite UTC text (`datetime('now')`) → ISO-8601 at the public boundary. */
function sqliteUtcToIso(value: string): string {
  const candidate = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const time = Date.parse(candidate);
  if (!Number.isFinite(time)) throw new Error("invalid persisted help timestamp");
  return new Date(time).toISOString();
}

export type HelpRowState = "pending" | "accepted" | "declined" | "deferred" | "unknown";

interface PeerHelpRow {
  origin_peer: string;
  request_id: string;
  request_hash: string;
  state: HelpRowState;
  contribution_ref: string | null;
  local_card_id: number | null;
  local_run_id: string | null;
  response_json: string | null;
  withdrawn_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReserveHelpResult {
  status: "new" | "replay" | "conflict" | "in_flight";
  response?: PeerHelpResponseV1;
  contribution_ref?: string;
}

export interface AcceptedHelp {
  contribution_ref: string;
  local_card_id: number;
}

export interface WithdrawalResult {
  status: "noted" | "already_terminal" | "unknown_contribution" | "rejected";
}

interface CardInput {
  goal: string;
  title: string;
  sourcePeer: string;
  sourceId: string;
  deliveryMode: string;
  priority?: string;
}

interface KanbanBoard {
  kanbanEnqueue(title: string, source: string, sourceId: string, opts: Record<string, unknown>): number | undefined;
  kanbanGetCard(id: number): { id: number; status: string; result_summary?: string | null; error?: string | null } | undefined;
  kanbanUpdate(id: number, updates: Record<string, unknown>): void;
  kanbanList(status: string, field?: string): Array<{ id: number; type?: string | null; status: string; notes?: string | null; result_summary?: string | null; error?: string | null }>;
  kanbanComplete(id: number, result: string | null, summary: string): void;
  kanbanFail(id: number, error: string): void;
}

interface NerveEmitter {
  fire(event: "card:queued" | "card:running" | "card:done" | "card:failed" | "card:delivered", cardId: number): void;
}

/** #1618: database-only receiver project admission. No Nerve/Spin/network/timer side effects. */
interface ReceiverProjectAdmission {
  ensureAwaitingContract(projectCardId: number): boolean;
}

interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
}

export class PeerHelpStore {
  private db: Db;
  private kanban: KanbanBoard;
  private nerve: NerveEmitter;
  private admission?: ReceiverProjectAdmission;

  constructor(db: Db, kanban: KanbanBoard, nerve: NerveEmitter, admission?: ReceiverProjectAdmission) {
    this.db = db;
    this.kanban = kanban;
    this.nerve = nerve;
    this.admission = admission;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_help_requests (
        origin_peer TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined','deferred','unknown')),
        contribution_ref TEXT,
        local_card_id INTEGER,
        local_run_id TEXT,
        response_json TEXT,
        withdrawn_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (origin_peer, request_id),
        UNIQUE (contribution_ref)
      )
    `);
  }

  reserve(originPeer: string, requestId: string, requestHash: string): ReserveHelpResult {
    const existing = this.db.prepare(
      "SELECT state, request_hash, response_json, contribution_ref FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "request_hash" | "response_json" | "contribution_ref"> | undefined;

    if (existing) {
      // Same request ID reused with different canonical content → conflict.
      if (existing.request_hash !== requestHash) {
        return { status: "conflict" };
      }
      // Same content: terminal decision replays; in-flight (pending/unknown)
      // must not create a second card/run/process.
      if (existing.state === "accepted" || existing.state === "declined" || existing.state === "deferred") {
        const response = JSON.parse(existing.response_json ?? "{}") as PeerHelpResponseV1;
        return {
          status: "replay",
          response,
          contribution_ref: existing.contribution_ref ?? undefined,
        };
      }
      return { status: "in_flight" };
    }

    this.db.prepare(
      `INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    ).run(originPeer, requestId, requestHash);

    return { status: "new" };
  }

  acceptGeneric(reservation: { originPeer: string; requestId: string; requestHash: string }, cardInput: CardInput, response: PeerHelpResponseV1): AcceptedHelp {
    const contributionRef = response.contribution_ref ?? generateContributionRef();
    const VALID_PRIORITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
    const normalizedPriority = cardInput.priority?.toUpperCase();
    const priority = normalizedPriority && VALID_PRIORITIES.has(normalizedPriority) ? normalizedPriority : "MEDIUM";
    const deliveryMode = cardInput.deliveryMode === "report" ? "deliver" : cardInput.deliveryMode;

    const result = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT state, request_hash FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
      ).get(reservation.originPeer, reservation.requestId) as Pick<PeerHelpRow, "state" | "request_hash"> | undefined;

      if (!row || row.state !== "pending") {
        throw new Error(`Cannot accept non-pending request ${reservation.requestId}`);
      }
      if (row.request_hash !== reservation.requestHash) {
        throw new Error(`Request hash mismatch for ${reservation.requestId}`);
      }

      // Insert the local O card directly (not via kanbanEnqueue) so the
      // card:queued Nerve event fires only after the transaction commits.
      const insert = this.db.prepare(
        `INSERT INTO kanban_board (title, source, source_id, priority, type, goal, notes, delivery_mode, source_peer)
         VALUES (?, ?, ?, ?, 'O', ?, ?, ?, ?)`
      ).run(
        cardInput.title,
        "peer",
        cardInput.sourceId,
        priority,
        cardInput.goal,
        JSON.stringify({
          origin_peer: reservation.originPeer,
          request_id: reservation.requestId,
          contribution_ref: contributionRef,
          help_decision: "accepted",
        }),
        deliveryMode,
        cardInput.sourcePeer,
      );

      const cardId = Number(insert.lastInsertRowid);
      if (!cardId) throw new Error("Failed to insert help card");

      // #1618: admit the receiver-owned project in the same transaction so the
      // peer root is supervised from birth — no window where the card exists
      // without its awaiting_contract supervision row. Generic admission must
      // fail closed if production wiring omitted the supervision port.
      if (!this.admission) throw new Error("receiver project admission unavailable");
      if (!this.admission.ensureAwaitingContract(cardId)) {
        throw new Error(`failed to admit receiver project ${cardId}`);
      }

      this.db.prepare(
        `UPDATE peer_help_requests
         SET state = 'accepted', contribution_ref = ?, local_card_id = ?, response_json = ?, updated_at = datetime('now')
         WHERE origin_peer = ? AND request_id = ?`
      ).run(contributionRef, cardId, JSON.stringify(response), reservation.originPeer, reservation.requestId);

      return cardId;
    });

    // Fire only after commit — a rolled-back transaction must not notify consumers.
    this.nerve.fire("card:queued", result);

    return { contribution_ref: contributionRef, local_card_id: result };
  }

  acceptPi(reservation: { originPeer: string; requestId: string; requestHash: string }, runId: string, response: PeerHelpResponseV1): void {
    const contributionRef = response.contribution_ref ?? generateContributionRef();

    this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT state, request_hash FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
      ).get(reservation.originPeer, reservation.requestId) as Pick<PeerHelpRow, "state" | "request_hash"> | undefined;

      if (!row || row.state !== "pending") {
        throw new Error(`Cannot accept non-pending Pi request ${reservation.requestId}`);
      }
      if (row.request_hash !== reservation.requestHash) {
        throw new Error(`Request hash mismatch for ${reservation.requestId}`);
      }

      this.db.prepare(
        `UPDATE peer_help_requests
         SET state = 'accepted', contribution_ref = ?, local_run_id = ?, response_json = ?, updated_at = datetime('now')
         WHERE origin_peer = ? AND request_id = ?`
      ).run(contributionRef, runId, JSON.stringify(response), reservation.originPeer, reservation.requestId);
    });
  }

  completeDecision(reservation: { originPeer: string; requestId: string }, decision: HelpDecision, response: PeerHelpResponseV1): void {
    this.db.prepare(
      `UPDATE peer_help_requests
       SET state = ?, response_json = ?, updated_at = datetime('now')
       WHERE origin_peer = ? AND request_id = ? AND state = 'pending'`
    ).run(decision, JSON.stringify(response), reservation.originPeer, reservation.requestId);
  }

  markUnknown(originPeer: string, requestId: string): void {
    this.db.prepare(
      `UPDATE peer_help_requests
       SET state = 'unknown', updated_at = datetime('now')
       WHERE origin_peer = ? AND request_id = ? AND state = 'pending'`
    ).run(originPeer, requestId);
  }

  recordWithdrawal(originPeer: string, requestId: string, contributionRef: string): WithdrawalResult {
    const row = this.db.prepare(
      "SELECT state, contribution_ref, local_card_id FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "contribution_ref" | "local_card_id"> | undefined;

    if (!row || row.contribution_ref !== contributionRef) {
      return { status: "unknown_contribution" };
    }

    if (row.state !== "accepted") {
      return { status: "already_terminal" };
    }

    this.db.prepare(
      `UPDATE peer_help_requests
       SET withdrawn_at = datetime('now'), updated_at = datetime('now')
       WHERE origin_peer = ? AND request_id = ?`
    ).run(originPeer, requestId);

    return { status: "noted" };
  }

  getPublicStatus(originPeer: string, requestId: string, contributionRef: string): PeerHelpStatusV1 | null {
    const row = this.db.prepare(
      "SELECT state, contribution_ref, local_card_id, withdrawn_at, updated_at FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "contribution_ref" | "local_card_id" | "withdrawn_at" | "updated_at"> | undefined;

    if (!row || row.contribution_ref !== contributionRef) return null;

    let state: PeerHelpStatusV1["state"] = "queued";
    if (row.state === "accepted") {
      state = "running";
      if (row.withdrawn_at) state = "withdrawal_noted";
      if (row.local_card_id) {
        const card = this.kanban.kanbanGetCard(row.local_card_id);
        if (card) {
          if (card.status === "done") state = "completed";
          else if (card.status === "failed") state = "failed";
        }
      }
    } else if (row.state === "declined" || row.state === "deferred") {
      state = "completed";
    }

    return {
      version: 1,
      request_id: requestId,
      contribution_ref: contributionRef,
      state,
      updated_at: sqliteUtcToIso(row.updated_at),
    };
  }

  recordContributionEvent(originPeer: string, requestId: string, contributionRef: string, kind: PeerHelpStatusV1["state"]): void {
    const row = this.db.prepare(
      "SELECT state, contribution_ref, local_card_id FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "contribution_ref" | "local_card_id"> | undefined;

    if (!row || row.contribution_ref !== contributionRef || row.state !== "accepted") return;

    if ((kind === "completed" || kind === "failed") && row.local_card_id) {
      if (kind === "completed") {
        this.kanban.kanbanComplete(row.local_card_id, null, "contribution completed");
      } else {
        this.kanban.kanbanFail(row.local_card_id, "contribution failed");
      }
    }

    this.db.prepare(
      `UPDATE peer_help_requests SET updated_at = datetime('now') WHERE origin_peer = ? AND request_id = ?`
    ).run(originPeer, requestId);
  }

  /** #1357: Retrieve stored response for a help request (used for reconciliation). */
  getStoredResponse(originPeer: string, requestId: string): PeerHelpResponseV1 | null {
    const row = this.db.prepare(
      "SELECT state, response_json FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "response_json"> | undefined;
    if (!row || !row.response_json) return null;
    try {
      return JSON.parse(row.response_json) as PeerHelpResponseV1;
    } catch { return null; }
  }
}
