import { describe, it, expect } from "vitest";
import {
  validateProgressEvent,
  computeSemanticFingerprint,
  computeLeaseEffect,
  computeDeadlines,
  DEFAULT_LOCAL_POLICY,
  type ExecutorProgressFactV1,
} from "./executor-progress.js";

const VALID_EVENT: Record<string, unknown> = {
  schema_version: 1,
  fact_id: "fact_001",
  attempt_id: "a_test_001",
  claim_generation: 1,
  executor: { kind: "agent", id: "spin-01" },
  kind: "alive",
  producer_at: "2026-07-13T00:00:00.000Z",
  payload: {},
};

describe("validateProgressEvent", () => {
  it("accepts a valid alive event", () => {
    const result = validateProgressEvent(VALID_EVENT);
    expect(result.ok).toBe(true);
  });

  it("rejects null input", () => {
    expect(validateProgressEvent(null).ok).toBe(false);
  });

  it("rejects unknown schema_version", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, schema_version: 2 }).ok).toBe(false);
  });

  it("rejects missing fact_id", () => {
    const { fact_id, ...noId } = VALID_EVENT;
    expect(validateProgressEvent(noId).ok).toBe(false);
  });

  it("rejects missing attempt_id", () => {
    const { attempt_id, ...noId } = VALID_EVENT;
    expect(validateProgressEvent(noId).ok).toBe(false);
  });

  it("rejects invalid executor kind", () => {
    expect(validateProgressEvent({
      ...VALID_EVENT,
      executor: { kind: "invalid", id: "x" },
    }).ok).toBe(false);
  });

  it("rejects remote executor kind", () => {
    expect(validateProgressEvent({
      ...VALID_EVENT,
      executor: { kind: "remote", id: "x" },
    }).ok).toBe(false);
  });

  it("accepts pi executor kind", () => {
    expect(validateProgressEvent({
      ...VALID_EVENT,
      executor: { kind: "pi", id: "pi-01" },
    }).ok).toBe(true);
  });

  it("rejects invalid kind", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "invalid" }).ok).toBe(false);
  });

  it("accepts all valid kinds", () => {
    for (const kind of ["alive", "producing_output", "stalled"]) {
      expect(validateProgressEvent({ ...VALID_EVENT, kind }).ok).toBe(true);
    }
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "durable_milestone", payload: { milestone_id: "m1" } }).ok).toBe(true);
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "using_tool", phase: "start", payload: { operation_id: "op1" } }).ok).toBe(true);
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "awaiting_input", phase: "start", payload: { input_request_id: "req1" } }).ok).toBe(true);
  });

  it("rejects using_tool without phase", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "using_tool" }).ok).toBe(false);
  });

  it("rejects awaiting_input without phase", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "awaiting_input" }).ok).toBe(false);
  });

  it("rejects using_tool with resolved phase", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "using_tool", phase: "resolved" }).ok).toBe(false);
  });

  it("accepts valid phases for using_tool", () => {
    for (const phase of ["start", "advance", "end"]) {
      expect(validateProgressEvent({ ...VALID_EVENT, kind: "using_tool", phase, payload: { operation_id: "op1" } }).ok).toBe(true);
    }
  });

  it("accepts valid phases for awaiting_input", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "awaiting_input", phase: "start", payload: { input_request_id: "req1" } }).ok).toBe(true);
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "awaiting_input", phase: "resolved", payload: { input_request_id: "req1" } }).ok).toBe(true);
  });
});

describe("computeSemanticFingerprint", () => {
  it("produces deterministic fingerprints", () => {
    const event = VALID_EVENT as unknown as ExecutorProgressFactV1;
    expect(computeSemanticFingerprint(event)).toBe(computeSemanticFingerprint(event));
  });

  it("different kinds produce different fingerprints", () => {
    const alive = VALID_EVENT as unknown as ExecutorProgressFactV1;
    const milestone = { ...VALID_EVENT, kind: "durable_milestone", payload: { milestone_id: "m1" } } as unknown as ExecutorProgressFactV1;
    expect(computeSemanticFingerprint(alive)).not.toBe(computeSemanticFingerprint(milestone));
  });
});

describe("computeLeaseEffect", () => {
  it("alive is liveness", () => {
    expect(computeLeaseEffect("alive")).toBe("liveness");
  });

  it("durable_milestone is meaningful", () => {
    expect(computeLeaseEffect("durable_milestone")).toBe("meaningful");
  });

  it("using_tool end is meaningful", () => {
    expect(computeLeaseEffect("using_tool", "end")).toBe("meaningful");
  });

  it("using_tool start is liveness", () => {
    expect(computeLeaseEffect("using_tool", "start")).toBe("liveness");
  });

  it("awaiting_input resolved is meaningful", () => {
    expect(computeLeaseEffect("awaiting_input", "resolved")).toBe("meaningful");
  });

  it("awaiting_input start is state", () => {
    expect(computeLeaseEffect("awaiting_input", "start")).toBe("state");
  });

  it("stalled is state", () => {
    expect(computeLeaseEffect("stalled")).toBe("state");
  });
});

describe("computeDeadlines", () => {
  it("returns deadlines based on policy", () => {
    const now = Date.now();
    const result = computeDeadlines(now, DEFAULT_LOCAL_POLICY);
    expect(new Date(result.livenessDeadlineAt).getTime()).toBe(now + DEFAULT_LOCAL_POLICY.livenessMs);
    expect(new Date(result.progressDeadlineAt).getTime()).toBe(now + DEFAULT_LOCAL_POLICY.meaningfulProgressMs);
  });

  it("hard deadline clamps both deadlines", () => {
    const now = Date.now();
    const result = computeDeadlines(now, DEFAULT_LOCAL_POLICY, undefined, now + 10_000);
    expect(new Date(result.livenessDeadlineAt).getTime()).toBe(now + 10_000);
    expect(new Date(result.progressDeadlineAt).getTime()).toBe(now + 10_000);
  });
});
