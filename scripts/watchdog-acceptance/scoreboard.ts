/**
 * Scoreboard semantics (#1712 R8, R8.1, R8.2): manifest validation and outcome
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

/**
 * First committed expectation per scenario id, oldest first. An absent id has
 * no committed history (first appearance is the current manifest).
 */
export type ManifestHistory = ReadonlyMap<ScenarioId, ManifestExpectation["expect"]>;

export interface ManifestProblem {
  readonly id: string;
  readonly problem: string;
}

export function validateManifest(
  manifest: ExpectationManifest,
  scenarioIds: readonly string[],
  history: ManifestHistory = new Map(),
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
    const p = validateEntry(id, entry, history);
    if (p) problems.push({ id, problem: p });
  }
  for (const id of Object.keys(manifest.scenarios)) {
    if (!seen.has(id)) problems.push({ id, problem: "manifest references an unknown scenario id" });
  }
  return problems;
}

function validateEntry(id: string, entry: ManifestExpectation, history: ManifestHistory): string | null {
  switch (entry.expect) {
    case "pass": {
      // Born-green rule (R8.2): a defect-linked scenario (carries an owner)
      // that appears for the first time already marked pass has never recorded
      // a red baseline and must not count as evidence. Preserved-behavior
      // scenarios without an owner cover no fix and are exempt.
      if (!entry.owner) return null;
      const firstSeen = history.get(id);
      if (firstSeen !== undefined && firstSeen !== "pass") return null; // red state was committed first
      if (entry.redBaseline?.commit && entry.redBaseline?.evidence) return null; // measured red against pre-fix commit
      if (firstSeen === "pass") {
        return (
          "defect-linked scenario born green: its first committed expectation was already pass, " +
          "so no red baseline exists. Record a red run against the pre-fix commit and attach " +
          "redBaseline {commit, evidence}, or — only if the defect branch is structurally " +
          "unreachable in CI — convert to baseline-advisory naming the platform limit and the " +
          "host-smoke item that proves it"
        );
      }
      return (
        "defect-linked scenario born green: first appearance as pass records no red baseline. " +
        "Land it known-fail measured against the pre-fix commit and flip it in the fix commit, " +
        "attach redBaseline {commit, evidence} for a red run already measured, or — only if the " +
        "defect branch is structurally unreachable in CI — use baseline-advisory naming the " +
        "platform limit and host-smoke item"
      );
    }
    case "known-fail":
      if (!entry.owner || !entry.reason) return "known-fail entries require owner and reason";
      return null;
    case "baseline-advisory":
      // No longer restricted to A8 (R8.2): any assertion this suite
      // structurally cannot fail may be advisory, but must say why and name
      // the host-smoke item that covers it.
      if (!entry.reason) return "baseline-advisory entries require a reason naming the platform limit and the host-smoke item";
      return null;
    default:
      return `unknown expectation ${String((entry as { expect?: string }).expect)}`;
  }
}

/** R8.1: release-gating against unattributable expectations is not evidence. */
export function sourceCommitProblem(manifest: ExpectationManifest): string | null {
  if (!manifest.sourceCommit) {
    return "expected.json sourceCommit is null: record the commit the expectations were measured at (--baseline prints it). Release-gating against unattributable expectations is not evidence.";
  }
  return null;
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
        // Visible but non-gating (structurally unprovable in CI; host smoke owns proof).
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
