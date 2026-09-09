/**
 * orc-workflow-store.ts — #1792 Task 2: durable persistence for the generic
 * workflow runner. Owns ALL workflow_* SQL plus the single-transaction commit
 * envelope (Revision I order: ingress dedupe FIRST, version fencing SECOND).
 *
 * Transition SEMANTICS live in orc-workflow-runner.ts; this module executes the
 * envelope and exposes granular writers the runner's appliers call inside it.
 * better-sqlite3 (v12) composes nested transaction() calls via savepoints, so
 * applier helpers below are safe to call inside commitTransition.
 *
 * Timestamps use SQLite datetime('now')-compatible UTC ('YYYY-MM-DD HH:MM:SS')
 * for every column the SQL compares; ISO strings appear only inside JSON payloads.
 */
import { randomUUID } from "node:crypto";
import {
  requireTaskDatabase,
  sqliteNow,
  type TaskDatabase,
} from "../tasks/kanban-board.js";
import { initWorkflowSchema } from "./workflow-schema.js";

export type WorkflowRunState =
  | "admitted" | "planning" | "dispatched" | "executing" | "reviewing"
  | "repairing" | "awaiting_input" | "delivering" | "succeeded" | "failed" | "cancelled";

export type RootKind = "scheduled" | "interactive" | "peer";
export type BudgetScope = "work_retry" | "plan_revision" | "review_repair" | "protocol_correction";
export type ResolvedBudgets = Record<BudgetScope, number>;
export type CommandAction = "dispatch" | "notify" | "deliver" | "review" | "plan";
export type CommandStatus = "pending" | "claimed" | "done" | "cancelled";
export type IngressDisposition = "applied" | "noop" | "duplicate" | "conflict";
export type NodeKind = "work" | "synthesis" | "planning" | "review" | "delivery";
export type NodeStatus = "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export const BUDGET_SCOPES: BudgetScope[] = ["work_retry", "plan_revision", "review_repair", "protocol_correction"];
export const COMMAND_CLAIM_LEASE_MIN = 5;
export const DRAIN_LIMIT_DEFAULT = 10;
export const CLAIM_INSPECTION_CAP = 10;
export const MAX_CONSECUTIVE_INCONCLUSIVE = 5;

/** Run states that accept no further applier writes. */
const TERMINAL_RUNISH: Set<string> = new Set(["succeeded", "failed", "cancelled"]);

export interface WorkflowRunRow {
  runId: string;
  rootKind: RootKind;
  rootCardId: number;
  scheduledRunId: string | null;
  generation: number;
  state: WorkflowRunState;
  stateVersion: number;
  clientOperationId: string;
  budgets: ResolvedBudgets;
  failureCode: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandKey {
  runId: string;
  generation: number;
  nodeId: string;
  action: CommandAction;
  ordinal: number;
}

export interface CommandRow extends CommandKey {
  status: CommandStatus;
  payloadJson: string;
  createdAt: string;
  claimedAt: string | null;
  doneAt: string | null;
  owner: string | null;
  claimToken: string | null;
  inspectGen: number;
  consecutiveInconclusive: number;
  nextInspectionAt: string | null;
}

export interface NewCommand extends CommandKey {
  payloadJson: string;
}

export interface RunnerIngress {
  eventId: string;
  runId: string;
  payloadHash: string;
  payloadJson: string;
  generation: number;
  stateVersion: number;
}

/** What an applier produces inside the commit envelope. */
export interface TransitionEffect {
  /** Target run state; omitted keeps the current state. */
  nextState?: WorkflowRunState;
  failureCode?: string | null;
  failureReason?: string | null;
  /** No state change but the event was meaningfully consumed (stale-gen,
   * already-settled): mark ingress 'noop' instead of 'applied'. */
  noop?: boolean;
}

export interface CommitResult {
  disposition: IngressDisposition;
  diagnostics: string | null;
}

function parseBudgets(json: string): ResolvedBudgets {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out = {} as ResolvedBudgets;
  for (const scope of BUDGET_SCOPES) {
    const v = raw[scope];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new Error(`workflow store: corrupt budgets_json for scope ${scope}`);
    }
    out[scope] = v;
  }
  return out;
}

