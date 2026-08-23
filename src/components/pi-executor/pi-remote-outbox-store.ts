/**
 * pi-remote-outbox-store.ts — #1693 Phase A: durable remote Pi outbox.
 *
 * Extracted from PiRunStore: the remote lifecycle event outbox, command
 * ledger, consumed-approval ledger, and drain cursor (#1358), plus their
 * schema migration. Owns only these four remote tables; run-state logic stays
 * in PiRunStore, which keeps delegating shims so downstream callers do not
 * change.
 *
 * Transaction contract: methods suffixed `InTx` never open a transaction and
 * are intended to run inside the caller's transition transaction; everything
 * else owns its transaction boundary exactly as before extraction.
 */

import type { TaskDatabase } from "../tasks/kanban-board.js";

/**
 * #1358 review — In-transaction lifecycle event emission seam (mechanism A).
 *
 * The store calls `emitTransitionInTx` INSIDE the same transaction that
 * applies a public run transition, for delegated runs (origin_peer set).
 * If the transaction aborts, neither the transition nor the event exists;
 * if it commits, the event is durable before the caller can observe the
 * transition. This is the durability contract of spec #1358: snapshot
 * scanning is projection repair only and is never the event-durability
 * mechanism.
 *
 * The callback must be synchronous and must not open its own transaction
 * (it runs inside the caller's). It may read run state through the store —
 * the same connection sees the transaction's uncommitted writes.
 */
export interface RemotePiTransitionEmitter {
  emitTransitionInTx(input: {
    runId: string;
    fromStatus: string | undefined;
    toStatus: string;
    /** Set when the transition bumps execution_generation (resume). */
    newGeneration?: number;
  }): void;
}

export class PiRemoteOutboxStore {
  private readonly db: TaskDatabase;

