/**
 * provider-failure.ts — #1297: provider-neutral terminal failure contract.
 *
 * Pi owns provider calls, retries and overflow recovery (#1940). When Pi's
 * final verdict for a run is a provider error with no committed answer, the
 * transport throws a typed `ProviderExecutionError`. Downstream consumers
 * (scheduled-task runner, self-heal gate) branch on the exact code, never on
 * error text. The only classification is credit/quota exhaustion, which no
 * retry or self-heal can fix.
 */

export type TerminalFailureCode = "credits_exhausted" | "all_candidates_failed";

export interface ProviderTerminalFailure {
  /** Stable machine-readable cause. Consumers branch on this exact code. */
  code: TerminalFailureCode;
  /** Terminal failures are never retryable by construction. */
  retryable: false;
  /** Number of configured candidates evaluated for this execution. */
  attemptedCandidates: number;
  /** Non-secret display text (Pi's final provider message). */
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

/** #1753: quota/billing exhaustion phrasing (mirrors pi-ai's private
 *  non-retryable provider-limit pattern) plus credit wording. */
const CREDITS_EXHAUSTED =
  /insufficient_quota|quota exceeded|out of budget|billing|available balance|monthly usage limit reached|GoUsageLimitError|FreeUsageLimitError|insufficient credits|credits? exhausted/i;

/** Terminal code for Pi's final provider error message. */
export function terminalFailureCodeFor(providerMessage: string): TerminalFailureCode {
  return CREDITS_EXHAUSTED.test(providerMessage) ? "credits_exhausted" : "all_candidates_failed";
}
