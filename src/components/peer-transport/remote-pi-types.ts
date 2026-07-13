/**
 * peer-transport/remote-pi-types.ts — Remote Pi lifecycle and control types (#1358).
 *
 * Versioned schemas for lifecycle events, public projections, cursors,
 * acknowledgements, commands, responses, and errors.
 */

/**
 * Event kinds representing the lifecycle of a remote Pi run.
 */
export type RemotePiEventKind =
  | "accepted"
  | "queued"
  | "starting"
  | "running"
  | "progress"
  | "awaiting_input"
  | "input_cleared"
  | "cancelling"
  | "interrupted"
  | "resumed"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Delivery policy options for remote Pi execution results.
 */
export type DeliveryPolicy = "leave_remote" | "patch_artifact" | "commit_push";

/**
 * Delivery status for a remote Pi run.
 */
export type DeliveryStatus = "pending" | "succeeded" | "failed" | "not_requested";

/**
 * Pending input request type.
 */
export type PendingInputType = "select" | "confirm" | "input" | "editor";

/**
 * Bounded public projection of a remote Pi run state.
 * Contains only information safe to transmit to the origin peer.
 */
export interface RemotePiPublicProjectionV1 {
  /** Current run status */
  status: string;
  /** Current generation number */
  generation: number;
  /** Last activity timestamp (ISO 8601) */
  last_activity_at?: string;
  /** Pending input information when awaiting_input */
  pending_input?: {
    request_id: string;
    type: PendingInputType;
    title?: string;
    prompt?: string;
    options?: Array<{ id: string; label: string }>;
  };
  /** Bounded result summary (terminal) */
  result_summary?: string;
  /** Bounded error summary (terminal) */
  error_summary?: string;
  /** Token usage summary (terminal) */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  /** Changed files summary (terminal) */
  changed_files_summary?: string;
  /** Resume capability token (if available) */
  resume_capability?: string;
  /** Delivery policy outcome */
  delivery?: {
    policy: DeliveryPolicy;
    status: DeliveryStatus;
    references?: Array<{
      kind: string;
      id: string;
      sha256?: string;
      size?: number;
    }>;
    error?: string;
  };
}

/**
 * Remote Pi lifecycle event envelope (V1).
 */
export interface RemotePiEventV1 {
  /** Protocol version */
  version: 1;
  /** Unique event identifier (derived from run_id + sequence) */
  event_id: string;
  /** SHA-256 of canonical event payload (excluding this field) */
  content_sha256: string;
  /** Origin peer identifier */
  origin_peer: string;
  /** Origin request ID for correlation */
  origin_request_id: string;
  /** Remote run ID */
  run_id: string;
  /** Remote card ID */
  card_id: number;
  /** Generation number */
  generation: number;
  /** Monotonically increasing sequence per run (never resets) */
  sequence: number;
  /** Event kind */
  kind: RemotePiEventKind;
  /** Event occurrence timestamp (ISO 8601) */
  occurred_at: string;
  /** Complete public projection at this event */
  projection: RemotePiPublicProjectionV1;
}

/**
 * Event cursor for catch-up and acknowledgement.
 */
export interface RemotePiEventCursor {
  run_id: string;
  sequence: number;
}

/**
 * Event list request for catch-up.
 */
export interface RemotePiEventsListRequestV1 {
  version: 1;
  run_id: string;
  after_sequence: number;
  limit?: number;
}

/**
 * Event list response.
 */
export interface RemotePiEventsListResponseV1 {
  version: 1;
  run_id: string;
  events: RemotePiEventV1[];
  has_more: boolean;
}

/**
 * Event acknowledgement request.
 */
export interface RemotePiEventsAckRequestV1 {
  version: 1;
  run_id: string;
  sequence: number;
}

/**
 * Event acknowledgement response.
 */
export interface RemotePiEventsAckResponseV1 {
  version: 1;
  run_id: string;
  acknowledged_sequence: number;
}

/**
 * Command action types.
 */
export type RemotePiCommandAction = "status" | "reply" | "steer" | "cancel" | "resume";

/**
 * Remote Pi command variants (V1).
 */
export type RemotePiCommandV1 =
  | { action: "status" }
  | { action: "reply"; request_id: string; value: unknown }
  | { action: "steer"; instruction: string }
  | { action: "cancel" }
  | { action: "resume"; approval: ResumeApprovalV1 };

/**
 * Resume approval assertion.
 * Created after explicit operator approval on the origin peer.
 */
