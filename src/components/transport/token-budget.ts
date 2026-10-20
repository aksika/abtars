/**
 * token-budget.ts — Token budget estimation.
 *
 * Single canonical estimator: estimateTokensFromChars (chars/4, ceil).
 * Used by prompt-builder (image context sizing).
 *
 * Compile-time free of any LLM-specific imports; pure math.
 */

/** Rough token estimate from a JSON-serializable payload (chars/4). */
export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}
