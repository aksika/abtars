/**
 * provider-failure.ts — #1297: provider-neutral terminal failure contract.
 *
 * The Pi transport carries provider failure classification (model health kinds,
 * status/message parsing) at the adapter boundary. When an execution ends with
 * every configured candidate blocked by the SAME provider-neutral cause, the
 * stream boundary reports a structured terminal failure and core transport
 * throws a typed `ProviderExecutionError`. Downstream consumers (scheduled-task
 * runner, failure hook) identify the condition by type + exact code — never by
 * matching an error message.
 *
 * No provider names, provider-specific parsing, or raw provider payloads may
 * appear here or in any downstream consumer.
 */

export const TERMINAL_FAILURE_CODES = ["credits_exhausted", "context_overflow"] as const;
export type TerminalFailureCode = (typeof TERMINAL_FAILURE_CODES)[number];

export interface ProviderTerminalFailure {
  /** Stable machine-readable cause. Consumers branch on this exact code. */
  code: TerminalFailureCode;
  /** Terminal failures are never retryable by construction. */
  retryable: false;
  /** Number of configured candidates evaluated for this execution. */
  attemptedCandidates: number;
  /** Stable, non-secret, provider-neutral display text. */
  message: string;
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
