/**
 * token-budget.ts — Clamp a requested output-token budget so input + output
 * stays within the model's context window, with a safety margin.
 *
 * #1326: the runtime guard against `maxOutput == contextWindow` misconfigurations
 * in models.json (where OpenRouter reports top_provider.max_completion_tokens
 * equal to context_length, the value is "correct" per the provider's API but
 * useless as a per-request output cap without a downstream clamp). Every L0
 * body builder (chat / Responses / Anthropic) and the L1 pi-ai adapter route
 * through this single helper, called once per request from
 * `direct-api-transport.ts:streamCompletion`.
 *
 * Compile-time free of any LLM-specific imports; pure math + a logWarn edge-case
 * for the "input already exceeds contextWindow" path so that failure mode is
 * visible at runtime instead of silently sending a doomed `max_tokens: 1`.
 */
import { logWarn } from "../logger.js";

const TAG = "token-budget";

/** Clamp a requested output-token budget so input + output stays within the
 *  context window, with a safety margin. `contextWindow <= 0` (unknown) →
 *  pass through unclamped — matches pi-ai's own convention for this case
 *  and the abtars contract for "maxContext not yet known to the transport".
 *
 *  `safetyMargin` default (4096) is a generous buffer for tool-call argument
 *  growth, tool-result echoes, and system-message drift between when this
 *  estimate is computed and when the actual request is serialized — NOT a
 *  tunable performance knob. Do not reduce it to "reclaim" output budget
 *  without re-verifying against a real overflow case.
 *
 *  @returns clamped output budget (always >= 1, even when input alone exceeds
 *  the window — but logs a warning so the doomed request is visible).
 */
export function clampMaxOutputTokens(
  maxOutput: number,
  contextWindow: number,
  estimatedInputTokens: number,
  safetyMargin = 4096,
): number {
  if (contextWindow <= 0) return maxOutput;
  const available = contextWindow - estimatedInputTokens - safetyMargin;
  if (available < 1) {
    logWarn(TAG, `input (${estimatedInputTokens} tok) already exceeds contextWindow (${contextWindow}) minus safety margin — clamp forced to 1; request will still likely fail upstream`);
  }
  return Math.max(1, Math.min(maxOutput, available));
}

/** Rough token estimate from a JSON-serializable payload (chars/4), matching
 *  the convention pi-ai's own `estimateContextTokens` uses. Good enough for a
 *  safety clamp — NOT billing-accurate. */
export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}
