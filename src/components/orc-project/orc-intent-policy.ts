/**
 * orc-intent-policy.ts — #1680: the single provider-neutral Orc intent policy
 * registry.
 *
 * #1792: the supervised scheduling surface is deleted — the workflow runner
 * dispatches all work now. Only the `operator_turn` policy row remains. The
 * shared tool-presentation boundary (createPiAgentTools) and the
 * execution-time authorization gate (executeToolCall) consume the same
 * tool-surface decision via `orcToolAllowedOnIntent`; the trusted intent kind
 * comes only from the persisted run row via OrcInvocationContextV2. Model
 * arguments, prompts, and provider candidates can never select or change a
 * policy.
 *
 * `hasAllLanesTerminal` and `readOrcProjectSnapshot` are retained unchanged:
 * `orc-project-run-store.ts` still imports both (claim gate + salvage
 * eligibility), so deleting them here would break module load. Their
 * caller-side removal belongs to the run-store retirement slice.
 */

import type { TaskDatabase } from "../tasks/kanban-board.js";
import type { OrcIntentKind, OrcRunFailureCode } from "./orc-project-contracts.js";

/**
 * #1680: durable read-only snapshot used by actionability and completion
 * decisions. Reads fail closed to the least-assertive value: a missing table or
 * a read failure can never satisfy an intent postcondition.
 */
export interface OrcProjectSnapshot {
  readonly supervisionState: string | null;
  readonly supervisionGeneration: number | null;
  readonly contractExists: boolean;
  readonly projectTerminal: boolean;
  readonly contributionActive: boolean;
  readonly openReviewCase: boolean;
  readonly inputRequestsOutstanding: boolean;
  /** Every higher-priority-owner query completed without a read error. */
  readonly ownerReadsComplete: boolean;
  /** A direct child card carrying a worker contract (Worker/repair ownership). */
  readonly workerOwnedChild: boolean;
  /** #1789: at least one W lane exists and every W lane is terminal. */
  readonly allLanesTerminal: boolean;
}

export interface OrcIntentCompletion {
  satisfied: boolean;
  code: string;
}

export interface OrcIntentPolicy {
  readonly intentKind: OrcIntentKind;
  readonly maxPromptRounds: number;
  readonly allowedTools: "operator_surface" | ReadonlySet<string>;
  isActionable(snapshot: OrcProjectSnapshot): boolean;
  completion(snapshot: OrcProjectSnapshot): OrcIntentCompletion;
}

const TERMINAL_SUPERVISION = new Set(["accepted", "blocked"]);

/**
 * #1792: the only surviving policy row. Supervised tool surfaces
 * (`AUTHORING_TOOLS`, `EXECUTION_TOOLS` + `yield_turn`, `REVIEW_TOOLS`,
 * `REPAIR_TOOLS`, `INPUT_RESUME_TOOLS`) and the supervised
 * `isActionable`/`completion` closures (`contract_authoring`,
 * `project_execution`, `project_review`, `repair_review`, `input_resume`)
 * are deleted — verified 2026-09-10 on `dev`: no production producer
 * remains (coordinator `schedule*` retired; `claimSalvageExecution`'s sole
 * caller `scheduleProjectSalvage` retired with it).
 */
const OPERATOR_POLICY: OrcIntentPolicy = {
  intentKind: "operator_turn",
  maxPromptRounds: 25,
  allowedTools: "operator_surface",
  isActionable: () => true,
  // An operator turn reaches normal terminal output when the model ends it.
  completion: () => ({ satisfied: true, code: "operator_turn_complete" }),
};

const POLICIES: Partial<Record<OrcIntentKind, OrcIntentPolicy>> = {
  operator_turn: OPERATOR_POLICY,
};

/** #1792: fail-closed for the deleted supervised kinds — they have no
 *  production producer, so reaching here is a programmer error, never a
 *  schedulable state. */
function deadIntentError(intentKind: OrcIntentKind): Error {
  return new Error(`orc-intent-policy: dead supervised intent kind (deleted #1792): ${intentKind}`);
}

/** #1680: the exact policy row for a persisted intent kind. Throws for the
 *  deleted supervised kinds. */
export function intentPolicyFor(intentKind: OrcIntentKind): OrcIntentPolicy {
  const policy = POLICIES[intentKind];
  if (!policy) throw deadIntentError(intentKind);
  return policy;
}

/**
 * #1728: attempt-aware effective prompt bound.
 *
 * #1792: only `operator_turn` remains, so the bound is fixed at 25 and the
 * `project_review` dispatch-ordinal escalation is deleted with its policy.
 * The `dispatchOrdinal` parameter is retained (ignored) so the
 * coordinator-era call shape keeps compiling for any in-flight caller.
 */
export function effectiveMaxPromptRounds(intentKind: OrcIntentKind, _dispatchOrdinal?: number): number {
  const policy = POLICIES[intentKind];
  if (!policy) throw deadIntentError(intentKind);
  return policy.maxPromptRounds;
}

/** #1680: the allowed tool surface for schema presentation and execution
 *  authorization. `operator_surface` means the full current operator surface.
 *  Throws for the deleted supervised kinds — use `orcToolAllowedOnIntent`
 *  for a non-throwing authorization check. */
