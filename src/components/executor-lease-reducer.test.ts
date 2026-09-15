import { describe, it, expect } from "vitest";
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

const BASE_SNAPSHOT = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, Date.now());

describe("createInitialSnapshot", () => {
  it("creates snapshot with initial deadlines", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    expect(snap.attemptId).toBe("a1");
    expect(snap.cardId).toBe(42);
    expect(snap.semanticState).toBe("alive");
    expect(snap.evaluation.phase).toBe("healthy");
    expect(new Date(snap.livenessDeadlineAt).getTime()).toBe(now + DEFAULT_LOCAL_POLICY.livenessMs);
    expect(new Date(snap.progressDeadlineAt).getTime()).toBe(now + DEFAULT_LOCAL_POLICY.meaningfulProgressMs);
  });
});

describe("reduceFact — dual clocks", () => {
  it("alive renews liveness but not progress", () => {
    const now = Date.now();
    const oldProgress = BASE_SNAPSHOT.lastMeaningfulProgressAt;
    const result = reduceFact(BASE_SNAPSHOT, { ...BASE_FACT, kind: "alive", fact_id: "f2" }, DEFAULT_LOCAL_POLICY, now + 10_000);
    expect(result.lastLivenessAt).not.toBe(BASE_SNAPSHOT.lastLivenessAt);
    expect(result.lastMeaningfulProgressAt).toBe(oldProgress);
  });

  it("durable_milestone renews both", () => {
    const now = Date.now();
    const oldLiveness = BASE_SNAPSHOT.lastLivenessAt;
    const result = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "durable_milestone",
      fact_id: "f2",
      payload: { milestone_id: "m1" },
    }, DEFAULT_LOCAL_POLICY, now + 10_000);
    expect(result.lastLivenessAt).not.toBe(oldLiveness);
    expect(result.lastMeaningfulProgressAt).not.toBe(BASE_SNAPSHOT.lastMeaningfulProgressAt);
  });

  it("producing_output renews liveness and meaningful within cap", () => {
    const now = Date.now();
    const oldProgress = BASE_SNAPSHOT.lastMeaningfulProgressAt;
    const result = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "producing_output",
      fact_id: "f2",
      payload: { progress_units: 10 },
    }, DEFAULT_LOCAL_POLICY, now);
    expect(result.lastMeaningfulProgressAt).not.toBe(oldProgress);
    expect(result.outputOnlySince).toBeDefined();
  });

  it("producing_output beyond cap renews liveness only", () => {
    const snap = { ...BASE_SNAPSHOT, outputOnlySince: new Date(Date.now() - 200_000).toISOString(), outputUnits: 10 };
    snap.lastMeaningfulProgressAt = new Date(Date.now() - 200_000).toISOString();
    const now = Date.now();
    const oldProgress = snap.lastMeaningfulProgressAt;
    const result = reduceFact(snap, {
      ...BASE_FACT,
      kind: "producing_output",
      fact_id: "f2",
      payload: { progress_units: 20 },
    }, DEFAULT_LOCAL_POLICY, now);
    expect(result.lastMeaningfulProgressAt).toBe(oldProgress);
  });

  it("using_tool/start opens operation with silence deadline", () => {
    const now = Date.now();
    const result = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "using_tool",
      phase: "start",
      fact_id: "f2",
      payload: { operation_id: "op1", operation_label: "test", expected_timeout_ms: 60_000 },
    }, DEFAULT_LOCAL_POLICY, now);
    expect(result.operation).toBeDefined();
    expect(result.operation!.id).toBe("op1");
    expect(result.semanticState).toBe("using_tool");
  });

  it("using_tool/end removes operation and renews meaningful if new observation", () => {
    const now = Date.now();
    const withOp = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "using_tool",
      phase: "start",
      fact_id: "f2",
      payload: { operation_id: "op1" },
    }, DEFAULT_LOCAL_POLICY, now);
    const oldProgress = withOp.lastMeaningfulProgressAt;
    const result = reduceFact(withOp, {
      ...BASE_FACT,
      kind: "using_tool",
      phase: "end",
      fact_id: "f3",
      payload: { operation_id: "op1", observation_id: "obs1" },
    }, DEFAULT_LOCAL_POLICY, now + 5_000);
    expect(result.operation).toBeUndefined();
    expect(result.lastMeaningfulProgressAt).not.toBe(oldProgress);
  });

  it("using_tool/end without observation does not renew meaningful", () => {
    const now = Date.now();
    const withOp = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "using_tool",
      phase: "start",
      fact_id: "f2",
      payload: { operation_id: "op1" },
    }, DEFAULT_LOCAL_POLICY, now);
    const oldProgress = withOp.lastMeaningfulProgressAt;
    const result = reduceFact(withOp, {
      ...BASE_FACT,
      kind: "using_tool",
      phase: "end",
      fact_id: "f3",
      payload: { operation_id: "op1" },
    }, DEFAULT_LOCAL_POLICY, now + 5_000);
    expect(result.lastMeaningfulProgressAt).toBe(oldProgress);
  });

  it("stalled sets nextEvaluationAt", () => {
    const result = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "stalled",
      fact_id: "f2",
    }, DEFAULT_LOCAL_POLICY, Date.now());
    expect(result.semanticState).toBe("stalled");
    expect(result.nextEvaluationAt).toBeDefined();
  });

  it("durable_milestone tracks lastMilestoneId for duplicate detection", () => {
    const now = Date.now();
    const r1 = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "durable_milestone",
      fact_id: "ms1",
      payload: { milestone_id: "m1" },
    }, DEFAULT_LOCAL_POLICY, now);
    expect(r1.lastMilestoneId).toBe("m1");
    expect(r1.lastMeaningfulProgressAt).not.toBe(BASE_SNAPSHOT.lastMeaningfulProgressAt);

    const oldMeaningful = r1.lastMeaningfulProgressAt;
    const r2 = reduceFact(r1, {
      ...BASE_FACT,
      kind: "durable_milestone",
      fact_id: "ms1dup",
      payload: { milestone_id: "m1" },
    }, DEFAULT_LOCAL_POLICY, now + 1_000);
    expect(r2.lastMilestoneId).toBe("m1");
    expect(r2.lastMeaningfulProgressAt).toBe(oldMeaningful);
  });

  it("new milestone_id after duplicate renews progress", () => {
    const now = Date.now();
    const r1 = reduceFact(BASE_SNAPSHOT, {
      ...BASE_FACT,
      kind: "durable_milestone",
      fact_id: "ms1",
      payload: { milestone_id: "m1" },
    }, DEFAULT_LOCAL_POLICY, now);
    const oldMeaningful = r1.lastMeaningfulProgressAt;

    const r2 = reduceFact(r1, {
      ...BASE_FACT,
      kind: "durable_milestone",
      fact_id: "ms2",
      payload: { milestone_id: "m2" },
    }, DEFAULT_LOCAL_POLICY, now + 5_000);
    expect(r2.lastMilestoneId).toBe("m2");
    expect(r2.lastMeaningfulProgressAt).not.toBe(oldMeaningful);
  });
});

