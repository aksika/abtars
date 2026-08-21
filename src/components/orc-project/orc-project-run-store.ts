import { requireTaskDatabase, type TaskDatabase } from "../tasks/kanban-board.js";
import type {
  OrcProjectRunRow,
  OrcRunOutcome,
  OrcRunClaimResult,
  OrcClaimInput,
  OrcContextValidation,
  OrcInvocationContextV2,
  OrcRunFailureCode,
} from "./orc-project-contracts.js";
import { deriveIntentKey } from "./orc-project-contracts.js";
import { intentPolicyFor, readOrcProjectSnapshot } from "./orc-intent-policy.js";

/**
 * #1679: the read-side owner fence, defined once. Every method composes these
 * facts in its own precedence order; session/execution use the optional-context
 * semantics (absent passes, present must equal the bound row value).
 */
interface OrcOwnerFenceFacts {
  readonly ownerInstanceMatches: boolean;
  readonly projectCardMatches: boolean;
  readonly projectGenerationMatches: boolean;
  readonly ownershipGenerationMatches: boolean;
  readonly intentMatches: boolean;
  readonly originMatches: boolean;
  readonly sessionMatches: boolean;
  readonly executionMatches: boolean;
}

function evaluateOwnerFence(
  row: OrcProjectRunRow,
  context: OrcInvocationContextV2,
): OrcOwnerFenceFacts {
  return {
    ownerInstanceMatches: row.owner_instance_id === context.ownerInstanceId,
    projectCardMatches: row.project_card_id === context.projectCardId,
    projectGenerationMatches: row.project_generation === context.projectGeneration,
    ownershipGenerationMatches: row.ownership_generation === context.ownershipGeneration,
    intentMatches: row.intent_key === context.intentKey
      && row.intent_kind === context.intentKind
      && (row.intent_ref ?? undefined) === context.intentRef,
    originMatches: row.origin_kind === context.origin.kind
      && (row.origin_peer ?? undefined) === context.origin.peer,
    sessionMatches: context.sessionId === undefined || row.session_id === context.sessionId,
    executionMatches: context.executionId === undefined || row.execution_id === context.executionId,
  };
}

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
                                  ('contract_authoring','project_execution',
                                   'project_review',
                                   'repair_review','input_resume','operator_turn')),
        intent_ref            TEXT,
        /* #1675: the run row owns its goal — written once by the first
           claimant and never overwritten by a later idempotent claim. A run
           cannot be inserted without it. */
        goal                  TEXT NOT NULL,
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
    this.migrateIntentCheck();
  }

  /**
   * #1680: narrow preserving migration that admits the `project_execution`
   * intent. SQLite cannot alter a CHECK constraint, so an old table is rebuilt
   * in one `BEGIN IMMEDIATE` transaction: every column is copied explicitly,
   * the table is replaced, and both live-run partial uniqueness indexes are
   * recreated. Any copy/index failure rolls the whole rebuild back. Historical
   * rows keep their historically truthful intent values — nothing is rewritten.
   * Rerunning is idempotent: a table whose CHECK already admits the value is
   * left untouched.
   */
  private migrateIntentCheck(): void {
    const raw = this.db.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'orc_project_runs'
    `).get() as { sql: string } | undefined;
    if (!raw || raw.sql.includes("'project_execution'")) return;

    this.db.transactionImmediate(() => {
      const replacement = raw.sql.replace(
        "('contract_authoring','project_review',",
        "('contract_authoring','project_execution','project_review',",
      );
      if (!replacement.includes("'project_execution'")) {
        throw new Error("orc_project_runs intent CHECK migration: replacement failed");
      }
      this.db.exec(`
        DROP TABLE IF EXISTS orc_project_runs_new;
        ${replacement.replace("CREATE TABLE orc_project_runs", "CREATE TABLE orc_project_runs_new")}
      `);
      // Explicit-column copy: every column of the old table, preserving all
      // rows (historical terminal rows and live runs included).
      this.db.exec(`
        INSERT INTO orc_project_runs_new
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
           project_generation, ownership_generation, global_slot, owner_peer,
           owner_instance_id, origin_kind, origin_peer, session_id, execution_id,
           state, outcome, failure_code, created_at, started_at, released_at,
           updated_at)
        SELECT id, intent_key, intent_kind, intent_ref, goal, project_card_id,
               project_generation, ownership_generation, global_slot, owner_peer,
               owner_instance_id, origin_kind, origin_peer, session_id, execution_id,
               state, outcome, failure_code, created_at, started_at, released_at,
               updated_at
          FROM orc_project_runs;
      `);
      this.db.exec(`
        DROP TABLE orc_project_runs;
        ALTER TABLE orc_project_runs_new RENAME TO orc_project_runs;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_live_orc_run_per_project
          ON orc_project_runs(project_card_id)
          WHERE state IN ('scheduled','dispatching','running');
        CREATE UNIQUE INDEX IF NOT EXISTS idx_one_global_orc_turn
          ON orc_project_runs(global_slot)
          WHERE state IN ('dispatching','running');
      `);
    });
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
      if (input.expectedProjectGeneration !== undefined && input.expectedProjectGeneration !== projectGeneration) {
        return { kind: "conflict" as const, reason: "project_generation_mismatch" as const };
      }

      const admittedOrigin = input.cardSource === "peer" ? "peer" : "local";
      const authenticatedPeer = input.originPeer ?? input.sourcePeer ?? null;
      if (input.originKind !== admittedOrigin || (admittedOrigin === "peer" && (!authenticatedPeer || authenticatedPeer.length > 128))) {
        return { kind: "conflict" as const, reason: "origin_invalid" as const };
      }

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

      // #1680: actionability is evaluated on the same connection and inside
      // the claim transaction. The public schedule boundaries cannot create
      // an authoring run after a contract or an execution run before the
      // contract/no-higher-owner postcondition is true.
      if (!intentPolicyFor(input.intentKind).isActionable(readOrcProjectSnapshot(this.db, input.projectCardId))) {
        return { kind: "not_actionable" as const, reason: "intent_not_actionable" as const };
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

      const originPeer = admittedOrigin === "peer" ? authenticatedPeer : null;

      this.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
           project_generation, ownership_generation, owner_peer, owner_instance_id,
           origin_kind, origin_peer, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
      `).run(runId, intentKey, input.intentKind, input.intentRef ?? null, input.goal, input.projectCardId,
        projectGeneration, nextGen, ownerPeer, ownerInstanceId,
        input.originKind, originPeer, now, now);

      const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(runId) as unknown as OrcProjectRunRow;
      return { kind: "claimed" as const, context: buildContextFromRow(row) };
    });
  }

  /**
   * #1675: promote exactly this run into the global turn slot, or leave it
   * scheduled. Never promotes another project's run — the run row owns the
   * goal used by the eventual start. The replaced global FIFO `pump()` had no
   * caller and is deleted; the owner's wake re-enters this scoped promotion
   * with the row's own goal.
   *
   * Global single-turn semantics: only one run may be dispatching/running at a
   * time (idx_one_global_orc_turn). A concurrent promotion may have just
   * claimed the slot; flipping this run anyway would violate the partial
   * UNIQUE index and crash the whole bridge as an unhandled rejection.
   * Leave the run scheduled and let the owner's next wake pick it up.
   */
  promoteRun(runId: string): boolean {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE orc_project_runs SET state = 'dispatching', updated_at = ?
         WHERE id = ? AND state = 'scheduled'
           AND NOT EXISTS (
             SELECT 1 FROM orc_project_runs WHERE state IN ('dispatching', 'running')
           )
      `).run(new Date().toISOString(), runId);
      return result.changes > 0;
    });
  }

  bindExecution(context: OrcInvocationContextV2, sessionId: string, executionId: string): OrcContextValidation {
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
      if (!row) return { ok: false as const, reason: "run_unknown" as const };
      const fence = evaluateOwnerFence(row, context);
      if (!fence.intentMatches) return { ok: false as const, reason: "intent_mismatch" as const };
      if (!fence.originMatches) return { ok: false as const, reason: "origin_invalid" as const };
      if (row.state === "running" && row.session_id === sessionId && row.execution_id === executionId) {
        return { ok: true as const, row };
      }
      if (row.state === "running") return { ok: false as const, reason: "session_mismatch" as const };
      if (row.state === "released" || row.state === "superseded") return { ok: false as const, reason: "run_released" as const };
      if (!fence.ownerInstanceMatches) return { ok: false as const, reason: "foreign_instance" as const };
      if (!fence.projectCardMatches || !fence.projectGenerationMatches) {
        return { ok: false as const, reason: "project_generation_mismatch" as const };
      }
      if (!fence.ownershipGenerationMatches) {
        return { ok: false as const, reason: "ownership_generation_mismatch" as const };
      }
      if (!this.currentSupervisionMatches(row)) {
        return { ok: false as const, reason: "project_generation_mismatch" as const };
      }
      const now = new Date().toISOString();
      const result = this.db.prepare(`
        UPDATE orc_project_runs
        SET state = 'running', session_id = ?, execution_id = ?, started_at = ?, updated_at = ?
        WHERE id = ? AND state = 'dispatching' AND ownership_generation = ?
          AND owner_instance_id = ? AND project_card_id = ? AND project_generation = ?
      `).run(sessionId, executionId, now, now, context.runId, context.ownershipGeneration,
        context.ownerInstanceId, context.projectCardId, context.projectGeneration);
      if (result.changes === 0) return { ok: false as const, reason: "ownership_generation_mismatch" as const };
      const bound = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow;
      return { ok: true as const, row: bound };
    });
  }

  validateCurrentContext(context: OrcInvocationContextV2, knownRow?: OrcProjectRunRow): OrcContextValidation {
    // #1671: a failed-release classifier may already have read this exact row;
    // reuse it so diagnostics stay bounded to one run-row read.
    const row = knownRow ?? this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
    if (!row) return { ok: false as const, reason: "run_unknown" as const };

    if (row.state === "released" || row.state === "superseded") {
      return { ok: false as const, reason: "run_released" as const };
    }
    const fence = evaluateOwnerFence(row, context);
    if (!fence.intentMatches) {
      return { ok: false as const, reason: "intent_mismatch" as const };
    }
    if (!fence.originMatches) {
      return { ok: false as const, reason: "origin_invalid" as const };
    }
    if (!fence.ownerInstanceMatches) {
      return { ok: false as const, reason: "foreign_instance" as const };
    }
    if (!fence.projectCardMatches) {
      return { ok: false as const, reason: "project_mismatch" as const };
    }
    if (!fence.projectGenerationMatches || !this.currentSupervisionMatches(row)) {
      return { ok: false as const, reason: "project_generation_mismatch" as const };
    }
    if (!fence.ownershipGenerationMatches) {
      return { ok: false as const, reason: "ownership_generation_mismatch" as const };
    }
    if (!fence.sessionMatches) {
      return { ok: false as const, reason: "session_mismatch" as const };
    }
    if (!fence.executionMatches) {
      return { ok: false as const, reason: "execution_mismatch" as const };
    }

    return { ok: true, row };
  }

  /**
   * #1673: terminal cleanup authority is separate from project mutation
   * authority. Release retires the caller's own run row and is fenced only on
   * the run's immutable identity columns (id, intent, origin, ownership
   * generation, owner, project card, the generation the run recorded, live
   * state, session, execution). It deliberately does NOT compare against current
   * `project_supervision.generation` — i.e. it never calls
   * `currentSupervisionMatches`: a turn that legitimately advanced its own
   * project's generation as part of its durable work must still be able to
   * release the global slot it owns, or the retained row wedges
   * `idx_one_global_orc_turn` forever. Current-supervision fencing belongs to
   * `bindExecution`/`validateCurrentContext`/`withCurrentRun`, which gate
   * mutation of live project state and are unchanged.
   */
  /**
   * #1680: one terminal record — outcome and the stable bounded failure code
   * are written in the same owner-fenced CAS. Success writes `failure_code =
   * NULL`; a failed run must persist one of the stable codes or the caller
   * passes `provider_failure`.
   */
  release(context: OrcInvocationContextV2, outcome: OrcRunOutcome, failureCode?: OrcRunFailureCode | null): boolean {
    return this.db.transaction(() => {
      const now = new Date().toISOString();
      // #1680: success leaves `failure_code = NULL`; every non-success release
      // persists one stable bounded code, defaulting to `provider_failure`
      // when the caller cannot state a more specific reason. A cancelled turn
      // persists `turn_cancelled` via its outcome/`cancelled` terminal, never
      // a bare NULL.
      const code = outcome === "completed" ? null : (failureCode ?? "provider_failure");
      const result = this.db.prepare(`
        UPDATE orc_project_runs
        SET state = 'released', outcome = ?, failure_code = ?, released_at = ?, updated_at = ?
        WHERE id = ? AND ownership_generation = ? AND owner_instance_id = ?
          AND project_card_id = ? AND project_generation = ?
          AND intent_key = ? AND intent_kind = ? AND intent_ref IS ?
          AND origin_kind = ? AND origin_peer IS ? AND owner_peer = ?
          AND state IN ('scheduled','dispatching','running')
          AND (session_id IS NULL OR session_id = ?)
          AND (execution_id IS NULL OR execution_id = ?)
      `).run(outcome, code, now, now, context.runId, context.ownershipGeneration, context.ownerInstanceId,
        context.projectCardId, context.projectGeneration, context.intentKey, context.intentKind,
        context.intentRef ?? null, context.origin.kind, context.origin.peer ?? null, context.ownerPeer,
        context.sessionId ?? null, context.executionId ?? null);
      return result.changes > 0;
    });
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

  // ── #1628: authoring attempt counts ──────────────────────────────────────────
  // Derived from immutable run rows, scoped to the project generation. No
  // mutable counter — concurrent wakes can never double-increment.

  /** Authoring turns that reached the dispatching→running bind for this generation. */
  countStartedAuthoringTurns(projectCardId: number, projectGeneration: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM orc_project_runs
       WHERE project_card_id = ? AND project_generation = ?
         AND intent_kind = 'contract_authoring'
         AND started_at IS NOT NULL
    `).get(projectCardId, projectGeneration) as { n: number };
    return row.n;
  }

  /**
   * Consecutive terminal pre-start authoring failures ("consecutive" = newer
   * than the most recent started turn, so one successful start resets it).
   * A startPort rejection releases with started_at NULL and must not spin —
   * this ceiling terminates that loop.
   */
  countConsecutiveUnstartableAuthoringTurns(projectCardId: number, projectGeneration: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM orc_project_runs
       WHERE project_card_id = ? AND project_generation = ?
         AND intent_kind = 'contract_authoring'
         AND started_at IS NULL
         AND state IN ('released', 'superseded')
         AND created_at > COALESCE((
           SELECT MAX(created_at) FROM orc_project_runs
            WHERE project_card_id = ? AND project_generation = ?
              AND intent_kind = 'contract_authoring' AND started_at IS NOT NULL
         ), '')
    `).get(projectCardId, projectGeneration, projectCardId, projectGeneration) as { n: number };
    return row.n;
  }

  /** failure_code of the most recent terminal authoring run, for requester diagnosis. */
  lastAuthoringFailureCode(projectCardId: number, projectGeneration: number): string | null {
    const row = this.db.prepare(`
      SELECT failure_code FROM orc_project_runs
       WHERE project_card_id = ? AND project_generation = ?
         AND intent_kind = 'contract_authoring'
         AND state IN ('released', 'superseded')
       ORDER BY created_at DESC LIMIT 1
    `).get(projectCardId, projectGeneration) as { failure_code: string | null } | undefined;
    return row?.failure_code ?? null;
  }

  /** created_at of the most recent authoring run for this generation, or null. */
  lastAuthoringClaimAt(projectCardId: number, projectGeneration: number): string | null {
    const row = this.db.prepare(`
      SELECT MAX(created_at) AS at FROM orc_project_runs
       WHERE project_card_id = ? AND project_generation = ?
         AND intent_kind = 'contract_authoring'
    `).get(projectCardId, projectGeneration) as { at: string | null };
    return row.at;
  }

  /**
   * #1679: current-supervision fence — the row still belongs to the
   * authoritative project_supervision generation. Callers gate project
   * mutation on this. Terminal cleanup (`release`) deliberately never calls
   * it; see the #1673 comment on `release`.
   */
  private currentSupervisionMatches(row: OrcProjectRunRow): boolean {
    const sup = this.db.prepare(`SELECT generation FROM project_supervision WHERE project_card_id = ?`).get(row.project_card_id) as { generation: number } | undefined;
    return sup !== undefined && sup.generation === row.project_generation;
  }

  withCurrentRun<T>(context: OrcInvocationContextV2, fn: (row: OrcProjectRunRow) => T): { ok: true; value: T } | { ok: false; reason: string } {
    const validation = this.validateCurrentContext(context);
    if (!validation.ok) return { ok: false as const, reason: validation.reason };
    return this.db.transaction(() => {
      const revalidated = this.db.prepare(`SELECT * FROM orc_project_runs WHERE id = ?`).get(context.runId) as unknown as OrcProjectRunRow | undefined;
      if (!revalidated || revalidated.state === "released" || revalidated.state === "superseded") {
        return { ok: false as const, reason: "run_released" };
      }
      const fence = evaluateOwnerFence(revalidated, context);
      if (!fence.intentMatches) {
        return { ok: false as const, reason: "intent_mismatch" };
      }
      if (!fence.originMatches) {
        return { ok: false as const, reason: "origin_invalid" };
      }
      if (!fence.ownerInstanceMatches) {
        return { ok: false as const, reason: "foreign_instance" };
      }
      if (!fence.projectCardMatches || !fence.projectGenerationMatches) {
        return { ok: false as const, reason: "project_generation_mismatch" };
      }
      if (!fence.ownershipGenerationMatches) {
        return { ok: false as const, reason: "ownership_generation_mismatch" };
      }
      if (!fence.sessionMatches) {
        return { ok: false as const, reason: "session_mismatch" };
      }
      if (!fence.executionMatches) {
        return { ok: false as const, reason: "execution_mismatch" };
      }
      if (!this.currentSupervisionMatches(revalidated)) {
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
}

function buildContextFromRow(row: OrcProjectRunRow): OrcInvocationContextV2 {
  return {
    version: 2,
    runId: row.id,
    intentKey: row.intent_key,
    intentKind: row.intent_kind,
    intentRef: row.intent_ref ?? undefined,
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
