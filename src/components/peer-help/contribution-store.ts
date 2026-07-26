import type { PeerContributionEventV1 } from "./contract.js";

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
  kanbanComplete(id: number, result: string | null, summary: string): void;
  kanbanFail(id: number, error: string): void;
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

  transitionToAccepted(peer: string, requestId: string): boolean {
    return this.transitionState(peer, requestId, ["pending"], "accepted");
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
    return this.transitionState(peer, requestId, ["pending"], state);
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
    const row = this.db.prepare(
      "SELECT state, last_sequence, terminal_event_id, terminal_digest FROM peer_contributions WHERE peer = ? AND request_id = ?",
    ).get(peer, event.request_id) as Pick<ContributionRow, "state" | "last_sequence" | "terminal_event_id" | "terminal_digest"> | undefined;

    if (!row) return "rejected";

    if (row.state === "completed" || row.state === "failed") {
      if (row.terminal_event_id === event.event_id && row.terminal_digest === payloadDigest) return "duplicate";
      return "conflict";
    }

    const existingEvent = this.db.prepare(
      "SELECT payload_digest FROM peer_contribution_events WHERE peer = ? AND event_id = ?",
    ).get(peer, event.event_id) as Pick<EventRow, "payload_digest"> | undefined;

    if (existingEvent) {
      return existingEvent.payload_digest === payloadDigest ? "duplicate" : "conflict";
    }

    if (event.kind === "completed" || event.kind === "failed") {
      this.db.prepare(
        `UPDATE peer_contributions SET state = ?, last_sequence = ?, terminal_event_id = ?, terminal_digest = ?, projection_json = ?, updated_at = datetime('now')
         WHERE peer = ? AND request_id = ?`,
      ).run(
        event.kind === "completed" ? "completed" : "failed",
        event.sequence, event.event_id, payloadDigest, projectionJson,
        peer, event.request_id,
      );
    } else {
      this.db.prepare(
        `UPDATE peer_contributions SET state = 'running', last_sequence = ?, updated_at = datetime('now')
         WHERE peer = ? AND request_id = ?`,
      ).run(event.sequence, peer, event.request_id);
    }

    this.db.prepare(
      `INSERT INTO peer_contribution_events (peer, event_id, request_id, contribution_ref, sequence, payload_digest, projection_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).run(peer, event.event_id, event.request_id, event.contribution_ref, event.sequence, payloadDigest, projectionJson);

    const proxyCardId = (this.db.prepare(
      "SELECT proxy_card_id FROM peer_contributions WHERE peer = ? AND request_id = ?",
    ).get(peer, event.request_id) as Pick<ContributionRow, "proxy_card_id"> | undefined)?.proxy_card_id;

    if ((event.kind === "completed" || event.kind === "failed") && proxyCardId) {
      if (event.kind === "completed") {
        this.kanban.kanbanComplete(proxyCardId, null, event.summary?.slice(0, 1000) ?? "contribution completed");
      } else {
        this.kanban.kanbanFail(proxyCardId, "contribution failed");
      }
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
