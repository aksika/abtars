import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { logSwarmTrace, type SwarmTraceEvent } from "./swarm-trace.js";

const traceLines: string[] = [];

vi.mock("./logger.js", () => ({
  logTrace: (tag: string, msg: string) => {
    if (tag === "swarm-trace") traceLines.push(msg);
  },
}));

beforeEach(() => { traceLines.length = 0; });

function parseLast(): Record<string, unknown> {
  expect(traceLines.length).toBe(1);
  return JSON.parse(traceLines[0]!);
}

describe("swarm-trace", () => {
  it("emits event with all fields", () => {
    logSwarmTrace({
      event: "attempt_transition",
      project: 1,
      card: 42,
      attempt: "a_7",
      generation: 2,
      executor: "agent",
      from: "claimed",
      to: "starting",
      reviewCase: "rc_1",
      decision: "dec_1",
      reason: "normal_progress",
    });
    const out = parseLast();
    expect(out.event).toBe("attempt_transition");
    expect(out.project).toBe(1);
    expect(out.card).toBe(42);
    expect(out.attempt).toBe("a_7");
    expect(out.generation).toBe(2);
    expect(out.executor).toBe("agent");
    expect(out.from).toBe("claimed");
    expect(out.to).toBe("starting");
    expect(out.reviewCase).toBe("rc_1");
    expect(out.decision).toBe("dec_1");
    expect(out.reason).toBe("normal_progress");
  });

  it("omits null/undefined fields", () => {
    logSwarmTrace({ event: "wake" });
    const out = parseLast();
    expect(out.event).toBe("wake");
    expect(out.project).toBeUndefined();
    expect(out.card).toBeUndefined();
    expect(out.attempt).toBeUndefined();
  });

  it("omits non-positive numeric IDs", () => {
    logSwarmTrace({ event: "test", project: 0, card: -1, generation: -5 });
    const out = parseLast();
    expect(out.project).toBeUndefined();
    expect(out.card).toBeUndefined();
    expect(out.generation).toBeUndefined();
  });

  it("caps long string fields", () => {
    const long = "x".repeat(500);
    logSwarmTrace({ event: long, attempt: long, reason: long });
    const out = parseLast();
    expect(out.event!.toString().length).toBeLessThanOrEqual(203);
    expect(out.attempt!.toString().length).toBeLessThanOrEqual(203);
    expect(out.reason!.toString().length).toBeLessThanOrEqual(203);
  });

  it("normalizes line breaks", () => {
    logSwarmTrace({ event: "hello\nworld\r\nagain" });
    const out = parseLast();
    expect(out.event).toBe("hello world again");
  });

  it("caps total serialized length with many saturated fields", () => {
    const long = "x".repeat(195);
    logSwarmTrace({
      event: long,
      project: 999999,
      card: 999999,
      attempt: long,
      generation: 999999,
      executor: long,
      from: long,
      to: long,
      reviewCase: long,
      decision: long,
      reason: long,
    });
    const out = parseLast();
    const serialized = JSON.stringify(out);
    expect(serialized.length).toBeLessThanOrEqual(4100);
  });

  it("does not include unlisted payload keys", () => {
    logSwarmTrace({
      event: "test",
      project: 1,
    } as SwarmTraceEvent & { prompt?: string; evidence?: string; tokenCount?: number });
    const out = parseLast();
    expect(out.event).toBe("test");
    expect(out.project).toBe(1);
    expect(out.prompt).toBeUndefined();
    expect(out.evidence).toBeUndefined();
    expect(out.tokenCount).toBeUndefined();
  });

  it("rejects non-numeric project/card/generation", () => {
    logSwarmTrace({ event: "test", project: NaN } as any);
    const out = parseLast();
    expect(out.project).toBeUndefined();
  });

  it("accepts generation 0", () => {
    logSwarmTrace({ event: "test", generation: 0 });
    const out = parseLast();
    expect(out.generation).toBe(0);
  });
});