export function orcAllowedToolsFor(intentKind: OrcIntentKind): ReadonlySet<string> | "operator_surface" {
  const policy = POLICIES[intentKind];
  if (!policy) throw deadIntentError(intentKind);
  return policy.allowedTools;
}

/**
 * #1680: true when an Orc tool name is legal for the given intent surface.
 * Fail-closed total function: deleted supervised kinds deny every tool
 * (never throw), so the transport gate degrades to denial rather than a
 * crash on historical contexts.
 */
export function orcToolAllowedOnIntent(toolName: string, intentKind: OrcIntentKind): boolean {
  const policy = POLICIES[intentKind];
  if (!policy) return false;
  const surface = policy.allowedTools;
  if (surface === "operator_surface") return true;
  return surface.has(toolName);
}

/**
 * #1789: true when the project has at least one W lane and every W lane is
 * terminal (`done`/`delivered`/`failed`). Uses the canonical terminal lane
 * set inline so lane-terminal reads and the claim transaction cannot disagree.
 *
 * Zero lanes → false: a project that never spawned has not finished a work
 * phase, and `project_execution.completion` must not read that as a handoff.
 * Never requires `done` specifically — `done` is transient (the delivery
 * sweeper moves any done card to delivering/delivered), which is the #1789 bug.
 * Fail-closed: any read error, missing table, or zero children returns false.
 */
export function hasAllLanesTerminal(db: TaskDatabase, projectCardId: number): boolean {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status NOT IN ('done','delivered','failed') THEN 1 ELSE 0 END) AS pending
         FROM kanban_board
        WHERE parent_id = ? AND type = 'W'`
    ).get(projectCardId) as { total: number; pending: number | null } | undefined;
    if (!row || row.total === 0) return false;
    return (row.pending ?? 1) === 0;
  } catch {
    return false;
  }
}

/**
 * #1680: durable read-only snapshot of one project for intent decisions.
 * Reads are fail-closed: any read error yields the least-assertive value so a
 * transient failure can never satisfy a durable postcondition.
 */
export function readOrcProjectSnapshot(db: TaskDatabase, projectCardId: number): OrcProjectSnapshot {
  let supervisionState: string | null = null;
  let supervisionGeneration: number | null = null;
  let contractExists = false;
  let contributionActive = false;
  let openReviewCase = false;
  let inputRequestsOutstanding = false;
  let ownerReadsComplete = true;
  let workerOwnedChild = false;
  let allLanesTerminal = false;

  try {
    const sup = db.prepare(`SELECT state, generation FROM project_supervision WHERE project_card_id = ?`).get(projectCardId) as { state: string; generation: number } | undefined;
    if (sup) {
      supervisionState = sup.state;
      supervisionGeneration = sup.generation;
    }
  } catch { /* fail closed */ }

  try {
    const row = db.prepare(`SELECT 1 FROM project_contracts WHERE project_card_id = ? LIMIT 1`).get(projectCardId);
    contractExists = row !== undefined;
  } catch { /* fail closed */ }

  try {
    const row = db.prepare(`
      SELECT 1
        FROM peer_contributions AS pc
        JOIN kanban_board AS proxy ON proxy.id = pc.proxy_card_id
       WHERE pc.project_card_id = ?
         AND pc.state IN ('accepted', 'running')
         AND proxy.status IN ('queued', 'running')
       LIMIT 1
    `).get(projectCardId);
    contributionActive = row !== undefined;
  } catch { ownerReadsComplete = false; }

  try {
    const row = db.prepare(`SELECT 1 FROM project_review_cases WHERE project_card_id = ? AND status = 'open' LIMIT 1`).get(projectCardId);
    openReviewCase = row !== undefined;
  } catch { ownerReadsComplete = false; }

  try {
    const row = db.prepare(`SELECT 1 FROM project_input_requests WHERE project_card_id = ? AND status IN ('pending','answered') LIMIT 1`).get(projectCardId);
    inputRequestsOutstanding = row !== undefined;
  } catch { ownerReadsComplete = false; }

  try {
    const row = db.prepare(`
      SELECT 1
        FROM kanban_board AS k
        JOIN worker_contracts AS wc ON wc.card_id = k.id
       WHERE k.parent_id = ?
         AND k.status IN ('queued', 'running')
       LIMIT 1
    `).get(projectCardId);
    workerOwnedChild = row !== undefined;
  } catch { ownerReadsComplete = false; }

  try {
    allLanesTerminal = hasAllLanesTerminal(db, projectCardId);
  } catch { /* fail closed */ }

  return {
    supervisionState,
    supervisionGeneration,
    contractExists,
    projectTerminal: supervisionState !== null && TERMINAL_SUPERVISION.has(supervisionState),
    contributionActive,
    openReviewCase,
    inputRequestsOutstanding,
    ownerReadsComplete,
    workerOwnedChild,
    allLanesTerminal,
  };
}

/** #1680: stable bounded failure code for an unsatisfied durable postcondition. */
export const INTENT_POSTCONDITION_UNSATISFIED: OrcRunFailureCode = "intent_postcondition_unsatisfied";
