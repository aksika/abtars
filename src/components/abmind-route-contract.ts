/**
 * Abtars-owned structural copy of the signed-WSS route and delivery contract
 * (#1382). Mirrors abmind's route-contract module; abtars never imports the
 * abmind package at runtime, so the contract is duplicated and protected by
 * cross-repository conformance acceptance.
 */

export type AbmindRouteStateLike =
  | "closed"
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "negotiating"
  | "ready"
  | "reconnecting"
  | "unavailable";

export type AbmindRouteReasonCodeLike =
  | "route_unavailable"
  | "connection_failed"
  | "pin_mismatch"
  | "authentication_failed"
  | "negotiation_failed"
  | "policy_rejected"
  | "retry_exhausted"
  | "transport_closed";

export interface AbmindRouteSnapshotV1Like {
  version: 1;
  state: AbmindRouteStateLike;
  generation: number;
  reasonCode?: AbmindRouteReasonCodeLike;
  retryEligible: number;
  terminalUnknown: number;
  nextAttemptAt?: number;
}

export type AbmindDeliveryStateLike =
  | "admitted"
  | "in_flight"
  | "retry_wait"
  | "terminal_unknown";

export type RetryFailureClassLike =
  | "timeout"
  | "send_failed"
  | "socket_lost"
  | "generation_lost"
  | "connection_refused";

export const ROUTE_RETRY_MAX_ATTEMPTS = 5;
export const ROUTE_RETRY_DEADLINE_MS = 15 * 60_000;
export const ROUTE_RETRY_BASE_MS = 1_000;
export const ROUTE_RETRY_MAX_MS = 60_000;
export const ROUTE_RETRY_JITTER_MS = 250;
export const ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES = 50;
export const ROUTE_TERMINAL_UNKNOWN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const ROUTE_METHOD_MAX_BYTES = 128;

export const TERMINAL_SERVICE_ERROR_CODES = [
  "validation_error",
  "unauthorized",
  "unsupported_method",
  "unsupported_version",
  "idempotency_conflict",
  "conflict",
  "not_found",
  "audit_failure",
  "internal_error",
] as const;

/** Must match abmind's ABMIND_ROUTE_CONFORMANCE_V1 exactly. */
export const ABMIND_ROUTE_CONFORMANCE_V1 = {
  version: 1,
  routeStates: [
    "closed", "disconnected", "connecting", "authenticating",
    "negotiating", "ready", "reconnecting", "unavailable",
  ] as const,
  deliveryStates: ["admitted", "in_flight", "retry_wait", "terminal_unknown"] as const,
  reasonCodes: [
    "route_unavailable", "connection_failed", "pin_mismatch",
    "authentication_failed", "negotiation_failed", "policy_rejected",
    "retry_exhausted", "transport_closed",
  ] as const,
  retryableFailureClasses: [
    "timeout", "send_failed", "socket_lost", "generation_lost", "connection_refused",
  ] as const,
  terminalServiceErrorCodes: TERMINAL_SERVICE_ERROR_CODES,
  logicalIdentity: ["frameId", "requestId", "method", "body", "idempotencyKey"] as const,
  freshAuthFields: ["ts", "nonce", "sig"] as const,
  bounds: {
    maxAttempts: ROUTE_RETRY_MAX_ATTEMPTS,
    deadlineMs: ROUTE_RETRY_DEADLINE_MS,
    backoffBaseMs: ROUTE_RETRY_BASE_MS,
    backoffMaxMs: ROUTE_RETRY_MAX_MS,
    jitterMs: ROUTE_RETRY_JITTER_MS,
    terminalUnknownMaxEntries: ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES,
    terminalUnknownRetentionMs: ROUTE_TERMINAL_UNKNOWN_RETENTION_MS,
    methodMaxBytes: ROUTE_METHOD_MAX_BYTES,
  },
} as const;
