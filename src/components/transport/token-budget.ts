/**
 * token-budget.ts — Token budget estimation.
 *
 * Single canonical estimator: estimateTokensFromChars (chars/4, ceil).
 * Used by compact-summarizer and (after #1747) by prompt-builder,
 * memory-runtime, and durable-adapter. The #1335 reserve calculator
 * and the #1326 output clamp were removed as dead code in #1747.
 *
 * Compile-time free of any LLM-specific imports; pure math.
 */

/** Rough token estimate from a JSON-serializable payload (chars/4). */
export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}
