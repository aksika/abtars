import { describe, it, expect } from "vitest";
import {
  validateProgressEvent,
  computeSequenceFingerprint,
  isMeaningfulProgress,
  computeDeadlines,
  DEFAULT_LOCAL_POLICY,
  type ExecutorProgressEventV1,
} from "./executor-progress.js";

const VALID_EVENT: Record<string, unknown> = {
  schema_version: 1,
  attempt_id: "a_test_001",
  claim_generation: 1,
  executor: { kind: "agent", id: "spin-01" },
  sequence: 1,
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

  it("rejects invalid kind", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, kind: "invalid" }).ok).toBe(false);
  });

  it("accepts all valid kinds", () => {
    for (const kind of ["alive", "producing_output", "using_tool", "durable_milestone", "awaiting_input", "stalled"]) {
      expect(validateProgressEvent({ ...VALID_EVENT, kind }).ok).toBe(true);
    }
  });

  it("accepts valid phases", () => {
    for (const phase of ["start", "advance", "end", "resolved"]) {
      expect(validateProgressEvent({ ...VALID_EVENT, kind: "using_tool", phase }).ok).toBe(true);
    }
  });

  it("rejects invalid sequence", () => {
    expect(validateProgressEvent({ ...VALID_EVENT, sequence: 0 }).ok).toBe(false);
  });
});

describe("computeSequenceFingerprint", () => {
  it("produces deterministic fingerprints", () => {
    const event = VALID_EVENT as unknown as ExecutorProgressEventV1;
    expect(computeSequenceFingerprint(event)).toBe(computeSequenceFingerprint(event));
  });

  it("different kinds produce different fingerprints", () => {
    const alive = VALID_EVENT as unknown as ExecutorProgressEventV1;
    const milestone = { ...VALID_EVENT, kind: "durable_milestone" } as unknown as ExecutorProgressEventV1;
    expect(computeSequenceFingerprint(alive)).not.toBe(computeSequenceFingerprint(milestone));
  });
});

describe("isMeaningfulProgress", () => {
  it("durable_milestone is meaningful", () => {
    expect(isMeaningfulProgress("durable_milestone")).toBe(true);
  });

  it("alive is not meaningful", () => {
    expect(isMeaningfulProgress("alive")).toBe(false);
  });

  it("using_tool end is meaningful", () => {
    expect(isMeaningfulProgress("using_tool", "end")).toBe(true);
  });

  it("using_tool start is not meaningful", () => {
    expect(isMeaningfulProgress("using_tool", "start")).toBe(false);
  });

  it("awaiting_input resolved is meaningful", () => {
    expect(isMeaningfulProgress("awaiting_input", "resolved")).toBe(true);
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
    const result = computeDeadlines(now, DEFAULT_LOCAL_POLICY, undefined, 10_000);
    expect(new Date(result.livenessDeadlineAt).getTime()).toBe(now + 10_000);
    expect(new Date(result.progressDeadlineAt).getTime()).toBe(now + 10_000);
  });
});
