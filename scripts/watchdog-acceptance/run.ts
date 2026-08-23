/**
 * Watchdog E2E acceptance runner (#1712 Phase 0).
 *
 * Serial, black-box execution of the scenario suite against the real watchdog
 * shell + freshly bundled supervisor CLI + real OS processes. Modes:
 *
 *   npm run test:watchdog-acceptance                        # manifest-gated
 *   npm run test:watchdog-acceptance -- --baseline          # measure only
 *   npm run test:watchdog-acceptance -- --only A6           # one scenario
 *   npm run test:watchdog-acceptance -- --require-all-green # epic gate
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessRegistry } from "./process-registry.ts";
import { SuiteBuilder, PROFILE_NAMES } from "./build.ts";
import { ScenarioFailure, World, TIMELINE_CAP, LOG_TAIL_LINES, setDoctorBundle } from "./world.ts";
import { PRESERVED_SCENARIOS } from "./scenarios/preserved.ts";
import { DEFICIENCY_SCENARIOS } from "./scenarios/deficiencies.ts";
import type { ExpectationManifest, ScoreboardRow, ScenarioDefinition, TimelineEntry } from "./contracts.ts";
import { classifyOutcome, decideExit, validateManifest } from "./scoreboard.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const ALL_SCENARIOS: readonly ScenarioDefinition[] = [...PRESERVED_SCENARIOS, ...DEFICIENCY_SCENARIOS];

interface CliOptions {
  only: string | null;
  baseline: boolean;
  requireAllGreen: boolean;
  list: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const opts: CliOptions = { only: null, baseline: false, requireAllGreen: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--only") {
      const v = argv[i + 1];
      if (!v) throw new UsageError("--only requires a scenario id");
      opts.only = v;
      i++;
    } else if (a === "--baseline") {
      opts.baseline = true;
    } else if (a === "--require-all-green") {
      opts.requireAllGreen = true;
    } else if (a === "--list") {
      opts.list = true;
    } else {
      throw new UsageError(`unknown argument ${a}`);
    }
  }
  return opts;
}

class UsageError extends Error {}

function loadManifest(): ExpectationManifest {
  const raw = JSON.parse(readFileSync(join(__dirname, "expected.json"), "utf-8")) as ExpectationManifest;
  raw.sourceCommit = null; // filled per run from build evidence
  return raw;
}

// ── Global safety net ────────────────────────────────────────────────────────

const liveRegistries = new Set<ProcessRegistry>();
let interrupted = false;

async function globalCleanup(reason: string): Promise<void> {
  for (const r of liveRegistries) {
    try {
      await r.cleanupAll(reason);
    } catch { /* best effort during interrupt */ }
  }
}

function installGlobalHandlers(): void {
  const handler = (signal: NodeJS.Signals): void => {
    if (interrupted) return;
    interrupted = true;
    process.stderr.write(`\n[watchdog-acceptance] ${signal} received — running validated cleanup\n`);
    void globalCleanup(signal).then(() => process.exit(130));
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`\n[watchdog-acceptance] uncaught exception: ${err.stack ?? err}\n`);
    void globalCleanup("uncaught-exception").then(() => process.exit(3));
  });
  process.on("exit", () => {
    // Last-resort synchronous sweep of registered groups.
    for (const r of liveRegistries) {
      for (const p of r.all()) {
        try {
          process.kill(-p.processGroupId, "SIGKILL");
        } catch { /* already gone */ }
      }
    }
  });
}

// ── Execution ───────────────────────────────────────────────────────────────

interface ScenarioRunResult {
  row: ScoreboardRow;
  timeline: TimelineEntry[];
  logTails: Record<string, string[]>;
  failure: string | null;
}

