import type { PeerContributionEventV1 } from "./contract.js";
import { randomUUID } from "node:crypto";

export type ContributionState =
  | "pending" | "accepted" | "running"
  | "completed" | "failed"
  | "declined" | "deferred" | "unknown" | "withdrawal_noted";

// TERMINAL_STATES used by getProjectContributions consumers

export interface ContributionRow {
  peer: string;
  request_id: string;
  request_hash: string;
  contribution_ref: string;
  project_card_id: number | null;
  proxy_card_id: number | null;
  root_criteria_json: string | null;
  state: ContributionState;
  last_sequence: number;
  terminal_event_id: string | null;
  terminal_digest: string | null;
  projection_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  peer: string;
  event_id: string;
  request_id: string;
  contribution_ref: string;
  sequence: number;
  payload_digest: string;
  projection_json: string | null;
  created_at: string;
}

export interface TerminalProjectionV1 {
  outcome: "completed" | "failed";
  summary: string;
  evidence: readonly EvidenceClaim[];
  artifacts: readonly BoundedArtifactRef[];
  provenance: ReceiverProvenance;
}

export interface EvidenceClaim {
  id: string;
  kind: string;
  summary: string;
  observed_by: string;
}

export interface BoundedArtifactRef {
  name: string;
  content_type: string;
  size_bytes: number;
  ref: string;
}

export interface ReceiverProvenance {
  receiver_peer: string;
  receiver_project_ref: string;
  acceptance_id: string;
  accepted_at: string;
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

interface KanbanBoard {
  kanbanGetCard(id: number): { id: number; status: string; result_summary?: string | null; error?: string | null } | undefined;
  kanbanUpdate(id: number, updates: Record<string, unknown>): void;
  kanbanComplete(id: number, result: string | null, summary: string, emit?: boolean): void;
  kanbanFail(id: number, error: string, emit?: boolean): void;
  onTerminalCommitted?(event: "card:done" | "card:failed", cardId: number): void;
}

export interface ProxyReservation {
  peer: string;
  requestId: string;
  requestHash: string;
  projectCardId: number | null;
  proxyCardId?: number;
  title: string;
  goal: string;
  priority: string;
  notes: Record<string, unknown>;
  sourcePeer: string;
}

export class ContributionStore {
  private db: Db;
  private kanban: KanbanBoard;