describe("evaluation arming (#1793)", () => {
  it("createInitialSnapshot arms the first evaluation at the earlier deadline minus the warning lead", () => {
    const now = Date.now();
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now);
    expect(snap.nextEvaluationAt).toBeDefined();
    const expected = Math.min(
      now + DEFAULT_LOCAL_POLICY.livenessMs,
      now + DEFAULT_LOCAL_POLICY.meaningfulProgressMs,
    ) - DEFAULT_LOCAL_POLICY.warningBeforeMs;
    expect(new Date(snap.nextEvaluationAt as string).getTime()).toBe(expected);
  });

  it("reduceFact arms the schedule on every fact", () => {
    const now = Date.now();
    const unarmed = { ...BASE_SNAPSHOT, nextEvaluationAt: undefined };
    const result = reduceFact(unarmed, {
      ...BASE_FACT,
      kind: "alive",
      fact_id: "arm1",
    }, DEFAULT_LOCAL_POLICY, now);
    expect(result.nextEvaluationAt).toBeDefined();
    const expected = Math.min(
      new Date(result.livenessDeadlineAt).getTime(),
      new Date(result.progressDeadlineAt).getTime(),
    ) - DEFAULT_LOCAL_POLICY.warningBeforeMs;
    expect(new Date(result.nextEvaluationAt as string).getTime()).toBe(expected);
  });

  it("reduceFact never pushes an existing earlier arming later", () => {
    const now = Date.now();
    const immediate = new Date(now).toISOString();
    const armed = { ...BASE_SNAPSHOT, nextEvaluationAt: immediate };
    const result = reduceFact(armed, {
      ...BASE_FACT,
      kind: "alive",
      fact_id: "arm2",
    }, DEFAULT_LOCAL_POLICY, now);
    expect(result.nextEvaluationAt).toBe(immediate);
  });

  it("arming floors at now when the deadlines already passed", () => {
    const now = Date.now();
    const stale = {
      ...BASE_SNAPSHOT,
      livenessDeadlineAt: new Date(now - 60_000).toISOString(),
      progressDeadlineAt: new Date(now - 60_000).toISOString(),
      nextEvaluationAt: undefined,
    };
    const result = reduceFact(stale, {
      ...BASE_FACT,
      kind: "alive",
      fact_id: "arm3",
    }, DEFAULT_LOCAL_POLICY, now);
    // alive renews liveness but not meaningful progress, so the progress
    // deadline stays past and the arming floors at now: already-due.
    expect(new Date(result.nextEvaluationAt as string).getTime()).toBe(now);
  });

  it("arming recomputes when the existing instant is unparseable", () => {
    const now = Date.now();
    const corrupt = { ...BASE_SNAPSHOT, nextEvaluationAt: "not-a-date" };
    const result = reduceFact(corrupt, {
      ...BASE_FACT,
      kind: "alive",
      fact_id: "arm5",
    }, DEFAULT_LOCAL_POLICY, now);
    expect(Number.isFinite(new Date(result.nextEvaluationAt as string).getTime())).toBe(true);
  });

  it("arming clamps to the hard deadline", () => {
    const now = Date.now();
    // Hard deadline inside the warning window: both deadlines clamp to it,
    // so the arming lands one warning lead before it.
    const hardAt = now + 60_000;
    const snap = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now, hardAt);
    expect(new Date(snap.nextEvaluationAt as string).getTime()).toBe(hardAt - DEFAULT_LOCAL_POLICY.warningBeforeMs);
    // Hard deadline nearer than the warning lead: evaluate immediately.
    const snapDue = createInitialSnapshot(BASE_FACT, 42, DEFAULT_LOCAL_POLICY, now, now + 10_000);
    expect(new Date(snapDue.nextEvaluationAt as string).getTime()).toBe(now);
  });
});
