export type OrcRunState =
  | "scheduled"
  | "dispatching"
  | "running"
  | "released"
  | "superseded";

// ── #1628: bounded contract-authoring policy ──────────────────────────────────

/** Max started authoring turns per project generation before terminal settlement. */
export const MAX_STARTED_CONTRACT_AUTHORING_TURNS = 3;
/** Max consecutive pre-start authoring failures before terminal settlement. */
export const MAX_CONSECUTIVE_UNSTARTABLE_AUTHORING_TURNS = 3;
/** Minimum interval between authoring claims for one project generation. */
export const MIN_AUTHORING_CLAIM_INTERVAL_MS = 5_000;

/**
 * #1628: in-process fact published after every committed Orc ownership
 * relinquishment (release/supersede). The reconciler wakes the affected
 * project from it; the boot sweep remains the durability floor.
 */
export interface OrcOwnershipReleasedV1 {
  readonly version: 1;
  readonly projectCardId: number;
  readonly runId: string;
  readonly intentKind: OrcIntentKind;
  readonly outcome: OrcRunOutcome;
  /** True when the run reached the dispatching→running bind. */
  readonly started: boolean;
}

export type OrcRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "project_terminal"
  | "generation_changed";

export type OrcIntentKind =
  | "contract_authoring"
  | "project_execution"
  | "project_review"
  | "repair_review"
  | "input_resume"
  | "operator_turn";

/**
 * #1680: stable bounded vocabulary persisted into `orc_project_runs.failure_code`
 * on every failed Orc run. Provider/model prose, prompts, tool arguments, and
 * exception messages never cross this boundary.
 */
export type OrcRunFailureCode =
  | "start_port_rejected"
  | "prompt_round_limit"
  | "provider_failure"
  | "intent_postcondition_unsatisfied"
  | "turn_cancelled";

export type OrcOriginKind = "local" | "peer";

export type OrcRunReason =
  | "context_missing"
  | "run_unknown"
  | "run_released"
  | "foreign_instance"
  | "project_mismatch"
  | "project_generation_mismatch"
  | "ownership_generation_mismatch"
  | "session_mismatch"
  | "execution_mismatch"
  | "intent_mismatch"
  | "origin_invalid"
  | "project_terminal"
  | "intent_not_actionable"
  | "occurrence_terminal"
  | "fuse_open"
  | "peer_relay_blocked"
  | "busy";

export interface OrcInvocationContextV2 {
  readonly version: 2;
  readonly runId: string;
  readonly intentKey: string;
  /** #1680: the persisted intent kind — copied from the claimed run row, never
   *  from a model argument or prompt. Schema presentation and execution-time
   *  authorization consume the same central intent-policy decision. */
  readonly intentKind: OrcIntentKind;
  /** #1680: optional run-scoped reference (review case id, input round, …). */
  readonly intentRef?: string;
  readonly projectCardId: number;
  readonly projectGeneration: number;
  readonly ownershipGeneration: number;
  readonly ownerPeer: string;
  readonly ownerInstanceId: string;
  readonly origin: {
    readonly kind: OrcOriginKind;
    readonly peer?: string;
  };
  readonly sessionId?: string;
  readonly executionId?: string;
}

/**
 * #1680: one-shot host-owned terminal outcome of an Orc turn. `intent_satisfied`
 * is distinct from cancellation and failure: it claims the durable intent
 * postcondition and ends the turn immediately.
 */
export type OrcTurnTerminal =
  | { kind: "intent_satisfied"; code: string }
  | { kind: "failed"; failureCode: OrcRunFailureCode }
  | { kind: "cancelled"; failureCode: "turn_cancelled" };

/**
 * #1680: host-owned one-shot turn control. The first `complete()` call wins;
 * every later call is rejected. An `intent_satisfied` terminal is only accepted
 * after the durable intent postcondition is re-read under the exact bound run
 * (never from a tool result string).
 */
export interface OrcTurnControl {
  readonly runId: string;
  /** Re-verify against durable state when needed and win the one-shot latch. */
  complete(terminal: OrcTurnTerminal): boolean;
  readonly completed: OrcTurnTerminal | null;
}

