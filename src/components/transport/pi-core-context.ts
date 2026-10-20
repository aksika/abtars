export type DurableContextUnavailableReason =
  | "no_provider"
  | "provider_rejected"
  | "malformed_response"
  | "cursor_unavailable"
  | "identity_unavailable"
  | "hydration_failed"
  | "runtime_unavailable"
  | "record_failed"
  | "cursor_missing";

/**
 * #1529: required-but-unavailable durable intents fail closed. Memory is
 * decided once at boot (#1940 R1); a required intent that cannot be met
 * rejects before any provider request instead of degrading silently.
 */
export class DurableContextUnavailableError extends Error {
  readonly reason: DurableContextUnavailableReason;
  constructor(reason: DurableContextUnavailableReason, cause?: unknown) {
    super(`Durable context unavailable: ${reason}`, { cause });
    this.name = "DurableContextUnavailableError";
    this.reason = reason;
  }
}
