#!/usr/bin/env node
/**
 * pi-production-e2e.ts — #1528 CLI orchestrator for the Pi production
 * composition acceptance harness.
 *
 *   tsx scripts/pi-production-e2e.ts [--profile core|full] [--lane local-unix|remote-wss]
 *                                    [--abmind-root <path>] [--keep-artifacts]
 *
 * Missing prerequisites (repo, build artifact, lane material) produce a
 * non-zero blocked result — never a passing skip.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiProductionE2E } from "../src/tests/e2e/pi-production/runner.js";
import type { PiAcceptanceLane, PiAcceptanceProfile } from "../src/tests/e2e/pi-production/contracts.js";

function parseArgs(argv: string[]): {
  profile: PiAcceptanceProfile;
  lane?: PiAcceptanceLane;
  abmindRoot?: string;
  keepArtifacts: boolean;
} {
  let profile: PiAcceptanceProfile = "core";
  let lane: PiAcceptanceLane | undefined;
  let abmindRoot: string | undefined;
  let keepArtifacts = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[++i] ?? "";
      if (value !== "core" && value !== "full") {
        throw new Error(`--profile must be core or full (got ${JSON.stringify(value)})`);
      }
      profile = value;
    } else if (arg === "--lane") {
      const value = argv[++i] ?? "";
      if (value !== "local-unix" && value !== "remote-wss") {
        throw new Error(`--lane must be local-unix or remote-wss (got ${JSON.stringify(value)})`);
      }
      lane = value;
    } else if (arg === "--abmind-root") {
      abmindRoot = resolve(argv[++i] ?? "");
    } else if (arg === "--keep-artifacts") {
      keepArtifacts = true;
    }
  }
  return { profile, lane, abmindRoot, keepArtifacts };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const abtarsRoot = resolve(here, "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const result = await runPiProductionE2E({
    profile: args.profile,
    lane: args.lane,
    abtarsRoot,
    abmindRoot: args.abmindRoot,
    keepArtifacts: args.keepArtifacts,
  });

  console.log(`\n═══ Pi production E2E — profile ${args.profile} (${result.matrix.runId}) ═══`);
  for (const lane of result.matrix.lanes) {
    if (lane.state === "blocked") {
      console.log(`  ⊘ ${lane.lane} — blocked: ${lane.blockedBy}`);
      continue;
    }
    const failed = lane.scenarios.filter((s) => s.state === "failed").length;
    console.log(`  ${failed === 0 ? "+" : "x"} ${lane.lane} — ${lane.scenarios.length - failed}/${lane.scenarios.length} passed (${(lane.scenarios.reduce((a, s) => a + s.durationMs, 0) / 1000).toFixed(1)}s)`);
    for (const scenario of lane.scenarios) {
      const icon = scenario.state === "passed" ? "  +" : "  x";
      const detail = scenario.failure ? `  ${scenario.failure.code}: ${scenario.failure.message.slice(0, 300)}` : "";
      console.log(`${icon} ${scenario.name} (${scenario.durationMs}ms)${detail}`);
    }
  }
  console.log(`Total: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  console.log(`PI_E2E_RESULT=${JSON.stringify({ runId: result.matrix.runId, profile: args.profile, lanes: result.matrix.lanes.map((l) => ({ lane: l.lane, state: l.state })) })}`);

  process.exitCode = result.exitCode;
}

await main().catch((err) => {
  console.error(`pi-production-e2e failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
