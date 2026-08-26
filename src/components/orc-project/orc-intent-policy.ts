/**
 * orc-intent-policy.ts — #1680: the single provider-neutral Orc intent policy
 * registry.
 *
 * One intent row owns: the prompt-round bound, the allowed tool surface,
 * durable actionability, and the durable completion postcondition. Both the
 * shared tool-presentation boundary (createPiAgentTools) and the execution-time
 * authorization gate (executeToolCall) consume the same tool-surface decision;
 * Spin consumes the prompt bound and the completion postcondition. Model
 * arguments, prompts, and provider candidates can never select or change a
 * policy — the trusted intent kind comes only from the persisted run row via
 * OrcInvocationContextV2.
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
  /** A direct child card carrying a worker contract (Worker/repair ownership). */
  readonly workerOwnedChild: boolean;
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

const AUTHORING_TOOLS: ReadonlySet<string> = new Set(["define_project_contract"]);

const EXECUTION_TOOLS: ReadonlySet<string> = new Set([
  "execute_bash",
  "artifact_attach",
  "artifact_pull",
  "artifact_push",
  "channel_post",
  "channel_read",
  "kanban_manage",
  "memory_recall",
  "peer_ask_help",
  "peer_help_status",
  "peer_withdraw_help",
  "spawn_worker",
  "check_workers",
  "cancel_worker",
  "review_worker_failure",
  // #1728: explicit durable-handoff yield — ends the execute turn once a
  // durable owner (Worker/contribution/review case) exists.
  "yield_turn",
]);

const REVIEW_TOOLS: ReadonlySet<string> = new Set([
  "get_project_review_case",
  "review_project",
  "artifact_pull",
  "channel_read",
]);

const REPAIR_TOOLS: ReadonlySet<string> = new Set([
  "check_workers",
  "cancel_worker",
  "review_worker_failure",
  "artifact_pull",
  "channel_read",
]);

const INPUT_RESUME_TOOLS: ReadonlySet<string> = new Set([
  "get_project_review_case",
  "review_project",
  "artifact_pull",
  "channel_read",
]);

const POLICIES: Record<OrcIntentKind, OrcIntentPolicy> = {
  contract_authoring: {
    intentKind: "contract_authoring",
    maxPromptRounds: 3,
    allowedTools: AUTHORING_TOOLS,
    isActionable: (s) => !s.contractExists && s.supervisionState === "awaiting_contract",
    // A committed contract that advanced supervision to `executing` satisfies
    // the authoring intent durably.
    completion: (s) => s.contractExists && s.supervisionState === "executing"
      ? { satisfied: true, code: "contract_defined" }
      : { satisfied: false, code: "intent_postcondition_unsatisfied" },
  },
  project_execution: {
    intentKind: "project_execution",
    maxPromptRounds: 25,
    allowedTools: EXECUTION_TOOLS,
    isActionable: (s) => s.supervisionState === "executing"
      && s.contractExists
      && !s.projectTerminal
      && !s.workerOwnedChild
      && !s.contributionActive
      && !s.openReviewCase
      && !s.inputRequestsOutstanding,
    // A durable owner (Worker/contribution/review) or a terminal project means
    // the execution intent has handed off; synthesis without any durable owner
    // is unsatisfied.
    completion: (s) => s.projectTerminal || s.workerOwnedChild || s.contributionActive || s.openReviewCase
      ? { satisfied: true, code: "project_execution_handed_off" }
      : { satisfied: false, code: "intent_postcondition_unsatisfied" },
  },
  project_review: {
    intentKind: "project_review",
    // #1725: 6, not 3. A successful review turn uses two provider requests
    // (read case, then review_project, which satisfies the intent and stops
    // safety mid-round), so 3 left only one spare request — consumed by a
    // single artifact_pull/channel_read or one invalid proposal. Six leaves
    // four spare requests while keeping the bound finite.
    maxPromptRounds: 6,
    allowedTools: REVIEW_TOOLS,
    isActionable: (s) => s.openReviewCase && !s.projectTerminal,
    // The referenced case is consumed once no open case remains for the
    // project, or the project reached terminal state.
    completion: (s) => s.projectTerminal || !s.openReviewCase
      ? { satisfied: true, code: "review_case_consumed" }
      : { satisfied: false, code: "intent_postcondition_unsatisfied" },
  },
  repair_review: {
    intentKind: "repair_review",
    maxPromptRounds: 5,
    allowedTools: REPAIR_TOOLS,
    isActionable: (s) => s.supervisionState === "repair_planned" || s.supervisionState === "repairing",
    // A repair decision that advanced durable ownership leaves the repair
    // states; a terminal project also satisfies.
    completion: (s) => s.projectTerminal
      || (s.supervisionState !== "repair_planned" && s.supervisionState !== "repairing")
      ? { satisfied: true, code: "repair_decision_advanced" }
      : { satisfied: false, code: "intent_postcondition_unsatisfied" },
  },
  input_resume: {
    intentKind: "input_resume",
    // #1725: same review tool surface and the same read-then-submit turn shape
    // as project_review — same bound.
    maxPromptRounds: 6,
    allowedTools: INPUT_RESUME_TOOLS,
    isActionable: (s) => s.inputRequestsOutstanding && !s.projectTerminal,
    // The input/review request is consumed once no outstanding request row
    // remains for the project.
    completion: (s) => s.projectTerminal || !s.inputRequestsOutstanding
      ? { satisfied: true, code: "input_request_consumed" }
      : { satisfied: false, code: "intent_postcondition_unsatisfied" },
  },
  operator_turn: {
    intentKind: "operator_turn",
    maxPromptRounds: 25,
    allowedTools: "operator_surface",
    isActionable: () => true,
    // An operator turn reaches normal terminal output when the model ends it.
    completion: () => ({ satisfied: true, code: "operator_turn_complete" }),
  },
};

