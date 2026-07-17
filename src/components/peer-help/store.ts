import type { HelpDecision, PeerHelpResponseV1, PeerHelpStatusV1 } from "./contract.js";
import { generateContributionRef } from "./contract.js";

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
  ok: true;
  existing?: {
    decision: HelpDecision;
    response: PeerHelpResponseV1;
    contribution_ref?: string;
  };
  conflict?: true;
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
  emit(event: string, ...args: unknown[]): void;
}

export class PeerHelpStore {
  private db: import("better-sqlite3").Database;
  private kanban: KanbanBoard;

  constructor(db: import("better-sqlite3").Database, kanban: KanbanBoard, _nerve: NerveEmitter) {
    this.db = db;
    this.kanban = kanban;
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
      "SELECT state, response_json, contribution_ref FROM peer_help_requests WHERE origin_peer = ? AND request_id = ?"
    ).get(originPeer, requestId) as Pick<PeerHelpRow, "state" | "response_json" | "contribution_ref"> | undefined;

    if (existing) {
      if (existing.state === "accepted" || existing.state === "declined" || existing.state === "deferred") {
        const response = JSON.parse(existing.response_json ?? "{}") as PeerHelpResponseV1;
        return {
          ok: true,
          existing: {
            decision: existing.state as HelpDecision,
            response,
            contribution_ref: existing.contribution_ref ?? undefined,
          },
        };
      }
      return { ok: true, conflict: true };
    }

    this.db.prepare(
      `INSERT INTO peer_help_requests (origin_peer, request_id, request_hash, state, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))`
    ).run(originPeer, requestId, requestHash);

    return { ok: true };
  }

  acceptGeneric(reservation: { originPeer: string; requestId: string; requestHash: string }, cardInput: CardInput, response: PeerHelpResponseV1): AcceptedHelp {
    const contributionRef = response.contribution_ref ?? generateContributionRef();

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

      const cardId = this.kanban.kanbanEnqueue(cardInput.title, "peer", cardInput.sourceId, {
        type: "O",
        source: "peer",
        sourcePeer: cardInput.sourcePeer,
        sourceId: cardInput.sourceId,
        deliveryMode: cardInput.deliveryMode,
        goal: cardInput.goal,
        priority: cardInput.priority ?? "MEDIUM",
        notes: JSON.stringify({
          origin_peer: reservation.originPeer,
          request_id: reservation.requestId,
          contribution_ref: contributionRef,
          help_decision: "accepted",
        }),
      });

      if (!cardId) throw new Error("Failed to enqueue help card");

      this.db.prepare(
        `UPDATE peer_help_requests
         SET state = 'accepted', contribution_ref = ?, local_card_id = ?, response_json = ?, updated_at = datetime('now')
         WHERE origin_peer = ? AND request_id = ?`
      ).run(contributionRef, cardId, JSON.stringify(response), reservation.originPeer, reservation.requestId);

      return cardId;
    })();

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
    })();
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
      updated_at: row.updated_at,
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
}
