import { requireTaskDatabase, type TaskDatabase } from "./tasks/kanban-board.js";
import type { ExecutorProgressEventV1, AttemptLeaseSnapshot, ProgressKind } from "./executor-progress.js";
import { computeSequenceFingerprint, isMeaningfulProgress, computeDeadlines, DEFAULT_LOCAL_POLICY } from "./executor-progress.js";

export class ExecutorLeaseStore {
  private db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attempt_lease_snapshots (
        attempt_id TEXT PRIMARY KEY,
        claim_generation INTEGER NOT NULL,
        executor_kind TEXT NOT NULL,
        executor_id TEXT NOT NULL,
        high_water_sequence INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS attempt_progress_events (
        attempt_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        fingerprint TEXT,
        received_at TEXT NOT NULL,
        event_json TEXT NOT NULL,
        PRIMARY KEY(attempt_id, claim_generation, sequence)
      );
    `);
  }

  ingestEvent(
    event: ExecutorProgressEventV1,
    receivedAt: string,
    policyLivenessMs: number = DEFAULT_LOCAL_POLICY.livenessMs,
    policyProgressMs: number = DEFAULT_LOCAL_POLICY.meaningfulProgressMs,
  ): { snapshot: AttemptLeaseSnapshot } | { conflict: string } {
    const existingSnapshot = this.db.prepare(
      `SELECT * FROM attempt_lease_snapshots WHERE attempt_id = ?`,
    ).get(event.attempt_id) as Record<string, unknown> | undefined;

    if (existingSnapshot) {
      const gen = existingSnapshot["claim_generation"] as number;
      if (gen !== event.claim_generation) {
        return { conflict: `generation mismatch: expected ${gen}, got ${event.claim_generation}` };
      }
      const hwSeq = existingSnapshot["high_water_sequence"] as number;
      if (event.sequence <= hwSeq) {
        return { conflict: `duplicate sequence: ${event.sequence} <= high water ${hwSeq}` };
      }
    }

    const fingerprint = computeSequenceFingerprint(event);
    const now = new Date(receivedAt).getTime();
    const lastSnapshot = existingSnapshot ? JSON.parse(existingSnapshot["snapshot_json"] as string) as AttemptLeaseSnapshot : null;

    const lastProgressAt = lastSnapshot?.lastMeaningfulProgressAt ?? receivedAt;
    const newLivenessAt = receivedAt;
    const newProgressAt = isMeaningfulProgress(event.kind, event.phase) ? receivedAt : lastProgressAt;

    const semanticState: ProgressKind = event.kind === "awaiting_input" ? "awaiting_input" : event.kind;
    const stateFingerprint = fingerprint;

    let operation: AttemptLeaseSnapshot["operation"] | undefined;
    if (event.kind === "using_tool" && event.payload.operation_id) {
      if (event.phase === "start") {
        const silenceDeadline = event.payload.expected_timeout_ms
          ? new Date(now + Math.min(event.payload.expected_timeout_ms, policyLivenessMs * 5)).toISOString()
          : new Date(now + policyLivenessMs * 3).toISOString();
        operation = {
          id: event.payload.operation_id,
          label: event.payload.operation_label ?? event.payload.operation_id,
          startedAt: receivedAt,
          silenceDeadlineAt: silenceDeadline,
        };
      } else if (lastSnapshot?.operation?.id === event.payload.operation_id) {
        operation = event.phase === "end" ? undefined : lastSnapshot.operation;
      }
    } else if (lastSnapshot?.operation && event.kind !== "using_tool") {
      operation = lastSnapshot.operation;
    }

    let awaitingInput: AttemptLeaseSnapshot["awaitingInput"] | undefined;
    if (event.kind === "awaiting_input") {
      if (event.phase === "start" && event.payload.input_request_id) {
        awaitingInput = {
          requestId: event.payload.input_request_id,
          since: receivedAt,
          deadlineAt: new Date(now + policyLivenessMs * 5).toISOString(),
        };
      } else if (event.phase === "resolved") {
        awaitingInput = undefined;
      } else if (lastSnapshot?.awaitingInput) {
        awaitingInput = lastSnapshot.awaitingInput;
      }
    } else if (lastSnapshot?.awaitingInput) {
      awaitingInput = lastSnapshot.awaitingInput;
    }

    const deadlines = computeDeadlines(now, {
      livenessMs: policyLivenessMs,
      meaningfulProgressMs: policyProgressMs,
      warningBeforeMs: 0,
      inspectGraceMs: 0,
      maxUnknownInspections: 3,
      maxToolSilenceMs: 0,
      awaitingInputMs: 0,
      outputOnlyProgressCapMs: 0,
    });

    const snapshot: AttemptLeaseSnapshot = {
      attemptId: event.attempt_id,
      claimGeneration: event.claim_generation,
      executorKind: event.executor.kind,
      executorId: event.executor.id,
      highWaterSequence: event.sequence,
      semanticState,
      stateFingerprint,
      lastReceivedAt: receivedAt,
      lastLivenessAt: newLivenessAt,
      lastMeaningfulProgressAt: newProgressAt,
      livenessDeadlineAt: deadlines.livenessDeadlineAt,
      progressDeadlineAt: deadlines.progressDeadlineAt,
      evaluation: "healthy",
      operation,
      awaitingInput,
      updatedAt: receivedAt,
    };

    const snapshotJson = JSON.stringify(snapshot);

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO attempt_lease_snapshots (attempt_id, claim_generation, executor_kind, executor_id, high_water_sequence, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.attempt_id, event.claim_generation, event.executor.kind, event.executor.id, event.sequence, snapshotJson, receivedAt);

      this.db.prepare(`
        INSERT OR IGNORE INTO attempt_progress_events (attempt_id, claim_generation, sequence, kind, fingerprint, received_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(event.attempt_id, event.claim_generation, event.sequence, event.kind, fingerprint, receivedAt, JSON.stringify(event));
    });

    return { snapshot };
  }

  getSnapshot(attemptId: string): AttemptLeaseSnapshot | undefined {
    const row = this.db.prepare(`SELECT snapshot_json FROM attempt_lease_snapshots WHERE attempt_id = ?`).get(attemptId) as { snapshot_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.snapshot_json) as AttemptLeaseSnapshot;
  }

  updateEvaluation(attemptId: string, evaluation: AttemptLeaseSnapshot["evaluation"]): void {
    const existing = this.getSnapshot(attemptId);
    if (!existing) return;
    existing.evaluation = evaluation;
    existing.updatedAt = new Date().toISOString();
    this.db.prepare(`UPDATE attempt_lease_snapshots SET snapshot_json = ?, updated_at = ? WHERE attempt_id = ?`).run(JSON.stringify(existing), existing.updatedAt, attemptId);
  }

  removeSnapshot(attemptId: string): void {
    this.db.prepare(`DELETE FROM attempt_lease_snapshots WHERE attempt_id = ?`).run(attemptId);
  }

  getActiveSnapshots(): AttemptLeaseSnapshot[] {
    const rows = this.db.prepare(`SELECT snapshot_json FROM attempt_lease_snapshots`).all() as { snapshot_json: string }[];
    return rows.map(r => JSON.parse(r.snapshot_json) as AttemptLeaseSnapshot);
  }
}
