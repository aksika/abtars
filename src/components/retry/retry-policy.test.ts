import { describe, it, expect } from "vitest";
import { evaluatePolicy, computeBudget, GLOBAL_LIMITS } from "./retry-policy.js";

describe("retry-policy", () => {
  const baseInput = {
    sourceAttemptId: "a_test_1",
    classification: { primary: "transient_transport" as const, retryability: "automatic" as const, factors: [] },
    budgets: computeBudget(1, 0, 0, 0, 0, 0, 0),
    candidateExecutorIds: ["spin"],
    previousExecutors: ["spin"],
  };

  it("stops on never retryability", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "operator_cancelled" as const, retryability: "never" as const, factors: [] },
    });
    expect(result.disposition).toBe("stop");
    expect(result.reasonCode).toContain("policy_denies_retry");
  });

  it("stops on needs_input retryability", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "awaiting_input_expired" as const, retryability: "needs_input" as const, factors: [] },
    });
    expect(result.disposition).toBe("needs_input");
  });

  it("auto-retries transient transport", () => {
    const result = evaluatePolicy(baseInput);
    expect(result.disposition).toBe("automatic_retry");
    expect(result.earliestAt).toBeDefined();
  });

  it("auto-retries executor_unavailable", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "executor_unavailable" as const, retryability: "automatic" as const, factors: [] },
    });
    expect(result.disposition).toBe("automatic_retry");
  });

  it("requests orc review for acceptance_unmet", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "acceptance_unmet" as const, retryability: "review_required" as const, factors: [] },
    });
    expect(result.disposition).toBe("orc_review");
  });

  it("requests orc review for strategy_failure", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "strategy_failure" as const, retryability: "review_required" as const, factors: [] },
    });
    expect(result.disposition).toBe("orc_review");
  });

  it("stops on hard_deadline", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "hard_deadline" as const, retryability: "never" as const, factors: [] },
    });
    expect(result.disposition).toBe("stop");
  });

  it("stops exhausted budget", () => {
    const result = evaluatePolicy({
      ...baseInput,
      budgets: computeBudget(GLOBAL_LIMITS.maxAttempts, 0, 0, 0, 0, 0, 0),
    });
    expect(result.disposition).toBe("stop");
    expect(result.reasonCode).toContain("max_attempts");
  });

  it("stops exhausted same-class budget", () => {
    const result = evaluatePolicy({
      ...baseInput,
      budgets: computeBudget(1, GLOBAL_LIMITS.maxSameClassAttempts, 0, 0, 0, 0, 0),
    });
    expect(result.disposition).toBe("stop");
    expect(result.reasonCode).toContain("same_class");
  });

  it("stops on zero remaining attempts", () => {
    const result = evaluatePolicy({
      ...baseInput,
      budgets: computeBudget(GLOBAL_LIMITS.maxAttempts, 0, 0, 0, 0, 0, 0),
    });
    expect(result.disposition).toBe("stop");
  });

  it("capability_mismatch auto-retries if candidate available", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "capability_mismatch" as const, retryability: "review_required" as const, factors: [] },
      candidateExecutorIds: ["other_executor"],
    });
    expect(result.disposition).toBe("automatic_retry");
    expect(result.requiredStrategyChanges).toContain("switch_executor");
  });

  it("capability_mismatch orc_review if no candidate", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "capability_mismatch" as const, retryability: "review_required" as const, factors: [] },
      candidateExecutorIds: [],
    });
    expect(result.disposition).toBe("orc_review");
  });

  it("unknown defaults to orc_review", () => {
    const result = evaluatePolicy({
      ...baseInput,
      classification: { primary: "unknown" as const, retryability: "review_required" as const, factors: [] },
    });
    expect(result.disposition).toBe("orc_review");
  });

  it("computes backoff based on attempt index", () => {
    const result = evaluatePolicy({
      ...baseInput,
      budgets: computeBudget(3, 2, 0, 0, 5000, 0, 0),
    });
    expect(result.disposition).toBe("automatic_retry");
    const earliest = result.earliestAt ? new Date(result.earliestAt).getTime() : 0;
    expect(earliest).toBeGreaterThan(Date.now());
  });

  it("remaining attempts decremented on scheduled retry", () => {
    const result = evaluatePolicy(baseInput);
    expect(result.remaining.attemptsRemaining).toBe(GLOBAL_LIMITS.maxAttempts - 1 - 1);
  });
});
