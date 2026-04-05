/**
 * Generic retry utility with escalating backoff, jitter, and fatal error detection.
 */

export interface RetryPolicy {
  /** Max attempts (including first). Default: 3 */
  attempts?: number;
  /** Initial delay in ms. Default: 300 */
  minDelayMs?: number;
  /** Max delay cap in ms. Default: 30_000 */
  maxDelayMs?: number;
  /** Jitter factor 0-1 (0.1 = ±10%). Default: 0.1 */
  jitter?: number;
  /** Return false to stop retrying (fatal error). Default: always retry. */
  isRecoverable?: (err: unknown) => boolean;
  /** Extract delay hint from error (e.g. rate limit header). */
  getDelayHint?: (err: unknown) => number | undefined;
  /** Called before each retry. */
  onAttempt?: (info: { attempt: number; maxAttempts: number; err: unknown; delayMs: number }) => void;
}

const DEFAULTS = { attempts: 3, minDelayMs: 300, maxDelayMs: 30_000, jitter: 0.1 };

/** Known-fatal error patterns — don't retry these. */
export const FATAL_PATTERNS = [
  /auth.*fail|invalid.*key|unauthorized/i,
  /model.*not found|not supported/i,
  /account.*suspended|quota.*exceeded/i,
  /bot was blocked/i,
];

/** Check if an error matches a known-fatal pattern. */
export function isFatal(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return FATAL_PATTERNS.some(p => p.test(msg));
}

/** Execute `fn` with retry, escalating backoff, and jitter. */
export async function withRetry<T>(fn: () => Promise<T>, policy?: RetryPolicy): Promise<T> {
  const attempts = Math.max(1, policy?.attempts ?? DEFAULTS.attempts);
  const minDelay = Math.max(0, policy?.minDelayMs ?? DEFAULTS.minDelayMs);
  const maxDelay = Math.max(minDelay, policy?.maxDelayMs ?? DEFAULTS.maxDelayMs);
  const jitter = Math.max(0, Math.min(1, policy?.jitter ?? DEFAULTS.jitter));
  const isRecoverable = policy?.isRecoverable ?? ((err: unknown) => !isFatal(err));

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      if (!isRecoverable(err)) break;

      const hint = policy?.getDelayHint?.(err);
      const baseDelay = hint ?? Math.min(maxDelay, minDelay * Math.pow(2, i));
      const offset = jitter > 0 ? (Math.random() * 2 - 1) * jitter * baseDelay : 0;
      const delayMs = Math.max(0, Math.round(baseDelay + offset));

      policy?.onAttempt?.({ attempt: i + 1, maxAttempts: attempts, err, delayMs });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
