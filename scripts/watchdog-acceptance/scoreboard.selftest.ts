/**
 * Focused harness self-tests: scoreboard and runner-mode semantics (#1712
 * Task 8). Pure classification — no processes spawned.
 */
import { describe, expect, it } from "vitest";
import type { ExpectationManifest, ScoreboardRow } from "./contracts.ts";
import { classifyOutcome, decideExit, validateManifest } from "./scoreboard.ts";

const ALL_IDS = [...Array.from({ length: 23 }, (_, i) => `A${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `B${i + 1}`)];

function validManifest(): ExpectationManifest {
  const scenarios: ExpectationManifest["scenarios"] = {};
  for (const id of ALL_IDS) scenarios[id] = { expect: "pass" };
  scenarios["A8"] = { expect: "baseline-advisory", reason: "SIGSTOP suspend simulation" };
  for (let i = 1; i <= 12; i++) scenarios[`B${i}`] = { expect: "known-fail", owner: "#1711", reason: "test" };
  return { sourceCommit: null, scenarios };
}

function row(id: string, status: ScoreboardRow["outcomeStatus"], verdict?: ScoreboardRow["verdict"]): ScoreboardRow {
  return { id, title: id, outcomeStatus: status, verdict: verdict ?? classifyOutcome(id, status, validManifest().scenarios[id] ?? null), durationMs: 1, expect: null };
}

describe("manifest validation", () => {
  it("accepts the shipped manifest shape", () => {
    expect(validateManifest(validManifest(), ALL_IDS)).toHaveLength(0);
  });

  it("rejects missing entries and unknown ids", () => {
    const m = validManifest();
    delete m.scenarios.B7;
    const problems = validateManifest(m, ALL_IDS);
    expect(problems.some((p) => p.id === "B7")).toBe(true);
    (m.scenarios as Record<string, unknown>)["Z9"] = { expect: "pass" };
    expect(validateManifest(m, ALL_IDS).some((p) => p.id === "Z9" && p.problem.includes("unknown"))).toBe(true);
  });

  it("requires owner and reason on known-fail entries", () => {
    const m = validManifest();
    (m.scenarios as Record<string, { expect: string }>)[("B3")] = { expect: "known-fail" } as never;
    expect(validateManifest(m, ALL_IDS).some((p) => p.id === "B3")).toBe(true);
  });

  it("permits baseline-advisory only for A8", () => {
    const m = validManifest();
    (m.scenarios as Record<string, unknown>)["A5"] = { expect: "baseline-advisory", reason: "nope" };
    expect(validateManifest(m, ALL_IDS).some((p) => p.id === "A5")).toBe(true);
  });
});

describe("outcome classification", () => {
  it("fails a pass-scenario that fails", () => {
    expect(classifyOutcome("A2", "fail", { expect: "pass" })).toBe("unexpected-fail");
  });

  it("fails a known-fail that unexpectedly passes", () => {
    expect(classifyOutcome("B1", "pass", { expect: "known-fail", owner: "#1711", reason: "r" })).toBe("unexpected-pass");
  });

  it("accepts an expected known-fail without gating", () => {
    expect(classifyOutcome("B1", "fail", { expect: "known-fail", owner: "#1711", reason: "r" })).toBe("ok-known-fail");
  });

  it("keeps advisory visible but non-gating in either direction", () => {
    expect(classifyOutcome("A8", "pass", { expect: "baseline-advisory", reason: "r" })).toBe("advisory");
    expect(classifyOutcome("A8", "fail", { expect: "baseline-advisory", reason: "r" })).toBe("advisory");
  });

  it("treats inconclusive as a harness failure regardless of expectation", () => {
    expect(classifyOutcome("A1", "inconclusive", { expect: "pass" })).toBe("harness-failure");
  });
});

describe("exit policy", () => {
  it("exits 0 when every verdict is within expectation", () => {
    const rows = [
      row("A1", "pass"),
      row("A8", "pass", "advisory"),
      row("B1", "fail", "ok-known-fail"),
    ];
    expect(decideExit({ rows, requireAllGreen: false, baselineMode: false }).code).toBe(0);
  });

  it("exits 1 on unexpected flips in either direction and harness failures", () => {
    expect(decideExit({ rows: [row("A2", "fail")], requireAllGreen: false, baselineMode: false }).code).toBe(1);
    expect(decideExit({ rows: [row("B2", "pass", "unexpected-pass")], requireAllGreen: false, baselineMode: false }).code).toBe(1);
    expect(decideExit({ rows: [row("A1", "inconclusive", "harness-failure")], requireAllGreen: false, baselineMode: false }).code).toBe(1);
  });

  it("--require-all-green rejects any non-ok verdict including advisories", () => {
    const decision = decideExit({
      rows: [row("A1", "pass"), row("A8", "pass", "advisory"), row("B1", "fail", "ok-known-fail")],
      requireAllGreen: true,
      baselineMode: false,
    });
    expect(decision.code).toBe(1);
    expect(decision.reasons.some((r) => r.startsWith("A8"))).toBe(true);
    expect(decision.reasons.some((r) => r.startsWith("B1"))).toBe(true);
  });

  it("baseline mode reports but only gates harness failures", () => {
    const decision = decideExit({
      rows: [row("A2", "fail"), row("B1", "pass", "unexpected-pass")],
      requireAllGreen: false,
      baselineMode: true,
    });
    expect(decision.code).toBe(0);
  });
});
