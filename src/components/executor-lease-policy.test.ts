import { describe, it, expect } from "vitest";
import { evaluateLease, applyInspectionOutcome } from "./executor-lease-policy.js";
import { createInitialSnapshot, reduceFact } from "./executor-lease-reducer.js";
import { DEFAULT_LOCAL_POLICY, type ExecutorProgressFactV1 } from "./executor-progress.js";

const BASE_FACT: ExecutorProgressFactV1 = {
  schema_version: 1,
  fact_id: "f1",
  attempt_id: "a1",
  claim_generation: 1,
  executor: { kind: "agent", id: "spin-01" },
  kind: "alive",
  payload: {},
};

describe("evaluateLease", () => {
  it("returns healthy for fresh snapshot", () => {
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, Date.now());
    const decision = evaluateLease(snap, Date.now(), DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("healthy");
    expect(decision.nextAt).toBeDefined();
  });

  it("returns warning when progress is expired but within warning window", () => {
    const now = Date.now();
    const expired = now - DEFAULT_LOCAL_POLICY.meaningfulProgressMs - 1;
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    snap.lastMeaningfulProgressAt = new Date(expired).toISOString();
    snap.progressDeadlineAt = new Date(expired + DEFAULT_LOCAL_POLICY.meaningfulProgressMs).toISOString();
    const pastWarning = expired + DEFAULT_LOCAL_POLICY.meaningfulProgressMs + DEFAULT_LOCAL_POLICY.warningBeforeMs;
    const decision = evaluateLease(snap, pastWarning, DEFAULT_LOCAL_POLICY);
    expect(["warning", "inspect", "cancel"]).toContain(decision.action);
  });

  it("returns inspect when expired and past warning", () => {
    const now = Date.now();
    const veryOld = now - DEFAULT_LOCAL_POLICY.meaningfulProgressMs - DEFAULT_LOCAL_POLICY.warningBeforeMs - 10_000;
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, veryOld);
    // Set to warning first
    snap.evaluation.phase = "warning";
    const decision = evaluateLease(snap, now, DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("inspect");
  });

  it("returns cancel for hard deadline", () => {
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, Date.now());
    const decision = evaluateLease(snap, Date.now(), DEFAULT_LOCAL_POLICY, 0);
    expect(decision.action).toBe("cancel");
    expect(decision.reason).toBe("hard_deadline");
  });

  it("schedules the absolute hard deadline before the semantic lease windows", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    const decision = evaluateLease(snap, now, DEFAULT_LOCAL_POLICY, now + 5_000);
    expect(decision.action).toBe("warning");
    expect(decision.nextAt).toBe(new Date(now + 5_000).toISOString());
  });

  it("returns closed for closed lease", () => {
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, Date.now());
    snap.evaluation.phase = "closed";
    snap.closedAt = new Date().toISOString();
    const decision = evaluateLease(snap, Date.now(), DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("closed");
  });

  it("cancel_requested returns cancel", () => {
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, Date.now());
    snap.evaluation.phase = "cancel_requested";
    const decision = evaluateLease(snap, Date.now(), DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("cancel");
  });

  it("returns healthy for awaiting_input within deadline", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    snap.awaitingInput = { requestId: "r1", since: new Date(now).toISOString(), deadlineAt: new Date(now + 10_000).toISOString() };
    snap.semanticState = "awaiting_input";
    const decision = evaluateLease(snap, now, DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("healthy");
  });

  it("returns cancel for expired input wait", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    snap.awaitingInput = { requestId: "r1", since: new Date(now - 10_000).toISOString(), deadlineAt: new Date(now - 1).toISOString() };
    snap.semanticState = "awaiting_input";
    const decision = evaluateLease(snap, now, DEFAULT_LOCAL_POLICY);
    expect(decision.action).toBe("cancel");
  });
});

describe("applyInspectionOutcome", () => {
  it("running inspection renews liveness and grants grace", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    snap.lastMeaningfulProgressAt = new Date(now - 400_000).toISOString();
    const result = applyInspectionOutcome(snap, "running", now, DEFAULT_LOCAL_POLICY);
    expect(result.evaluation.phase).toBe("inspect_grace");
    expect(result.evaluation.lastInspectionOutcome).toBe("running");
    expect(result.evaluation.inspectionCount).toBe(1);
  });

  it("cancels when the fixed inspection grace expires", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now - 400_000);
    snap.evaluation.phase = "inspect_grace";
    snap.evaluation.graceDeadlineAt = new Date(now - 1).toISOString();
    const result = evaluateLease(snap, now, DEFAULT_LOCAL_POLICY);
    expect(result.action).toBe("cancel");
  });

  it("unknown inspection increments count and grants grace", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    const result = applyInspectionOutcome(snap, "unknown", now, DEFAULT_LOCAL_POLICY);
    expect(result.evaluation.phase).toBe("inspect_grace");
    expect(result.evaluation.inspectionCount).toBe(1);
  });

  it("unknown exhaustion reaches cancel_due", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    snap.evaluation.inspectionCount = DEFAULT_LOCAL_POLICY.maxUnknownInspections - 1;
    const result = applyInspectionOutcome(snap, "unknown", now, DEFAULT_LOCAL_POLICY);
    expect(result.evaluation.phase).toBe("inspect_grace");
    expect(result.evaluation.reason).toBe("inspection_unknown_exhausted");
  });

  it("terminal closes the lease", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    const result = applyInspectionOutcome(snap, "terminal", now, DEFAULT_LOCAL_POLICY);
    expect(result.evaluation.phase).toBe("closed");
    expect(result.closedAt).toBeDefined();
  });
});
