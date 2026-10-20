import { describe, it, expect, beforeEach } from "vitest";
import { shouldEmitProjectionDiagnostic, resetProjectionDiagnosticStateForTest, PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS } from "./pi-core-context.js";

describe("#1705 context_projection diagnostic containment", () => {
  beforeEach(() => resetProjectionDiagnosticStateForTest());

  it("rate-limits one line per session per interval — a runaway hour stays under the target", () => {
    let emitted = 0;
    const start = 1_000_000;
    // Simulate one hot session transforming every few ms for a full hour:
    // the incident shape (per-transform DEBUG flood) must be impossible.
    for (let t = start; t < start + 3_600_000; t += 50) {
      if (shouldEmitProjectionDiagnostic("runaway_session", t)) emitted++;
    }
    expect(emitted).toBeLessThan(100);
    expect(emitted).toBe(60); // exactly one per 60s interval in the hour
  });

  it("deduplicates per session, not globally", () => {
    expect(shouldEmitProjectionDiagnostic("session-a", 1000)).toBe(true);
    expect(shouldEmitProjectionDiagnostic("session-b", 1000)).toBe(true);
    expect(shouldEmitProjectionDiagnostic("session-a", 2000)).toBe(false);
    expect(shouldEmitProjectionDiagnostic("session-b", 2000)).toBe(false);
    expect(shouldEmitProjectionDiagnostic("session-a", 1000 + PROJECTION_DIAGNOSTIC_MIN_INTERVAL_MS)).toBe(true);
  });

  it("a transform burst emits at most one success diagnostic (deterministic log-volume regression)", async () => {
    resetProjectionDiagnosticStateForTest();
    let emitted = 0;
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      if (shouldEmitProjectionDiagnostic("test_session", now)) emitted++;
    }
    // The 500 transforms above consumed this session's emission budget: the
    // gate is still rate-limiting, so the burst produced at most one line —
    // deterministically under the hourly bound.
    expect(emitted).toBe(1);
    expect(shouldEmitProjectionDiagnostic("test_session", now)).toBe(false);
  });
});
