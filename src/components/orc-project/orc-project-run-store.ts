import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";
import type {
  OrcProjectRunRow,
  OrcRunOutcome,
  OrcRunClaimResult,
  OrcClaimInput,
  OrcContextValidation,
  OrcInvocationContextV1,
} from "./orc-project-contracts.js";
import { deriveIntentKey } from "./orc-project-contracts.js";

export class OrcProjectRunStore {
  readonly db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    this.migrate();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orc_project_runs (
        id                    TEXT PRIMARY KEY,
        intent_key            TEXT NOT NULL,
        intent_kind           TEXT NOT NULL
                                CHECK(intent_kind IN
                                  ('contract_authoring','project_review',
                                   'repair_review','input_resume','operator_turn')),
        intent_ref            TEXT,
        project_card_id       INTEGER NOT NULL,
        project_generation    INTEGER NOT NULL,
        ownership_generation  INTEGER NOT NULL,
        global_slot           INTEGER NOT NULL DEFAULT 1 CHECK(global_slot = 1),
        owner_peer            TEXT NOT NULL,
        owner_instance_id     TEXT NOT NULL,
        origin_kind           TEXT NOT NULL CHECK(origin_kind IN ('local','peer')),
        origin_peer           TEXT,
        session_id            TEXT,
        execution_id          TEXT,
        state                 TEXT NOT NULL
                                CHECK(state IN
                                  ('scheduled','dispatching','running',
                                   'released','superseded')),
        outcome               TEXT
                                CHECK(outcome IS NULL OR outcome IN
                                  ('completed','failed','cancelled','stale',
                                   'project_terminal','generation_changed')),
        failure_code          TEXT,
        created_at            TEXT NOT NULL,
        started_at            TEXT,
        released_at           TEXT,
        updated_at            TEXT NOT NULL,
        UNIQUE(project_card_id, ownership_generation),
        UNIQUE(project_card_id, intent_key, ownership_generation)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_orc_run_per_project
        ON orc_project_runs(project_card_id)
        WHERE state IN ('scheduled','dispatching','running');

      CREATE UNIQUE INDEX IF NOT EXISTS idx_one_global_orc_turn
        ON orc_project_runs(global_slot)
        WHERE state IN ('dispatching','running');

      CREATE TABLE IF NOT EXISTS orc_project_ownership_counters (
        project_card_id       INTEGER PRIMARY KEY,
        next_generation       INTEGER NOT NULL
      );
    `);
  }

  claimIntent(input: OrcClaimInput, ownerPeer: string, ownerInstanceId: string): OrcRunClaimResult {
    return this.db.transaction(() => {
      const sup = this.db.prepare(`
        SELECT state, generation FROM project_supervision WHERE project_card_id = ?
      `).get(input.projectCardId) as { state: string; generation: number } | undefined;

      if (!sup) return { kind: "conflict" as const, reason: "intent_not_actionable" as const };
      if (sup.state === "blocked" || sup.state === "accepted") {
        return { kind: "not_actionable" as const, reason: "project_terminal" as const };
      }

      const projectGeneration = sup.generation;

      const existing = this.db.prepare(`
        SELECT id, state, ownership_generation FROM orc_project_runs
        WHERE project_card_id = ? AND state IN ('scheduled','dispatching','running')
        ORDER BY created_at ASC LIMIT 1
      `).get(input.projectCardId) as { id: string; state: string; ownership_generation: number } | undefined;

      if (existing) {
        const expectedIntentKey = deriveIntentKey(input.intentKind, input.projectCardId, projectGeneration, input.intentRef);
        const existingRow = this.db.prepare(`SELECT intent_key, owner_instance_id FROM orc_project_runs WHERE id = ?`).get(existing.id) as { intent_key: string; owner_instance_id: string } | undefined;
        if (existingRow && existingRow.intent_key === expectedIntentKey && existingRow.owner_instance_id === ownerInstanceId) {
          const ctx = buildContextFromRow(this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(existing.id) as unknown as OrcProjectRunRow);
          return { kind: "idempotent" as const, context: ctx };
        }
        return { kind: "busy" as const, activeRunId: existing.id };
      }

      const counter = this.db.prepare(`
        UPDATE orc_project_ownership_counters SET next_generation = next_generation + 1
        WHERE project_card_id = ?
      `).run(input.projectCardId);

      let nextGen: number;
      if (counter.changes === 0) {
        nextGen = 1;
        this.db.prepare(`
          INSERT INTO orc_project_ownership_counters (project_card_id, next_generation)
          VALUES (?, 2)
        `).run(input.projectCardId);
      } else {
        const row = this.db.prepare(`
          SELECT next_generation FROM orc_project_ownership_counters WHERE project_card_id = ?
        `).get(input.projectCardId) as { next_generation: number };
        nextGen = row.next_generation - 1;
      }

      const runId = `or_${input.projectCardId}_${nextGen}_${Date.now()}`;
      const now = new Date().toISOString();
      const intentKey = deriveIntentKey(input.intentKind, input.projectCardId, projectGeneration, input.intentRef);

      let originPeer: string | null = null;
      if (input.originKind === "peer") {
        originPeer = input.originPeer ?? input.sourcePeer ?? null;
      }

      this.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, project_card_id,
           project_generation, ownership_generation, owner_peer, owner_instance_id,
           origin_kind, origin_peer, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
      `).run(runId, intentKey, input.intentKind, input.intentRef ?? null, input.projectCardId,
        projectGeneration, nextGen, ownerPeer, ownerInstanceId,
        input.originKind, originPeer, now, now);

