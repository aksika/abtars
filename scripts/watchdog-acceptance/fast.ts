/**
 * FAST lane orchestrator (#1712 Task 5 / requirements R10): the 12 registered
 * M shell projections, then the 16 fast R cases. One command for every
 * watchdog edit.
 *
 * The M phase runs scripts/abtars-watchdog.test.sh as a child only long
 * enough to execute its shell assertions — no World, no esbuild artifacts,
 * no fixtures. Each case emits one machine-readable row which is classified
 * against the manifest's mock projection section. The R phase reuses run.ts
 * (--suite fast) with its full process-safety and scoreboard machinery.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MOCK_PROJECTION_IDS } from "./contracts.ts";
import type { ExpectationManifest, ScoreboardRow } from "./contracts.ts";
import { classifyOutcome, decideExit, mockEntryAsExpectation, validateMockPortfolio } from "./scoreboard.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

function loadManifest(): ExpectationManifest {
  return JSON.parse(readFileSync(join(__dirname, "expected.json"), "utf-8")) as ExpectationManifest;
}

interface MockRunRow {
  id: string;
  outcomeStatus: "pass" | "fail";
  detail: string;
}

function runMockSuite(): { rows: MockRunRow[]; durationMs: number } {
  const startedAt = Date.now();
  // The approved selector set is passed explicitly so a drifted default in
  // the shell file cannot silently widen the portfolio.
  const proc = spawnSync("bash", [join(REPO_ROOT, "scripts/abtars-watchdog.test.sh"), ...MOCK_PROJECTION_IDS], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const durationMs = Date.now() - startedAt;
  const rows: MockRunRow[] = [];
  const seen = new Set<string>();
  let summaryLeakOk = false;
  for (const line of (proc.stdout ?? "").split("\n")) {
    if (line.startsWith("M-SUITE ")) {
      summaryLeakOk = /leak_scan=ok/.test(line);
      continue;
    }
    const m = /^(M[AB]\d{2})\t(pass|fail)\t(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1]!;
    seen.add(id);
    rows.push({ id, outcomeStatus: m[2] as MockRunRow["outcomeStatus"], detail: m[3] ?? "" });
  }
  if (proc.status !== 0 || !summaryLeakOk) {
    process.stderr.write(
      `[fast] M suite failed (exit ${proc.status}, leak_scan=${summaryLeakOk ? "ok" : "FAILED"}). ` +
        `Rows observed: ${rows.map((r) => `${r.id}=${r.outcomeStatus}`).join(" ") || "none"}\n`,
    );
    process.exit(1);
  }
  const missing = MOCK_PROJECTION_IDS.filter((id) => !seen.has(id));
  const unknown = [...seen].filter((id) => !MOCK_PROJECTION_IDS.includes(id));
  const duplicate = rows
    .map((row) => row.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (missing.length > 0 || unknown.length > 0 || duplicate.length > 0 || rows.length !== MOCK_PROJECTION_IDS.length) {
    process.stderr.write(
      `[fast] M suite portfolio mismatch — missing: ${missing.join(",") || "none"}; ` +
        `unexpected: ${unknown.join(",") || "none"}; duplicates: ${[...new Set(duplicate)].join(",") || "none"}\n`,
    );
    process.exit(2);
  }
  return { rows, durationMs };
}

function printMockScoreboard(rows: readonly ScoreboardRow[], details: ReadonlyMap<string, string>): void {
  process.stdout.write("\nprojection  pair     status   verdict           detail\n");
  process.stdout.write("-".repeat(78) + "\n");
  for (const r of rows) {
    const line = [
      r.id.padEnd(11),
      (r.publicId ?? "").padEnd(8),
      r.outcomeStatus.padEnd(8),
      r.verdict.padEnd(17),
      (details.get(r.id) ?? "").slice(0, 28),
    ].join(" ");
    process.stdout.write(line + "\n");
  }
  process.stdout.write("-".repeat(78) + "\n");
  process.stdout.write("(M rows are shell projections; their paired RA/RB contract keeps the authoritative word)\n");
}

async function main(): Promise<number> {
  if (process.argv.length > 2) {
    process.stderr.write("usage: fast.ts\n");
    return 2;
  }
  const manifest = loadManifest();
  const manifestProblems = validateMockPortfolio(manifest);
  if (manifestProblems.length > 0) {
    for (const p of manifestProblems) process.stderr.write(`manifest problem [${p.id}]: ${p.problem}\n`);
    return 2;
  }

  // ── Phase 1: M shell projections ────────────────────────────────────────
  const mockPhase = runMockSuite();
  const rows: ScoreboardRow[] = [];
  const details = new Map<string, string>();
  for (const mock of mockPhase.rows) {
    const entry = manifest.mockScenarios?.[mock.id];
    const expect = entry ? mockEntryAsExpectation(entry) : null;
    const outcomeStatus = mock.outcomeStatus;
    const row: ScoreboardRow = {
      id: mock.id,
      publicId: entry?.pairedReal ?? `R${mock.id.slice(1)}`,
      title: entry?.projection ?? "UNREVIEWED PROJECTION — missing manifest entry",
      outcomeStatus,
      verdict: classifyOutcome(mock.id, outcomeStatus, expect),
      durationMs: 0,
      expect,
    };
    rows.push(row);
    if (outcomeStatus !== "pass") details.set(mock.id, `[${mock.detail}] ${entry?.pairedReal ?? "?"} owns the contract`);
  }
  printMockScoreboard(rows, details);
  process.stdout.write(
    `[fast] M phase: ${rows.length} projections in ${(mockPhase.durationMs / 1000).toFixed(2)}s\n`,
  );
  const mockDecision = decideExit({ rows, requireAllGreen: false, baselineMode: false });
  if (mockDecision.reasons.length > 0) {
    for (const r of mockDecision.reasons) process.stdout.write(`FAIL: ${r}\n`);
    // A regressed projection is directly actionable at the seam; stop here
    // instead of paying for the real boundary.
    return 1;
  }

  // ── Phase 2: fast R cases at the real boundary ──────────────────────────
  const rStartedAt = Date.now();
  const rProc = spawnSync("tsx", [join(__dirname, "run.ts"), "--suite", "fast"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  const rDurationMs = Date.now() - rStartedAt;
  process.stdout.write(
    `[fast] totals: M ${(mockPhase.durationMs / 1000).toFixed(2)}s + R fast ${(rDurationMs / 1000).toFixed(1)}s\n`,
  );
  return rProc.status ?? 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  },
);
