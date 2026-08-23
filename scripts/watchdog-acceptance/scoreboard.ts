/**
 * Scoreboard semantics (#1712 R8): manifest validation and outcome
 * classification. Pure module so runner self-tests can exercise it without
 * spawning anything.
 */
import type {
  ExpectationManifest,
  ManifestExpectation,
  ScoreboardRow,
  ScenarioOutcome,
  ScenarioId,
  Verdict,
} from "./contracts.ts";

/** The only scenario permitted to carry baseline-advisory today. */
const ADVISORY_ALLOWLIST: ReadonlySet<string> = new Set(["A8"]);

export interface ManifestProblem {
  readonly id: string;
  readonly problem: string;
}

export function validateManifest(
  manifest: ExpectationManifest,
  scenarioIds: readonly string[],
): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const seen = new Set<ScenarioId>();
  for (const id of scenarioIds) {
    if (seen.has(id)) problems.push({ id, problem: "duplicate scenario id in suite" });
    seen.add(id);
    const entry = manifest.scenarios[id];
    if (!entry) {
      problems.push({ id, problem: "missing manifest entry" });
      continue;
    }
    const p = validateEntry(id, entry);
    if (p) problems.push({ id, problem: p });
  }
  for (const id of Object.keys(manifest.scenarios)) {
    if (!seen.has(id)) problems.push({ id, problem: "manifest references an unknown scenario id" });
  }
  return problems;
}

function validateEntry(id: string, entry: ManifestExpectation): string | null {
  switch (entry.expect) {
    case "pass":
      return null;
    case "known-fail":
      if (!entry.owner || !entry.reason) return "known-fail entries require owner and reason";
      return null;
    case "baseline-advisory":
      if (!ADVISORY_ALLOWLIST.has(id)) return `baseline-advisory is not permitted for ${id}`;
      if (!entry.reason) return "baseline-advisory entries require reason";
      return null;
    default:
      return `unknown expectation ${String((entry as { expect?: string }).expect)}`;
  }
}

/**
 * Compare one measured outcome against its expectation. Throws only on
 * internal inconsistency; verdicts are data.
 */
export function classifyOutcome(
  id: string,
  outcomeStatus: ScenarioOutcome["status"],
  expect: ManifestExpectation | null,
): Verdict {
  if (outcomeStatus === "inconclusive") return "harness-failure";
  switch (expect?.expect) {
    case "pass":
      return outcomeStatus === "pass" ? "ok" : "unexpected-fail";
    case "known-fail":
      // Known failures must fail their final-form assertion; unexpectedly
      // passing means production changed or the scenario tests nothing.
      return outcomeStatus === "fail" ? "ok-known-fail" : "unexpected-pass";
    case "baseline-advisory":
      return "advisory";
    default:
      void id;
      return outcomeStatus === "pass" ? "ok" : "harness-failure";
  }
}

export interface RunExitPolicyInput {
  readonly rows: readonly ScoreboardRow[];
  readonly requireAllGreen: boolean;
  readonly baselineMode: boolean;
}

export interface ExitDecision {
  readonly code: number;
  readonly reasons: readonly string[];
}

export function decideExit(input: RunExitPolicyInput): ExitDecision {
  const reasons: string[] = [];
  for (const row of input.rows) {
    switch (row.verdict) {
      case "ok":
      case "ok-known-fail":
        break;
      case "advisory":
        // Visible but non-gating (A8's current SIGSTOP simulation).
        break;
      case "unexpected-fail":
        reasons.push(`${row.id}: expected pass, observed ${row.outcomeStatus}`);
        break;
      case "unexpected-pass":
        reasons.push(`${row.id}: known-fail unexpectedly passed`);
        break;
      case "harness-failure":
        reasons.push(`${row.id}: harness/setup/cleanup failure (${row.outcomeStatus})`);
        break;
    }
  }
  if (input.requireAllGreen) {
    for (const row of input.rows) {
      if (row.verdict !== "ok") reasons.push(`${row.id}: --require-all-green rejects ${row.verdict}`);
    }
  }
  // Baseline mode reports measurements; only genuine harness failures gate.
  const gated = input.baselineMode
    ? reasons.filter((r) => r.includes("harness"))
    : reasons;
  return { code: gated.length > 0 ? 1 : 0, reasons };
}