  constructor(db: Db, kanban: KanbanBoard) {
    this.db = db;
    this.kanban = kanban;
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peer_contributions (
        peer TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        contribution_ref TEXT NOT NULL,
        project_card_id INTEGER,
        proxy_card_id INTEGER,
        root_criteria_json TEXT,
        state TEXT NOT NULL DEFAULT 'pending'
          CHECK(state IN ('pending','accepted','running','completed','failed','declined','deferred','unknown','withdrawal_noted')),
        last_sequence INTEGER NOT NULL DEFAULT -1,
        terminal_event_id TEXT,
        terminal_digest TEXT,
        projection_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (peer, request_id),
        UNIQUE (contribution_ref)
      );
      CREATE TABLE IF NOT EXISTS peer_contribution_events (
        peer TEXT NOT NULL,
        event_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        contribution_ref TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        payload_digest TEXT NOT NULL,
        projection_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (peer, event_id)
      );
    `);
  }

  reserve(
    peer: string, requestId: string, requestHash: string,
    projectCardId: number | null, proxyCardId: number | null,
    rootCriteriaJson: string | null,
  ): { status: "new" | "replay" | "conflict"; contributionRef?: string } {
    const existing = this.db.prepare(
      "SELECT state, request_hash, contribution_ref, projection_json FROM peer_contributions WHERE peer = ? AND request_id = ?",
    ).get(peer, requestId) as Pick<ContributionRow, "state" | "request_hash" | "contribution_ref" | "projection_json"> | undefined;

    if (existing) {
      if (existing.request_hash !== requestHash) return { status: "conflict" };
      return { status: "replay", contributionRef: existing.contribution_ref ?? undefined };
    }

    const contributionRef = `help_${require("node:crypto").randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db.prepare(
      `INSERT INTO peer_contributions (peer, request_id, request_hash, contribution_ref, project_card_id, proxy_card_id, root_criteria_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
    ).run(peer, requestId, requestHash, contributionRef, projectCardId, proxyCardId, rootCriteriaJson);
    return { status: "new", contributionRef };
  }

  reserveProxy(input: ProxyReservation): { status: "new" | "replay" | "conflict"; contributionRef?: string; proxyCardId?: number } {
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        "SELECT * FROM peer_contributions WHERE peer = ? AND request_id = ?",
      ).get(input.peer, input.requestId) as ContributionRow | undefined;

      if (existing) {
        if (existing.request_hash !== input.requestHash) return { status: "conflict" as const };
        if (existing.proxy_card_id) {
          return { status: "replay" as const, contributionRef: existing.contribution_ref, proxyCardId: existing.proxy_card_id };
        }
      }

      const contributionRef = existing?.contribution_ref ?? `help_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      const notes = JSON.stringify({ ...input.notes, contribution_ref: contributionRef });
      const normalizedPriority = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(input.priority.toUpperCase())
        ? input.priority.toUpperCase() : "MEDIUM";
      const proxyCardId = input.proxyCardId ?? Number(this.db.prepare(
        `INSERT INTO kanban_board
          (title, source, source_id, priority, status, type, goal, notes, parent_id, delivery_mode, source_peer)
         VALUES (?, 'peer', ?, ?, 'running', 'contribution', ?, ?, ?, 'silent', ?)`
      ).run(
        input.title, input.requestId, normalizedPriority, input.goal, notes,
        input.projectCardId, input.sourcePeer,
      ).lastInsertRowid);
      if (!proxyCardId) throw new Error("Failed to create contribution proxy");

      // A fallback attempt deliberately reuses the first proxy card. Rebind
      // its durable routing identity in the same transaction as the new
      // ledger row; otherwise review assembly and operator views continue to
      // attribute the card to the declined peer/request.
      if (input.proxyCardId !== undefined) {
        this.db.prepare(
          `UPDATE kanban_board
           SET title = ?, source = 'peer', source_id = ?, priority = ?, goal = ?, notes = ?, parent_id = ?, source_peer = ?
           WHERE id = ?`
        ).run(
          input.title, input.requestId, normalizedPriority, input.goal, notes,
          input.projectCardId, input.sourcePeer, input.proxyCardId,
        );
      }

      if (existing) {
        this.db.prepare(
          `UPDATE peer_contributions SET proxy_card_id = ?, updated_at = datetime('now')
           WHERE peer = ? AND request_id = ? AND proxy_card_id IS NULL`
        ).run(proxyCardId, input.peer, input.requestId);
        return { status: "replay" as const, contributionRef, proxyCardId };
      }

      this.db.prepare(
        `INSERT INTO peer_contributions
          (peer, request_id, request_hash, contribution_ref, project_card_id, proxy_card_id,
           root_criteria_json, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`
      ).run(
        input.peer, input.requestId, input.requestHash, contributionRef,
        input.projectCardId, proxyCardId,
        input.notes.root_criteria ? JSON.stringify(input.notes.root_criteria) : null,
      );
      return { status: "new" as const, contributionRef, proxyCardId };
    });
  }

  adoptContributionRef(peer: string, requestId: string, contributionRef: string): boolean {
    const row = this.getContribution(peer, requestId);
    if (!row) return false;
    if (row.contribution_ref === contributionRef) return true;
    const existing = this.getContributionByRef(contributionRef);
    if (existing && (existing.peer !== peer || existing.request_id !== requestId)) return false;
    return this.db.prepare(
      `UPDATE peer_contributions SET contribution_ref = ?, updated_at = datetime('now')
       WHERE peer = ? AND request_id = ? AND state IN ('pending','accepted','unknown')`
    ).run(contributionRef, peer, requestId).changes > 0;
  }

  detachProxy(peer: string, requestId: string): boolean {
    return this.db.prepare(
      `UPDATE peer_contributions SET proxy_card_id = NULL, updated_at = datetime('now')
       WHERE peer = ? AND request_id = ? AND state IN ('declined','deferred','unknown')`
    ).run(peer, requestId).changes > 0;
  }