      const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(runId) as unknown as OrcProjectRunRow;
      return { kind: "claimed" as const, context: buildContextFromRow(row) };
    });
  }

  pump(): string | null {
    return this.db.transaction(() => {
      const eligible = this.db.prepare(`
        SELECT id FROM orc_project_runs
        WHERE state = 'scheduled'
        ORDER BY created_at ASC, project_card_id ASC
        LIMIT 1
      `).get() as { id: string } | undefined;

      if (!eligible) return null;

      const result = this.db.prepare(`
        UPDATE orc_project_runs SET state = 'dispatching', updated_at = ?
        WHERE id = ? AND state = 'scheduled'
      `).run(new Date().toISOString(), eligible.id);

      if (result.changes === 0) return null;
      return eligible.id;
    });
  }

  bindExecution(
    runId: string,
    expectedOwnershipGeneration: number,
    sessionId: string,
    executionId: string,
  ): OrcContextValidation {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE orc_project_runs
      SET state = 'running', session_id = ?, execution_id = ?, started_at = ?, updated_at = ?
      WHERE id = ? AND state = 'dispatching' AND ownership_generation = ?
    `).run(sessionId, executionId, now, now, runId, expectedOwnershipGeneration);

    if (result.changes === 0) {
      const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(runId) as unknown as OrcProjectRunRow | undefined;
      if (!row) return { ok: false as const, reason: "run_unknown" as const };
      if (row.state === "running" && row.session_id === sessionId && row.execution_id === executionId) {
        return { ok: true, row };
      }
      if (row.state === "running") return { ok: false as const, reason: "session_mismatch" as const };
      if (row.state === "released" || row.state === "superseded") return { ok: false as const, reason: "run_released" as const };
      return { ok: false as const, reason: "ownership_generation_mismatch" as const };
    }

    const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(runId) as unknown as OrcProjectRunRow;
    return { ok: true, row };
  }

  validateCurrentContext(context: OrcInvocationContextV1): OrcContextValidation {
    const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
    if (!row) return { ok: false as const, reason: "run_unknown" as const };

    if (row.state === "released" || row.state === "superseded") {
      return { ok: false as const, reason: "run_released" as const };
    }
    if (row.owner_instance_id !== context.ownerInstanceId) {
      return { ok: false as const, reason: "foreign_instance" as const };
    }
    if (row.project_card_id !== context.projectCardId) {
      return { ok: false as const, reason: "project_mismatch" as const };
    }
    const currentSup = this.db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(row.project_card_id) as { generation: number } | undefined;
    if (!currentSup || currentSup.generation !== row.project_generation) {
      return { ok: false as const, reason: "project_generation_mismatch" as const };
    }
    if (row.ownership_generation !== context.ownershipGeneration) {
      return { ok: false as const, reason: "ownership_generation_mismatch" as const };
    }

    return { ok: true, row };
  }

  release(runId: string, expectedOwnershipGeneration: number, outcome: OrcRunOutcome): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE orc_project_runs
      SET state = 'released', outcome = ?, released_at = ?, updated_at = ?
      WHERE id = ? AND ownership_generation = ? AND state IN ('scheduled','dispatching','running')
    `).run(outcome, now, now, runId, expectedOwnershipGeneration);
    return result.changes > 0;
  }

  supersede(runId: string, outcome: OrcRunOutcome): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE orc_project_runs
      SET state = 'superseded', outcome = ?, released_at = ?, updated_at = ?
      WHERE id = ? AND state IN ('scheduled','dispatching','running')
    `).run(outcome, now, now, runId);
    return result.changes > 0;
  }

  getLiveRuns(): OrcProjectRunRow[] {
    return this.db.prepare(`
      SELECT * FROM orc_project_runs
      WHERE state IN ('scheduled','dispatching','running')
      ORDER BY created_at ASC
    `).all() as unknown as OrcProjectRunRow[];
  }

  getRun(runId: string): OrcProjectRunRow | undefined {
    return this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(runId) as unknown as OrcProjectRunRow | undefined;
  }

  getLiveRunForProject(projectCardId: number): OrcProjectRunRow | undefined {
    return this.db.prepare(`
      SELECT * FROM orc_project_runs
      WHERE project_card_id = ? AND state IN ('scheduled','dispatching','running')
      ORDER BY created_at ASC LIMIT 1
    `).get(projectCardId) as unknown as OrcProjectRunRow | undefined;
  }

  getRunsForProject(projectCardId: number): OrcProjectRunRow[] {
    return this.db.prepare(`
      SELECT * FROM orc_project_runs WHERE project_card_id = ? ORDER BY created_at DESC LIMIT 100
    `).all(projectCardId) as unknown as OrcProjectRunRow[];
  }

  withCurrentRun<T>(context: OrcInvocationContextV1, fn: (row: OrcProjectRunRow) => T): { ok: true; value: T } | { ok: false; reason: string } {
    const validation = this.validateCurrentContext(context);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    return this.db.transaction(() => {
      const revalidated = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
      if (!revalidated || revalidated.state === "released" || revalidated.state === "superseded") {
        return { ok: false as const, reason: "run_released" };
      }
      if (revalidated.ownership_generation !== context.ownershipGeneration) {
        return { ok: false as const, reason: "ownership_generation_mismatch" };
      }
      const sup = this.db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`).get(revalidated.project_card_id) as { state: string; generation: number } | undefined;
      if (!sup || sup.generation !== revalidated.project_generation) {
        return { ok: false as const, reason: "project_generation_mismatch" };
      }
      try {
        const value = fn(revalidated);
        return { ok: true as const, value };
      } catch (err) {
        return { ok: false as const, reason: String(err) };
      }
    });
  }

  releaseInTransaction(context: OrcInvocationContextV1, outcome: OrcRunOutcome): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
      if (!row || row.state === "released" || row.state === "superseded") return false;
      if (row.ownership_generation !== context.ownershipGeneration) return false;
      return this.release(context.runId, context.ownershipGeneration, outcome);
    });
  }
}

function buildContextFromRow(row: OrcProjectRunRow): OrcInvocationContextV1 {
  return {
    version: 1,
    runId: row.id,
    intentKey: row.intent_key,
    projectCardId: row.project_card_id,
    projectGeneration: row.project_generation,
    ownershipGeneration: row.ownership_generation,
    ownerPeer: row.owner_peer,
    ownerInstanceId: row.owner_instance_id,
    origin: {
      kind: row.origin_kind,
      peer: row.origin_peer ?? undefined,
    },
    sessionId: row.session_id ?? undefined,
    executionId: row.execution_id ?? undefined,
  };
}