async function runScenario(
  def: ScenarioDefinition,
  builder: SuiteBuilder,
): Promise<ScenarioRunResult> {
  const registry = new ProcessRegistry();
  liveRegistries.add(registry);
  const world = new World("abtars-wd-acc", def.id.toLowerCase(), registry, builder, def.profile);
  const startedAt = Date.now();
  let failure: string | null = null;
  let outcomeStatus: "pass" | "fail" | "inconclusive" = "fail";
  const logTails: Record<string, string[]> = {};

  try {
    await def.run(world);
    outcomeStatus = "pass";
  } catch (err) {
    if (err instanceof ScenarioFailure) {
      failure = `[${err.kind}] ${err.message}`;
      outcomeStatus = err.kind === "assertion" || err.kind === "timeout" ? "fail" : "inconclusive";
    } else {
      failure = `[harness] ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
      outcomeStatus = "inconclusive";
    }
  }

  // Cleanup is part of the contract: a leaked registered process fails the
  // run. After registry cleanup, sweep the scenario's own homes for stray
  // bridge processes the watchdog may have respawned during teardown — every
  // abtars.js process whose cwd is inside a harness-owned home belongs to us.
  let strays = 0;
  try {
    await registry.cleanupAll(`end of ${def.id}`);
    registry.assertEmpty();
    for (const home of world.knownHomes()) {
      for (const pid of world.listLiveBridgesByHome(home)) {
        const snap = world.procSnapshot(pid);
        if (snap === null || snap.state === "Z") continue;
        if (!snap.cmdline || !snap.cmdline.includes("abtars.js")) continue;
        const cwd = world.processCwd(pid);
        if (cwd !== null && cwd !== home) continue; // not ours — never signal
        process.kill(pid, "SIGKILL");
        strays++;
      }
    }
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (world.knownHomes().every((h) => world.listLiveBridgesByHome(h).length === 0)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    for (const home of world.knownHomes()) {
      if (world.listLiveBridgesByHome(home).length > 0) {
        failure = `[cleanup] stray bridge processes remain in ${home}${failure ? ` (prior: ${failure})` : ""}`;
        outcomeStatus = "inconclusive";
      }
    }
    void strays;
  } catch (err) {
    failure = `[cleanup] ${err instanceof Error ? err.message : String(err)}${failure ? ` (prior: ${failure})` : ""}`;
    outcomeStatus = "inconclusive";
  } finally {
    for (const home of world.knownHomes()) {
      logTails[home] = world.watchdogLogLines(home, LOG_TAIL_LINES);
    }
    liveRegistries.delete(registry);
    if (!(process.env.WD_ACC_KEEP === "1" && outcomeStatus !== "pass")) world.destroy();
  }

  return {
    row: {
      id: def.id,
      title: def.title,
      outcomeStatus,
      verdict: classifyOutcome(def.id, outcomeStatus, null),
      durationMs: Date.now() - startedAt,
      expect: null,
    },
    timeline: world.cappedTimeline(),
    logTails,
    failure,
  };
}

async function main(): Promise<number> {
  installGlobalHandlers();
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("usage: run.ts [--only ID] [--baseline] [--require-all-green] [--list]\n");
    return 2;
  }

  if (opts.list) {
    for (const s of ALL_SCENARIOS) process.stdout.write(`${s.id}\t${s.profile}\t${s.title}\n`);
    return 0;
  }

  const scenarios = opts.only
    ? ALL_SCENARIOS.filter((s) => s.id.toUpperCase() === opts.only!.toUpperCase())
    : ALL_SCENARIOS;
  if (scenarios.length === 0) {
    process.stderr.write(`no scenario matches --only ${opts.only}\n`);
    return 2;
  }

  const manifest = loadManifest();
  const problems = validateManifest(manifest, ALL_SCENARIOS.map((s) => s.id));
  if (problems.length > 0) {
    for (const p of problems) process.stderr.write(`manifest problem [${p.id}]: ${p.problem}\n`);
    return 2;
  }
  if (opts.requireAllGreen && !opts.only) {
    const nonGreen = Object.entries(manifest.scenarios).filter(([, e]) => e.expect !== "pass");
    if (nonGreen.length > 0) {
      process.stderr.write(
        `--require-all-green rejects non-pass manifest entries: ${nonGreen.map(([id]) => id).join(", ")}\n`,
      );
      return 2;
    }
  }

  const artifactsRoot = join(__dirname, ".artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  const builder = new SuiteBuilder(REPO_ROOT, artifactsRoot);
  builder.prepare();
  await builder.prebuild(PROFILE_NAMES);

  // The doctor bundle crosses the B5 boundary; inject it once.
  setDoctorBundle(builder.bundleDoctorCli());

  const rows: ScoreboardRow[] = [];
  const evidence: Array<ScenarioRunResult & { expect: unknown }> = [];
  for (const def of scenarios) {
    process.stdout.write(`[${def.id}] ${def.title} ... `);
    const result = await runScenario(def, builder);
    const expect = manifest.scenarios[def.id] ?? null;
    const row: ScoreboardRow = {
      ...result.row,
      verdict: classifyOutcome(def.id, result.row.outcomeStatus, expect),
      expect,
    };
    rows.push(row);
    evidence.push({ ...result, row, expect });
    process.stdout.write(`${row.verdict} (${(row.durationMs / 1000).toFixed(1)}s)\n`);
    if (!opts.baseline && row.verdict !== "ok" && row.verdict !== "ok-known-fail") {
      printEvidence(def.id, result);
    }
  }

  writeFileSync(
    join(artifactsRoot, `run-results-${Date.now()}.json`),
    JSON.stringify({ commit: builder.evidenceJson(), rows, evidence }, null, 2),
  );

  printScoreboard(rows);

  const decision = decideExit({ rows, requireAllGreen: opts.requireAllGreen, baselineMode: opts.baseline });
  if (decision.reasons.length > 0) {
    for (const r of decision.reasons) process.stdout.write(`FAIL: ${r}\n`);
  }
  return decision.code;
}

function printScoreboard(rows: readonly ScoreboardRow[]): void {
  process.stdout.write("\nscenario  status   verdict           duration\n");
  process.stdout.write("-".repeat(66) + "\n");
  for (const r of rows) {
    const line = [
      r.id.padEnd(9),
      r.outcomeStatus.padEnd(8),
      r.verdict.padEnd(17),
      `${(r.durationMs / 1000).toFixed(1)}s`,
    ].join(" ");
    process.stdout.write(line + "\n");
  }
  process.stdout.write("-".repeat(66) + "\n");
}

/** Bounded failure evidence: capped timeline plus last 50 log lines. */
function printEvidence(id: string, result: ScenarioRunResult): void {
  process.stdout.write(`\n--- evidence for ${id} ---\n`);
  if (result.failure) process.stdout.write(`failure: ${result.failure}\n`);
  const timeline = result.timeline.slice(-TIMELINE_CAP);
  if (timeline.length > 0) {
    process.stdout.write(`timeline (last ${timeline.length} entries):\n`);
    for (const t of timeline) process.stdout.write(`  +${(t.t / 1000).toFixed(2)}s ${t.event}${t.detail ? ` :: ${t.detail}` : ""}\n`);
  }
  for (const [home, lines] of Object.entries(result.logTails)) {
    process.stdout.write(`watchdog.log tail (${home}, last ${lines.length}): ${lines.join(" | ")}\n`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    void globalCleanup("fatal").then(() => process.exit(1));
  },
);
