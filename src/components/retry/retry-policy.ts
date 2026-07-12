import type { FailureClass, Retryability } from "./failure-classifier.js";

export type RetryDisposition = "automatic_retry" | "orc_review" | "needs_input" | "stop";

export interface RetryBudgetSnapshot {
  attemptsUsed: number;
  attemptsRemaining: number;
  sameClassUsed: number;
  sameExecutorConsecutiveFailures: number;
  executorSwitchesUsed: number;
  elapsedMs: number;
  tokensUsed: number;
  costUsed: number;
  hardDeadlineAt?: string;
}

export interface RetryPolicyDecision {
  sourceAttemptId: string;
  disposition: RetryDisposition;
  reasonCode: string;
  earliestAt?: string;
  remaining: RetryBudgetSnapshot;
  requiredStrategyChanges: string[];
  candidateExecutorIds: string[];
  inputDigest: string;
  policyVersion: string;
  created_at: string;
}

export const POLICY_VERSION = "v1.0.0";

// ── Named defaults and hard maxima ────────────────────────────────────────────

export const GLOBAL_LIMITS = {
  maxAttempts: 5,
  maxSameClassAttempts: 3,
  maxConsecutiveSameExecutorFailures: 2,
  maxExecutorSwitches: 3,
  maxElapsedMs: 60 * 60 * 1000,
  maxTokens: 1_000_000,
  maxCost: 100,
  maxPlannerModelCalls: 3,
  reviewDeadlineMs: 30 * 60 * 1000,
  backoffBaseMs: 5_000,
  backoffMaxMs: 60_000,
} as const;

export interface RetryPolicyInput {
  sourceAttemptId: string;
  classification: { primary: FailureClass; retryability: Retryability; factors: FailureClass[] };
  budgets: RetryBudgetSnapshot;
  candidateExecutorIds: string[];
  previousExecutors: string[];
}

