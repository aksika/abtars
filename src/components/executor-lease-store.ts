import { requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";
import type {
  ExecutorProgressFactV1,
  AttemptLeaseSnapshotV1,
  LeasePolicy,
  LeaseExecutorKind,
} from "./executor-progress.js";
import {
  computeSemanticFingerprint,
  computeLeaseEffect,
  validateProgressEvent,
  DEFAULT_LOCAL_POLICY,
  MAX_PAYLOAD_SUMMARY_LENGTH,
} from "./executor-progress.js";
import { createInitialSnapshot, reduceFact, type PendingInputResolver } from "./executor-lease-reducer.js";

export const MAX_EVENTS_PER_ATTEMPT = 500;

export type AppendFactResult =
  | { kind: "accepted"; snapshot: AttemptLeaseSnapshotV1 }
  | { kind: "idempotent"; snapshot: AttemptLeaseSnapshotV1 }
  | { kind: "rejected"; reason: string }
  | { kind: "conflict"; reason: string };

export interface LeaseView {
  attemptId: string;
  cardId: number;
  executorKind: LeaseExecutorKind;
  executorId: string;
  semanticState: string;
  livenessAgeSec: number;
  progressAgeSec: number;
  effectiveDeadlineAt?: string;
  evaluationPhase: string;
  evaluationReason?: string;
  inspectionCount: number;
  lastInspectionOutcome?: string;
  operationLabel?: string;
  awaitingInputSince?: string;
  cancellationReason?: string;
  closedAt?: string;
}

export class ExecutorLeaseStore {
  private db: TaskDatabase;
  static onLeaseChanged?: () => void;
  /** #1539: the card of the most recently mutated lease — projected into the
   * owning scheduled run's progress by the lifecycle wiring. */
  static lastChangedCardId?: number;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_lease_snapshots (
        attempt_id TEXT PRIMARY KEY,
        card_id INTEGER,
        claim_generation INTEGER NOT NULL,
        executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        high_water_sequence INTEGER NOT NULL,
        state_version INTEGER DEFAULT 1,
        next_evaluation_at TEXT,
        closed_at TEXT,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attempt_progress_events (
        attempt_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        fact_id TEXT,
        kind TEXT NOT NULL,
        fingerprint TEXT,
        lease_effect TEXT DEFAULT 'none',
        received_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(attempt_id, claim_generation, sequence)
      );
    `);

    try { this.db.exec(`ALTER TABLE attempt_lease_snapshots ADD COLUMN card_id INTEGER`); } catch {}
    try { this.db.exec(`ALTER TABLE attempt_lease_snapshots ADD COLUMN state_version INTEGER DEFAULT 1`); } catch {}
    try { this.db.exec(`ALTER TABLE attempt_lease_snapshots ADD COLUMN next_evaluation_at TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE attempt_lease_snapshots ADD COLUMN closed_at TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE attempt_progress_events ADD COLUMN fact_id TEXT`); } catch {}
    try { this.db.exec(`ALTER TABLE attempt_progress_events ADD COLUMN lease_effect TEXT DEFAULT 'none'`); } catch {}

    try {
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_progress_fact_id ON attempt_progress_events(attempt_id, claim_generation, fact_id)`);
    } catch {}
  }

  appendFact(
    fact: ExecutorProgressFactV1,
    policy: LeasePolicy = DEFAULT_LOCAL_POLICY,
    inputResolver?: PendingInputResolver,
  ): AppendFactResult {
    const validation = validateProgressEvent(fact);
    if (!validation.ok) return { kind: "rejected", reason: validation.errors.map(e => e.tag).join(",") };
    const sanitized = this._sanitizeFact(validation.event);
    if (!sanitized) return { kind: "rejected", reason: "sanitization failed" };

    const now = Date.now();
    const receivedAt = new Date(now).toISOString();
    const fingerprint = computeSemanticFingerprint(sanitized);

    return this.db.transaction(() => {
      const attempt = this.db.prepare(`
        SELECT id, card_id, lifecycle, generation, executor_kind, executor_id, hard_deadline_at
        FROM worker_attempts WHERE id = ?
      `).get(fact.attempt_id) as Record<string, unknown> | undefined;

      if (!attempt) return { kind: "rejected", reason: "attempt not found" } as AppendFactResult;
      const lifecycle = attempt["lifecycle"] as string;
      const terminalStates = ["completed", "failed", "cancelled", "timed_out"];
      if (terminalStates.includes(lifecycle)) {
        return { kind: "rejected", reason: `attempt is ${lifecycle}` } as AppendFactResult;
      }
      // A lease belongs only to a claimed executor. Pending work has no owner,
      // and cancel-requested work must not be revivable by late observations.
      const activeStates = ["claimed", "starting", "running"];
      if (!activeStates.includes(lifecycle)) {
        return { kind: "rejected", reason: `attempt lifecycle ${lifecycle} not active` } as AppendFactResult;
      }

      if ((attempt["generation"] as number) !== fact.claim_generation) {
        return { kind: "rejected", reason: `generation mismatch: expected ${attempt["generation"]}, got ${fact.claim_generation}` } as AppendFactResult;
      }
      if ((attempt["executor_kind"] as string) !== fact.executor.kind) {
        return { kind: "rejected", reason: `executor kind mismatch: expected ${attempt["executor_kind"]}, got ${fact.executor.kind}` } as AppendFactResult;
      }
      if ((attempt["executor_id"] as string) !== fact.executor.id) {
        return { kind: "rejected", reason: `executor id mismatch: expected ${attempt["executor_id"]}, got ${fact.executor.id}` } as AppendFactResult;
      }

      const existingDuplicate = this.db.prepare(`
        SELECT fingerprint, event_json FROM attempt_progress_events
        WHERE attempt_id = ? AND claim_generation = ? AND fact_id = ?
      `).get(fact.attempt_id, fact.claim_generation, fact.fact_id) as { fingerprint: string; event_json: string } | undefined;

      if (existingDuplicate) {
        if (existingDuplicate.fingerprint === fingerprint) {
          const snapRow = this.db.prepare(`SELECT snapshot_json FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(fact.attempt_id) as { snapshot_json: string } | undefined;
          if (snapRow) {
            return { kind: "idempotent", snapshot: JSON.parse(snapRow.snapshot_json) as AttemptLeaseSnapshotV1 } as AppendFactResult;
          }
        }
        return { kind: "conflict", reason: "duplicate fact_id with different fingerprint" } as AppendFactResult;
      }

      const hardDeadlineAt = attempt["hard_deadline_at"] as string | null;
      const hardDeadlineTimestamp = hardDeadlineAt ? new Date(hardDeadlineAt).getTime() : undefined;
      const cardId = attempt["card_id"] as number;

      const existingRow = this.db.prepare(`SELECT snapshot_json, high_water_sequence FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(fact.attempt_id) as { snapshot_json: string; high_water_sequence: number } | undefined;

      let snapshot: AttemptLeaseSnapshotV1;
      let nextSequence: number;

      if (!existingRow) {
        nextSequence = 1;
        snapshot = createInitialSnapshot(sanitized, cardId, policy, now, hardDeadlineTimestamp);
        snapshot.highWaterSequence = nextSequence;
      } else {
        snapshot = JSON.parse(existingRow.snapshot_json) as AttemptLeaseSnapshotV1;
        if (snapshot.closedAt) {
          return { kind: "rejected", reason: "lease is closed" } as AppendFactResult;
        }
        nextSequence = existingRow.high_water_sequence + 1;
        snapshot = reduceFact(snapshot, sanitized, policy, now, hardDeadlineTimestamp, inputResolver);
        snapshot.highWaterSequence = nextSequence;
      }

      const effect = computeLeaseEffect(fact.kind, fact.phase);
      const snapshotJson = JSON.stringify(snapshot);

      this.db.prepare(`
        INSERT OR REPLACE INTO attempt_lease_snapshots
          (attempt_id, card_id, claim_generation, executor_kind, executor_id,
           high_water_sequence, state_version, next_evaluation_at, closed_at,
           snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.attemptId, snapshot.cardId, snapshot.claimGeneration,
        snapshot.executorKind, snapshot.executorId,
        snapshot.highWaterSequence, snapshot.stateVersion,
        snapshot.nextEvaluationAt ?? null, snapshot.closedAt ?? null,
        snapshotJson, snapshot.updatedAt,
      );

      const eventJson = JSON.stringify({
        schema_version: 1,
        fact_id: sanitized.fact_id,
        attempt_id: sanitized.attempt_id,
        claim_generation: sanitized.claim_generation,
        executor: sanitized.executor,
        sequence: nextSequence,
        kind: sanitized.kind,
        phase: sanitized.phase,
        producer_at: sanitized.producer_at,
        payload: sanitized.payload,
      });

      this.db.prepare(`
        INSERT OR IGNORE INTO attempt_progress_events
          (attempt_id, claim_generation, sequence, fact_id, kind, fingerprint, lease_effect, received_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        fact.attempt_id, fact.claim_generation, nextSequence,
        sanitized.fact_id, sanitized.kind, fingerprint, effect,
        receivedAt, eventJson,
      );

      this._pruneEvents(fact.attempt_id, fact.claim_generation);

      ExecutorLeaseStore.lastChangedCardId = snapshot.cardId;
      ExecutorLeaseStore.onLeaseChanged?.();
      return { kind: "accepted", snapshot } as AppendFactResult;
    }) as AppendFactResult;
  }

  closeLease(
    attemptId: string,
    generation: number,
    reason: string,
  ): boolean {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const attempt = this.db.prepare(`
        SELECT card_id, generation, executor_kind, executor_id
        FROM worker_attempts WHERE id = ?
      `).get(attemptId) as { card_id: number; generation: number; executor_kind: LeaseExecutorKind; executor_id: string } | undefined;
      if (!attempt || attempt.generation !== generation) return false;
      const existing = this.db.prepare(`SELECT snapshot_json FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(attemptId) as { snapshot_json: string } | undefined;

      let snapshot: AttemptLeaseSnapshotV1;
      if (existing) {
        snapshot = JSON.parse(existing.snapshot_json) as AttemptLeaseSnapshotV1;
        if (snapshot.closedAt) return false;
        snapshot.closedAt = now;
        snapshot.closeReason = reason;
        snapshot.evaluation.phase = "closed";
        snapshot.evaluation.version++;
        snapshot.updatedAt = now;
        snapshot.nextEvaluationAt = undefined;
      } else {
        snapshot = {
          schemaVersion: 1,
          attemptId,
          cardId: attempt.card_id,
          claimGeneration: generation,
          executorKind: attempt.executor_kind,
          executorId: attempt.executor_id,
          highWaterSequence: 0,
          stateVersion: 1,
          semanticState: "alive",
          lastReceivedAt: now,
          lastLivenessAt: now,
          lastMeaningfulProgressAt: now,
          livenessDeadlineAt: now,
          progressDeadlineAt: now,
          evaluation: { phase: "closed", inspectionCount: 0, version: 1 },
          closedAt: now,
          closeReason: reason,
          updatedAt: now,
        };
      }

      const nextSequence = snapshot.highWaterSequence + 1;
      snapshot.highWaterSequence = nextSequence;

      this.db.prepare(`
        INSERT OR REPLACE INTO attempt_lease_snapshots
          (attempt_id, card_id, claim_generation, executor_kind, executor_id,
           high_water_sequence, state_version, next_evaluation_at, closed_at,
           snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshot.attemptId, snapshot.cardId, snapshot.claimGeneration,
        snapshot.executorKind, snapshot.executorId,
        snapshot.highWaterSequence, snapshot.stateVersion,
        null, snapshot.closedAt,
        JSON.stringify(snapshot), snapshot.updatedAt,
      );

      this.db.prepare(`
        INSERT OR IGNORE INTO attempt_progress_events
          (attempt_id, claim_generation, sequence, fact_id, kind, fingerprint, lease_effect, received_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(attemptId, generation, nextSequence, `close:${attemptId}`, "stalled", `closed:${reason}`, "none", now, JSON.stringify({ reason, closedAt: now, sequence: nextSequence }));

      ExecutorLeaseStore.lastChangedCardId = attempt.card_id;
      ExecutorLeaseStore.onLeaseChanged?.();
      return true;
    }) as boolean;
  }

  /**
   * Update evaluation phase with CAS on stateVersion.
   * Returns true only when the update was applied (no concurrent write won).
   */
  updateEvaluation(
    attemptId: string,
    phase: string,
    expectedStateVersion?: number,
    nextEvaluationAt?: string,
  ): boolean {
    const row = this.db.prepare(`SELECT state_version, snapshot_json FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(attemptId) as { state_version: number; snapshot_json: string } | undefined;
    if (!row) return false;
    if (expectedStateVersion !== undefined && row.state_version !== expectedStateVersion) return false;
    const snapshot = JSON.parse(row.snapshot_json) as AttemptLeaseSnapshotV1;
    snapshot.evaluation.phase = phase as AttemptLeaseSnapshotV1["evaluation"]["phase"];
    snapshot.evaluation.version++;
    if (nextEvaluationAt !== undefined) snapshot.nextEvaluationAt = nextEvaluationAt;
    snapshot.updatedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE attempt_lease_snapshots
      SET snapshot_json = ?, state_version = state_version + 1, next_evaluation_at = ?, updated_at = ?
      WHERE attempt_id = ? AND state_version = ?
    `).run(JSON.stringify(snapshot), snapshot.nextEvaluationAt ?? null, snapshot.updatedAt, attemptId, row.state_version);
    if (result.changes > 0) {
      ExecutorLeaseStore.lastChangedCardId = snapshot.cardId;
      ExecutorLeaseStore.onLeaseChanged?.();
    }
    return result.changes > 0;
  }

  getSnapshot(attemptId: string): AttemptLeaseSnapshotV1 | undefined {
    const row = this.db.prepare(`SELECT snapshot_json FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(attemptId) as { snapshot_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.snapshot_json) as AttemptLeaseSnapshotV1;
  }

  getActiveSnapshots(): AttemptLeaseSnapshotV1[] {
    const rows = this.db.prepare(`
      SELECT snapshot_json FROM attempt_lease_snapshots WHERE closed_at IS NULL
    `).all() as { snapshot_json: string }[];
    return rows.map(r => JSON.parse(r.snapshot_json) as AttemptLeaseSnapshotV1);
  }

  /** Get due snapshots (next_evaluation_at <= now) for scheduler. */
  getDueSnapshots(): Array<{ attemptId: string; cardId: number; nextEvaluationAt: string }> {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT attempt_id, card_id, next_evaluation_at
      FROM attempt_lease_snapshots
      WHERE closed_at IS NULL AND next_evaluation_at IS NOT NULL AND next_evaluation_at <= ?
    `).all(now) as Array<{ attempt_id: string; card_id: number; next_evaluation_at: string }>;
    return rows.map(r => ({
      attemptId: r.attempt_id,
      cardId: r.card_id,
      nextEvaluationAt: r.next_evaluation_at,
    }));
  }

  /**
   * #1539: every active evaluation due time (past AND future) so the
   * lifecycle wake scheduler can arm the earliest future one. `getDueSnapshots`
   * only returns overdue rows, which cannot arm a timer.
   */
  getEvaluationSchedule(): Array<{ attemptId: string; cardId: number; nextEvaluationAt: string }> {
    const rows = this.db.prepare(`
      SELECT attempt_id, card_id, next_evaluation_at
      FROM attempt_lease_snapshots
      WHERE closed_at IS NULL AND next_evaluation_at IS NOT NULL
    `).all() as Array<{ attempt_id: string; card_id: number; next_evaluation_at: string }>;
    return rows.map(r => ({
      attemptId: r.attempt_id,
      cardId: r.card_id,
      nextEvaluationAt: r.next_evaluation_at,
    }));
  }

  /**
   * Atomically record cancel intent in both worker_attempts and lease snapshot.
   * Uses a single transaction on the shared DB to avoid the race between
   * requestCancel and updateEvaluation as separate roundtrips.
   */
  recordCancelIntent(attemptId: string, reason: string, generation: number, expectedStateVersion: number): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT state_version, snapshot_json
        FROM attempt_lease_snapshots WHERE attempt_id = ?
      `).get(attemptId) as { state_version: number; snapshot_json: string } | undefined;
      if (!row || row.state_version !== expectedStateVersion) return false;

      const attemptUpdated = this.db.prepare(`
        UPDATE worker_attempts
        SET lifecycle = 'cancel_requested', cancel_reason = ?
        WHERE id = ? AND generation = ? AND lifecycle IN ('claimed','starting','running')
      `).run(`lease:${reason}`, attemptId, generation);
      if (attemptUpdated.changes === 0) return false;

      const snapshot = JSON.parse(row.snapshot_json) as AttemptLeaseSnapshotV1;
      snapshot.evaluation.phase = "cancel_requested";
      snapshot.evaluation.reason = reason as AttemptLeaseSnapshotV1["evaluation"]["reason"];
      snapshot.evaluation.version++;
      snapshot.nextEvaluationAt = undefined;
      snapshot.updatedAt = new Date().toISOString();

      const snapshotUpdated = this.db.prepare(`
        UPDATE attempt_lease_snapshots
        SET snapshot_json = ?, state_version = state_version + 1, next_evaluation_at = NULL, updated_at = ?
        WHERE attempt_id = ? AND state_version = ?
      `).run(JSON.stringify(snapshot), snapshot.updatedAt, attemptId, row.state_version);
      if (snapshotUpdated.changes !== 1) return false;

      return true;
    }) as boolean;
  }

  setUpcomingEvaluation(attemptId: string, nextAt: string): void {
    this.db.prepare(`
      UPDATE attempt_lease_snapshots SET next_evaluation_at = ?, updated_at = ?
      WHERE attempt_id = ?
    `).run(nextAt, new Date().toISOString(), attemptId);
  }

  getView(attemptId: string): LeaseView | undefined {
    const snapshot = this.getSnapshot(attemptId);
    if (!snapshot) return undefined;
    const now = Date.now();
    const livenessAgeSec = Math.round((now - new Date(snapshot.lastLivenessAt).getTime()) / 1000);
    const progressAgeSec = Math.round((now - new Date(snapshot.lastMeaningfulProgressAt).getTime()) / 1000);

    let effectiveDeadlineAt: string | undefined;
    if (snapshot.awaitingInput) {
      effectiveDeadlineAt = snapshot.awaitingInput.deadlineAt;
    } else if (snapshot.operation) {
      effectiveDeadlineAt = snapshot.operation.absoluteSilenceDeadlineAt;
    } else {
      const livenessDl = new Date(snapshot.livenessDeadlineAt).getTime();
      const progressDl = new Date(snapshot.progressDeadlineAt).getTime();
      effectiveDeadlineAt = new Date(Math.min(livenessDl, progressDl)).toISOString();
    }

    return {
      attemptId: snapshot.attemptId,
      cardId: snapshot.cardId,
      executorKind: snapshot.executorKind,
      executorId: snapshot.executorId,
      semanticState: snapshot.semanticState,
      livenessAgeSec,
      progressAgeSec,
      effectiveDeadlineAt,
      evaluationPhase: snapshot.evaluation.phase,
      evaluationReason: snapshot.evaluation.reason,
      inspectionCount: snapshot.evaluation.inspectionCount,
      lastInspectionOutcome: snapshot.evaluation.lastInspectionOutcome,
      operationLabel: snapshot.operation?.label,
      awaitingInputSince: snapshot.awaitingInput?.since,
      cancellationReason: snapshot.closeReason,
      closedAt: snapshot.closedAt,
    };
  }

  private _sanitizeFact(fact: ExecutorProgressFactV1): ExecutorProgressFactV1 | null {
    const payload = fact.payload;
    const sanitizedPayload: Record<string, unknown> = {};

    if (payload.operation_id !== undefined) {
      if (typeof payload.operation_id !== "string" || Buffer.byteLength(payload.operation_id, "utf8") > 200) return null;
      sanitizedPayload["operation_id"] = payload.operation_id;
    }
    if (payload.operation_label !== undefined) {
      if (typeof payload.operation_label !== "string" || Buffer.byteLength(payload.operation_label, "utf8") > 200) return null;
      sanitizedPayload["operation_label"] = redactSecrets(payload.operation_label).slice(0, 200);
    }
    if (payload.expected_timeout_ms !== undefined) {
      if (typeof payload.expected_timeout_ms !== "number" || !Number.isFinite(payload.expected_timeout_ms) || payload.expected_timeout_ms < 0) return null;
      sanitizedPayload["expected_timeout_ms"] = payload.expected_timeout_ms;
    }
    if (payload.progress_units !== undefined) {
      if (typeof payload.progress_units !== "number" || !Number.isSafeInteger(payload.progress_units) || payload.progress_units < 0) return null;
      sanitizedPayload["progress_units"] = Math.floor(payload.progress_units);
    }
    if (payload.observation_id !== undefined) {
      if (typeof payload.observation_id !== "string" || Buffer.byteLength(payload.observation_id, "utf8") > 200) return null;
      sanitizedPayload["observation_id"] = payload.observation_id;
    }
    if (payload.milestone_id !== undefined) {
      if (typeof payload.milestone_id !== "string" || Buffer.byteLength(payload.milestone_id, "utf8") > 200) return null;
      sanitizedPayload["milestone_id"] = payload.milestone_id;
    }
    if (payload.input_request_id !== undefined) {
      if (typeof payload.input_request_id !== "string" || Buffer.byteLength(payload.input_request_id, "utf8") > 200) return null;
      sanitizedPayload["input_request_id"] = payload.input_request_id;
    }
    if (payload.summary !== undefined) {
      if (typeof payload.summary !== "string") return null;
      sanitizedPayload["summary"] = redactSecrets(payload.summary).slice(0, MAX_PAYLOAD_SUMMARY_LENGTH);
    }

    return {
      schema_version: 1,
      fact_id: fact.fact_id,
      attempt_id: fact.attempt_id,
      claim_generation: fact.claim_generation,
      executor: { kind: fact.executor.kind, id: fact.executor.id },
      kind: fact.kind,
      phase: fact.phase,
      producer_at: fact.producer_at,
      payload: sanitizedPayload as ExecutorProgressFactV1["payload"],
    };
  }

  private _pruneEvents(attemptId: string, generation: number): void {
    const count = this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM attempt_progress_events
      WHERE attempt_id = ? AND claim_generation = ?
    `).get(attemptId, generation) as { cnt: number };

    if (count.cnt > MAX_EVENTS_PER_ATTEMPT) {
      const excess = count.cnt - MAX_EVENTS_PER_ATTEMPT;
      this.db.prepare(`
        DELETE FROM attempt_progress_events
        WHERE rowid IN (
          SELECT rowid FROM attempt_progress_events
          WHERE attempt_id = ? AND claim_generation = ?
          ORDER BY sequence ASC
          LIMIT ?
        )
      `).run(attemptId, generation, excess);
    }
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi, "[redacted]")
    .replace(/\b(?:bearer|token|api[_ -]?key|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, "[redacted]");
}