function rowToRun(row: Record<string, unknown>): WorkflowRunRow {
  return {
    runId: row["run_id"] as string,
    rootKind: row["root_kind"] as RootKind,
    rootCardId: Number(row["root_card_id"]),
    scheduledRunId: (row["scheduled_run_id"] as string | null) ?? null,
    generation: Number(row["generation"]),
    state: row["state"] as WorkflowRunState,
    stateVersion: Number(row["state_version"]),
    clientOperationId: row["client_operation_id"] as string,
    budgets: parseBudgets(row["budgets_json"] as string),
    failureCode: (row["failure_code"] as string | null) ?? null,
    failureReason: (row["failure_reason"] as string | null) ?? null,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

function rowToCommand(row: Record<string, unknown>): CommandRow {
  return {
    runId: row["run_id"] as string,
    generation: Number(row["generation"]),
    nodeId: row["node_id"] as string,
    action: row["action"] as CommandAction,
    ordinal: Number(row["ordinal"]),
    status: row["status"] as CommandStatus,
    payloadJson: row["payload_json"] as string,
    createdAt: row["created_at"] as string,
    claimedAt: (row["claimed_at"] as string | null) ?? null,
    doneAt: (row["done_at"] as string | null) ?? null,
    owner: (row["owner"] as string | null) ?? null,
    claimToken: (row["claim_token"] as string | null) ?? null,
    inspectGen: Number(row["inspect_gen"] ?? 0),
    consecutiveInconclusive: Number(row["consecutive_inconclusive"] ?? 0),
    nextInspectionAt: (row["next_inspection_at"] as string | null) ?? null,
  };
}

export class WorkflowStore {
  readonly db: TaskDatabase;

  constructor(db?: TaskDatabase) {
    this.db = db ?? requireTaskDatabase();
    initWorkflowSchema(this.db);
  }

  // ── admission ──────────────────────────────────────────────────────────

  admitRun(input: {
    runId?: string;
    rootKind: RootKind;
    rootCardId: number;
    scheduledRunId?: string | null;
    clientOperationId: string;
    budgets: ResolvedBudgets;
  }): { row: WorkflowRunRow; disposition: "admitted" | "duplicate" } {
    for (const scope of BUDGET_SCOPES) {
      const v = input.budgets[scope];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`workflow store: budget scope ${scope} must be finite >= 0`);
      }
    }
    const runId = input.runId ?? `wf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return this.db.transaction(() => {
      const card = this.db
        .prepare(`SELECT id FROM kanban_board WHERE id = ?`)
        .get(input.rootCardId) as { id: number } | undefined;
      if (!card) throw new Error(`workflow store: root card ${input.rootCardId} missing`);
      if (input.scheduledRunId != null) {
        const occ = this.db
          .prepare(`SELECT run_id FROM task_runs WHERE run_id = ? AND finished_at IS NULL`)
          .get(input.scheduledRunId) as { run_id: string } | undefined;
        if (!occ) throw new Error(`workflow store: scheduled run ${input.scheduledRunId} not live`);
      }
      const now = sqliteNow();
      const existing = this.db
        .prepare(`SELECT * FROM workflow_runs WHERE client_operation_id = ?`)
        .get(input.clientOperationId);
      if (existing) return { row: rowToRun(existing), disposition: "duplicate" as const };
      this.db
        .prepare(
          `INSERT INTO workflow_runs (run_id, root_kind, root_card_id, scheduled_run_id,
            generation, state, state_version, client_operation_id, budgets_json,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, 'admitted', 0, ?, ?, ?, ?)`,
        )
        .run(
          runId, input.rootKind, input.rootCardId, input.scheduledRunId ?? null,
          input.clientOperationId, JSON.stringify(input.budgets), now, now,
        );
      for (const scope of BUDGET_SCOPES) {
        this.db
          .prepare(`INSERT INTO workflow_budgets (run_id, scope, allowed, consumed) VALUES (?, ?, ?, 0)`)
          .run(runId, scope, input.budgets[scope]);
      }
      this.db
        .prepare(
          `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json,
            disposition, received_at, applied_at)
           VALUES (?, ?, ?, ?, 'applied', ?, ?)`,
        )
        .run(`admit-${input.clientOperationId}`, runId, "admit", "{}", now, now);
      const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`).get(runId) as Record<string, unknown>;
      return { row: rowToRun(row), disposition: "admitted" as const };
    });
  }

  getRun(runId: string): WorkflowRunRow | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`).get(runId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToRun(row) : null;
  }

  // ── commit envelope (Revision I order: dedupe first, fence second) ─────

  commitTransition(
    event: RunnerIngress,
    apply: (run: WorkflowRunRow) => TransitionEffect,
  ): CommitResult {
    return this.db.transaction(() => {
      // 1. Ingress dedupe — PK-targeted conflict only; malformed rows raise.
      const ins = this.db
        .prepare(
          `INSERT INTO workflow_ingress (event_id, run_id, payload_hash, payload_json,
            disposition, received_at)
           VALUES (?, ?, ?, ?, 'received', datetime('now'))
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .run(event.eventId, event.runId, event.payloadHash, event.payloadJson);
      if (ins.changes === 0) {
        const stored = this.db
          .prepare(`SELECT payload_hash, disposition FROM workflow_ingress WHERE event_id = ?`)
          .get(event.eventId) as { payload_hash: string; disposition: string };
        if (stored.payload_hash !== event.payloadHash) {
          return { disposition: "conflict" as const, diagnostics: `event ${event.eventId}: conflicting duplicate payload` };
        }
        if (stored.disposition === "received") {
          // NOT YET APPLIED (SHA pre-insert / crash recovery) — fall through.
        } else {
          // applied/noop are terminal and sticky: redelivery changes nothing.
          return { disposition: stored.disposition === "noop" ? ("noop" as const) : ("duplicate" as const), diagnostics: null };
        }
      }
      // 2. Fence generation + version (reached only by new or received events).
      const raw = this.db.prepare(`SELECT * FROM workflow_runs WHERE run_id = ?`).get(event.runId) as
        | Record<string, unknown>
        | undefined;
      if (!raw) throw new Error(`workflow store: run ${event.runId} missing`);
      const run = rowToRun(raw);
      if (run.generation !== event.generation || run.stateVersion !== event.stateVersion) {
        if (ins.changes === 0 && TERMINAL_RUNISH.has(run.state)) {
          // Pre-existing received row for a run that has since terminalized:
          // genuinely moot (no applier accepts terminal runs) — consume as noop
          // so recovery never redrives it again. A LIVE run never takes this
          // branch: losing an applicable event silently would violate
          // requirement 6, so it throws loudly and stays received.
          this.db
            .prepare(`UPDATE workflow_ingress SET disposition='noop', applied_at=datetime('now') WHERE event_id = ? AND disposition='received'`)
            .run(event.eventId);
          return { disposition: "noop" as const, diagnostics: `event ${event.eventId}: run ${event.runId} terminal since receipt` };
        }
        throw new Error(`workflow store: run ${event.runId} fence mismatch (gen/state)`);
      }
      // 3. Runner semantics.
      const effect = apply(run);
      // 4. Version bump + ingress consumption, one commit.
      const nextState = effect.nextState ?? run.state;
      const bumped = this.db
        .prepare(
          `UPDATE workflow_runs SET state = ?, state_version = state_version + 1,
            failure_code = COALESCE(?, failure_code), failure_reason = COALESCE(?, failure_reason),
            updated_at = datetime('now')
           WHERE run_id = ? AND state_version = ?`,
        )
        .run(nextState, effect.failureCode ?? null, effect.failureReason ?? null, event.runId, event.stateVersion);
      if (bumped.changes !== 1) throw new Error(`workflow store: run ${event.runId} lost version race`);
      const finalDisposition = effect.noop === true ? "noop" : "applied";
      const marked = this.db
        .prepare(`UPDATE workflow_ingress SET disposition = ?, applied_at = datetime('now') WHERE event_id = ? AND disposition = 'received'`)
        .run(finalDisposition, event.eventId);
      if (marked.changes !== 1) throw new Error(`workflow store: event ${event.eventId} apply race lost`);
      return { disposition: finalDisposition === "noop" ? ("noop" as const) : ("applied" as const), diagnostics: null };
    });
  }

  // ── granular writers (runner appliers call these inside commitTransition) ─

  insertPlanRevision(runId: string, revision: number, planJson: string): void {
    this.db
      .prepare(`INSERT INTO workflow_plan_revisions (run_id, revision, plan_json, admitted_at) VALUES (?, ?, ?, datetime('now'))`)
      .run(runId, revision, planJson);
  }

  insertNodes(rows: Array<{
    runId: string; revision: number; nodeId: string; kind: NodeKind;
    status?: NodeStatus; workerCardId?: number | null; attemptId?: string | null; outcome?: string | null;
  }>): void {
    const stmt = this.db.prepare(
      `INSERT INTO workflow_nodes (run_id, revision, node_id, kind, status, worker_card_id,
        attempt_id, outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    );
    for (const r of rows) {
      stmt.run(r.runId, r.revision, r.nodeId, r.kind, r.status ?? "queued", r.workerCardId ?? null, r.attemptId ?? null, r.outcome ?? null);
    }
  }

  insertDeps(rows: Array<{ runId: string; revision: number; nodeId: string; dependsOn: string }>): void {
    const stmt = this.db.prepare(
      `INSERT INTO workflow_node_deps (run_id, revision, node_id, depends_on_node_id, satisfied) VALUES (?, ?, ?, ?, 0)`,
    );
    for (const r of rows) stmt.run(r.runId, r.revision, r.nodeId, r.dependsOn);
  }

  listNodes(runId: string, revision: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT node_id, kind, status, worker_card_id, attempt_id, outcome FROM workflow_nodes WHERE run_id = ? AND revision = ? ORDER BY node_id`)
      .all(runId, revision);
  }

  currentRevision(runId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(revision), 0) AS rev FROM workflow_plan_revisions WHERE run_id = ?`)
      .get(runId) as { rev: number };
    return Number(row.rev);
  }

  getPlanJson(runId: string, revision: number): string {
    const row = this.db
      .prepare(`SELECT plan_json FROM workflow_plan_revisions WHERE run_id = ? AND revision = ?`)
      .get(runId, revision) as { plan_json: string } | undefined;
    if (!row) throw new Error(`workflow store: plan revision ${runId}#${revision} missing`);
    return row.plan_json;
  }

  hasUnsatisfiedDeps(runId: string, revision: number, nodeId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT EXISTS(SELECT 1 FROM workflow_node_deps WHERE run_id = ? AND revision = ?
          AND node_id = ? AND satisfied = 0) AS v`,
      )
      .get(runId, revision, nodeId) as { v: number };
    return Number(row.v) === 1;
  }

  markNodeRunning(runId: string, revision: number, nodeId: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE workflow_nodes SET status = 'running', updated_at = datetime('now')
         WHERE run_id = ? AND revision = ? AND node_id = ? AND status = 'queued'`,
      )
      .run(runId, revision, nodeId);
    return res.changes === 1;
  }

  /** Cascade-skip dependents of a failed node (queued only; never rewrites terminal nodes). */
  skipDependents(runId: string, revision: number, nodeId: string): void {
    const skipDirectOf = (dep: string): void => {
      this.db
        .prepare(
          `UPDATE workflow_nodes SET status = 'skipped', updated_at = datetime('now')
           WHERE run_id = ? AND revision = ? AND status = 'queued' AND node_id IN (
             SELECT node_id FROM workflow_node_deps
             WHERE run_id = ? AND revision = ? AND depends_on_node_id = ?
           )`,
        )
        .run(runId, revision, runId, revision, dep);
    };
    skipDirectOf(nodeId);
    // Fixpoint: each pass must skip at least one new node, so passes <= node count.
    for (;;) {
      const res = this.db
        .prepare(
          `UPDATE workflow_nodes SET status = 'skipped', updated_at = datetime('now')
           WHERE run_id = ? AND revision = ? AND status = 'queued' AND node_id IN (
             SELECT d.node_id FROM workflow_node_deps d
             JOIN workflow_nodes n ON n.run_id = d.run_id AND n.revision = d.revision
               AND n.node_id = d.depends_on_node_id
             WHERE d.run_id = ? AND d.revision = ? AND n.status = 'skipped'
           )`,
        )
        .run(runId, revision, runId, revision);
      if (res.changes === 0) return;
    }
  }

  nextCommandOrdinal(runId: string, generation: number, nodeId: string, action: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(ordinal), -1) AS m FROM workflow_commands
         WHERE run_id = ? AND generation = ? AND node_id = ? AND action = ?`,
      )
      .get(runId, generation, nodeId, action) as { m: number };
    return Number(row.m) + 1;
  }

  countPendingCommands(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE status = 'pending'`)
      .get() as { c: number };
    return Number(row.c);
  }

  countRunCommands(runId: string, status?: CommandStatus): number {    const row = status === undefined
      ? (this.db.prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ?`).get(runId) as { c: number })
      : (this.db
          .prepare(`SELECT COUNT(*) AS c FROM workflow_commands WHERE run_id = ? AND status = ?`)
          .get(runId, status) as { c: number });
    return Number(row.c);
  }

  setNodeOutcome(runId: string, revision: number, nodeId: string, status: NodeStatus, outcome: string | null, attemptId?: string | null): void {
    const res = this.db
      .prepare(
        `UPDATE workflow_nodes SET status = ?, outcome = COALESCE(?, outcome),
          attempt_id = COALESCE(?, attempt_id), updated_at = datetime('now')
         WHERE run_id = ? AND revision = ? AND node_id = ?`,
      )
      .run(status, outcome, attemptId ?? null, runId, revision, nodeId);
    if (res.changes !== 1) throw new Error(`workflow store: node ${runId}/${nodeId} missing`);
  }

  /**
   * Mark deps satisfied where the given node was the blocker; returns the ids
   * of nodes that BECAME unblocked by this satisfaction (dependents of the
   * given node now fully satisfied). Already-queued roots are never returned:
   * without this, every completion would re-queue every satisfied root and
   * violate the command PK.
   */
  satisfyDependents(runId: string, revision: number, dependsOn: string): string[] {
    this.db
      .prepare(`UPDATE workflow_node_deps SET satisfied = 1 WHERE run_id = ? AND revision = ? AND depends_on_node_id = ?`)
      .run(runId, revision, dependsOn);
    return this.db
      .prepare(
        `SELECT n.node_id AS node_id FROM workflow_nodes n
         WHERE n.run_id = ? AND n.revision = ? AND n.status = 'queued'
           AND EXISTS (
             SELECT 1 FROM workflow_node_deps d
             WHERE d.run_id = n.run_id AND d.revision = n.revision
               AND d.node_id = n.node_id AND d.depends_on_node_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM workflow_node_deps d
             WHERE d.run_id = n.run_id AND d.revision = n.revision
               AND d.node_id = n.node_id AND d.satisfied = 0
           )
         ORDER BY n.node_id`,
      )
      .all(runId, revision, dependsOn)
      .map((r) => r["node_id"] as string);
  }

  queueCommand(cmd: NewCommand): void {
    this.db
      .prepare(
        `INSERT INTO workflow_commands (run_id, generation, node_id, action, ordinal,
          status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`,
      )
      .run(cmd.runId, cmd.generation, cmd.nodeId, cmd.action, cmd.ordinal, cmd.payloadJson);
  }

  /**
   * One delivery obligation per (run, review node); re-acceptance refreshes it.
   * PK-targeted upsert: a malformed obligation still raises.
   */
  insertDelivery(runId: string, nodeId: string, obligationJson: string): void {
    this.db
      .prepare(
        `INSERT INTO workflow_deliveries (run_id, node_id, obligation_json, outcome,
          attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 0, datetime('now'), datetime('now'))
         ON CONFLICT(run_id, node_id) DO UPDATE SET obligation_json = excluded.obligation_json,
           updated_at = datetime('now')`,
      )
      .run(runId, nodeId, obligationJson);
  }

  setDeliveryOutcome(runId: string, nodeId: string, outcome: "acknowledged" | "failed" | "unknown", receiptJson: string | null): void {    const res = this.db
      .prepare(
        `UPDATE workflow_deliveries SET outcome = ?, receipt_json = COALESCE(?, receipt_json),
          updated_at = datetime('now') WHERE run_id = ? AND node_id = ?`,
      )
      .run(outcome, receiptJson, runId, nodeId);
    if (res.changes !== 1) throw new Error(`workflow store: delivery ${runId}/${nodeId} missing`);
  }

  hasPendingDelivery(runId: string): boolean {
    const row = this.db
      .prepare(`SELECT EXISTS(SELECT 1 FROM workflow_deliveries WHERE run_id = ? AND outcome = 'pending') AS v`)
      .get(runId) as { v: number };
    return Number(row.v) === 1;
  }

  upsertOperation(op: {
    opId: string; runId: string; kind: "planning" | "review"; revision?: number | null;
    status: "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
    resultJson?: string | null;
  }): void {
    const res = this.db
      .prepare(`UPDATE workflow_operations SET status = ?, result_json = COALESCE(?, result_json), updated_at = datetime('now') WHERE op_id = ?`)
      .run(op.status, op.resultJson ?? null, op.opId);
    if (res.changes === 0) {
      this.db
        .prepare(
          `INSERT INTO workflow_operations (op_id, run_id, kind, revision, status, attempt,
            result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, datetime('now'), datetime('now'))`,
        )
        .run(op.opId, op.runId, op.kind, op.revision ?? null, op.status, op.resultJson ?? null);
    }
  }

  // ── commands: claim / complete / drain ────────────────────────────────

  claimCommand(key: CommandKey, owner: string): { row: CommandRow; token: string } | null {
    const token = randomUUID().replace(/-/g, "");
    const res = this.db
      .prepare(
        `UPDATE workflow_commands SET status = 'claimed', claimed_at = datetime('now'),
          owner = ?, claim_token = ?, inspect_gen = 0, consecutive_inconclusive = 0,
          next_inspection_at = datetime('now', '+${COMMAND_CLAIM_LEASE_MIN} minutes')
         WHERE run_id = ? AND generation = ? AND node_id = ? AND action = ? AND ordinal = ?
           AND status = 'pending'`,
      )
      .run(owner, token, key.runId, key.generation, key.nodeId, key.action, key.ordinal);
    if (res.changes !== 1) return null;
    const row = this.db
      .prepare(`SELECT * FROM workflow_commands WHERE run_id = ? AND generation = ? AND node_id = ? AND action = ? AND ordinal = ?`)
      .get(key.runId, key.generation, key.nodeId, key.action, key.ordinal) as Record<string, unknown>;
    return { row: rowToCommand(row), token };
  }

  completeCommand(key: CommandKey, owner: string, token: string): void {
    const res = this.db
      .prepare(
        `UPDATE workflow_commands SET status = 'done', done_at = datetime('now'),
          next_inspection_at = NULL
         WHERE run_id = ? AND generation = ? AND node_id = ? AND action = ? AND ordinal = ?
           AND status = 'claimed' AND owner = ? AND claim_token = ?`,
      )
      .run(key.runId, key.generation, key.nodeId, key.action, key.ordinal, owner, token);
    if (res.changes !== 1) {
      throw new Error(`workflow store: complete rejected for ${key.runId}/${key.nodeId} (stale or cross-owner)`);
    }
  }

  consumeBudget(runId: string, scope: BudgetScope): boolean {
    const res = this.db
      .prepare(`UPDATE workflow_budgets SET consumed = consumed + 1 WHERE run_id = ? AND scope = ? AND consumed < allowed`)
      .run(runId, scope);
    return res.changes === 1;
  }

  readBudgets(runId: string): Record<BudgetScope, { allowed: number; consumed: number }> {
    const rows = this.db
      .prepare(`SELECT scope, allowed, consumed FROM workflow_budgets WHERE run_id = ?`)
      .all(runId) as Array<Record<string, unknown>>;
    const out = {} as Record<BudgetScope, { allowed: number; consumed: number }>;
    for (const r of rows) {
      out[r["scope"] as BudgetScope] = { allowed: Number(r["allowed"]), consumed: Number(r["consumed"]) };
    }
    return out;
  }

  /**
   * Cancel non-terminal nodes of superseded revisions (replacement never
   * rewrites running work). Review-kind nodes are spared: a review verdict
   * spans revisions by design (re-review judges the new revision on the same
   * node). Callers may spare additional nodes (e.g. the planning node whose
   * proposal is being admitted — it completes instead).
   */
  cancelPriorNodes(runId: string, revision: number, spareNodeIds: string[] = []): number {
    const spare = spareNodeIds.length > 0
      ? `AND node_id NOT IN (${spareNodeIds.map(() => "?").join(",")})`
      : ``;
    const res = this.db
      .prepare(
        `UPDATE workflow_nodes SET status = 'cancelled', updated_at = datetime('now')
         WHERE run_id = ? AND revision < ? AND status IN ('queued','running')
           AND kind <> 'review' ${spare}`,
      )
      .run(runId, revision, ...spareNodeIds);
    return res.changes;
  }

  drainPendingCommands(limit: number): CommandRow[] {
    return this.db
      .prepare(`SELECT * FROM workflow_commands WHERE status = 'pending' ORDER BY created_at LIMIT ?`)
      .all(limit)
      .map(rowToCommand);
  }

  // ── audit + recovery reads ────────────────────────────────────────────

  listAuditRoots(cursor: number, limit: number): Array<{ runId: string; rootCardId: number; state: string }> {
    return this.db
      .prepare(
        `SELECT run_id, root_card_id, state FROM workflow_runs
         WHERE state NOT IN ('succeeded','failed','cancelled') AND root_card_id > ?
         ORDER BY root_card_id LIMIT ?`,
      )
      .all(cursor, limit)
      .map((r) => ({ runId: r["run_id"] as string, rootCardId: Number(r["root_card_id"]), state: r["state"] as string }));
  }

  probeRun(runId: string, cardId: number): {
    pending: boolean; freshClaim: boolean; dueClaim: boolean; liveAttempt: boolean;
    pendingInput: boolean; openOp: boolean; pendingDelivery: boolean;
  } {
    const row = this.db
      .prepare(
        `SELECT
          EXISTS(SELECT 1 FROM workflow_commands WHERE run_id = ? AND status = 'pending') AS pending,
          EXISTS(SELECT 1 FROM workflow_commands WHERE run_id = ? AND status = 'claimed'
            AND next_inspection_at > datetime('now')) AS fresh_claim,
          EXISTS(SELECT 1 FROM workflow_commands WHERE run_id = ? AND status = 'claimed'
            AND next_inspection_at <= datetime('now')) AS due_claim,
          EXISTS(SELECT 1 FROM worker_attempts WHERE root_project_card_id = ?
            AND lifecycle IN ('pending','claimed','starting','running','cancel_requested')) AS live_attempt,
          EXISTS(SELECT 1 FROM project_input_requests WHERE project_card_id = ?
            AND status = 'pending') AS pending_input,
          EXISTS(SELECT 1 FROM workflow_operations WHERE run_id = ?
            AND status IN ('pending','claimed','running')) AS open_op,
          EXISTS(SELECT 1 FROM workflow_deliveries WHERE run_id = ? AND outcome = 'pending') AS pending_delivery`,
      )
      .get(runId, runId, runId, cardId, cardId, runId, runId) as Record<string, unknown>;
    const bit = (v: unknown): boolean => Number(v) === 1;
    return {
      pending: bit(row["pending"]),
      freshClaim: bit(row["fresh_claim"]),
      dueClaim: bit(row["due_claim"]),
      liveAttempt: bit(row["live_attempt"]),
      pendingInput: bit(row["pending_input"]),
      openOp: bit(row["open_op"]),
      pendingDelivery: bit(row["pending_delivery"]),
    };
  }

  dueInspections(runId: string, limit: number): Array<{ claimToken: string; inspectGen: number }> {
    return this.db
      .prepare(
        `SELECT claim_token, inspect_gen FROM workflow_commands
         WHERE run_id = ? AND status = 'claimed' AND next_inspection_at <= datetime('now')
         ORDER BY next_inspection_at LIMIT ?`,
      )
      .all(runId, limit)
      .map((r) => ({ claimToken: r["claim_token"] as string, inspectGen: Number(r["inspect_gen"]) }));
  }

  listUnappliedIngress(limit: number): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT event_id, run_id, payload_hash, payload_json, received_at FROM workflow_ingress WHERE disposition = 'received' ORDER BY received_at LIMIT ?`)
      .all(limit);
  }

  /** Consume a received row without applying (terminal-run redrive only). */
  consumeIngressNoop(eventId: string): boolean {
    const res = this.db
      .prepare(`UPDATE workflow_ingress SET disposition = 'noop', applied_at = datetime('now') WHERE event_id = ? AND disposition = 'received'`)
      .run(eventId);
    return res.changes === 1;
  }
}
