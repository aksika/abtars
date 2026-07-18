/**
 * token-budget.ts — Token budget estimation and reserve calculation.
 *
 * #1326: the runtime guard against `maxOutput == contextWindow` misconfigurations
 * in models.json. Every L0 body builder and the L1 pi-ai adapter route through
 * this single helper.
 *
 * #1335: active-candidate reserve calculator replaces the fixed-percentage
 * compaction trigger with headroom/growth awareness.
 *
 * Compile-time free of any LLM-specific imports; pure math + a logWarn edge-case
 * for the "input already exceeds contextWindow" path.
 */
import { logWarn } from "../logger.js";

const TAG = "token-budget";

/** Clamp a requested output-token budget so input + output stays within the
 *  context window, with a safety margin. `contextWindow <= 0` (unknown) →
 *  pass through unclamped.
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

/** Rough token estimate from a JSON-serializable payload (chars/4). */
export function estimateTokensFromChars(charCount: number): number {
  return Math.ceil(charCount / 4);
}

// ── #1335: active-candidate reserve calculator ─────────────────────────────────

export interface ContextReserveInput {
  /** The active candidate's context window in tokens. */
  contextWindow: number;
  /** Configured (pre-clamp) max output tokens for this candidate. */
  configuredMaxOutput: number;
  /** Actually clamped max output after applying safety/context limits. */
  clampedMaxOutput: number;
  /** Safety margin in tokens. Default 4096. */
  safetyMargin: number;
  /** Estimated tokens for the stable system prompt. */
  stableSystemTokens: number;
  /** Estimated tokens for the tool schema definitions. */
  toolSchemaTokens: number;
  /** Estimated tokens for volatile per-turn context (recall, runtime blocks). */
  volatileContextTokens: number;
  /** Estimated tokens for the current user turn. */
  currentTurnTokens: number;
  /** Estimated tokens for in-flight (unresolved) tool exchanges. */
  inFlightTokens: number;
  /** Measured tokens of the current stable context (active checkpoint +
   *  verbatim suffix) that must fit within the history budget. #1335 finding #2:
   *  compaction is decided against this real value, not the budget itself. */
  stableContextTokens: number;
  /** Recent atomic growth measurements for growth reserve calculation. */
  recentAtomicGrowthTokens: number[];
}

export interface ContextReserve {
  /** Total usable input capacity (context window − reserved output − safety margin). */
  usableInput: number;
  /** Budget for historical content (system + checkpoint + verbatim suffix). */
  historyBudget: number;
  /** Actually reserved output tokens. */
  reservedOutput: number;
  /** Dynamic growth reserve for next-turn expansion. */
  growthReserve: number;
  /** True when compaction is needed to fit the history budget. */
  compactionDue: boolean;
  /** Human-readable reason when compaction is due. */
  reason?: string;
}

/**
 * Calculate context reserve for the active candidate.
 *
 * `growthReserve` is `clamp(max(configured minimum, recent P90 atomic growth),
 * min, max)` rather than a context percentage. Unknown tokenizers use
 * conservative versioned char/token estimation.
 *
 * @returns ContextReserve with all computed values.
 */
export function calculateReserve(input: ContextReserveInput): ContextReserve {
  const { contextWindow, configuredMaxOutput, clampedMaxOutput, safetyMargin, stableSystemTokens, toolSchemaTokens, volatileContextTokens, currentTurnTokens, inFlightTokens, stableContextTokens, recentAtomicGrowthTokens } = input;

  // Handle unknown context window
  if (contextWindow <= 0) {
    return {
      usableInput: 0,
      historyBudget: 0,
      reservedOutput: clampedMaxOutput,
      growthReserve: 0,
      compactionDue: false,
      reason: "unknown context window",
    };
  }

  // Reserved output: use the already-clamped value for actual reserve,
  // but never exceed the configured max.
  const reservedOutput = Math.min(clampedMaxOutput, configuredMaxOutput);

  // Usable input: context window minus output reservation and safety margin
  const usableInput = contextWindow - reservedOutput - safetyMargin;

  // Non-historical overhead
  const overhead = stableSystemTokens + toolSchemaTokens + volatileContextTokens + currentTurnTokens + inFlightTokens;

  // History budget
  const historyBudget = Math.max(0, usableInput - overhead);

  // Growth reserve: P90 of recent atomic growth, bounded
  const sortedGrowth = [...recentAtomicGrowthTokens].sort((a, b) => a - b);
  const p90Index = Math.floor(sortedGrowth.length * 0.9);
  const p90Growth = sortedGrowth.length > 0 ? sortedGrowth[Math.min(p90Index, sortedGrowth.length - 1)]! : 0;
  const MIN_GROWTH_RESERVE = 512;
  const MAX_GROWTH_RESERVE = Math.floor(contextWindow * 0.1);
  const growthReserve = Math.max(MIN_GROWTH_RESERVE, Math.min(p90Growth, MAX_GROWTH_RESERVE));

  // Check if compaction is due: the *measured* stable context (checkpoint +
  // verbatim suffix) plus the bounded growth reserve must fit within the
  // history budget. #1335 finding #2: the prior code compared historyBudget
  // against itself, so compaction was always requested after two growth
  // samples regardless of the real prefix size. Now the actual measured
  // stable-context token count is compared against the budget less reserve.
  const compactionDue = stableContextTokens + growthReserve > historyBudget && historyBudget > 0;

  return {
    usableInput: Math.max(0, usableInput),
    historyBudget: Math.max(0, historyBudget),
    reservedOutput,
    growthReserve,
    compactionDue,
    reason: compactionDue
      ? `history budget insufficient for next-turn growth (budget=${historyBudget}, growthReserve=${growthReserve})`
      : undefined,
  };
}

/**
 * Compute a safety-padded safety margin proportional to the context window.
 * Used when the caller doesn't have a fixed margin preference.
 */
export function proportionalSafetyMargin(contextWindow: number): number {
  if (contextWindow <= 0) return 4096;
  return Math.min(8192, Math.max(2048, Math.floor(contextWindow * 0.03)));
}
