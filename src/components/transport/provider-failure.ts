/**
 * provider-failure.ts — #1297: provider-neutral terminal failure contract.
 *
 * The Pi transport classifies provider failures (model health kinds,
 * status/message parsing) at the adapter boundary. When an execution ends with
 * every configured candidate blocked by the SAME provider-neutral cause, the
 * stream boundary reports that structured terminal failure; other genuine
 * exhaustion (mixed kinds, zero-attempt, silent empty streams) reports the
 * generic `all_candidates_failed` code (#1905). Core transport throws a typed
 * `ProviderExecutionError` for any of them. Downstream consumers (scheduled-task
 * runner, failure hook) identify the condition by type + exact code — never by
 * matching an error message.
 *
 * No provider names, provider-specific parsing, or raw provider payloads may
 * appear here or in any downstream consumer.
 */

export const TERMINAL_FAILURE_CODES = [
  "credits_exhausted",
  "context_overflow",
  "all_candidates_failed",
  "provider_unavailable",
] as const;
export type TerminalFailureCode = (typeof TERMINAL_FAILURE_CODES)[number];

/**
 * #1932: single-interpreter error taxonomy for the Pi route. Status/message
 * classification lives here — never in a health bucket, rotation policy, or
 * downstream consumer. The durable availability memo and the terminal
 * failure codes above are the only readers.
 */
export type ErrorKind = "rate_limit" | "credits" | "auth" | "transient" | "weak" | "empty" | "truncated" | "context_exceeded";

export interface ProviderTerminalFailure {
  /** Stable machine-readable cause. Consumers branch on this exact code. */
  code: TerminalFailureCode;
  /** Terminal failures are never retryable by construction. */
  retryable: false;
  /** Number of configured candidates evaluated for this execution. */
  attemptedCandidates: number;
  /** Stable, non-secret, provider-neutral display text. */
  message: string;
  /** #1932: earliest time the availability memo admits dispatch again.
   *  Present only for provider_unavailable; consumers may schedule a bounded
   *  retry at or after this instant instead of inventing a backoff. */
  retryAt?: number;
}

export class ProviderExecutionError extends Error {
  readonly failure: ProviderTerminalFailure;

  constructor(failure: ProviderTerminalFailure) {
    super(failure.message);
    this.name = "ProviderExecutionError";
    this.failure = failure;
  }
}

export function isProviderExecutionError(err: unknown): err is ProviderExecutionError {
  return err instanceof ProviderExecutionError;
}

export function isCreditsExhausted(err: unknown): boolean {
  return isProviderExecutionError(err) && err.failure.code === "credits_exhausted";
}

/** #1745: every attempted candidate rejected the request as over-context. */
export function isContextOverflowFailure(err: unknown): boolean {
  return isProviderExecutionError(err) && err.failure.code === "context_overflow";
}

/** #1905: every configured candidate failed or was unavailable with no
 * single-cause verdict (mixed failure kinds, latch/registry zero-attempt, or
 * silent empty streams). Never reported for credit/overflow exhaustion —
 * those keep their exact codes above. */
export function isAllCandidatesFailed(err: unknown): boolean {
  return isProviderExecutionError(err) && err.failure.code === "all_candidates_failed";
}

/** #1932: every allowed selection is inside its availability cooldown.
 * Distinct from all_candidates_failed: no provider request was sent —
 * dispatch was suppressed before the boundary. */
export function isProviderUnavailable(err: unknown): err is ProviderExecutionError {
  return isProviderExecutionError(err) && err.failure.code === "provider_unavailable";
}

/** #1753: quota/billing exhaustion is sticky regardless of how the transport
 *  reported it. The candidate cannot succeed until the account is topped up, so
 *  a drainable rate_limit (0.5 fill, ~17min) or transient bucket retries it
 *  forever. Status is gated to 429/402/0 — 0 covers an unparseable status from
 *  parseErrorStatus — so an unrelated 5xx that merely mentions billing is not
 *  promoted to a sticky verdict. String set mirrors pi-ai's private
 *  NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN (packages/ai/src/utils/retry.ts:7). */
const QUOTA_EXHAUSTED =
  /insufficient_quota|quota exceeded|out of budget|billing|available balance|monthly usage limit reached|GoUsageLimitError|FreeUsageLimitError/i;

/** Classify HTTP status to error kind. */
export function classifyError(status: number, message?: string): ErrorKind {
  if ((status === 429 || status === 402 || status === 0) && message && QUOTA_EXHAUSTED.test(message)) return "credits";
  if (status === 402 && message?.toLowerCase().includes("credit")) return "credits";
  if (status === 429 || status === 402) return "rate_limit";
  if (status === 404 && message && /image input|No endpoints found/i.test(message)) return "transient";
  if (status === 401 || status === 403 || status === 404) return "auth";
  return "transient";
}
