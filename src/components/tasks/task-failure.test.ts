import { describe, it, expect } from "vitest";
import { makeTaskFailure, decideFailurePolicy, parseTaskFailure, formatTaskFailure } from "./task-failure.js";
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
});