  transitionToAccepted(peer: string, requestId: string): boolean {
    // #1357: reconciliation may promote an unknown/pending row once the
    // receiver proves acceptance with the original request ID.
    return this.transitionState(peer, requestId, ["pending", "unknown"], "accepted");
  }

  transitionToRunning(peer: string, requestId: string): boolean {
    return this.transitionState(peer, requestId, ["accepted"], "running");
  }

  transitionToCompleted(peer: string, requestId: string, projectionJson: string): boolean {
    const updated = this.db.prepare(
      `UPDATE peer_contributions SET state = 'completed', projection_json = ?, updated_at = datetime('now')
       WHERE peer = ? AND request_id = ? AND state IN ('accepted','running')`,
    ).run(projectionJson, peer, requestId);
    return updated.changes > 0;
  }

  transitionToFailed(peer: string, requestId: string): boolean {
    return this.transitionState(peer, requestId, ["accepted", "running"], "failed");
  }

  transitionToNonStarted(peer: string, requestId: string, state: ContributionState): boolean {
    if (!["declined", "deferred", "unknown"].includes(state)) return false;
    // #1357: an unknown row may be resolved by a later deterministic outcome
    // from the same (peer, request_id) — pending and unknown both transition.
    return this.transitionState(peer, requestId, ["pending", "unknown"], state);
  }

  recordWithdrawal(peer: string, requestId: string): boolean {
    return this.transitionState(peer, requestId, ["accepted", "running"], "withdrawal_noted");
  }

  private transitionState(peer: string, requestId: string, fromStates: ContributionState[], toState: ContributionState): boolean {
    const placeholders = fromStates.map(() => "?").join(",");
    const result = this.db.prepare(
      `UPDATE peer_contributions SET state = ?, updated_at = datetime('now')
       WHERE peer = ? AND request_id = ? AND state IN (${placeholders})`,
    ).run(toState, peer, requestId, ...fromStates);
    return result.changes > 0;
  }