/** #1680: the exact policy row for a persisted intent kind. */
export function intentPolicyFor(intentKind: OrcIntentKind): OrcIntentPolicy {
  return POLICIES[intentKind];
}

/**
 * #1728: attempt-aware effective prompt bound. Fixed for every intent except
 * `project_review`, whose durable review-dispatch stream escalates from the
 * #1725 base of 6 by two requests per additional dispatch attempt, capped at
 * 10 (`6, 8, 10, 10, 10` across the five permitted attempts). The ordinal is
 * one-based trusted scheduler input: non-finite, non-integer, zero, or negative
 * values fail closed to the base bound; large ordinals cap at 10.
 */
export function effectiveMaxPromptRounds(intentKind: OrcIntentKind, dispatchOrdinal?: number): number {
  const base = POLICIES[intentKind].maxPromptRounds;
  if (intentKind !== "project_review") return base;
  const ordinal = dispatchOrdinal !== undefined
    && Number.isInteger(dispatchOrdinal)
    && dispatchOrdinal >= 1
    ? dispatchOrdinal
    : 1;
  return Math.min(base + (ordinal - 1) * 2, 10);
}

/** #1680: the allowed tool surface for schema presentation and execution
 *  authorization. `operator_surface` means the full current operator surface. */
export function orcAllowedToolsFor(intentKind: OrcIntentKind): ReadonlySet<string> | "operator_surface" {
  return POLICIES[intentKind].allowedTools;
}

/** #1680: true when an Orc tool name is legal for the given intent surface. */
export function orcToolAllowedOnIntent(toolName: string, intentKind: OrcIntentKind): boolean {
  const surface = orcAllowedToolsFor(intentKind);
  if (surface === "operator_surface") return true;
  return surface.has(toolName);
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
  let workerOwnedChild = false;

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
  } catch { /* fail closed */ }

  try {
    const row = db.prepare(`SELECT 1 FROM project_review_cases WHERE project_card_id = ? AND status = 'open' LIMIT 1`).get(projectCardId);
    openReviewCase = row !== undefined;
  } catch { /* fail closed */ }

  try {
    const row = db.prepare(`SELECT 1 FROM project_input_requests WHERE project_card_id = ? AND status IN ('pending','answered') LIMIT 1`).get(projectCardId);
    inputRequestsOutstanding = row !== undefined;
  } catch { /* fail closed */ }

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
  } catch { /* fail closed */ }

  return {
    supervisionState,
    supervisionGeneration,
    contractExists,
    projectTerminal: supervisionState !== null && TERMINAL_SUPERVISION.has(supervisionState),
    contributionActive,
    openReviewCase,
    inputRequestsOutstanding,
    workerOwnedChild,
  };
}

/** #1680: stable bounded failure code for an unsatisfied durable postcondition. */
export const INTENT_POSTCONDITION_UNSATISFIED: OrcRunFailureCode = "intent_postcondition_unsatisfied";