/**
 * #1680: one typed turn specification replacing the loose `(context, goal)`
 * start boundary. The immutable intent, its policy-derived prompt bound, and
 * the host-owned one-shot turn control travel together; callers cannot select
 * an independent intent, tool policy, or bound.
 */
export interface OrcTurnSpec {
  readonly context: OrcInvocationContextV2;
  readonly goal: string;
  readonly maxPromptRounds: number;
  readonly turnControl: OrcTurnControl;
}

export interface OrcProjectRunRow {
  id: string;
  intent_key: string;
  intent_kind: OrcIntentKind;
  intent_ref: string | null;
  /** #1675: the first claimant's goal, written once at insert and never overwritten. */
  goal: string;
  project_card_id: number;
  project_generation: number;
  ownership_generation: number;
  owner_peer: string;
  owner_instance_id: string;
  origin_kind: OrcOriginKind;
  origin_peer: string | null;
  session_id: string | null;
  execution_id: string | null;
  state: OrcRunState;
  outcome: OrcRunOutcome | null;
  failure_code: string | null;
  created_at: string;
  started_at: string | null;
  released_at: string | null;
  updated_at: string;
}

export type OrcRunClaimResult =
  | { kind: "claimed"; context: OrcInvocationContextV2 }
  | { kind: "idempotent"; context: OrcInvocationContextV2 }
  | { kind: "busy"; activeRunId: string }
  | { kind: "not_actionable"; reason: OrcRunReason }
  | { kind: "conflict"; reason: OrcRunReason };

export interface OrcClaimInput {
  projectCardId: number;
  intentKind: OrcIntentKind;
  intentRef?: string;
  /** #1675: the goal of the claiming turn. The first claimant's goal wins the run; later idempotent claims never replace it. */
  goal: string;
  originKind: OrcOriginKind;
  originPeer?: string;
  sourcePeer: string | null;
  cardSource: string;
  expectedProjectGeneration?: number;
}

export type OrcContextValidation =
  | { ok: true; row: OrcProjectRunRow }
  | { ok: false; reason: OrcRunReason };

export interface OrcProjectSession {
  projectCardId: number;
  runId: string;
  sessionId: string;
}

export function deriveIntentKey(
  intentKind: OrcIntentKind,
  projectCardId: number,
  projectGeneration: number,
  ref?: string,
): string {
  switch (intentKind) {
    case "contract_authoring":
      return `contract:${projectCardId}:${projectGeneration}`;
    case "project_execution":
      return `execute:${projectCardId}:${projectGeneration}`;
    case "project_review":
      return `review:${ref ?? projectCardId}`;
    case "repair_review":
      return `repair:${projectCardId}:${projectGeneration}`;
    case "input_resume":
      return `input:${projectCardId}:${projectGeneration}:${ref ?? "0"}`;
    case "operator_turn":
      return `operator:${ref ?? projectCardId}:${Date.now()}`;
  }
}

export function formatRunReason(reason: OrcRunReason): string {
  switch (reason) {
    case "context_missing": return "Orc invocation context is missing";
    case "run_unknown": return "Run ID not found";
    case "run_released": return "Run has already been released";
    case "foreign_instance": return "Run belongs to a different bridge instance";
    case "project_mismatch": return "Project card ID does not match the current run";
    case "project_generation_mismatch": return "Project supervision generation has changed";
    case "ownership_generation_mismatch": return "Ownership generation has been superseded";
    case "session_mismatch": return "Session ID does not match the bound run";
    case "execution_mismatch": return "Execution ID does not match the bound run";
    case "intent_mismatch": return "Intent identity does not match the bound run";
    case "origin_invalid": return "Project origin is missing or inconsistent with authenticated admission";
    case "project_terminal": return "Project is in a terminal state";
    case "intent_not_actionable": return "Underlying intent is no longer actionable";
    case "occurrence_terminal": return "Owning scheduled task occurrence is terminal — the project may never be restarted";
    case "fuse_open": return "Circuit breaker is open for this scope — operator reset required";
    case "peer_relay_blocked": return "Peer-origin project may not relay to third peers";
    case "busy": return "Another Orc intent owns this project";
  }
}