  applyEvent(peer: string, event: PeerContributionEventV1, payloadDigest: string, projectionJson: string | null): "applied" | "duplicate" | "conflict" | "rejected" {
    if ((event.kind === "completed" || event.kind === "failed") && !projectionJson) return "rejected";

    let proxyCardId: number | null = null;
    let terminalEvent: "card:done" | "card:failed" | undefined;

    const result = this.db.transaction<"applied" | "duplicate" | "conflict" | "rejected">(() => {
      // Re-read the contribution inside the write transaction. The previous
      // implementation read this row before opening the transaction, allowing
      // two bridge processes to both pass first-terminal-wins and let the later
      // terminal event overwrite the earlier one.
      const row = this.db.prepare(
        "SELECT state, contribution_ref, last_sequence, terminal_event_id, terminal_digest, proxy_card_id FROM peer_contributions WHERE peer = ? AND request_id = ?",
      ).get(peer, event.request_id) as Pick<ContributionRow, "state" | "contribution_ref" | "last_sequence" | "terminal_event_id" | "terminal_digest" | "proxy_card_id"> | undefined;

      if (!row) return "rejected";
      if (row.contribution_ref !== event.contribution_ref) return "rejected";

      if (row.state === "completed" || row.state === "failed") {
        if (row.terminal_event_id === event.event_id && row.terminal_digest === payloadDigest) return "duplicate";
        try { console.warn(`[contribution-store] conflict: terminal event for settled contribution ${peer}/${event.request_id}`); } catch { /* console may be closed during shutdown; the conflict warning is best-effort */ }
        return "conflict";
      }

      const existingEvent = this.db.prepare(
        "SELECT request_id, contribution_ref, sequence, payload_digest FROM peer_contribution_events WHERE peer = ? AND event_id = ?",
      ).get(peer, event.event_id) as Pick<EventRow, "request_id" | "contribution_ref" | "sequence" | "payload_digest"> | undefined;

      if (existingEvent) {
        return existingEvent.request_id === event.request_id &&
          existingEvent.contribution_ref === event.contribution_ref &&
          existingEvent.sequence === event.sequence &&
          existingEvent.payload_digest === payloadDigest ? "duplicate" : "conflict";
      }

      if (event.sequence <= row.last_sequence) {
        try { console.warn(`[contribution-store] reorder: sequence ${event.sequence} <= last ${row.last_sequence} for ${peer}/${event.request_id} — rejecting`); } catch { /* console may be closed during shutdown; the reorder warning is best-effort */ }
        return "conflict";
      }

      proxyCardId = row.proxy_card_id;
      if (event.kind === "completed" || event.kind === "failed") {
        const update = this.db.prepare(
          `UPDATE peer_contributions SET state = ?, last_sequence = ?, terminal_event_id = ?, terminal_digest = ?, projection_json = ?, updated_at = datetime('now')
           WHERE peer = ? AND request_id = ? AND state NOT IN ('completed', 'failed') AND last_sequence = ?`,
        ).run(
          event.kind === "completed" ? "completed" : "failed",
          event.sequence, event.event_id, payloadDigest, projectionJson,
          peer, event.request_id, row.last_sequence,
        );
        if (update.changes !== 1) return "conflict";
      } else {
        const update = this.db.prepare(
          `UPDATE peer_contributions SET state = 'running', last_sequence = ?, updated_at = datetime('now')
           WHERE peer = ? AND request_id = ? AND state NOT IN ('completed', 'failed') AND last_sequence = ?`,
        ).run(event.sequence, peer, event.request_id, row.last_sequence);
        if (update.changes !== 1) return "conflict";
      }

      this.db.prepare(
        `INSERT INTO peer_contribution_events (peer, event_id, request_id, contribution_ref, sequence, payload_digest, projection_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      ).run(peer, event.event_id, event.request_id, event.contribution_ref, event.sequence, payloadDigest, projectionJson);

      // #1618: the proxy transition and operator-visible projection are part of
      // the SAME transaction as the ledger/event writes — a crash can never
      // leave a terminal ledger with a running proxy. The ledger stays the
      // authority; the card notes are a bounded operator view.
      if ((event.kind === "completed" || event.kind === "failed") && proxyCardId) {
        if (event.kind === "completed") {
          this.kanban.kanbanComplete(proxyCardId, null, event.summary?.slice(0, 1000) ?? "contribution completed", false);
          terminalEvent = "card:done";
        } else {
          this.kanban.kanbanFail(proxyCardId, "contribution failed", false);
          terminalEvent = "card:failed";
        }
        const notes = {
          outcome: event.kind,
          summary: event.summary?.slice(0, 1000) ?? null,
          receiver_peer: event.projection?.provenance.receiver_peer ?? null,
          receiver_project_ref: event.projection?.provenance.receiver_project_ref ?? null,
          acceptance_id: event.projection?.provenance.acceptance_id ?? null,
          event_id: event.event_id,
        };
        this.kanban.kanbanUpdate(proxyCardId, { notes: JSON.stringify(notes) });
      }

      return "applied";
    });

    if (result !== "applied") return result;

    // The ledger, event row, proxy transition, and operator projection are
    // committed before any consumer is woken. A Nerve callback is optional so
    // isolated stores and tests can use their own parent wake boundary.
    if (terminalEvent && proxyCardId) {
      try { this.kanban.onTerminalCommitted?.(terminalEvent, proxyCardId); } catch { /* committed state remains authoritative */ }
    }

    return "applied";
  }

  getContribution(peer: string, requestId: string): ContributionRow | undefined {
    return this.db.prepare("SELECT * FROM peer_contributions WHERE peer = ? AND request_id = ?").get(peer, requestId) as ContributionRow | undefined;
  }

  getContributionByRef(contributionRef: string): ContributionRow | undefined {
    return this.db.prepare("SELECT * FROM peer_contributions WHERE contribution_ref = ?").get(contributionRef) as ContributionRow | undefined;
  }

  getProjectContributions(projectCardId: number): ContributionRow[] {
    return this.db.prepare(
      "SELECT * FROM peer_contributions WHERE project_card_id = ? ORDER BY created_at",
    ).all(projectCardId) as unknown as ContributionRow[];
  }

  getByProxyCardId(proxyCardId: number): ContributionRow | undefined {
    return this.db.prepare("SELECT * FROM peer_contributions WHERE proxy_card_id = ?").get(proxyCardId) as ContributionRow | undefined;
  }
}
