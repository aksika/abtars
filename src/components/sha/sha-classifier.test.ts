import { describe, it, expect } from "vitest";
import {
  classifyShaFailure,
  canonicalHash,
  canonicalJson,
  logEventKey,
  logFingerprint,
  normalizeFailureMessage,
  scheduledEventKey,
  scheduledFingerprint,
  type ShaPolicyView,
} from "./sha-classifier.js";
import { makeTaskFailure } from "../tasks/task-failure.js";
import type { LogFailureEvent, ScheduledFailureEvent } from "./sha-types.js";

const EMPTY_POLICY: ShaPolicyView = { fixes: [], logAdmissionAllowed: true };

function scheduled(opts: Partial<ScheduledFailureEvent> = {}): ScheduledFailureEvent {
  return {
    source: "scheduled",
    entryId: "daily-ai",
    runId: "run-123",
    taskKind: "agent",
    diagnostic: makeTaskFailure("execution", "model_error", "executing", "boom", "none"),
    occurredAt: 1_700_000_000_000,
    ...opts,
  };
}

function logEvent(opts: Partial<LogFailureEvent> = {}): LogFailureEvent {
  return {
    source: "log",
    component: "abtars",
    tag: "main",
    logPath: "/home/u/.abtars/logs/abtars.log",
    inode: 42,
    lineOffset: 1337,
    normalizedMessage: "adapter refused connection",
    occurredAt: 1_700_000_000_000,
    evidence: "line",
    ...opts,
  };
}

describe("classifyShaFailure — scheduled guard precedence (R3)", () => {
  it("suppresses everything in off mode", () => {
    const r = classifyShaFailure(scheduled(), "off", EMPTY_POLICY);
    expect(r.classification).toBe("suppressed");
    expect(r.reason).toContain("mode off");
  });

  it("classifies system-kind tasks as system in every enabled mode", () => {
    for (const mode of ["investigation", "full"] as const) {
      const r = classifyShaFailure(scheduled({ taskKind: "system" }), mode, EMPTY_POLICY);
      expect(r.classification).toBe("system");
      expect(r.reason).toContain("system-kind");
    }
  });

  it("classifies credits_exhausted as credits before any policy match", () => {
    const policy: ShaPolicyView = { fixes: [{ pattern: "credits", action: "run", command: ["true"], cooldownMin: 1 }], logAdmissionAllowed: true };
    const r = classifyShaFailure(
      scheduled({ diagnostic: makeTaskFailure("execution", "credits_exhausted", "executing", "out of credits", "none") }),
      "full",
      policy,
    );
    expect(r.classification).toBe("credits");
  });

  it("classifies structured routing/adapter outages as external", () => {
    const r = classifyShaFailure(
      scheduled({ diagnostic: makeTaskFailure("routing", "target_unavailable", "routing", "peer gone", "permanent") }),
      "full",
      EMPTY_POLICY,
    );
    expect(r.classification).toBe("external");
  });

  it("marks empty messages ambiguous (overlong messages are bounded at the settler)", () => {
    const empty = classifyShaFailure(scheduled({ diagnostic: makeTaskFailure("execution", "model_error", "executing", "", "none") }), "full", EMPTY_POLICY);
    expect(empty.classification).toBe("ambiguous");
    const long = classifyShaFailure(scheduled({ diagnostic: { ...makeTaskFailure("execution", "model_error", "executing", "boom", "none"), message: "x".repeat(501) } }), "full", EMPTY_POLICY);
    expect(long.classification).toBe("ambiguous");
  });

  it("suppress rules suppress; run rules classify known_fix; otherwise unknown actionable", () => {
    const policy: ShaPolicyView = {
      fixes: [
        { pattern: "suppress-me", action: "suppress", cooldownMin: 10 },
        { pattern: "fix-me", action: "run", command: ["rm"], cooldownMin: 10 },
      ],
      logAdmissionAllowed: true,
    };
    const suppressed = classifyShaFailure(scheduled({ diagnostic: makeTaskFailure("execution", "model_error", "executing", "suppress-me now", "none") }), "full", policy);
    expect(suppressed.classification).toBe("suppressed");
    const known = classifyShaFailure(scheduled({ diagnostic: makeTaskFailure("execution", "model_error", "executing", "fix-me now", "none") }), "full", policy);
    expect(known.classification).toBe("known_fix");
    const unknown = classifyShaFailure(scheduled(), "full", policy);
    expect(unknown.classification).toBe("unknown_actionable");
  });
});

