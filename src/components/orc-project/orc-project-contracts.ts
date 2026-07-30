export type OrcRunState =
  | "scheduled"
  | "dispatching"
  | "running"
  | "released"
  | "superseded";

export type OrcRunOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "stale"
  | "project_terminal"
  | "generation_changed";

export type OrcIntentKind =
  | "contract_authoring"
  | "project_review"
  | "repair_review"
  | "input_resume"
  | "operator_turn";

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
  | "project_terminal"
  | "intent_not_actionable"
  | "peer_relay_blocked"
  | "busy";

export interface OrcInvocationContextV1 {
  readonly version: 1;
  readonly runId: string;
  readonly intentKey: string;
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

export interface OrcProjectRunRow {
  id: string;
  intent_key: string;
  intent_kind: OrcIntentKind;
  intent_ref: string | null;
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
  | { kind: "claimed"; context: OrcInvocationContextV1 }
  | { kind: "idempotent"; context: OrcInvocationContextV1 }
  | { kind: "busy"; activeRunId: string }
  | { kind: "not_actionable"; reason: OrcRunReason }
  | { kind: "conflict"; reason: OrcRunReason };

export interface OrcClaimInput {
  projectCardId: number;
  intentKind: OrcIntentKind;
  intentRef?: string;
  originKind: OrcOriginKind;
  originPeer?: string;
  sourcePeer: string | null;
  cardSource: string;
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
    case "project_terminal": return "Project is in a terminal state";
    case "intent_not_actionable": return "Underlying intent is no longer actionable";
    case "peer_relay_blocked": return "Peer-origin project may not relay to third peers";
    case "busy": return "Another Orc intent owns this project";
  }
}
