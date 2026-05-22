import { describe, it, expect, beforeEach } from "vitest";
import { addCompletion, drainCompletions, hasCompletions } from "./completion-buffer.js";

describe("CompletionBuffer", () => {
  beforeEach(() => {
    // Drain any leftover state
    drainCompletions("test-mother");
  });

  it("addCompletion + drainCompletions round-trip", () => {
    addCompletion({
      sessionId: "s1", motherId: "test-mother", goal: "do X",
      status: "done", result: "done!", elapsedMs: 1000, inputTokens: 100, outputTokens: 50,
    });
    const entries = drainCompletions("test-mother");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.goal).toBe("do X");
    expect(entries[0]!.status).toBe("done");
  });

  it("drainCompletions clears the buffer", () => {
    addCompletion({
      sessionId: "s1", motherId: "test-mother", goal: "do X",
      status: "done", result: "ok", elapsedMs: 500, inputTokens: 10, outputTokens: 5,
    });
    drainCompletions("test-mother");
    expect(hasCompletions("test-mother")).toBe(false);
    expect(drainCompletions("test-mother")).toHaveLength(0);
  });

  it("hasCompletions returns true when entries exist", () => {
    expect(hasCompletions("test-mother")).toBe(false);
    addCompletion({
      sessionId: "s2", motherId: "test-mother", goal: "task",
      status: "failed", result: "err", elapsedMs: 200, inputTokens: 0, outputTokens: 0,
    });
    expect(hasCompletions("test-mother")).toBe(true);
  });

  it("multiple completions accumulate", () => {
    addCompletion({ sessionId: "a", motherId: "test-mother", goal: "1", status: "done", result: "r1", elapsedMs: 1, inputTokens: 0, outputTokens: 0 });
    addCompletion({ sessionId: "b", motherId: "test-mother", goal: "2", status: "failed", result: "r2", elapsedMs: 2, inputTokens: 0, outputTokens: 0 });
    const entries = drainCompletions("test-mother");
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sessionId).toBe("a");
    expect(entries[1]!.sessionId).toBe("b");
  });

  it("different mothers are isolated", () => {
    addCompletion({ sessionId: "x", motherId: "m1", goal: "g1", status: "done", result: "", elapsedMs: 0, inputTokens: 0, outputTokens: 0 });
    addCompletion({ sessionId: "y", motherId: "m2", goal: "g2", status: "done", result: "", elapsedMs: 0, inputTokens: 0, outputTokens: 0 });
    expect(drainCompletions("m1")).toHaveLength(1);
    expect(drainCompletions("m2")).toHaveLength(1);
  });
});
