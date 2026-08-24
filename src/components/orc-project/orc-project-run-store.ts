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
import {
  deriveIntentKey,
  CARD_FAILED_ATTEMPTS_WINDOW_MS,
  CARD_NO_PROGRESS_WINDOW_MS,
  BRIDGE_STARTS_5M_WINDOW_MS,
  BRIDGE_STARTS_HOUR_WINDOW_MS,
  BRIDGE_ROWS_5M_WINDOW_MS,
  DEFAULT_ORC_GUARDRAILS,
} from "./orc-project-contracts.js";
import { intentPolicyFor, readOrcProjectSnapshot } from "./orc-intent-policy.js";
import { logWarn } from "../logger.js";
import { emitOrcAlert } from "./orc-alerts.js";
import { getEffectiveOrcGuardrails } from "../sha/sha-policy.js";
import type { EffectiveOrcGuardrails } from "../sha/sha-policy.js";

/**
 * #1708: one effective guardrail snapshot per claim/status read. The provider
 * is resolved OUTSIDE any database transaction; a throwing provider falls
 * back to the shipped hard defaults (fail-closed) rather than skipping fuse
 * evaluation.
 */
export type OrcGuardrailsProvider = () => EffectiveOrcGuardrails;

export interface OrcProjectRunStoreDeps {
  /** Defaults to the shared effective-policy getter; tests may inject fixed
   *  or swapping providers to prove reload behavior. */
  guardrailsProvider?: OrcGuardrailsProvider;
}

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
  private readonly guardrailsProvider: OrcGuardrailsProvider;

  constructor(db?: TaskDatabase, deps?: OrcProjectRunStoreDeps) {
    this.db = db ?? requireTaskDatabase();
    this.guardrailsProvider = deps?.guardrailsProvider ?? (() => getEffectiveOrcGuardrails());
    this.migrate();
  }

  /**
   * #1708: resolve one complete guardrail snapshot. Never throws — a policy
   * read failure uses the shipped hard defaults and never removes or weakens
   * an existing fuse.
   */
  private effectiveGuardrails(): EffectiveOrcGuardrails {
    try {
      return this.guardrailsProvider();
    } catch (err) {
      logWarn("orc-fuse", `guardrails provider failed — using shipped defaults: ${err instanceof Error ? err.message : String(err)}`);
      return DEFAULT_ORC_GUARDRAILS;
    }
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
        global_sequence       INTEGER,
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

      CREATE TABLE IF NOT EXISTS orc_global_run_counter (
        singleton             INTEGER PRIMARY KEY CHECK(singleton = 1),
        next_sequence         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orc_fuse_state (
        scope                 TEXT PRIMARY KEY,
        opened_at             TEXT,
        trip_reason           TEXT,
        generation            INTEGER NOT NULL DEFAULT 0,
        cleared_at            TEXT,
        cleared_generation    INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrateIntentCheck();
    this.migrateTaskRunId();
    this.migrateFuseClearedGeneration();
    this.migrateBridgeSequence();
  }

  /** Global claim ordering for bridge-wide fuse resets; per-card generations are not comparable. */
  private migrateBridgeSequence(): void {
    const runColumns = this.db.prepare(`PRAGMA table_info(orc_project_runs)`).all() as Array<{ name: string }>;
    if (!runColumns.some(c => c.name === "global_sequence")) {
      this.db.exec(`ALTER TABLE orc_project_runs ADD COLUMN global_sequence INTEGER`);
    }
    const fuseColumns = this.db.prepare(`PRAGMA table_info(orc_fuse_state)`).all() as Array<{ name: string }>;
    if (!fuseColumns.some(c => c.name === "cleared_global_sequence")) {
      this.db.exec(`ALTER TABLE orc_fuse_state ADD COLUMN cleared_global_sequence INTEGER NOT NULL DEFAULT 0`);
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orc_runs_global_sequence
        ON orc_project_runs(global_sequence) WHERE global_sequence IS NOT NULL;
      INSERT INTO orc_global_run_counter (singleton, next_sequence) VALUES (1, 1)
        ON CONFLICT(singleton) DO NOTHING;
    `);
  }

  /**
   * #1707 Task 4: the cleared boundary must be monotonic, not clock-based —
   * ISO millisecond stamps cannot order operations inside one millisecond.
   * `cleared_generation` pins the boundary at an ownership-generation value
   * that only ever grows, so resets are exact under any timing.
   */
  private migrateFuseClearedGeneration(): void {
    const columns = this.db.prepare(`PRAGMA table_info(orc_fuse_state)`).all() as Array<{ name: string }>;
    if (columns.some(c => c.name === "cleared_generation")) return;
    this.db.exec(`ALTER TABLE orc_fuse_state ADD COLUMN cleared_generation INTEGER NOT NULL DEFAULT 0`);
  }

  /** Highest ownership generation ever assigned for a card (monotonic). */
  private maxOwnershipGeneration(projectCardId: number): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(ownership_generation), 0) AS g FROM orc_project_runs WHERE project_card_id = ?`).get(projectCardId) as { g: number };
    return row.g;
  }

  /**
   * #1707 Task 2: attribute each Orc attempt to its owning scheduled task
   * occurrence. Nullable — only task-sourced roots carry it. SQLite cannot add
   * a column conditionally, so this stays an idempotent ALTER.
   */
  private migrateTaskRunId(): void {
    const columns = this.db.prepare(`PRAGMA table_info(orc_project_runs)`).all() as Array<{ name: string }>;
    if (columns.some(c => c.name === "task_run_id")) return;
    this.db.exec(`ALTER TABLE orc_project_runs ADD COLUMN task_run_id TEXT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_orc_runs_task_run ON orc_project_runs(project_card_id, task_run_id)`);
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
    // #1708: one complete guardrail snapshot per claim, resolved BEFORE the
    // transaction opens — file parsing or a throwing provider must never hold
    // a database transaction open. The transaction sees only this captured
    // snapshot; a concurrent reload affects the next claim, never this one.
    const guardrails = this.effectiveGuardrails();
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

      // #1707 Task 4: the card circuit breaker is evaluated inside the claim
      // transaction BEFORE any counter increment or row insertion — a tripped
      // fuse refuses the claim at the store boundary itself.
      const fuse = this.evaluateCardFuse(input, guardrails);
      if (fuse) return { kind: "not_actionable" as const, reason: "fuse_open" as const };

      // #1707 Task 5: the bridge-wide emergency fuse is the last containment
      // layer — a card-level guard bypass cannot consume the whole process.
      const bridgeTrip = this.evaluateBridgeFuse(input.projectCardId, guardrails);
      if (bridgeTrip) return { kind: "not_actionable" as const, reason: "fuse_open" as const };

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
      const globalCounter = this.db.prepare(`
        UPDATE orc_global_run_counter SET next_sequence = next_sequence + 1 WHERE singleton = 1
        RETURNING next_sequence - 1 AS sequence
      `).get() as { sequence: number };
      const now = new Date().toISOString();
      const intentKey = deriveIntentKey(input.intentKind, input.projectCardId, projectGeneration, input.intentRef);

      const originPeer = admittedOrigin === "peer" ? authenticatedPeer : null;

      this.db.prepare(`
        INSERT INTO orc_project_runs
          (id, intent_key, intent_kind, intent_ref, goal, project_card_id,
           project_generation, ownership_generation, owner_peer, owner_instance_id,
           global_sequence, origin_kind, origin_peer, task_run_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)
      `).run(runId, intentKey, input.intentKind, input.intentRef ?? null, input.goal, input.projectCardId,
        projectGeneration, nextGen, ownerPeer, ownerInstanceId,
        globalCounter.sequence, input.originKind, originPeer, input.taskRunId ?? null, now, now);

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
      if (result.changes > 0 && outcome === "completed") {
        // #1707: durable progress clears the card's consecutive-failure streak.
        this.recordCardProgress(context.projectCardId, now);
      }
      return result.changes > 0;
    });
  }

  /** #1707: durable progress marker — resets the no-progress/failure windows for one card. */
  private recordCardProgress(projectCardId: number, nowIso: string): void {
    const clearedGen = this.maxOwnershipGeneration(projectCardId);
    this.db.prepare(`
      INSERT INTO orc_fuse_state (scope, cleared_at, cleared_generation) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET
        cleared_at = excluded.cleared_at, cleared_generation = excluded.cleared_generation
    `).run(`card:${projectCardId}`, nowIso, clearedGen);
  }

  // ── #1707 Task 4: card circuit breaker ───────────────────────────────────────
  //
  // All counters derive from immutable orc_project_runs rows inside the claim
  // transaction; concurrent wakes cannot double-count or race a trip. The
  // tripped state is durable in orc_fuse_state and survives ordinary restarts.

  /**
   * Returns a trip reason when the claim must be refused, undefined when the
   * card may proceed. Opening a fuse writes the durable trip row in the SAME
   * transaction as the refusal. Thresholds come from the captured effective
   * guardrail snapshot (#1708); windows stay code-owned.
   */
  private evaluateCardFuse(input: OrcClaimInput, guardrails: EffectiveOrcGuardrails): string | undefined {
    const scope = `card:${input.projectCardId}`;
    const fuseRow = this.db.prepare(`SELECT opened_at, trip_reason, cleared_generation FROM orc_fuse_state WHERE scope = ?`).get(scope) as { opened_at: string | null; trip_reason: string | null; cleared_generation: number | null } | undefined;
    if (fuseRow?.opened_at) return fuseRow.trip_reason ?? "already_open";
    // The cleared boundary is the monotonic ownership generation, never a
    // clock: rows claimed after a progress/reset event have strictly higher
    // generations, immune to millisecond-resolution collisions.
    const clearedGen = fuseRow?.cleared_generation ?? 0;

    const nowSec = Math.floor(Date.now() / 1000);
    const failedFrom = nowSec - Math.floor(CARD_FAILED_ATTEMPTS_WINDOW_MS / 1000);
    const churnFrom = nowSec - Math.floor(CARD_NO_PROGRESS_WINDOW_MS / 1000);

    // Failed/no-progress attempts: provider/turn failures persisted as
    // outcome='failed' (start rejections included — they release with
    // started_at NULL).
    const failedAttempts = this.db.prepare(`
      SELECT COUNT(*) AS n FROM orc_project_runs
       WHERE project_card_id = ? AND state = 'released'
         AND outcome = 'failed'
         AND ownership_generation > ?
         AND unixepoch(created_at) >= ?
    `).get(input.projectCardId, clearedGen, failedFrom) as { n: number };
    if (failedAttempts.n >= guardrails.sameCard.failedOrNoProgress.max) {
      return this.openFuse(scope, `failed_attempts:${failedAttempts.n}`);
    }

    // Starts that never produced durable progress (bound then cancelled or
    // otherwise ended non-completed) — distinct churn shape from outright
    // failures.
    const noProgressStarts = this.db.prepare(`
      SELECT COUNT(*) AS n FROM orc_project_runs
       WHERE project_card_id = ? AND started_at IS NOT NULL
         AND state IN ('released','superseded')
         AND outcome IS NOT NULL AND outcome != 'completed' AND outcome != 'failed'
         AND ownership_generation > ?
         AND unixepoch(created_at) >= ?
    `).get(input.projectCardId, clearedGen, churnFrom) as { n: number };
    if (noProgressStarts.n >= guardrails.sameCard.startsWithoutProgress.max) {
      return this.openFuse(scope, `no_progress_starts:${noProgressStarts.n}`);
    }

    // Hard boundary: one automatic execution attempt per scheduled task run;
    // a terminal failure means no automatic restart, only an operator reset
    // (which requires and produces a NEW attempt identity).
    if (input.intentKind === "project_execution" && input.taskRunId) {
      const priorFailure = this.db.prepare(`
        SELECT 1 FROM orc_project_runs
         WHERE project_card_id = ? AND task_run_id = ? AND intent_kind = 'project_execution'
           AND state = 'released' AND outcome = 'failed'
           AND ownership_generation > ?
         LIMIT 1
      `).get(input.projectCardId, input.taskRunId, clearedGen);
      if (priorFailure) {
        return this.openFuse(scope, "terminal_execution_attempt");
      }
    }

    return undefined;
  }

  /**
   * #1707 Task 5: bridge-wide emergency fuse. Process-wide start/row windows;
   * the first exceeded limit opens the durable 'bridge' scope. `bypassCardId`
   * is the claiming card — its own row insert is what would cross the line.
   * Thresholds come from the captured effective guardrail snapshot (#1708).
   */
  private evaluateBridgeFuse(bypassCardId: number, guardrails: EffectiveOrcGuardrails): string | undefined {
    const fuseRow = this.db.prepare(`SELECT opened_at, trip_reason, cleared_global_sequence FROM orc_fuse_state WHERE scope = 'bridge'`).get() as { opened_at: string | null; trip_reason: string | null; cleared_global_sequence: number | null } | undefined;
    if (fuseRow?.opened_at) return fuseRow.trip_reason ?? "already_open";
    const clearedSequence = fuseRow?.cleared_global_sequence ?? 0;

    const nowSec = Math.floor(Date.now() / 1000);
    const starts5mFrom = nowSec - Math.floor(BRIDGE_STARTS_5M_WINDOW_MS / 1000);
    const starts1hFrom = nowSec - Math.floor(BRIDGE_STARTS_HOUR_WINDOW_MS / 1000);
    const rows5mFrom = nowSec - Math.floor(BRIDGE_ROWS_5M_WINDOW_MS / 1000);

    const startsBase = `FROM orc_project_runs WHERE started_at IS NOT NULL AND global_sequence > ? AND unixepoch(created_at) >= ?`;

    const starts5m = this.db.prepare(`SELECT COUNT(*) AS n ${startsBase}`).get(clearedSequence, starts5mFrom) as { n: number };
    if (starts5m.n >= guardrails.bridge.starts5m) {
      return this.openFuse("bridge", `bridge_starts_5m:${starts5m.n}`, bypassCardId);
    }
    const starts1h = this.db.prepare(`SELECT COUNT(*) AS n ${startsBase}`).get(clearedSequence, starts1hFrom) as { n: number };
    if (starts1h.n >= guardrails.bridge.starts1h) {
      return this.openFuse("bridge", `bridge_starts_1h:${starts1h.n}`, bypassCardId);
    }
    const rows5m = this.db.prepare(`
      SELECT COUNT(*) AS n FROM orc_project_runs
       WHERE global_sequence > ? AND unixepoch(created_at) >= ?
    `).get(clearedSequence, rows5mFrom) as { n: number };
    if (rows5m.n >= guardrails.bridge.newRunRows5m) {
      return this.openFuse("bridge", `bridge_rows_5m:${rows5m.n}`, bypassCardId);
    }

    return undefined;
  }

  /** Open a durable fuse inside the caller's transaction. Returns the trip reason. */
  private openFuse(scope: string, reason: string, cardId?: number): string {
    const nowIso = new Date().toISOString();
    this.db.prepare(`
      UPDATE orc_fuse_state SET opened_at = ?, trip_reason = ?
      WHERE scope = ? AND opened_at IS NULL
    `).run(nowIso, reason, scope);
    this.db.prepare(`
      INSERT INTO orc_fuse_state (scope, opened_at, trip_reason)
      VALUES (?, ?, ?)
      ON CONFLICT(scope) DO NOTHING
    `).run(scope, nowIso, reason);
    logWarn("orc-fuse", `circuit breaker OPEN scope=${scope} reason=${reason}${cardId !== undefined ? ` card=${cardId}` : ""}`);
    // Bounded delivery: rate-limited per kind, mute-aware, no secrets.
    emitOrcAlert(`trip:${scope}`, `[orc-fuse] circuit breaker OPEN scope=${scope} reason=${reason}${cardId !== undefined ? ` card=${cardId}` : ""}`);
    return reason;
  }

  /**
   * #1707: explicit operator reset — clears ONLY fuse state and windows.
   * Terminal run rows stay terminal; a terminal task occurrence stays settled;
   * the next attempt gets a new identity because history rows are untouched.
   */
  resetProjectFuse(projectCardId: number): void {
    const nowIso = new Date().toISOString();
    const clearedGen = this.maxOwnershipGeneration(projectCardId);
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO orc_fuse_state (scope, generation, cleared_at, cleared_generation) VALUES (?, 1, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          opened_at = NULL, trip_reason = NULL, generation = generation + 1,
          cleared_at = excluded.cleared_at, cleared_generation = excluded.cleared_generation
      `).run(`card:${projectCardId}`, nowIso, clearedGen);
    });
    logWarn("orc-fuse", `circuit breaker RESET scope=card:${projectCardId}`);
  }

  /** #1707 Task 5: explicit bridge-fuse reset with a generation bump so stale events stay harmless. */
  resetBridgeFuse(): void {
    const nowIso = new Date().toISOString();
    const maxRow = this.db.prepare(`SELECT COALESCE(MAX(global_sequence), 0) AS sequence FROM orc_project_runs`).get() as { sequence: number };
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO orc_fuse_state (scope, generation, cleared_at, cleared_global_sequence) VALUES ('bridge', 1, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET
          opened_at = NULL, trip_reason = NULL, generation = generation + 1,
          cleared_at = excluded.cleared_at, cleared_global_sequence = excluded.cleared_global_sequence
      `).run(nowIso, maxRow.sequence);
    });
    logWarn("orc-fuse", "circuit breaker RESET scope=bridge");
  }

  /** Durable fuse rows for the operator status surface. */
  getFuseSnapshot(): Array<{ scope: string; openedAt: string | null; tripReason: string | null; generation: number; clearedAt: string | null }> {
    const rows = this.db.prepare(`SELECT * FROM orc_fuse_state ORDER BY scope`).all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      scope: String(r.scope),
      openedAt: (r.opened_at as string | null) ?? null,
      tripReason: (r.trip_reason as string | null) ?? null,
      generation: Number(r.generation ?? 0),
      clearedAt: (r.cleared_at as string | null) ?? null,
    }));
  }

  /** #1707 Task 5: live bridge window counters for /orc status. */
  getBridgeWindowCounts(): { starts5m: number; starts1h: number; rows5m: number } {
    const nowSec = Math.floor(Date.now() / 1000);
    const starts5m = this.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE started_at IS NOT NULL AND unixepoch(created_at) >= ?`).get(nowSec - Math.floor(BRIDGE_STARTS_5M_WINDOW_MS / 1000)) as { n: number };
    const starts1h = this.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE started_at IS NOT NULL AND unixepoch(created_at) >= ?`).get(nowSec - Math.floor(BRIDGE_STARTS_HOUR_WINDOW_MS / 1000)) as { n: number };
    const rows5m = this.db.prepare(`SELECT COUNT(*) AS n FROM orc_project_runs WHERE unixepoch(created_at) >= ?`).get(nowSec - Math.floor(BRIDGE_ROWS_5M_WINDOW_MS / 1000)) as { n: number };
    return { starts5m: starts5m.n, starts1h: starts1h.n, rows5m: rows5m.n };
  }

  // ── #1707 Task 6: orphaned run-row cleanup ───────────────────────────────────
  //
  // Maintenance-only: NEVER called from the reconciler tick. Deletes terminal
  // run rows whose project is gone or settled, in bounded batches, skipping
  // any project that still has a live run row (history stays intact for
  // diagnostics of anything active).

  /**
   * Bounded-batch deletion of orphaned `orc_project_runs` rows. Eligible rows
   * are terminal (released/superseded) AND their project card is missing, or
   * its supervision is missing/terminal (accepted/blocked), AND the project
   * has no live run row at all. Returns selected/deleted/skipped counts.
   */
  cleanupOrphanedRuns(opts: { batchSize?: number; maxBatches?: number } = {}): { selected: number; deleted: number; batches: number } {
    const batchSize = Math.min(Math.max(opts.batchSize ?? 200, 1), 5_000);
    const maxBatches = Math.min(Math.max(opts.maxBatches ?? 250, 1), 10_000);
    const selectSql = `
      SELECT r.id FROM orc_project_runs r
       WHERE r.state IN ('released','superseded')
         AND NOT EXISTS (
           SELECT 1 FROM orc_project_runs live
            WHERE live.project_card_id = r.project_card_id
              AND live.state IN ('scheduled','dispatching','running')
         )
         AND (
           NOT EXISTS (SELECT 1 FROM kanban_board k WHERE k.id = r.project_card_id)
           OR EXISTS (
             SELECT 1 FROM project_supervision s
              WHERE s.project_card_id = r.project_card_id AND s.state IN ('accepted','blocked')
           )
           OR NOT EXISTS (SELECT 1 FROM project_supervision s2 WHERE s2.project_card_id = r.project_card_id)
         )
         AND r.id > ?
         ORDER BY r.id
         LIMIT ?
    `;
    let lastId = "";
    let selected = 0;
    let deleted = 0;
    let batches = 0;
    while (batches < maxBatches) {
      const ids = (this.db.prepare(selectSql).all(lastId, batchSize) as Array<{ id: string }>).map(r => r.id);
      if (ids.length === 0) break;
      batches++;
      selected += ids.length;
      const placeholders = ids.map(() => "?").join(", ");
      deleted += this.db.prepare(`DELETE FROM orc_project_runs WHERE id IN (${placeholders})`).run(...ids).changes;
      // Run IDs are TEXT: keep the raw key for pagination, never coerce.
      lastId = ids[ids.length - 1]!;
      if (ids.length < batchSize) break;
    }
    return { selected, deleted, batches };
  }

  /**
   * Safe WAL compaction for maintenance paths. PASSIVE never blocks writers,
   * so it is safe even if the bridge is live; a TRUNCATE-style compaction
   * belongs to stopped-bridge tooling outside this method.
   */
  checkpointWalPassive(): void {
    try {
      this.db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
    } catch { /* best-effort compaction */ }
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

  // ── #1707 Task 2: attempt-outcome classification ───────────────────────────
  //
  // One vocabulary for release semantics, fuse counting, and /orc status.
  // Derived from the durable row — never from event prose.

  /**
   * Classify a terminal attempt. A live row is "in_flight". Durable progress
   * means the intent postcondition was satisfied (`completed`); anything else
   * is failure or churn:
   * - "failed":      provider/turn failure persisted with outcome='failed'.
   * - "no_progress": released without ever binding a session (start churn,
   *                  empty/no-progress releases — the #1707 storm shape).
   * - "superseded":  housekeeping supersession (boot recovery, generation
   *                  change) — observed, never counted as churn.
   */
  classifyAttemptOutcome(row: Pick<OrcProjectRunRow, "state" | "outcome" | "started_at">): "in_flight" | "progress" | "failed" | "no_progress" | "superseded" {
    if (row.state !== "released" && row.state !== "superseded") return "in_flight";
    if (row.state === "superseded") return "superseded";
    if (row.outcome === "completed") return "progress";
    if (row.outcome === "failed") return "failed";
    if (row.started_at === null) return "no_progress";
    // Released mid-turn (cancelled/stale) after a real start: no durable
    // progress either way — churn, not a clean hand-off.
    return "no_progress";
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