describe("classifyShaFailure — log source (R3)", () => {
  it("suppresses recursion tags before rules", () => {
    const r = classifyShaFailure(logEvent({ tag: "self-healer" }), "full", EMPTY_POLICY);
    expect(r.classification).toBe("suppressed");
    expect(r.reason).toContain("recursion");
  });

  it("suppresses when policy is malformed (log admission disabled)", () => {
    const r = classifyShaFailure(logEvent(), "full", { fixes: [], logAdmissionAllowed: false });
    expect(r.classification).toBe("suppressed");
    expect(r.reason).toContain("malformed policy");
  });

  it("matches suppress and run rules on the normalized message", () => {
    const policy: ShaPolicyView = {
      fixes: [
        { pattern: "quiet noise", action: "suppress", cooldownMin: 5 },
        { pattern: "restart it", action: "run", command: ["systemctl", "restart"], cooldownMin: 5 },
      ],
      logAdmissionAllowed: true,
    };
    expect(classifyShaFailure(logEvent({ normalizedMessage: "quiet noise detected" }), "full", policy).classification).toBe("suppressed");
    expect(classifyShaFailure(logEvent({ normalizedMessage: "please restart it now" }), "full", policy).classification).toBe("known_fix");
  });

  it("classifies network/auth signatures as external", () => {
    const r = classifyShaFailure(logEvent({ normalizedMessage: "connection refused to host" }), "full", EMPTY_POLICY);
    expect(r.classification).toBe("external");
  });

  it("remaining valid ERROR records are unknown actionable; empty records ambiguous", () => {
    const unknown = classifyShaFailure(logEvent({ normalizedMessage: "probe failed with 7" }), "full", EMPTY_POLICY);
    expect(unknown.classification).toBe("unknown_actionable");
    const ambiguous = classifyShaFailure(logEvent({ normalizedMessage: "" }), "full", EMPTY_POLICY);
    expect(ambiguous.classification).toBe("ambiguous");
  });
});

describe("normalization and fingerprints (R3)", () => {
  it("redacts secrets, timestamps, long hex, large numbers, home paths; collapses whitespace", () => {
    const out = normalizeFailureMessage("  secret=abc123 token=deadbeef01234567 at 2026-08-21T10:00:00 pid=123456 /home/alice/x  a   b  ");
    expect(out).not.toContain("deadbeef01234567");
    expect(out).not.toContain("2026-08-21T10:00:00");
    expect(out).not.toContain("123456");
    expect(out).not.toContain("/home/alice");
    expect(out).toContain("secret=");
    expect(out).not.toContain("  ");
  });

  it("fingerprint excludes run IDs, card IDs, timestamps — same fault, different run", () => {
    const a = scheduledFingerprint(scheduled({ runId: "run-a", occurredAt: 1 }));
    const b = scheduledFingerprint(scheduled({ runId: "run-b", occurredAt: 2 }));
    expect(a).toBe(b);
    const c = scheduledFingerprint(scheduled({ runId: "run-c", cardId: 99, occurredAt: 3 }));
    expect(a).toBe(c);
  });

  it("fingerprint distinguishes task kind, category/code/phase, and scope", () => {
    const base = scheduledFingerprint(scheduled());
    const otherKind = scheduledFingerprint(scheduled({ taskKind: "script" }));
    const otherCode = scheduledFingerprint(scheduled({ diagnostic: makeTaskFailure("execution", "tool_error", "executing", "boom", "none") }));
    const otherScope = scheduledFingerprint(scheduled({ diagnostic: makeTaskFailure("execution", "model_error", "executing", "boom v2", "none") }));
    expect(otherKind).not.toBe(base);
    expect(otherCode).not.toBe(base);
    expect(otherScope).not.toBe(base);
  });

  it("log fingerprint uses component/tag and normalized message; not inode/offset", () => {
    const a = logFingerprint(logEvent({ inode: 1, lineOffset: 2 }));
    const b = logFingerprint(logEvent({ inode: 3, lineOffset: 4 }));
    expect(a).toBe(b);
    const c = logFingerprint(logEvent({ normalizedMessage: "different message" }));
    expect(c).not.toBe(a);
  });

  it("event keys are distinct per run/cursor and canonical", () => {
    expect(scheduledEventKey(scheduled())).toBe("task:daily-ai:run:run-123");
    const l = logEvent();
    expect(logEventKey(l)).toBe(`log:${canonicalHash(l.logPath)}:${l.inode}:${l.lineOffset}`);
  });

  it("canonical JSON is stable across key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    expect(canonicalHash("x")).toHaveLength(64);
  });
});