export interface ResumeApprovalV1 {
  approval_id: string;
  run_id: string;
  origin_peer: string;
  command_id: string;
  approving_principal: string;
  issued_at: string;
  expires_at: string;
  interrupted_generation: number;
  approval_statement_sha256: string;
}

/**
 * Remote Pi control request envelope (V1).
 */
export interface RemotePiControlRequestV1 {
  version: 1;
  command_id: string;
  run_id: string;
  expected_generation: number;
  command: RemotePiCommandV1;
}

/**
 * Control response outcome types.
 */
export type ControlOutcome = "succeeded" | "rejected" | "outcome_unknown";

/**
 * Remote Pi control response (V1).
 */
export interface RemotePiControlResponseV1 {
  version: 1;
  command_id: string;
  outcome: ControlOutcome;
  projection?: RemotePiPublicProjectionV1;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Command ledger state for idempotency.
 */
export type CommandLedgerState =
  | "received"
  | "dispatch_started"
  | "completed"
  | "rejected"
  | "outcome_unknown";

/**
 * Error codes for control responses.
 */
export type ControlErrorCode =
  | "UNKNOWN_RUN"
  | "FORBIDDEN_PEER"
  | "STALE_GENERATION"
  | "INVALID_STATE"
  | "MISSING_REQUEST"
  | "DUPLICATE_COMMAND"
  | "CONFLICTING_COMMAND"
  | "INVALID_APPROVAL"
  | "EXPIRED_APPROVAL"
  | "MISSING_RESUME_CAPABILITY"
  | "SESSION_CONTINUITY_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_ACTION"
  | "INTERNAL_ERROR";

/**
 * Size bounds for safety and DoS prevention.
 */
export const REMOTE_PI_BOUNDS = {
  /** Maximum event payload size in bytes */
  MAX_EVENT_SIZE: 100_000,
  /** Maximum command payload size in bytes */
  MAX_COMMAND_SIZE: 50_000,
  /** Maximum response payload size in bytes */
  MAX_RESPONSE_SIZE: 100_000,
  /** Maximum events per list/catch-up request */
  MAX_EVENTS_PER_LIST: 100,
  /** Maximum progress events to retain (beyond critical events) */
  MAX_RETAINED_PROGRESS: 50,
  /** Maximum string length in projection */
  MAX_PROJECTION_STRING: 5_000,
  /** Maximum number of options in pending_input */
  MAX_INPUT_OPTIONS: 10,
  /** Maximum number of delivery references */
  MAX_DELIVERY_REFERENCES: 20,
  /** Maximum instruction length for steer command */
  MAX_STEER_INSTRUCTION: 2_000,
  /** Maximum pending request reply value size */
  MAX_REPLY_VALUE_SIZE: 10_000,
} as const;

/**
 * Validate a projection string against bounds.
 */
export function validateBoundedString(value: string | undefined, fieldName: string): void {
  if (value && Buffer.byteLength(value, "utf-8") > REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING) {
    throw new Error(`${fieldName} exceeds ${REMOTE_PI_BOUNDS.MAX_PROJECTION_STRING} bytes`);
  }
}

/**
 * Validate a public projection against bounds.
 */
export function validatePublicProjection(projection: RemotePiPublicProjectionV1): void {
  validateBoundedString(projection.status, "status");
  validateBoundedString(projection.result_summary, "result_summary");
  validateBoundedString(projection.error_summary, "error_summary");
  validateBoundedString(projection.changed_files_summary, "changed_files_summary");
  validateBoundedString(projection.resume_capability, "resume_capability");
  validateBoundedString(projection.delivery?.error, "delivery.error");

  if (projection.pending_input) {
    validateBoundedString(projection.pending_input.request_id, "pending_input.request_id");
    validateBoundedString(projection.pending_input.title, "pending_input.title");
    validateBoundedString(projection.pending_input.prompt, "pending_input.prompt");

    if (projection.pending_input.options) {
      if (projection.pending_input.options.length > REMOTE_PI_BOUNDS.MAX_INPUT_OPTIONS) {
        throw new Error(`pending_input.options exceeds ${REMOTE_PI_BOUNDS.MAX_INPUT_OPTIONS} items`);
      }
      for (const opt of projection.pending_input.options) {
        validateBoundedString(opt.id, "pending_input.options[].id");
        validateBoundedString(opt.label, "pending_input.options[].label");
      }
    }
  }

  if (projection.delivery?.references) {
    if (projection.delivery.references.length > REMOTE_PI_BOUNDS.MAX_DELIVERY_REFERENCES) {
      throw new Error(`delivery.references exceeds ${REMOTE_PI_BOUNDS.MAX_DELIVERY_REFERENCES} items`);
    }
  }
}

/**
 * Compute SHA-256 of a string.
 */
export async function computeSha256(content: string): Promise<string> {
  const crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Derive event ID from run_id and sequence.
 */
export function deriveEventId(runId: string, sequence: number): string {
  return `evt_${runId}_${sequence}`;
}

/**
 * Validate event version and schema.
 */
export function validateEventV1(event: RemotePiEventV1): void {
  if (event.version !== 1) {
    throw new Error(`Unsupported event version: ${event.version}`);
  }
  if (!event.event_id || !event.content_sha256 || !event.origin_peer || !event.origin_request_id) {
    throw new Error("Event missing required fields");
  }
  if (!event.run_id || event.card_id <= 0 || event.generation < 1 || event.sequence < 1) {
    throw new Error("Event has invalid identifiers");
  }
  if (!event.kind || !event.occurred_at) {
    throw new Error("Event missing kind or timestamp");
  }

  // Validate projection
  validatePublicProjection(event.projection);

  // Validate event_id matches derived value
  const expectedEventId = deriveEventId(event.run_id, event.sequence);
  if (event.event_id !== expectedEventId) {
    throw new Error(`Event ID mismatch: expected ${expectedEventId}, got ${event.event_id}`);
  }
}

/**
 * Validate control request version and schema.
 */
export function validateControlRequestV1(request: RemotePiControlRequestV1): void {
  if (request.version !== 1) {
    throw new Error(`Unsupported control request version: ${request.version}`);
  }
  if (!request.command_id || !request.run_id || request.expected_generation < 1) {
    throw new Error("Control request missing required fields");
  }

  // Validate command variant
  const cmd = request.command;
  switch (cmd.action) {
    case "status":
      // No additional validation
      break;
    case "reply":
      if (!cmd.request_id) {
        throw new Error("Reply command missing request_id");
      }
      if (cmd.value !== undefined && typeof cmd.value !== "string" && typeof cmd.value !== "object") {
        throw new Error("Reply value must be string or object");
      }
      if (typeof cmd.value === "string" && Buffer.byteLength(cmd.value, "utf-8") > REMOTE_PI_BOUNDS.MAX_REPLY_VALUE_SIZE) {
        throw new Error(`Reply value exceeds ${REMOTE_PI_BOUNDS.MAX_REPLY_VALUE_SIZE} bytes`);
      }
      break;
    case "steer":
      if (!cmd.instruction) {
        throw new Error("Steer command missing instruction");
      }
      if (Buffer.byteLength(cmd.instruction, "utf-8") > REMOTE_PI_BOUNDS.MAX_STEER_INSTRUCTION) {
        throw new Error(`Steer instruction exceeds ${REMOTE_PI_BOUNDS.MAX_STEER_INSTRUCTION} bytes`);
      }
      break;
    case "cancel":
      // No additional validation
      break;
    case "resume":
      if (!cmd.approval) {
        throw new Error("Resume command missing approval");
      }
      validateResumeApproval(cmd.approval);
      break;
    default:
      const _exhaustive: never = cmd;
      throw new Error(`Unsupported command action: ${String(cmd)}`);
  }
}

/**
 * Validate resume approval assertion.
 */
export function validateResumeApproval(approval: ResumeApprovalV1): void {
  if (!approval.approval_id || !approval.run_id || !approval.origin_peer) {
    throw new Error("Approval missing required fields");
  }
  if (!approval.command_id || !approval.approving_principal) {
    throw new Error("Approval missing identity fields");
  }
  if (!approval.issued_at || !approval.expires_at) {
    throw new Error("Approval missing timestamp fields");
  }
  if (approval.interrupted_generation < 1) {
    throw new Error("Approval has invalid interrupted_generation");
  }
  if (!approval.approval_statement_sha256) {
    throw new Error("Approval missing approval_statement_sha256");
  }

  // Validate freshness
  const now = new Date().toISOString();
  if (approval.expires_at < now) {
    throw new Error("Approval has expired");
  }
  if (approval.issued_at > now) {
    throw new Error("Approval issued in the future");
  }
}

/**
 * Create a control error response.
 */
export function createControlError(
  commandId: string,
  code: ControlErrorCode,
  message: string,
  details?: Record<string, unknown>
): RemotePiControlResponseV1 {
  return {
    version: 1,
    command_id: commandId,
    outcome: "rejected",
    error: { code, message, details },
  };
}