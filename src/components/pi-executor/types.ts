export type PiRunOrigin = "user" | "agent" | "peer";

export type PiRunStatus =
  | "queued" | "starting" | "running" | "awaiting_input"
  | "cancelling" | "completed" | "failed" | "cancelled"
  | "interrupted";

export type ResumeCapability =
  | "available" | "never_started" | "session_missing"
  | "policy_changed" | "unsupported";

export type PiPendingRequestType = "select" | "confirm" | "input" | "editor";
export type PiUiReply = string | number | boolean | null;
export type UiReplyOutcome = "claimed" | "delivery_unknown";
export type RpcDelivery = "not_written" | "written_unacknowledged";

export type PendingUiClaim =
  | { claimed: true; requestType: PiPendingRequestType }
  | { claimed: false; reason: "missing" | "wrong_generation" | "wrong_status" | "request_mismatch" | "already_consumed" };

export type PendingUiSetResult =
  | { ok: true }
  | { ok: false; reason: "wrong_status" | "wrong_generation" | "duplicate_request" | "busy" | "missing" };

export type UiResponseResult = {
  ok: boolean;
  delivery: RpcDelivery;
  result?: unknown;
  error?: string;
};

export interface PiModelSelection {
  provider: string;
  modelId: string;
  thinking?: string;
}

export interface PiRunOwner {
  principalId: string;
  origin: PiRunOrigin;
  platform?: string;
  chatId?: string;
  peer?: string;
}

export interface PiRunRequest {
  goal: string;
  workspaceAlias: string;
  priority?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  model?: PiModelSelection;
  owner: PiRunOwner;
}

export interface PiRunRef {
  runId: string;
  cardId: number;
  sessionId: string;
  generation: number;
}

export interface PiRunRecord {
  id: string;
  cardId: number;
  workspaceAlias: string;
  operationalGoal: string;
  ownerPrincipalId: string;
  origin: PiRunOrigin;
  originPlatform?: string;
  originChatId?: string;
  originPeer?: string;
  executionGeneration: number;
  currentSessionId?: string;
  status: PiRunStatus;
  resumeCapability: ResumeCapability;
  piSessionId?: string;
  piSessionFile?: string;
  observedPid?: number;
  modelProvider?: string;
  modelId?: string;
  thinking?: string;
  pendingRequestId?: string;
  pendingRequestType?: PiPendingRequestType;
  lastUiReplyRequestId?: string;
  lastUiReplyGeneration?: number;
  lastUiReplyOutcome?: UiReplyOutcome;
  createdAt: string;
  updatedAt: string;
  lastRpcActivityAt?: string;
  resultSummary?: string;
  changedFilesSummary?: string;
  usageJson?: string;
  error?: string;
}

export interface PiRunView {
  runId: string;
  cardId: number;
  sessionId?: string;
  status: PiRunStatus;
  resumeCapability: ResumeCapability;
  workspaceAlias: string;
  owner: PiRunOwner;
  modelProvider?: string;
  modelId?: string;
  thinking?: string;
  pendingRequestId?: string;
  pendingRequestType?: PiPendingRequestType;
  lastUiReplyOutcome?: UiReplyOutcome;
  generation: number;
  createdAt: string;
  updatedAt: string;
  lastRpcActivityAt?: string;
  resultSummary?: string;
  changedFilesSummary?: string;
  error?: string;
}

export type ExecutionTarget =
  | { executor?: "agent" }
  | {
      executor: "pi";
      workspaceAlias: string;
      model?: PiModelSelection;
    };

export const MAX_GOAL_CHARS = 4000;
export const MAX_PROGRESS_ENTRIES = 50;
export const MAX_PROGRESS_BYTES = 32 * 1024;
export const MAX_RPC_LINE_BYTES = 16 * 1024;
export const MAX_STDERR_BYTES = 4 * 1024;
export const MAX_SUMMARY_CHARS = 1000;
export const MAX_ERROR_CHARS = 500;
export const MAX_UI_OPTIONS = 10;
export const MAX_UI_OPTION_CHARS = 200;
export const MAX_UI_TITLE_CHARS = 200;
export const MAX_UI_DESCRIPTION_CHARS = 1000;
export const MAX_USAGE_JSON_CHARS = 1000;
export const MAX_CHANGED_FILES_CHARS = 2000;
export const MAX_EVIDENCE_COMMAND_CHARS = 200;