  constructor(db: TaskDatabase) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    // #1358 — Remote Pi lifecycle event outbox. The card identifier is the
    // OWNER's local Pi card, namespaced as remote_card_id so it can never be
    // mistaken for an origin-side local card reference.
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_events (
      run_id TEXT NOT NULL,
      remote_card_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      content_sha256 TEXT NOT NULL,
      origin_peer TEXT NOT NULL,
      origin_request_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      projection_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at TEXT,
      PRIMARY KEY (run_id, sequence)
    )`);
    // Migration for databases created before the namespacing fix (#1358 review):
    // the owner-local card column is renamed so no bare `card_id` survives on
    // the event path.
    try { this.db.exec(`ALTER TABLE remote_pi_events RENAME COLUMN card_id TO remote_card_id`); } catch { /* column already named correctly */ }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_origin_peer ON remote_pi_events(origin_peer)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_events_acknowledged ON remote_pi_events(acknowledged_at) WHERE acknowledged_at IS NULL`);

    // #1358 — Persisted round-robin drain cursor for the remote-pi-drain
    // heartbeat task (no peer starves behind a noisy one; survives restarts).
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_drain_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);

    // #1358 — Remote Pi command ledger for idempotency
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_commands (
      origin_peer TEXT NOT NULL,
      command_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (origin_peer, command_id)
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_commands_run_id ON remote_pi_commands(run_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_commands_state ON remote_pi_commands(state)`);

    // #1358 — Consumed resume approvals (single-use enforcement)
    this.db.exec(`CREATE TABLE IF NOT EXISTS remote_pi_approvals_consumed (
      approval_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      origin_peer TEXT NOT NULL,
      command_id TEXT NOT NULL,
      consumed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_remote_approvals_run ON remote_pi_approvals_consumed(run_id)`);
  }

  // ── #1358: Remote Pi event outbox and command ledger ─────────────────────

  /**
   * Allocate the next sequence number for a run.
   * Thread-safe via SQLite's auto-increment and transactional isolation.
   */
  allocateNextSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
    ).get(runId) as { max_seq: number } | undefined;
    return (row?.max_seq ?? 0) + 1;
  }

  /**
   * Atomically allocate the next sequence AND insert the event in one
   * transaction. This is the only safe way to produce an event: the separate
   * allocateNextSequence + appendEvent pair has a race window where two
   * concurrent producers can both compute the same sequence and one of them
   * silently drops its event when the INSERT hits a UNIQUE violation.
   *
   * The `computeFields` callback receives the freshly-allocated sequence and
   * returns the derived `eventId` and `contentSha256`. The callback runs
   * inside the transaction so the row is inserted with the same sequence the
   * caller used to compute the hash.
   *
   * Returns { sequence, idempotent } on success. If a row already exists for
   * (run_id, sequence) with the same content_sha256, the call is treated as
   * an idempotent retry and returns the existing sequence.
   */
  appendEventAuto(input: {
    runId: string;
    cardId: number;
    generation: number;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
    computeFields: (sequence: number) => { eventId: string; contentSha256: string };
  }): { sequence: number; idempotent: boolean } {
    return this.db.transaction(() => this.appendEventAutoInTx(input));
  }

  /**
   * #1358 review — Same append logic as `appendEventAuto` but WITHOUT opening
   * a transaction: intended to run inside the caller's transition transaction
   * (mechanism A). Sequence allocation reads MAX within the same transaction,
   * so a rollback releases the reservation too.
   */
  appendEventAutoInTx(input: {
    runId: string;
    cardId: number;
    generation: number;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
    computeFields: (sequence: number) => { eventId: string; contentSha256: string };
  }): { sequence: number; idempotent: boolean } {
    const fn = (): { sequence: number; idempotent: boolean } => {
      // Step 1: read MAX inside the transaction. SQLite serializes writes, so
      // the MAX we read here is stable until our transaction commits.
      const row = this.db.prepare(
        `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
      ).get(input.runId) as { max_seq: number };
      const sequence = row.max_seq + 1;

      // Step 2: ask the caller to derive eventId and content_sha256 from
      // the allocated sequence. Both fields depend on the sequence, so they
      // must be computed AFTER allocation.
      const { eventId, contentSha256 } = input.computeFields(sequence);

      // Step 3: INSERT. If (run_id, sequence) already exists (because a prior
      // idempotent retry lost its return value), compare content.
      try {
        this.db.prepare(`
          INSERT INTO remote_pi_events
            (run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          input.runId, input.cardId, input.generation, sequence, eventId,
          contentSha256, input.originPeer, input.originRequestId,
          input.kind, input.projectionJson, input.occurredAt,
        );
        return { sequence, idempotent: false };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint")) {
          const existing = this.db.prepare(
            `SELECT content_sha256 FROM remote_pi_events WHERE run_id = ? AND sequence = ?`
          ).get(input.runId, sequence) as { content_sha256: string } | undefined;
          if (existing && existing.content_sha256 === contentSha256) {
            return { sequence, idempotent: true };
          }
          // Conflicting content for the same sequence — surface as a retryable
          // conflict so the caller can either rebuild with a fresh timestamp
          // or escalate. We do NOT swallow this; the producer must know.
          throw new Error(
            `Event conflict for run ${input.runId} sequence ${sequence}: ` +
            `existing content_sha256 differs from new`,
          );
        }
        throw err;
      }
    };
    return fn();
  }

  /**
   * Append a lifecycle event to the durable outbox.
   * Returns false if an event with the same (run_id, sequence) already exists with different content.
   */
  appendEvent(input: {
    runId: string;
    cardId: number;
    generation: number;
    sequence: number;
    eventId: string;
    contentSha256: string;
    originPeer: string;
    originRequestId: string;
    kind: string;
    occurredAt: string;
    projectionJson: string;
  }): boolean {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_events
          (run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        input.runId,
        input.cardId,
        input.generation,
        input.sequence,
        input.eventId,
        input.contentSha256,
        input.originPeer,
        input.originRequestId,
        input.kind,
        input.projectionJson,
        input.occurredAt,
      );
      return true;
    } catch (err: unknown) {
      // UNIQUE constraint violation means duplicate event_id or (run_id, sequence)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        // Check if it's the same content (idempotent)
        const existing = this.db.prepare(
          `SELECT content_sha256 FROM remote_pi_events WHERE run_id = ? AND sequence = ?`
        ).get(input.runId, input.sequence) as { content_sha256: string } | undefined;
        if (existing && existing.content_sha256 === input.contentSha256) {
          return true; // Idempotent duplicate
        }
        return false; // Conflicting content
      }
      throw err;
    }
  }

  /**
   * Get events for a run after a given sequence (for catch-up).
   */
  getEventsAfter(input: { runId: string; afterSequence: number; limit: number }): Array<{
    run_id: string;
    remote_card_id: number;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    occurred_at: string;
    created_at: string;
    acknowledged_at: string | null;
  }> {
    return this.db.prepare(`
      SELECT run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at, acknowledged_at
      FROM remote_pi_events
      WHERE run_id = ? AND sequence > ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(input.runId, input.afterSequence, input.limit) as any;
  }

  /**
   * Get unacknowledged events for a run (for push delivery).
   */
  getUnacknowledgedEvents(runId: string, limit: number): Array<{
    run_id: string;
    remote_card_id: number;
    generation: number;
    sequence: number;
    event_id: string;
    content_sha256: string;
    origin_peer: string;
    origin_request_id: string;
    kind: string;
    projection_json: string;
    occurred_at: string;
    created_at: string;
  }> {
    return this.db.prepare(`
      SELECT run_id, remote_card_id, generation, sequence, event_id, content_sha256, origin_peer, origin_request_id, kind, projection_json, occurred_at, created_at
      FROM remote_pi_events
      WHERE run_id = ? AND acknowledged_at IS NULL
      ORDER BY sequence ASC
      LIMIT ?
    `).all(runId, limit) as any;
  }

  /**
   * Acknowledge events up to a sequence.
   * Returns the number of events acknowledged.
   */
  acknowledgeEvents(runId: string, upToSequence: number): number {
    const result = this.db.prepare(`
      UPDATE remote_pi_events
      SET acknowledged_at = datetime('now')
      WHERE run_id = ? AND sequence <= ? AND acknowledged_at IS NULL
    `).run(runId, upToSequence);
    return result.changes;
  }

  /**
   * Get the latest acknowledged sequence for a run.
   */
  getLatestAcknowledgedSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ? AND acknowledged_at IS NOT NULL`
    ).get(runId) as { max_seq: number } | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * Get the maximum sequence for a run (acknowledged or not).
   */
  getMaxSequence(runId: string): number {
    const row = this.db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) as max_seq FROM remote_pi_events WHERE run_id = ?`
    ).get(runId) as { max_seq: number } | undefined;
    return row?.max_seq ?? 0;
  }

  /**
   * Compact old progress events for a run, retaining state/input/terminal events.
   * Keeps at most N progress events and all critical events.
   */
  compactProgressEvents(runId: string, maxProgressToRetain: number): number {
    const criticalKinds = ['awaiting_input', 'input_cleared', 'interrupted', 'resumed', 'completed', 'failed', 'cancelled', 'accepted', 'queued', 'starting', 'running'];
    const placeholders = criticalKinds.map(() => '?').join(',');
    // First find progress events to keep (most recent N)
    const toKeep = this.db.prepare(`
      SELECT sequence FROM remote_pi_events
      WHERE run_id = ? AND kind NOT IN (${placeholders})
      ORDER BY sequence DESC
      LIMIT ?
    `).all(runId, ...criticalKinds, maxProgressToRetain) as Array<{ sequence: number }>;
    const keepSequences = toKeep.map(r => r.sequence);
    if (keepSequences.length === 0) {
      // Delete all acknowledged progress events
      const result = this.db.prepare(`
        DELETE FROM remote_pi_events
        WHERE run_id = ? AND kind NOT IN (${placeholders}) AND acknowledged_at IS NOT NULL
      `).run(runId, ...criticalKinds);
      return result.changes;
    }
    // Delete progress events that are acknowledged and not in the keep set
    const keepList = keepSequences.map(() => '?').join(',');
    const result = this.db.prepare(`
      DELETE FROM remote_pi_events
      WHERE run_id = ?
        AND kind NOT IN (${placeholders})
        AND acknowledged_at IS NOT NULL
        AND sequence NOT IN (${keepList})
    `).run(runId, ...criticalKinds, ...keepSequences);
    return result.changes;
  }

  /**
   * Reserve a command slot for idempotency.
   *
   * Returns the reservation result:
   * - 'new': slot was created, caller may proceed
   * - 'replay_completed': identical payload already has a final response — return it
   * - 'replay_dispatch_started': identical payload was dispatched but outcome unknown
   *   (crash between dispatch and response persistence). Caller must return
   *   outcome_unknown and MUST NOT re-dispatch.
   * - 'conflict': different payload with same (peer, command_id) — reject
   */
  reserveCommand(input: {
    originPeer: string;
    commandId: string;
    runId: string;
    payloadHash: string;
  }): { result: "new" | "replay_completed" | "replay_dispatch_started" | "conflict"; state?: string } {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_commands (origin_peer, command_id, run_id, payload_hash, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'received', datetime('now'), datetime('now'))
      `).run(input.originPeer, input.commandId, input.runId, input.payloadHash);
      return { result: "new" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        const existing = this.db.prepare(
          `SELECT state, payload_hash FROM remote_pi_commands WHERE origin_peer = ? AND command_id = ?`
        ).get(input.originPeer, input.commandId) as { state: string; payload_hash: string } | undefined;
        if (!existing) return { result: "conflict" };
        if (existing.payload_hash !== input.payloadHash) {
          return { result: "conflict", state: existing.state };
        }
        // Same payload — return based on current state
        if (existing.state === "completed" || existing.state === "rejected" || existing.state === "outcome_unknown") {
          return { result: "replay_completed", state: existing.state };
        }
        if (existing.state === "dispatch_started" || existing.state === "received") {
          // dispatch_started = crash before response persisted → outcome unknown
          // received = concurrent retry before we started → outcome unknown
          return { result: "replay_dispatch_started", state: existing.state };
        }
        return { result: "conflict", state: existing.state };
      }
      throw err;
    }
  }

  /**
   * Update command state and response.
   */
  updateCommand(input: {
    originPeer: string;
    commandId: string;
    state: string;
    responseJson?: string;
  }): boolean {
    const setClauses = ["state = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [input.state];
    if (input.responseJson !== undefined) {
      setClauses.push("response_json = ?");
      params.push(input.responseJson);
    }
    params.push(input.originPeer, input.commandId);
    const result = this.db.prepare(`
      UPDATE remote_pi_commands
      SET ${setClauses.join(', ')}
      WHERE origin_peer = ? AND command_id = ?
    `).run(...params);
    return result.changes > 0;
  }

  /**
   * Get a command record.
   */
  getCommand(originPeer: string, commandId: string): {
    run_id: string;
    payload_hash: string;
    state: string;
    response_json: string | null;
    created_at: string;
    updated_at: string;
  } | null {
    const row = this.db.prepare(
      `SELECT run_id, payload_hash, state, response_json, created_at, updated_at FROM remote_pi_commands WHERE origin_peer = ? AND command_id = ?`
    ).get(originPeer, commandId) as any;
    return row ?? null;
  }

  /**
   * Clean up old command records (completed/rejected).
   */
  cleanupOldCommands(olderThanHours: number): number {
    const result = this.db.prepare(`
      DELETE FROM remote_pi_commands
      WHERE state IN ('completed', 'rejected', 'outcome_unknown')
        AND updated_at < datetime('now', '-' || ? || ' hours')
    `).run(olderThanHours);
    return result.changes;
  }

  /**
   * #1551 — Consumed approval markers are one-shot idempotency guards; once
   * consumed they have no further purpose, so pure age is a safe predicate
   * (no "in-flight" state to protect, unlike cleanupOldCommands above).
   */
  cleanupConsumedApprovals(olderThanHours: number): number {
    const result = this.db.prepare(`
      DELETE FROM remote_pi_approvals_consumed
      WHERE consumed_at < datetime('now', '-' || ? || ' hours')
    `).run(olderThanHours);
    return result.changes;
  }

  /**
   * Atomically consume a resume approval.
   * Returns true if the approval was newly consumed (first use),
   * false if it was already consumed by a different command.
   *
   * If the same (approval_id, command_id) is replayed, returns true
   * (idempotent — the command ledger handles that case separately).
   */
  consumeApproval(input: {
    approvalId: string;
    runId: string;
    originPeer: string;
    commandId: string;
  }): { consumed: true; firstUse: boolean } | { consumed: false; reason: string } {
    try {
      this.db.prepare(`
        INSERT INTO remote_pi_approvals_consumed (approval_id, run_id, origin_peer, command_id)
        VALUES (?, ?, ?, ?)
      `).run(input.approvalId, input.runId, input.originPeer, input.commandId);
      return { consumed: true, firstUse: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE constraint')) {
        // Already consumed — check if it's the same command (idempotent replay)
        const existing = this.db.prepare(
          `SELECT command_id FROM remote_pi_approvals_consumed WHERE approval_id = ?`
        ).get(input.approvalId) as { command_id: string } | undefined;
        if (existing && existing.command_id === input.commandId) {
          return { consumed: true, firstUse: false };
        }
        return { consumed: false, reason: "Approval already consumed by a different command" };
      }
      throw err;
    }
  }

  /**
   * Check if an approval has been consumed.
   */
  isApprovalConsumed(approvalId: string): boolean {
    const row = this.db.prepare(
      `SELECT approval_id FROM remote_pi_approvals_consumed WHERE approval_id = ?`
    ).get(approvalId) as { approval_id: string } | undefined;
    return !!row;
  }

  /**
   * Get runs with unacknowledged events (for outbox draining).
   *
   * #1693 — read-only cross-table query: joins pi_runs solely to resolve the
   * durable origin_peer of each run. The outbox performs no run-state
   * mutation.
   */
  findRunsWithUnacknowledgedEvents(): Array<{ run_id: string; origin_peer: string }> {
    return this.db.prepare(`
      SELECT DISTINCT e.run_id, r.origin_peer
      FROM remote_pi_events e
      JOIN pi_runs r ON e.run_id = r.id
      WHERE e.acknowledged_at IS NULL
    `).all() as Array<{ run_id: string; origin_peer: string }>;
  }

  /**
   * #1358 review — Persisted round-robin drain cursor for remote-pi-drain.
   * Survives restarts so no peer starves behind a noisy one.
   */
  getDrainCursor(): number {
    const row = this.db.prepare(
      `SELECT value FROM remote_pi_drain_state WHERE key = 'peer_cursor'`
    ).get() as { value: string } | undefined;
    const parsed = row ? Number(row.value) : 0;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  setDrainCursor(value: number): void {
    this.db.prepare(`
      INSERT INTO remote_pi_drain_state (key, value) VALUES ('peer_cursor', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(value));
  }
}