export function evaluatePolicy(input: RetryPolicyInput): RetryPolicyDecision {
  const { classification, budgets, candidateExecutorIds, previousExecutors } = input;
  let disposition: RetryDisposition;
  let reasonCode: string;
  let earliestAt: string | undefined;
  let requiredStrategyChanges: string[] = [];

  // Phase 1: Hard stops — never retry these
  if (classification.retryability === "never") {
    disposition = "stop";
    reasonCode = `${classification.primary}:policy_denies_retry`;
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (classification.retryability === "needs_input") {
    disposition = "needs_input";
    reasonCode = `${classification.primary}:requires_operator_input`;
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  // Phase 2: Budget checks
  if (budgets.attemptsRemaining <= 0) {
    disposition = "stop";
    reasonCode = "budget_exhausted:max_attempts";
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (budgets.hardDeadlineAt && Date.now() >= new Date(budgets.hardDeadlineAt).getTime()) {
    disposition = "stop";
    reasonCode = "budget_exhausted:hard_deadline";
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (budgets.elapsedMs >= GLOBAL_LIMITS.maxElapsedMs) {
    disposition = "stop";
    reasonCode = "budget_exhausted:wall_clock";
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (budgets.tokensUsed >= GLOBAL_LIMITS.maxTokens) {
    disposition = "stop";
    reasonCode = "budget_exhausted:token_budget";
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (budgets.sameClassUsed >= GLOBAL_LIMITS.maxSameClassAttempts) {
    disposition = "stop";
    reasonCode = `budget_exhausted:same_class_${classification.primary}`;
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  if (budgets.executorSwitchesUsed >= GLOBAL_LIMITS.maxExecutorSwitches) {
    disposition = "stop";
    reasonCode = "budget_exhausted:executor_switches";
    return buildDecision(input, disposition, reasonCode, undefined, [], candidateExecutorIds);
  }

  // Phase 3: Class-specific dispositions
  switch (classification.primary) {
    case "transient_transport":
    case "executor_unavailable":
      disposition = "automatic_retry";
      reasonCode = `${classification.primary}:transient_failure`;
      requiredStrategyChanges = ["clean_execution_context"];
      earliestAt = new Date(Date.now() + computeBackoff(budgets.sameClassUsed)).toISOString();
      break;

    case "capability_mismatch":
      if (candidateExecutorIds.length > 0) {
        disposition = "automatic_retry";
        reasonCode = "capability_mismatch:switch_executor";
        requiredStrategyChanges = ["switch_executor"];
      } else {
        disposition = "orc_review";
        reasonCode = "capability_mismatch:no_capable_executor";
      }
      break;

    case "lease_expired":
      disposition = "automatic_retry";
      reasonCode = "lease_expired:schedule_retry";
      requiredStrategyChanges = ["clean_session", "prefer_fresh_executor"];
      earliestAt = new Date(Date.now() + computeBackoff(budgets.sameClassUsed)).toISOString();
      break;

    case "tool_or_verification_failure":
    case "missing_or_invalid_artifact":
    case "acceptance_unmet":
    case "strategy_failure":
      disposition = "orc_review";
      reasonCode = `${classification.primary}:semantic_failure`;
      requiredStrategyChanges = ["repair_strategy"];
      break;

    case "hard_deadline":
      disposition = "stop";
      reasonCode = "hard_deadline:exceeded";
      break;

    case "resource_or_budget_exhausted":
      disposition = "stop";
      reasonCode = "budget_exhausted:project_limit";
      break;

    case "awaiting_input_expired":
      disposition = "needs_input";
      reasonCode = "awaiting_input_expired:requires_fresh_input";
      break;

    case "operator_cancelled":
    case "policy_or_security_denied":
    case "invalid_contract":
      disposition = "stop";
      reasonCode = `${classification.primary}:no_retry`;
      break;

    default:
      disposition = "orc_review";
      reasonCode = "unknown:needs_review";
  }

  // Phase 4: Executor escalation check
  if (previousExecutors.length > 0 && budgets.sameExecutorConsecutiveFailures >= GLOBAL_LIMITS.maxConsecutiveSameExecutorFailures) {
    const lastExecutor = previousExecutors[previousExecutors.length - 1]!;
    const otherCandidates = candidateExecutorIds.filter(id => id !== lastExecutor);
    if (otherCandidates.length > 0) {
      requiredStrategyChanges.push("executor_escalation");
      if (disposition === "automatic_retry") {
        reasonCode = `${reasonCode}:escalate_executor`;
      }
    }
  }

  return buildDecision(input, disposition, reasonCode, earliestAt, requiredStrategyChanges, candidateExecutorIds);
}

function computeBackoff(attemptIndex: number): number {
  const delay = GLOBAL_LIMITS.backoffBaseMs * Math.pow(2, attemptIndex);
  return Math.min(delay, GLOBAL_LIMITS.backoffMaxMs);
}

function buildDecision(
  input: RetryPolicyInput,
  disposition: RetryDisposition,
  reasonCode: string,
  earliestAt: string | undefined,
  requiredStrategyChanges: string[],
  candidateExecutorIds: string[],
): RetryPolicyDecision {
  return {
    sourceAttemptId: input.sourceAttemptId,
    disposition,
    reasonCode,
    earliestAt,
    remaining: {
      ...input.budgets,
      attemptsRemaining: disposition === "stop" ? 0 : input.budgets.attemptsRemaining - 1,
    },
    requiredStrategyChanges,
    candidateExecutorIds,
    inputDigest: input.sourceAttemptId,
    policyVersion: POLICY_VERSION,
    created_at: new Date().toISOString(),
  };
}

export function computeBudget(
  attemptsUsed: number,
  sameClassUsed: number,
  sameExecutorConsecutiveFailures: number,
  executorSwitchesUsed: number,
  elapsedMs: number,
  tokensUsed: number,
  costUsed: number,
  hardDeadlineAt?: string,
): RetryBudgetSnapshot {
  return {
    attemptsUsed,
    attemptsRemaining: Math.max(0, GLOBAL_LIMITS.maxAttempts - attemptsUsed),
    sameClassUsed,
    sameExecutorConsecutiveFailures,
    executorSwitchesUsed,
    elapsedMs,
    tokensUsed,
    costUsed,
    hardDeadlineAt,
  };
}

export function computeElapsedMs(startedAt: string): number {
  return Date.now() - new Date(startedAt).getTime();
}
