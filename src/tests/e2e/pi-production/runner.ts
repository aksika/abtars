/**
 * runner.ts — #1528 production-composition runner.
 *
 * Orchestrates one profile against one lane: builds artifacts once, starts
 * the deterministic provider + fixture controller + built bridge, waits for
 * real readiness, executes scenarios serially, then cleans up in reverse
 * ownership order and writes matrix + JUnit results.
 */

import { mkdirSync, rmSync, existsSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { TIMEOUTS, type PiAcceptanceLane, type PiAcceptanceMatrixV1, type PiAcceptanceProfile, type PiLaneResult, type PiScenarioResult } from "./contracts.js";import { ScriptedProvider } from "./scripted-provider.js";
import { TuiAcceptanceClient } from "./tui-client.js";
import { OwnerControllerClient, FixtureLaneBlockedError } from "./controller-client.js";
import { SpawnedChild, waitFor } from "./child-process.js";
import { buildBridgeConfig, resolvePiExecutable, resolveAbmindPackageDir, FIXTURE_MODEL_A } from "./bridge-config.js";
import { scenariosForProfile, MarkerFactory, type PiAcceptanceContext } from "./scenarios.js";
import { ResultWriter } from "./result-writer.js";

export interface PiE2EOptions {
  profile: PiAcceptanceProfile;
  lane?: PiAcceptanceLane;
  abtarsRoot: string;
  abmindRoot?: string;
  /** Keep the disposable run root after completion (diagnostics). */
  keepArtifacts?: boolean;
}

export interface PiE2ERunResult {
  matrix: PiAcceptanceMatrixV1;
  exitCode: number;
}

function repoRoot(abtarsRoot: string): string {
  return abtarsRoot;
}

function runBuild(abtarsRoot: string, abmindRoot: string | undefined): void {
  const abmind = abmindRoot ?? resolve(abtarsRoot, "../abmind");
  if (!existsSync(join(abmind, "dist/tests/acceptance/consumer-fixture-controller.js"))) {
    execFileSync("npm", ["run", "build"], { cwd: abmind, stdio: "inherit" });
  }
  if (!existsSync(join(abtarsRoot, "dist/main.js"))) {
    execFileSync("npm", ["run", "build"], { cwd: abtarsRoot, stdio: "inherit" });
  }
}

function blockedResult(lane: PiAcceptanceLane, profile: PiAcceptanceProfile, reason: string): PiLaneResult {
  return { lane, profile, state: "blocked", blockedBy: reason, scenarios: [] };
}

export async function runPiProductionE2E(opts: PiE2EOptions): Promise<PiE2ERunResult> {
  const startedAt = new Date().toISOString();
  const overallStart = Date.now();
  const runId = `pi-e2e-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const writer = new ResultWriter({ repoRoot: repoRoot(opts.abtarsRoot), runId });

  const lanes: PiLaneResult[] = [];
  const desiredLanes: PiAcceptanceLane[] = opts.lane ? [opts.lane] : ["local-unix", "remote-wss"];

  runBuild(opts.abtarsRoot, opts.abmindRoot);
  const abmindRoot = opts.abmindRoot ?? resolve(opts.abtarsRoot, "../abmind");

  // The Pi runtime is a required production dependency of the Pi journey: a
  // standalone pi executable must be resolvable (>= 0.83.0 per
  // PI_COMPATIBILITY). Missing it blocks the lane — never a passing skip.
  if (!resolvePiExecutable()) {
    const reason = "standalone `pi` executable not found on PATH (install pi >= 0.83.0 or add it to PATH outside node_modules/.bin)";
    for (const lane of desiredLanes) {
      lanes.push(blockedResult(lane, opts.profile, reason));
    }
    const matrix: PiAcceptanceMatrixV1 = {
      schemaVersion: 1,
      kind: "pi-production-e2e",
      runId,
      startedAt,
      durationMs: Date.now() - overallStart,
      lanes,
    };
    writer.writeMatrix(matrix);
    writer.writeJunit(matrix);
    return { matrix, exitCode: 1 };
  }

  // The local Unix lane requires the abmind package for the bridge's local
  // memory client; an unresolvable install blocks that lane, never skips.
  if (desiredLanes.includes("local-unix") && !resolveAbmindPackageDir(opts.abmindRoot ?? resolve(opts.abtarsRoot, "../abmind"))) {
    const reason = "abmind package not resolvable (checked ABMIND_PATH, npm root -g, ~/.abmind/src/abmind, ~/.local/lib/node_modules)";
    for (const lane of desiredLanes) {
      lanes.push(blockedResult(lane, opts.profile, reason));
    }
    const matrix: PiAcceptanceMatrixV1 = {
      schemaVersion: 1,
      kind: "pi-production-e2e",
      runId,
      startedAt,
      durationMs: Date.now() - overallStart,
      lanes,
    };
    writer.writeMatrix(matrix);
    writer.writeJunit(matrix);
    return { matrix, exitCode: 1 };
  }

  for (const lane of desiredLanes) {
    const laneResult = await runLane(lane, opts.profile, opts, abmindRoot, writer, runId);
    lanes.push(laneResult);
  }

  const matrix: PiAcceptanceMatrixV1 = {
    schemaVersion: 1,
    kind: "pi-production-e2e",
    runId,
    startedAt,
    durationMs: Date.now() - overallStart,
    lanes,
  };
  writer.writeMatrix(matrix);
  writer.writeJunit(matrix);

  const exitCode = matrix.lanes.some((l) => l.state !== "passed") ? 1 : 0;
  return { matrix, exitCode };
}

async function runLane(
  lane: PiAcceptanceLane,
  profile: PiAcceptanceProfile,
  opts: PiE2EOptions,
  abmindRoot: string,
  writer: ResultWriter,
  runId: string,
): Promise<PiLaneResult> {
  const runRoot = mkdtempSync(join(tmpdir(), `pi-prod-${lane}-`));
  chmodSync(runRoot, 0o700);
  const logDir = join(runRoot, "logs");
  mkdirSync(logDir, { recursive: true });

  let provider: ScriptedProvider | null = null;
  let owner: OwnerControllerClient | null = null;
  let bridge: SpawnedChild | null = null;
  let tui: TuiAcceptanceClient | null = null;
  let degradedCleanup = false;
  let bridgeEnv: NodeJS.ProcessEnv = {};
  const scenarioResults: PiScenarioResult[] = [];

  const laneDeadline = setTimeout(() => {
    degradedCleanup = true;
  }, TIMEOUTS.runMs);

  try {
    // 1. Deterministic provider first (its port feeds the bridge config).
    provider = new ScriptedProvider();
    await provider.start();

    // 2. Fixture controller (real owner daemon).
    try {
      owner = await OwnerControllerClient.spawn(abmindRoot, lane, runId, logDir);
    } catch (err) {
      if (err instanceof FixtureLaneBlockedError) {
        return blockedResult(lane, profile, err.message);
      }
      throw err;
    }

    // 3. Bridge config from the generic descriptor, validated by the
    //    production endpoint resolver.
    const config = buildBridgeConfig(runRoot, owner.descriptor, provider.baseUrl, lane, abmindRoot);
    bridgeEnv = config.bridgeEnv;

    // 4. Spawn the built bridge entry point.
    bridge = await spawnBridge(opts.abtarsRoot, logDir, bridgeEnv, lane, provider!);

    // 5. TUI readiness + one smoke exchange through the real Pi/SSE path.
    tui = new TuiAcceptanceClient(config.abtarsHome);
    await tui.connect("new");
    const smokeMarker = `PI-SMOKE-${runId}`;
    const smokeReply = `PI-SMOKE-OK-${runId}`;
    provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: undefined, action: { kind: "text", chunks: [smokeReply] } });
    const smokeReplyFrame = await tui.sendAndAwaitReply(smokeMarker, TIMEOUTS.turnMs);
    if (!smokeReplyFrame.markdown.includes(smokeReply)) {
      throw new Error(`smoke exchange failed: reply did not contain ${smokeReply} (got: ${smokeReplyFrame.markdown.slice(0, 200)})`);
    }

    // 6. Scenarios serially against the isolated state.
    const laneProvider = provider!;
    const restartBridge = async (): Promise<SpawnedChild> => {
      if (bridge && !bridge.exited) await bridge.terminate();
      bridge = await spawnBridge(opts.abtarsRoot, logDir, bridgeEnv, lane, laneProvider);
      return bridge;
    };

    const ctx: PiAcceptanceContext = {
      lane,
      provider,
      owner,
      tui,
      bridge,
      runId,
      markers: new MarkerFactory(runId),
      scenarioStart: Date.now(),
      restartBridge,
      abtarsHome: config.abtarsHome,
      writeArtifact: (name: string, data: string): void => {
        // #1548: artifact persistence is evidence — a failed write must fail
        // the scenario, never silently pass.
        const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        writeFileSync(join(writer.relativeDirectory, `${lane}-${safe}`), data, "utf-8");
      },
    };

    for (const scenario of scenariosForProfile(profile)) {
      const scenarioStart = Date.now();
      try {
        await scenario.run(ctx);
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: "passed",
          durationMs: Date.now() - scenarioStart,
          providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: "failed",
          durationMs: Date.now() - scenarioStart,
          providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
          failure: { stage: scenario.name, code: "scenario_failed", message: message.slice(0, 2000) },
        });
        // A scenario failure keeps the lane alive for later scenarios; the
        // failed lane is reported in the matrix.
      }
    }

    const state = scenarioResults.some((s) => s.state === "failed") ? "failed" : "passed";
    return { lane, profile, state, scenarios: scenarioResults };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      lane,
      profile,
      state: "failed",
      scenarios: [{
        name: "lane-setup",
        lane,
        profile,
        state: "failed",
        durationMs: 0,
        providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
        failure: { stage: "lane-setup", code: "setup_failed", message: message.slice(0, 2000) },
      }],
    };
  } finally {
    clearTimeout(laneDeadline);
    let cleanupError: Error | null = null;
    try {
      await cleanupLane({ provider, owner, bridge, tui }, writer);
    } catch (cleanupErr) {
      cleanupError = cleanupErr as Error;
      degradedCleanup = true;
      for (const result of scenarioResults) {
        if (result.state === "passed") {
          result.state = "failed";
          result.failure = { stage: "cleanup", code: "cleanup_failed", message: `cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}` };
        }
      }
    }
    // Writer failures must not be hidden by earlier results.
    try {
      if (degradedCleanup || cleanupError || scenarioResults.some((s) => s.state === "failed")) {
        writer.copyFailureArtifacts(lane, "lane-failure", [logDir]);
      }
    } catch (err) {
      throw new Error(`result/artifact write failed: ${(err as Error).message}`);
    }
    if (!opts.keepArtifacts && !degradedCleanup) {
      try { rmSync(runRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

interface LaneHandles {
  provider: ScriptedProvider | null;
  owner: OwnerControllerClient | null;
  bridge: SpawnedChild | null;
  tui: TuiAcceptanceClient | null;
}

/** Cleanup in reverse ownership order; exact PIDs only, bounded grace. */
async function cleanupLane(
  handles: LaneHandles,
  writer: ResultWriter,
): Promise<void> {
  const failures: string[] = [];

  if (handles.tui) {
    try { handles.tui.close(); } catch { /* best effort */ }
  }

  if (handles.bridge && !handles.bridge.exited) {
    try {
      await handles.bridge.terminate();
      if (handles.bridge.degradedCleanup) failures.push("bridge needed SIGKILL");
    } catch (err) {
      failures.push(`bridge cleanup failed: ${(err as Error).message}`);
    }
  }

  if (handles.owner) {
    try {
      await handles.owner.shutdown();
      if (handles.owner.isAlive) {
        await handles.owner.forceCleanup();
        failures.push("controller needed forced termination");
      }
    } catch (err) {
      failures.push(`controller cleanup failed: ${(err as Error).message}`);
    }
  }

  if (handles.provider) {
    try {
      await handles.provider.close();
      writer.writeProviderSummaries(handles.provider.summaries);
    } catch { /* best effort */ }
  }

  if (failures.length > 0) {
    throw new Error(failures.join("; "));
  }
}

async function spawnBridge(
  abtarsRoot: string,
  logDir: string,
  env: NodeJS.ProcessEnv,
  lane: PiAcceptanceLane,
  provider: ScriptedProvider,
): Promise<SpawnedChild> {
  const preBootRequests = provider.summaries.length;
  const bridge = new SpawnedChild({
    execPath: process.execPath,
    args: [resolve(abtarsRoot, "dist/main.js")],
    cwd: abtarsRoot,
    env,
    logDir,
    name: `bridge-${lane}`,
  });
  // The TUI socket becomes usable once platforms boot; a real exchange is the
  // readiness evidence (the runner's smoke does it), so here we only wait for
  // the process to stay alive long enough to bind the socket.
  await waitFor(
    async () => {
      if (bridge.exited) {
        throw new Error(`bridge exited during boot (code=${bridge.exitCodeValue}, signal=${bridge.signalValue})\n${bridge.stderrTail}`);
      }
      return existsSync(join(env["ABTARS_HOME"] ?? "", "tui.sock")) ? true : undefined;
    },
    TIMEOUTS.bridgeReadinessMs,
    "bridge TUI socket",
    () => `${bridge.stdoutTail}\n${bridge.stderrTail}`,
  );
  // The fresh bridge fires its autonomous boot greeting turn ([SESSION START])
  // against the provider. Wait until that request has been observed so the
  // greeting can never consume a scenario script enqueued right after boot.
  await waitFor(
    async () => (provider.summaries.length > preBootRequests ? true : undefined),
    TIMEOUTS.bridgeReadinessMs,
    "bridge boot greeting provider request",
    () => `${bridge.stdoutTail}\n${bridge.stderrTail}`,
  );
  return bridge;
}
