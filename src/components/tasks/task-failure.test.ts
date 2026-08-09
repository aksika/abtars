import { describe, it, expect } from "vitest";
import { makeTaskFailure, decideFailurePolicy, parseTaskFailure, formatTaskFailure, formatTaskFailureDetail } from "./task-failure.js";
import type { TaskFailureDiagnosticV1, TaskFailureCategory } from "./task-failure.js";

const PHASE = "executing" as const;

function diag(category: TaskFailureCategory, code: string, retryability: TaskFailureDiagnosticV1["retryability"], message = "boom"): TaskFailureDiagnosticV1 {
  return makeTaskFailure(category, code, PHASE, message, retryability);
}

describe("#1520 failure policy matrix", () => {
  const cases: Array<{ name: string; d: TaskFailureDiagnosticV1; expected: ReturnType<typeof decideFailurePolicy> }> = [
    // admission busy, cap, or cooldown → defer the same occurrence; no failure increment
    { name: "admission session_capacity defers", d: diag("admission", "session_capacity", "transient"), expected: { action: "defer" } },
    { name: "admission type_busy defers", d: diag("admission", "type_busy", "transient"), expected: { action: "defer" } },
    { name: "admission model_cooldown defers", d: diag("admission", "model_cooldown", "transient"), expected: { action: "defer" } },
    { name: "admission executor_unavailable defers", d: diag("admission", "executor_unavailable", "transient"), expected: { action: "defer" } },
    // permanent definition/dependency/routing fault → no retry, auto-pause immediately
    { name: "permanent definition pauses immediately", d: diag("definition", "required_executable_missing", "permanent"), expected: { action: "count", pauseNow: true } },
    { name: "permanent dependency pauses immediately", d: diag("dependency", "executable_missing", "permanent"), expected: { action: "count", pauseNow: true } },
    { name: "permanent routing pauses immediately", d: diag("routing", "peer_not_enrolled", "permanent"), expected: { action: "count", pauseNow: true } },
    // transient dependency/execution/validation → one delayed retry in the same run group
    { name: "transient dependency retries", d: diag("dependency", "probe_failed", "transient"), expected: { action: "retry" } },
    { name: "transient execution retries", d: diag("execution", "model_error", "transient"), expected: { action: "retry" } },
    { name: "transient validation retries", d: diag("validation", "artifact_stale_mtime", "transient"), expected: { action: "retry" } },
    // non-transient execution/validation → no retry, count one failed group
    { name: "non-transient execution counts", d: diag("execution", "model_error", "none"), expected: { action: "count", pauseNow: false } },
    { name: "non-transient validation counts", d: diag("validation", "required_heading_missing", "none"), expected: { action: "count", pauseNow: false } },
    // timeout/restart interruption → no blind replay; count one failed group
    { name: "timed_out counts", d: diag("interruption", "timed_out", "none"), expected: { action: "count", pauseNow: false } },
    { name: "restart_interrupted counts", d: diag("interruption", "restart_interrupted", "none"), expected: { action: "count", pauseNow: false } },
    { name: "deadline_exceeded counts", d: diag("interruption", "deadline_exceeded", "none"), expected: { action: "count", pauseNow: false } },
    // operator cancellation → no retry and no failure increment
    { name: "cancelled clears", d: diag("interruption", "cancelled", "none"), expected: { action: "clear" } },
    // delivery → never the scheduler settler; no count/retry here
    { name: "delivery definitely_not_sent clears", d: diag("delivery", "definitely_not_sent", "none"), expected: { action: "clear" } },
    { name: "delivery send_unknown clears", d: diag("delivery", "send_unknown", "none"), expected: { action: "clear" } },
    // safe messages never affect the decision
    { name: "message text does not change the decision", d: diag("execution", "model_error", "transient", "task failed: unknown peer: session busy"), expected: { action: "retry" } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(decideFailurePolicy(c.d)).toEqual(c.expected);
    });
  }

  it("bounded safe messages never exceed the cap", () => {
    const d = makeTaskFailure("execution", "model_error", PHASE, "x".repeat(5000), "none");
    expect(d.message.length).toBeLessThanOrEqual(500);
  });

  it("redacts credential-shaped content before durable persistence", () => {
    const d = makeTaskFailure("execution", "model_error", PHASE, "provider rejected sk-abc123def456ghi789jkl012mno", "none");
    expect(d.message).not.toContain("sk-abc123def456ghi789jkl012mno");
    expect(d.message).toContain("REDACTED");
  });

  it("rejects unknown failure codes at construction", () => {
    expect(() => makeTaskFailure("execution", "made_up_code", PHASE, "x", "none")).toThrow("Unknown task failure code");
  });

  // #1297: credits_exhausted is a recognized execution diagnostic without a
  // schema migration — version stays 1 and the policy path stays the ordinary
  // non-retryable execution branch.
  it("credits_exhausted is a recognized execution code at v1", () => {
    const d = makeTaskFailure("execution", "credits_exhausted", PHASE, "all providers out of credits", "none");
    expect(d.version).toBe(1);
    expect(parseTaskFailure(JSON.parse(JSON.stringify(d)))).toEqual(d);
  });

  it("credits_exhausted decides as non-retryable execution (no retry timestamp)", () => {
    const d = makeTaskFailure("execution", "credits_exhausted", PHASE, "all providers out of credits", "none");
    expect(decideFailurePolicy(d)).toEqual({ action: "count", pauseNow: false });
  });

  it("parse round-trips durable diagnostics and rejects unknown codes", () => {
    const d = makeTaskFailure("admission", "session_capacity", "queued", "busy", "transient");
    const parsed = parseTaskFailure(JSON.parse(JSON.stringify(d)));
    expect(parsed).toEqual(d);
    expect(parseTaskFailure({ version: 1, category: "admission", code: "made_up_code", phase: "queued", message: "x", retryability: "transient", occurredAt: 1 })).toBeNull();
    expect(parseTaskFailure("legacy string")).toBeNull();
  });

  it("format shows category/code plus safe message", () => {
    const d = diag("routing", "local_session_not_peer", "permanent", "local identity");
    expect(formatTaskFailure(d)).toBe("routing/local_session_not_peer: local identity");
  });

  it("a v1 history row without context still parses", () => {
    const legacy = { version: 1, category: "execution", code: "model_error", phase: "executing", message: "x", retryability: "none", occurredAt: 1 };
    const parsed = parseTaskFailure(JSON.parse(JSON.stringify(legacy)));
    expect(parsed).not.toBeNull();
    expect(parsed!.context).toBeUndefined();
  });

  it("a malformed context degrades to a valid diagnostic without context", () => {
    const d = makeTaskFailure("supervision", "lane_late_completion", "executing", "late", "none");
    const raw = JSON.parse(JSON.stringify(d));
    raw.context = { lanes: [{ cardId: "not-a-number", contractId: 42 }] };
    const parsed = parseTaskFailure(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.category).toBe("supervision");
    expect(parsed!.code).toBe("lane_late_completion");
    expect(parsed!.context).toBeUndefined();
  });

  it("drops the whole context when any lane is malformed", () => {
    const d = makeTaskFailure("supervision", "lane_failed", "executing", "failed", "none", {
      lanes: [{
        cardId: 1,
        contractId: "c1",
        attemptId: "a1",
        lifecycle: "failed",
        criteria: [],
        missingEvidence: [],
      }],
    });
    const raw = JSON.parse(JSON.stringify(d));
    raw.context.lanes.push({ cardId: "bad", contractId: "c2" });
    const parsed = parseTaskFailure(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.context).toBeUndefined();
  });

  it("redacts secrets when parsing externally supplied diagnostics", () => {
    const raw = {
      version: 1,
      category: "supervision",
      code: "lane_failed",
      phase: "executing",
      message: "worker returned sk-abc123def456ghi789jkl012mno",
      retryability: "none",
      occurredAt: 1,
      context: {
        lanes: [{
          cardId: 1,
          contractId: "c_secret sk-abc123def456ghi789jkl012mno",
          attemptId: "a1",
          lifecycle: "failed",
          cancelReason: "token=sk-abc123def456ghi789jkl012mno",
          criteria: [{ id: "c1", status: "failed" }],
          missingEvidence: [],
        }],
      },
    };
    const parsed = parseTaskFailure(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.message).not.toContain("sk-abc123def456ghi789jkl012mno");
    expect(parsed!.context!.lanes[0]!.contractId).not.toContain("sk-abc123def456ghi789jkl012mno");
    expect(parsed!.context!.lanes[0]!.cancelReason).not.toContain("sk-abc123def456ghi789jkl012mno");
  });

  it("supervision never returns retry — an over-budget lane is not blindly replayed", () => {
    expect(decideFailurePolicy(diag("supervision", "lane_late_completion", "none"))).toEqual({ action: "count", pauseNow: false });
    expect(decideFailurePolicy(diag("supervision", "lane_timed_out", "none"))).toEqual({ action: "count", pauseNow: false });
    expect(decideFailurePolicy(diag("supervision", "lane_failed", "none"))).toEqual({ action: "count", pauseNow: false });
    expect(decideFailurePolicy(diag("supervision", "project_blocked", "none"))).toEqual({ action: "count", pauseNow: false });
  });

  it("definition-shaped supervision faults pause immediately", () => {
    expect(decideFailurePolicy(diag("supervision", "criterion_unevidenced", "none"))).toEqual({ action: "count", pauseNow: true });
    expect(decideFailurePolicy(diag("supervision", "contract_uncovered", "none"))).toEqual({ action: "count", pauseNow: true });
  });

  it("context bounds truncate lanes, criteria, and remediation hint", () => {
    const lanes = Array.from({ length: 20 }, (_, i) => ({
      cardId: i,
      contractId: `c${i}`,
      attemptId: `a${i}`,
      lifecycle: "timed_out",
      criteria: Array.from({ length: 30 }, (_, j) => ({ id: `crit${j}`, status: "not_run" })),
      missingEvidence: ["c1"],
    }));
    const d = makeTaskFailure("supervision", "lane_timed_out", "executing", "x", "none", {
      lanes,
      remediationHint: "r".repeat(500),
    });
    expect(d.context!.lanes).toHaveLength(8);
    expect(d.context!.lanes[0]!.criteria).toHaveLength(20);
    expect(d.context!.lanes[0]!.missingEvidence).toHaveLength(1);
    expect(d.context!.remediationHint!.length).toBe(300);
  });

  it("context strings are redacted before durability", () => {
    const d = makeTaskFailure("supervision", "lane_failed", "executing", "x", "none", {
      lanes: [{ cardId: 1, contractId: "c_secret sk-abc123def456ghi789jkl012mno", attemptId: "a1", lifecycle: "failed", criteria: [], missingEvidence: [] }],
    });
    expect(d.context!.lanes[0]!.contractId).not.toContain("sk-abc123def456ghi789jkl012mno");
  });

  it("context round-trips through parse and the diagnostic survives", () => {
    const d = makeTaskFailure("supervision", "lane_late_completion", "executing", "late", "none", {
      rootCardId: 7,
      lanes: [{
        cardId: 4,
        contractId: "c_abc",
        attemptId: "a_xyz",
        lifecycle: "timed_out",
        cancelReason: "late_completion_timed_out: worker_completed",
        hardDeadlineAt: "2026-08-06T13:46:38.195Z",
        settledAt: "2026-08-06T13:46:45.680Z",
        overrunMs: 7485,
        bindingLimit: { name: "max_duration_ms", value: 120000 },
        criteria: [{ id: "c1", status: "not_run" }],
        missingEvidence: ["c1"],
      }],
      remediationHint: "raise the lane budget",
    });
    const parsed = parseTaskFailure(JSON.parse(JSON.stringify(d)));
    expect(parsed).toEqual(d);
    expect(parsed!.context!.lanes[0]!.bindingLimit).toEqual({ name: "max_duration_ms", value: 120000 });
    expect(parsed!.context!.lanes[0]!.overrunMs).toBe(7485);
  });

  it("formatTaskFailureDetail renders the lane breakdown", () => {
    const d = makeTaskFailure("supervision", "lane_late_completion", "executing", "late", "none", {
      lanes: [{
        cardId: 4, contractId: "c_abc", attemptId: "a_xyz", lifecycle: "timed_out",
        overrunMs: 7485, bindingLimit: { name: "max_duration_ms", value: 120000 },
        criteria: [{ id: "c1", status: "not_run" }], missingEvidence: ["c1"],
      }],
    });
    const text = formatTaskFailureDetail(d);
    expect(text).toContain("supervision/lane_late_completion");
    expect(text).toContain("card 4");
    expect(text).toContain("overrun_ms 7485");
    expect(text).toContain("binding_limit max_duration_ms=120000");
    expect(text).toContain("Unevidenced criteria: c1");
  });
});
