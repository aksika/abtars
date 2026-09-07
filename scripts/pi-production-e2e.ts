#!/usr/bin/env node
/**
 * pi-production-e2e.ts — #1528 CLI orchestrator for the Pi production
 * composition acceptance harness.
 *
 *   tsx scripts/pi-production-e2e.ts [--profile core|full|proof|hydration] [--lane local-unix|remote-wss]
 *                                    [--abmind-root <path>] [--pi installed|latest|pinned|exact]
 *                                    [--pi-version <exact-semver>] [--keep-artifacts]
 *
 * Missing prerequisites (repo, build artifact, lane material) produce a
 * non-zero blocked result — never a passing skip.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runPiProductionE2E } from "../src/tests/e2e/pi-production/runner.js";
import { resolvePiExecutable } from "../src/tests/e2e/pi-production/bridge-config.js";
import { PI_COMPATIBILITY } from "../src/config/pi-compatibility.js";
import {
  parsePiSelection,
  resolvePiPackageSpec,
  type PiSelection as PiSelectionSpec,
} from "../src/tests/e2e/pi-production/pi-selection.js";
import type { PiAcceptanceLane, PiAcceptanceProfile, PiRuntimeEvidence } from "../src/tests/e2e/pi-production/contracts.js";

interface PiRuntimeScope {
  evidence: PiRuntimeEvidence;
  cleanup(): void;
}

function parseArgs(argv: string[]): {
  profile: PiAcceptanceProfile;
  lane?: PiAcceptanceLane;
  abmindRoot?: string;
  pi: PiSelectionSpec;
  keepArtifacts: boolean;
} {
  let profile: PiAcceptanceProfile = "core";
  let lane: PiAcceptanceLane | undefined;
  let abmindRoot: string | undefined;
  let piRaw = "installed";
  let piVersion: string | undefined;
  let keepArtifacts = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") {
      const value = argv[++i] ?? "";
      if (value !== "core" && value !== "full" && value !== "proof" && value !== "hydration") {
        throw new Error(`--profile must be core, full, proof, or hydration (got ${JSON.stringify(value)})`);
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
    } else if (arg === "--pi") {
      piRaw = argv[++i] ?? "";
    } else if (arg === "--pi-version") {
      piVersion = argv[++i];
    } else if (arg === "--keep-artifacts") {
      keepArtifacts = true;
    }
  }
  // The pure selector validates the pair and rejects missing/malformed/range
  // exact versions before any candidate is installed (#1780).
  const pi = parsePiSelection({ pi: piRaw, piVersion });
  return { profile, lane, abmindRoot, pi, keepArtifacts };
}

const here = fileURLToPath(new URL(".", import.meta.url));
const abtarsRoot = resolve(here, "..");

function readPiVersion(executable: string): string {
  const output = execFileSync(executable, ["--version"], { encoding: "utf-8", timeout: 10_000 }).trim();
  const version = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0];
  if (!version) throw new Error(`Pi executable ${executable} returned an invalid version: ${JSON.stringify(output)}`);
  return version;
}

function preparePiRuntime(selection: PiSelectionSpec, keepArtifacts: boolean): PiRuntimeScope {
  if (selection.kind === "installed") {
    const executable = resolvePiExecutable();
    return {
      evidence: {
        source: "host",
        ...(executable ? { executable, version: readPiVersion(executable) } : {}),
      },
      cleanup: () => {},
    };
  }

  const prefix = mkdtempSync(join(tmpdir(), "abtars-pi-canary-"));
  const configHome = mkdtempSync(join(tmpdir(), "abtars-pi-canary-home-"));
  const workspace = join(configHome, "workspace");
  const configDir = join(configHome, "config");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  try {
    const packageSpec = resolvePiPackageSpec(selection, {
      packageName: PI_COMPATIBILITY.packageName,
      pinnedRange: PI_COMPATIBILITY.pinnedRange,
    });
    if (!packageSpec) throw new Error(`no package spec for Pi selection ${selection.kind}`);
    execFileSync("npm", [
      "install", "--global", "--prefix", prefix,
      "--no-fund", "--no-audit", "--package-lock=false",
      packageSpec,
    ], { stdio: "inherit" });

    const binDir = join(prefix, "bin");
    const executable = join(binDir, "pi");
    if (!existsSync(executable)) {
      throw new Error(`${selection.kind} Pi install completed without ${executable}`);
    }
    const version = readPiVersion(executable);

    // The production resolver honors pi-executor.json before PATH. Point it
    // at the disposable install so the canary cannot accidentally exercise a
    // developer's configured/global Pi instead.
    writeFileSync(join(configDir, "pi-executor.json"), JSON.stringify({
      enabled: true,
      command: executable,
      workspaceAliases: { default: { path: workspace } },
    }, null, 2));

    const previousPath = process.env.PATH;
    const previousHome = process.env.ABTARS_HOME;
    process.env.PATH = [binDir, previousPath].filter((value): value is string => Boolean(value)).join(delimiter);
    process.env.ABTARS_HOME = configHome;

    return {
      evidence: {
        source: selection.kind,
        ...(selection.kind === "exact" ? { requestedVersion: selection.requestedVersion } : {}),
        executable,
        version,
      },
      cleanup: () => {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousHome === undefined) delete process.env.ABTARS_HOME;
        else process.env.ABTARS_HOME = previousHome;
        if (!keepArtifacts) {
          rmSync(prefix, { recursive: true, force: true });
          rmSync(configHome, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    rmSync(prefix, { recursive: true, force: true });
    rmSync(configHome, { recursive: true, force: true });
    throw err;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const piRuntime = preparePiRuntime(args.pi, args.keepArtifacts);
  const startedAt = Date.now();
  try {
    const result = await runPiProductionE2E({
      profile: args.profile,
      lane: args.lane,
      abtarsRoot,
      abmindRoot: args.abmindRoot,
      keepArtifacts: args.keepArtifacts,
      piRuntime: piRuntime.evidence,
      ...(args.pi.kind === "exact" ? { expectedPiVersion: args.pi.requestedVersion } : {}),
    });

    console.log(`\n═══ Pi production E2E — ${args.pi.kind} Pi ${piRuntime.evidence.version ?? "unknown"}, profile ${args.profile} (${result.matrix.runId}) ═══`);
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
    console.log(`PI_E2E_RESULT=${JSON.stringify({ runId: result.matrix.runId, profile: args.profile, piRuntime: result.matrix.piRuntime, lanes: result.matrix.lanes.map((l) => ({ lane: l.lane, state: l.state })) })}`);

    process.exitCode = result.exitCode;
  } finally {
    piRuntime.cleanup();
  }
}

await main().catch((err) => {
  console.error(`pi-production-e2e failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
