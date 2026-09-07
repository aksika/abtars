import { describe, it, expect } from "vitest";
import { makeExecutionOutcomeEnvelope } from "./swarm-executor-types.js";

/**
 * #1778: contract tests for the product-owned outcome envelope. Each test
 * names the handoff invariant it protects: complete identity, fail-closed
 * construction, terminal/running/unknown discipline, and bounded evidence.
 */
describe("makeExecutionOutcomeEnvelope (#1778)", () => {
  it("accepts a complete terminal envelope and preserves distinct generation scopes", () => {
    const result = makeExecutionOutcomeEnvelope({
      source: "worker",
      executionRef: "a_1:3",
      attemptId: "a_1",
      projectId: 42,
      attemptGeneration: 3,
      ownershipGeneration: 7,
      observation: "terminal",
      outcome: "completed",
      cleanup: "pending",
      correlationKey: "settle:a_1:3:completed",
      detail: "worker completed",
      evidence: { criteriaPassed: 2, criteriaTotal: 2 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Scoped fences travel together but are never merged: 3 !== 7.
    expect(result.envelope.attemptGeneration).toBe(3);
    expect(result.envelope.ownershipGeneration).toBe(7);
    expect(result.envelope.cleanup).toBe("pending");
  });

  it("fails closed on missing executionRef or correlationKey", () => {
    expect(makeExecutionOutcomeEnvelope({
      source: "spin", executionRef: "", observation: "running",
      cleanup: "unknown", correlationKey: "k",
    }).ok).toBe(false);
    expect(makeExecutionOutcomeEnvelope({
      source: "spin", executionRef: "s_1", observation: "running",
      cleanup: "unknown", correlationKey: "",
    }).ok).toBe(false);
  });

  it("requires an outcome exactly for terminal observations", () => {
    // Terminal without outcome: not a verdict.
    expect(makeExecutionOutcomeEnvelope({
      source: "orc", executionRef: "r_1", observation: "terminal",
      cleanup: "confirmed", correlationKey: "k",
    }).ok).toBe(false);
    // Running with an outcome: contradictory report.
    expect(makeExecutionOutcomeEnvelope({
      source: "orc", executionRef: "r_1", observation: "running",
      outcome: "completed", cleanup: "confirmed", correlationKey: "k",
    }).ok).toBe(false);
    // Unknown with an outcome: unknown is never a terminal verdict.
    expect(makeExecutionOutcomeEnvelope({
      source: "pi", executionRef: "p_1", observation: "unknown",
      outcome: "failed", cleanup: "unknown", correlationKey: "k",
    }).ok).toBe(false);
    // Unknown without outcome routes to reconciliation/fail-closed.
    expect(makeExecutionOutcomeEnvelope({
      source: "pi", executionRef: "p_1", observation: "unknown",
      cleanup: "unknown", correlationKey: "k",
    }).ok).toBe(true);
  });

  it("bounds detail and evidence and rejects non-scalar evidence", () => {
    const long = "x".repeat(2000);
    const result = makeExecutionOutcomeEnvelope({
      source: "scheduled", executionRef: "run_1", observation: "terminal",
      outcome: "timed_out", cleanup: "not_required", correlationKey: "k",
      detail: long,
      evidence: { reason: "deadline_exceeded", latenessMs: 12, retried: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.detail?.length).toBeLessThanOrEqual(500);
    expect(result.envelope.evidence).toMatchObject({ reason: "deadline_exceeded", latenessMs: 12, retried: false });

    const tooMany: Record<string, number> = {};
    for (let i = 0; i < 9; i++) tooMany[`k${i}`] = i;
    expect(makeExecutionOutcomeEnvelope({
      source: "scheduled", executionRef: "run_1", observation: "terminal",
      outcome: "failed", cleanup: "not_required", correlationKey: "k", evidence: tooMany,
    }).ok).toBe(false);

    expect(makeExecutionOutcomeEnvelope({
      source: "scheduled", executionRef: "run_1", observation: "terminal",
      outcome: "failed", cleanup: "not_required", correlationKey: "k",
      evidence: { nested: { deep: true } },
    }).ok).toBe(false);
  });

  it("rejects negative or non-integer generations", () => {
    expect(makeExecutionOutcomeEnvelope({
      source: "worker", executionRef: "a_1:0", attemptId: "a_1",
      attemptGeneration: -1, observation: "terminal", outcome: "failed",
      cleanup: "unknown", correlationKey: "k",
    }).ok).toBe(false);
  });
});
