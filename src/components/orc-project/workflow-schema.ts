/**
 * workflow-schema.ts — #1792 Task 2: durable workflow-runner persistence.
 *
 * Sibling tables in the shared task database (same handle as task_state/task_runs,
 * owned through the same schema-setup path). `task_runs` is untouched: one scheduled
 * occurrence per row, `idx_task_runs_one_live` unchanged, no workflow data inside it.
 * `worker_attempts` remains the sole worker-execution ledger — these tables reference
 * attempt IDs and never copy lifecycle.
 *
 * No REFERENCES clauses (consistent with the task, orc, and project_review tables,
 * which carry zero FKs): cross-table consistency is enforced by same-transaction
 * existence checks, not by FK pragma (enabling it globally would newly enforce the
 * legacy REFERENCES on old rows — see specs/1792/task1-checkpoint.md §2.6).
 */
import type { TaskStateDb } from "../tasks/task-state-schema.js";

const TAG = "workflow-schema";

export const WORKFLOW_DDL = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  root_kind TEXT NOT NULL CHECK(root_kind IN ('scheduled','interactive','peer')),
  root_card_id INTEGER NOT NULL,
  scheduled_run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL CHECK(state IN ('admitted','planning','dispatched','executing',
    'reviewing','repairing','awaiting_input','delivering','succeeded','failed','cancelled')),
  state_version INTEGER NOT NULL DEFAULT 0,
  client_operation_id TEXT UNIQUE NOT NULL,
  budgets_json TEXT NOT NULL,
  failure_code TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_audit
  ON workflow_runs(root_card_id) WHERE state NOT IN ('succeeded','failed','cancelled');
CREATE INDEX IF NOT EXISTS idx_workflow_runs_card
  ON workflow_runs(root_card_id);

CREATE TABLE IF NOT EXISTS workflow_plan_revisions (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (run_id, revision)
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('work','synthesis','planning','review','delivery')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','succeeded','failed','skipped','cancelled')),
  worker_card_id INTEGER,
  attempt_id TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, revision, node_id)
);
CREATE TABLE IF NOT EXISTS workflow_node_deps (
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  depends_on_node_id TEXT NOT NULL,
  satisfied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, revision, node_id, depends_on_node_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_node_deps_blocked
  ON workflow_node_deps(run_id, revision, depends_on_node_id, satisfied);

CREATE TABLE IF NOT EXISTS workflow_operations (
  op_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('planning','review')),
  revision INTEGER,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','claimed','running','succeeded','failed','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_operations_run
  ON workflow_operations(run_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_operations_single_open
  ON workflow_operations(run_id, kind) WHERE status IN ('pending','claimed','running');

CREATE TABLE IF NOT EXISTS workflow_budgets (
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL
    CHECK(scope IN ('work_retry','plan_revision','review_repair','protocol_correction')),
  allowed INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, scope)
);

CREATE TABLE IF NOT EXISTS workflow_commands (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  action TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','claimed','done','cancelled')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT,
  owner TEXT,
  claim_token TEXT,
  inspect_gen INTEGER NOT NULL DEFAULT 0,
  consecutive_inconclusive INTEGER NOT NULL DEFAULT 0,
  next_inspection_at TEXT,
  PRIMARY KEY (run_id, generation, node_id, action, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_workflow_commands_pending
  ON workflow_commands(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_workflow_commands_pending_run
  ON workflow_commands(run_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_workflow_commands_claim_due
  ON workflow_commands(run_id, next_inspection_at)
  WHERE status = 'claimed' AND next_inspection_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS workflow_ingress (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('received','applied','noop')),
  received_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_ingress_unapplied
  ON workflow_ingress(received_at) WHERE disposition = 'received';

CREATE TABLE IF NOT EXISTS workflow_deliveries (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  obligation_json TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending'
    CHECK(outcome IN ('pending','acknowledged','failed','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, node_id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_deliveries_pending
  ON workflow_deliveries(run_id) WHERE outcome = 'pending';
`;

/** Supporting indexes on pre-existing tables (partial → zero cost outside predicate). */
const WORKFLOW_SUPPORT_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_worker_attempt_root
  ON worker_attempts(root_project_card_id, lifecycle) WHERE root_project_card_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_project_input_pending
  ON project_input_requests(project_card_id) WHERE status = 'pending';
`;

/**
 * #1792: create sibling workflow tables + support indexes. Idempotent
 * (CREATE TABLE/INDEX IF NOT EXISTS); safe to re-run. The workflow tables are new
 * at cutover, so no ALTER backfill path is needed — fresh and existing databases
 * converge on the same CREATE text.
 */
export function initWorkflowSchema(db: TaskStateDb): void {
  db.exec(WORKFLOW_DDL);
  // Support indexes reference tables owned by other stores; skip silently when
  // those tables do not exist yet (lazy store construction order).
  try {
    db.exec(WORKFLOW_SUPPORT_INDEXES);
  } catch {
    // Tables absent (e.g. harness DBs that only migrated workflow tables).
  }
}

export { TAG as WORKFLOW_SCHEMA_TAG };
