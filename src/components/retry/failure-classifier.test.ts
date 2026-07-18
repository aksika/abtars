import { describe, it, expect } from "vitest";
import { classify } from "./failure-classifier.js";

describe("failure-classifier", () => {
  const baseInput = {
    attempt_id: "a_test_1",
    lifecycle: "failed" as const,
  };

  it("returns unknown for minimal input", () => {
    const result = classify(baseInput as any);
    expect(result.classification.primary).toBe("unknown");
    expect(result.classification.confidence).toBe("ambiguous");
    expect(result.classification.retryability).toBe("review_required");
  });

  it("classifies operator cancellation", () => {
    const result = classify({ ...baseInput, cancelReason: "operator" } as any);
    expect(result.classification.primary).toBe("operator_cancelled");
    expect(result.classification.retryability).toBe("never");
  });

  it("classifies shutdown as transient transport", () => {
    const result = classify({ ...baseInput, cancelReason: "shutdown" } as any);
    expect(result.classification.primary).toBe("transient_transport");
    expect(result.classification.retryability).toBe("automatic");
  });

  it("classifies project abort as operator_cancelled", () => {
    const result = classify({ ...baseInput, cancelReason: "project_abort" } as any);
    expect(result.classification.primary).toBe("operator_cancelled");
    expect(result.classification.retryability).toBe("never");
  });

  it("classifies timed out lifecycle", () => {
    const result = classify({ ...baseInput, lifecycle: "timed_out" } as any);
    expect(result.classification.primary).toBe("hard_deadline");
    expect(result.classification.retryability).toBe("never");
  });

  it("classifies envelope with retryable transport error", () => {
    const env = {
      attempt: { id: "a_test_1" },
      outcome: "failed",
      error: { code: "TRANSPORT", message: "connection reset", retryable: true },
      criteria: [{ criterion_id: "c1", status: "not_run", evidence_ids: [] }],
      checks: [],
      artifacts: [],
      worker_report: { summary: "error", claims: [], unresolved_risks: [] },
    };
    const result = classify({ ...baseInput, envelope: env } as any);
    expect(result.classification.primary).toBe("transient_transport");
    expect(result.classification.retryability).toBe("automatic");
    expect(result.classification.stable_codes).toContain("error:TRANSPORT");
  });

  it("classifies policy denial", () => {
    const env = {
      attempt: { id: "a_test_1" },
      outcome: "failed",
      error: { code: "POLICY", message: "denied", retryable: false },
      criteria: [],
      checks: [],
      artifacts: [],
      worker_report: { summary: "denied", claims: [], unresolved_risks: [] },
    };
    const result = classify({ ...baseInput, envelope: env } as any);
    expect(result.classification.primary).toBe("policy_or_security_denied");
    expect(result.classification.retryability).toBe("never");
  });

  it("classifies invalid_contract", () => {
    const env = {
      attempt: { id: "a_test_1" },
      outcome: "failed",
      error: { code: "INVALID_CONTRACT", message: "bad contract", retryable: false },
      criteria: [],
      checks: [],
      artifacts: [],
      worker_report: { summary: "invalid", claims: [], unresolved_risks: [] },
    };
    const result = classify({ ...baseInput, envelope: env } as any);
    expect(result.classification.primary).toBe("invalid_contract");
    expect(result.classification.retryability).toBe("never");
  });

  it("classifies acceptance failure with check failures", () => {
    const env = {
      attempt: { id: "a_test_1" },
      outcome: "failed",
      criteria: [{ criterion_id: "c1", status: "failed", evidence_ids: ["check1"] }],
      checks: [{ check_id: "check1", exit_code: 1, timed_out: false }],
      artifacts: [],
      worker_report: { summary: "failed", claims: [], unresolved_risks: [] },
    };
    const result = classify({ ...baseInput, envelope: env } as any);
    expect(result.classification.primary).toBe("tool_or_verification_failure");
    expect(result.classification.factors).toContain("acceptance_unmet");
  });

  it("classifies lease expired with stalled state", () => {
    const leaseSnapshot = {
      attemptId: "a_test_1",
      semanticState: "stalled" as const,
      evaluation: "cancel_requested" as const,
    };
    const result = classify({ ...baseInput, leaseSnapshot } as any);
    expect(result.classification.primary).toBe("lease_expired");
    expect(result.classification.retryability).toBe("automatic");
  });

  it("deduplicates factors", () => {
    const env = {
      attempt: { id: "a_test_1" },
      outcome: "failed",
      criteria: [{ criterion_id: "c1", status: "failed", evidence_ids: [] }],
      checks: [{ check_id: "check1", exit_code: 1, timed_out: false }],
      artifacts: [{ artifact_id: "a1", exists: false, kind: "file", ref: "out.txt" }],
      worker_report: { summary: "failed", claims: [], unresolved_risks: [] },
    };
    const result = classify({ ...baseInput, envelope: env } as any);
    const factorSet = new Set(result.classification.factors);
    expect(factorSet.size).toBe(result.classification.factors.length);
  });
});
