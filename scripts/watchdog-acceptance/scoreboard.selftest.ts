/**
 * Focused harness self-tests: scoreboard and runner-mode semantics (#1712
 * Task 8, R8/R8.1/R8.2; M projection validation per Task 4). Pure
 * classification — no processes spawned.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExpectationManifest, MockExpectation, ScoreboardRow } from "./contracts.ts";
import { classifyOutcome, decideExit, mockEntryAsExpectation, sourceCommitProblem, validateManifest, validateMockScenarios } from "./scoreboard.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ALL_IDS = [
  ...Array.from({ length: 24 }, (_, i) => `A${i + 1}`),
  ...Array.from({ length: 14 }, (_, i) => `B${i + 1}`),
];

function validManifest(): ExpectationManifest {
  const scenarios: ExpectationManifest["scenarios"] = {};
  for (const id of ALL_IDS) scenarios[id] = { expect: "pass" };
  scenarios["A8"] = { expect: "baseline-advisory", reason: "SIGSTOP suspend simulation; host smoke owns real suspend" };
  for (let i = 1; i <= 14; i++) scenarios[`B${i}`] = { expect: "known-fail", owner: "#1711", reason: "test" };
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

  it("permits baseline-advisory for any scenario carrying a reason (R8.2)", () => {
    const m = validManifest();
    (m.scenarios as Record<string, unknown>)["A5"] = {
      expect: "baseline-advisory",
      reason: "defect branch unreachable on Linux CI; host-smoke item X proves it",
    };
    expect(validateManifest(m, ALL_IDS)).toHaveLength(0);
  });

  it("requires a reason on baseline-advisory entries", () => {
    const m = validManifest();
    (m.scenarios as Record<string, unknown>)["A5"] = { expect: "baseline-advisory" };
    expect(validateManifest(m, ALL_IDS).some((p) => p.id === "A5")).toBe(true);
  });
});

describe("born-green rule (R8.2)", () => {
  it("rejects a defect-linked scenario whose first committed expectation was already pass", () => {
    const m = validManifest();
    m.scenarios["B13"] = { expect: "pass", owner: "#1711 R2.1", reason: "implemented" };
    const problems = validateManifest(m, ALL_IDS, new Map());
    const p = problems.find((x) => x.id === "B13");
    expect(p).toBeDefined();
    expect(p!.problem).toContain("born green");
  });

  it("still rejects a born-green pass even if the reason claims structural unreachability", () => {
    const m = validManifest();
    m.scenarios["B13"] = {
      expect: "pass",
      owner: "#1711 R2.1",
      reason: "defect branch structurally unreachable in CI",
    };
    const p = validateManifest(m, ALL_IDS, new Map()).find((x) => x.id === "B13");
    expect(p).toBeDefined();
    expect(p!.problem).toContain("baseline-advisory");
  });

  it("accepts a defect-linked pass flipped after a committed non-pass state", () => {
    const m = validManifest();
    m.scenarios["B14"] = { expect: "pass", owner: "#1719", reason: "fixed" };
    const history = new Map([["B14", "known-fail" as const]]);
    expect(validateManifest(m, ALL_IDS, history).some((p) => p.id === "B14")).toBe(false);
  });

  it("accepts a defect-linked pass carrying redBaseline evidence", () => {
    const m = validManifest();
    m.scenarios["B13"] = {
      expect: "pass",
      owner: "#1711 R2.1",
      reason: "red baseline recorded",
      redBaseline: { commit: "730525282fb324477e1e48ff832dd7a0571fa333", evidence: "baseline/b13-red-baseline.md" },
    };
    expect(validateManifest(m, ALL_IDS, new Map()).some((p) => p.id === "B13")).toBe(false);
  });

  it("rejects an incomplete redBaseline evidence pointer", () => {
    const m = validManifest();
    m.scenarios["B13"] = {
      expect: "pass",
      owner: "#1711 R2.1",
      reason: "r",
      redBaseline: { commit: "", evidence: "" },
    };
    expect(validateManifest(m, ALL_IDS, new Map()).some((p) => p.id === "B13")).toBe(true);
  });

  it("does not apply to preserved scenarios without an owner", () => {
    const m = validManifest(); // every A id is a first-time pass without owner
    expect(validateManifest(m, ALL_IDS, new Map())).toHaveLength(0);
  });
});

describe("sourceCommit requirement (R8.1)", () => {
  it("flags a null sourceCommit", () => {
    expect(sourceCommitProblem(validManifest())).toMatch(/null/);
  });

  it("accepts a recorded sourceCommit", () => {
    const m = validManifest();
    m.sourceCommit = "bf7c3c42c7f4269555c2a7556e283ce6e9574017";
    expect(sourceCommitProblem(m)).toBeNull();
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

describe("mock projection section (M/R migration, Task 4)", () => {
  function mock(id: string, over: Partial<MockExpectation> = {}): Record<string, MockExpectation> {
    const track = id[1];
    const num = String(Number(id.slice(2)));
    return {
      [id]: {
        contract: `${track}${num}`,
        pairedReal: `R${track}${num.padStart(2, "0")}`,
        projection: "shell-owned sub-invariant",
        expect: "pass",
        ...over,
      },
    };
  }

  it("accepts a manifest with well-formed M entries and leaves real validation untouched", () => {
    const m = validManifest();
    m.mockScenarios = { ...mock("MA09"), ...mock("MB14") };
    expect(validateManifest(m, ALL_IDS)).toHaveLength(0);
  });

  it("rejects suffix/track mismatch between mock id, contract, and pairedReal", () => {
    const m = validManifest();
    m.mockScenarios = mock("MA09", { contract: "B9", pairedReal: "RB09" });
    expect(validateMockScenarios(m)[0]?.problem).toMatch(/suffix mismatch/);
    m.mockScenarios = mock("MA09", { contract: "A9", pairedReal: "RB09" });
    expect(validateMockScenarios(m)[0]?.problem).toMatch(/pairedReal mismatch/);
  });

  it("rejects unregistered projections and malformed ids", () => {
    const m = validManifest();
    m.mockScenarios = mock("MA03"); // not part of the approved portfolio
    expect(validateMockScenarios(m)[0]?.problem).toMatch(/registered/);
    (m.mockScenarios as Record<string, unknown>)["MX99"] = mock("MA08")["MA08"];
    expect(validateMockScenarios(m).some((p) => p.id === "MX99" && p.problem.match(/shape/))).toBe(true);
  });

  it("rejects duplicate projections of the same real case", () => {
    const m = validManifest();
    m.mockScenarios = mock("MA09");
    (m.mockScenarios as Record<string, MockExpectation>)["MA9"] = {
      contract: "A9",
      pairedReal: "RA09",
      projection: "duplicate",
      expect: "pass",
    };
    const problems = validateMockScenarios(m);
    expect(problems.some((p) => p.problem.match(/shape/))).toBe(true); // MA9 is not two-digit
  });

  it("requires a projection description", () => {
    const m = validManifest();
    m.mockScenarios = mock("MA12", { projection: "   " });
    expect(validateMockScenarios(m)[0]?.problem).toMatch(/projection must describe/);
  });

  it("permits a real-only contract without manufacturing an M entry", () => {
    const m = validManifest(); // no mockScenarios at all
    expect(validateManifest(m, ALL_IDS)).toHaveLength(0);
  });

  it("keeps M expectations independent from their paired R expectation", () => {
    // MB02's real case is known-fail; its helper projection may pass.
    const m = validManifest();
    m.scenarios["B2"] = { expect: "known-fail", owner: "#1711 P3", reason: "wiring defect" };
    m.mockScenarios = mock("MB02", { expect: "pass" });
    const mb02 = m.mockScenarios!["MB02"]!;
    expect(classifyOutcome("MB02", "pass", mockEntryAsExpectation(mb02))).toBe("ok");
    expect(classifyOutcome("B2", "fail", m.scenarios["B2"])).toBe("ok-known-fail");
    expect(decideExit({
      rows: [
        { id: "B2", publicId: "RB02", title: "b2", outcomeStatus: "fail", verdict: "ok-known-fail", durationMs: 1, expect: m.scenarios["B2"] },
        { id: "MB02", publicId: "MB02", title: "projection of RB02", outcomeStatus: "pass", verdict: "ok", durationMs: 1, expect: { expect: "pass" } },
      ],
      requireAllGreen: false,
      baselineMode: false,
    }).code).toBe(0);
  });

  it("preserves legacy history resolution and the shipped B13 red baseline through the migration", () => {
    const shipped = JSON.parse(
      readFileSync(join(__dirname, "expected.json"), "utf-8"),
    ) as ExpectationManifest;
    // Real expectation history stays keyed by A/B; its born-green verification
    // runs against git history inside the runner (R8.2) and is untouched here.
    expect(Object.keys(shipped.scenarios).sort()).toEqual([...ALL_IDS].sort());
    expect(shipped.sourceCommit).toBe("2418d7fce5d3582c9e46e402b4283f26e9ce45de");
    const b13 = shipped.scenarios["B13"];
    expect(b13?.expect).toBe("pass");
    if (b13?.expect === "pass") {
      expect(b13.redBaseline?.commit).toBe("730525282fb324477e1e48ff832dd7a0571fa333");
      expect(b13.redBaseline?.evidence).toBe("baseline/b13-red-baseline.md");
    }
    // The shipped M section registers exactly the approved 12 projections,
    // each structurally valid and independently expected to pass.
    const mockIds = Object.keys(shipped.mockScenarios ?? {});
    expect(mockIds).toHaveLength(12);
    expect(validateMockScenarios(shipped)).toHaveLength(0);
    for (const [id, entry] of Object.entries(shipped.mockScenarios ?? {})) {
      expect(entry.pairedReal).toBe(`R${id.slice(1)}`);
      expect(entry.expect).toBe("pass");
    }
  });

  it("rejects a malformed M expectation body under the same entry rules", () => {
    const m = validManifest();
    m.mockScenarios = mock("MA21", { expect: "baseline-advisory" });
    expect(validateMockScenarios(m)[0]?.problem).toMatch(/baseline-advisory entries require a reason/);
  });
});
