/**
 * runner.ts — #1528 production-composition runner.
 *
 * Orchestrates one profile against one lane: builds artifacts once, starts
 * the deterministic provider + fixture controller + built bridge, waits for
 * real readiness, executes scenarios serially, then cleans up in reverse
 * ownership order and writes matrix + JUnit results.
 */

import { mkdirSync, rmSync, existsSync, chmodSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  TIMEOUTS,
  type PiAcceptanceLane,
  type PiAcceptanceMatrixV1,
  type PiAcceptanceProfile,
  type PiLaneResult,
  type PiRuntimeEvidence,
  type PiRuntimeReport,
  type PiScenarioResult,
} from "./contracts.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { TuiAcceptanceClient } from "./tui-client.js";
import { OwnerControllerClient, FixtureLaneBlockedError } from "./controller-client.js";
import { SpawnedChild, waitFor } from "./child-process.js";
import { buildBridgeConfig, resolvePiExecutable, resolveAbmindPackageDir, FIXTURE_MODEL_A } from "./bridge-config.js";
import { scenariosForProfile, MarkerFactory, type PiAcceptanceContext } from "./scenarios.js";
import { ResultWriter } from "./result-writer.js";
import { inspectPiRuntime } from "./runtime-report.js";
import { runInteractiveTuiSmoke } from "./interactive-tui.js";

export interface PiE2EOptions {
  profile: PiAcceptanceProfile;
  lane?: PiAcceptanceLane;
  abtarsRoot: string;
  abmindRoot?: string;
  /** Keep the disposable run root after completion (diagnostics). */
  keepArtifacts?: boolean;
  piRuntime?: PiRuntimeEvidence;
  /** Exact candidate version — when set, the runtime report gates lanes on it. */
  expectedPiVersion?: string;
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
  // The deployed bridge is the esbuild bundle, not raw tsc ESM output. The
  // bundle supplies the ESM-safe require shim used by the production path.
  execFileSync("npm", ["run", "build"], { cwd: abtarsRoot, stdio: "inherit" });
  execFileSync("npm", ["run", "bundle"], { cwd: abtarsRoot, stdio: "inherit" });
}

function blockedResult(lane: PiAcceptanceLane, profile: PiAcceptanceProfile, reason: string): PiLaneResult {
  return { lane, profile, state: "blocked", blockedBy: reason, scenarios: [] };
}

/** #1900: the scheduled pair's dependency — a non-passed first cell blocks
 *  its restart successor without executing it. No general workflow engine. */
export function shouldBlockScheduledRestart(
  scenarioName: string,
  scenarioResults: Pick<PiScenarioResult, "name" | "state">[],
): boolean {
  if (scenarioName !== "scheduled-orc-round-limit-restart") return false;
  const first = scenarioResults.find((s) => s.name === "scheduled-orc-round-limit");
  return !!first && first.state !== "passed";
}

/** #1900: a lane passes only when every reported scenario passes and cleanup
 *  succeeds. Blocked counts as non-green. */
export function deriveLaneState(
  scenarioResults: Pick<PiScenarioResult, "state">[],
): "passed" | "failed" {
  return scenarioResults.some((s) => s.state !== "passed") ? "failed" : "passed";
}

function runtimeFailureResult(lane: PiAcceptanceLane, profile: PiAcceptanceProfile, report: PiRuntimeReport): PiLaneResult {
  const failures = report.checks
    .filter((entry) => entry.state === "failed")
    .map((entry) => `${entry.component}/${entry.capability}${entry.detail ? `: ${entry.detail}` : ""}`)
    .join("; ");
  return {
    lane,
    profile,
    state: "failed",
    scenarios: [{
      name: "pi-runtime-surface",
      lane,
      profile,
      state: "failed",
      durationMs: 0,
      providerRequestIds: [],
      failure: { stage: "pi-runtime-surface", code: "runtime_contract_failed", message: failures.slice(0, 2000) },
    }],
  };
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
  // standalone pi executable must be resolvable (>= 0.85.1 per
  // PI_COMPATIBILITY). Missing it blocks the lane — never a passing skip.
  if (!resolvePiExecutable()) {
    const reason = "standalone `pi` executable not found on PATH (install pi >= 0.85.1 or add it to PATH outside node_modules/.bin)";
    for (const lane of desiredLanes) {
      lanes.push(blockedResult(lane, opts.profile, reason));
    }
    const matrix: PiAcceptanceMatrixV1 = {
      schemaVersion: 1,
      kind: "pi-production-e2e",
      runId,
      startedAt,
      durationMs: Date.now() - overallStart,
      piRuntime: opts.piRuntime,
      piRuntimeReport: undefined,
      lanes,
    };
    writer.writeMatrix(matrix);
    writer.writeJunit(matrix);
    return { matrix, exitCode: 1 };
  }

  const piRuntimeReport = await inspectPiRuntime(opts.expectedPiVersion);
  if (!piRuntimeReport.ok) {
    for (const lane of desiredLanes) {
      lanes.push(runtimeFailureResult(lane, opts.profile, piRuntimeReport));
    }
    const matrix: PiAcceptanceMatrixV1 = {
      schemaVersion: 1,
      kind: "pi-production-e2e",
      runId,
      startedAt,
      durationMs: Date.now() - overallStart,
      piRuntime: opts.piRuntime,
      piRuntimeReport,
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
      piRuntime: opts.piRuntime,
      piRuntimeReport,
      lanes,
    };
    writer.writeMatrix(matrix);
    writer.writeJunit(matrix);
    return { matrix, exitCode: 1 };
  }

  for (const lane of desiredLanes) {
    const laneResult = await runLane(lane, opts.profile, opts, abmindRoot, writer, runId);
    lanes.push(laneResult);
    // #1900: if cleanup could not confirm the previous lane's work stopped,
    // block remaining lanes rather than overlap them.
    const unconfirmed = laneResult.scenarios.some(
      (s) => s.name === "lane-cleanup" && s.state !== "passed" && (s.failure?.message.includes("unconfirmed") ?? false),
    );
    if (unconfirmed) {
      const remaining = desiredLanes.slice(desiredLanes.indexOf(lane) + 1);
      for (const blockedLane of remaining) {
        lanes.push({
          lane: blockedLane,
          profile: opts.profile,
          state: "blocked",
          blockedBy: `previous lane ${lane} cleanup unconfirmed — blocking to prevent overlap`,
          scenarios: [],
        });
      }
      break;
    }
  }

  const matrix: PiAcceptanceMatrixV1 = {
    schemaVersion: 1,
    kind: "pi-production-e2e",
    runId,
    startedAt,
    durationMs: Date.now() - overallStart,
    piRuntime: opts.piRuntime,
    piRuntimeReport,
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
  // Compact leaf: every socket path under runRoot must fit the macOS
  // 104-char sun_path limit with ~50-char $TMPDIRs (#1841 follow-up).
  const runRoot = mkdtempSync(join(tmpdir(), `pp-${lane === "local-unix" ? "l" : "w"}-`));
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

  // #1900: 20-minute execution deadline established before provider and
  // controller setup. Installation, build and runtime inspection happen
  // earlier and are outside this per-lane cap.
  const laneDeadlineAt = Date.now() + TIMEOUTS.laneExecutionMs;
  let laneTornDown = false;
  const remainingMs = (): number => Math.max(0, laneDeadlineAt - Date.now());
  const isExpired = (): boolean => Date.now() >= laneDeadlineAt;
  const laneTimeout = (stage: string): Error =>
    new Error(`${stage}: lane execution deadline exceeded after ${TIMEOUTS.laneExecutionMs}ms (timeout)`);
  let laneExpiryTimer: NodeJS.Timeout | null = null;
  const laneExpiry = new Promise<never>((_, reject) => {
    laneExpiryTimer = setTimeout(() => {
      reject(laneTimeout("lane"));
    }, TIMEOUTS.laneExecutionMs);
  });
  // Prevent unhandled rejection when the lane finishes before expiry; the
  // timer is cleared in finally and this handler owns the rejection.
  laneExpiry.catch(() => {
    // handled via per-scenario races; no late continuation may proceed
  });

  let setupError: Error | null = null;

  try {
    if (isExpired()) throw laneTimeout("lane-setup");
    // 1. Deterministic provider first (its port feeds the bridge config).
    // Owned immediately before readiness so expiry can terminate it.
    provider = new ScriptedProvider();
    await Promise.race([provider.start(), laneExpiry]);

    // 2. Fixture controller (real owner daemon).
    try {
      owner = await Promise.race([
        OwnerControllerClient.spawn(abmindRoot, lane, runId, logDir),
        laneExpiry,
      ]);
    } catch (err) {
      if (err instanceof FixtureLaneBlockedError) {
        // Blocked lanes still trigger finally cleanup for the owned provider.
        setupError = err;
        throw err;
      }
      throw err;
    }

    // 3. Bridge config from the generic descriptor, validated by the
    //    production endpoint resolver.
    if (isExpired()) throw laneTimeout("lane-setup");
    const config = buildBridgeConfig(runRoot, owner.descriptor, provider.baseUrl, lane, abmindRoot);
    bridgeEnv = config.bridgeEnv;

    // 4. Spawn the built bridge entry point. Owned before readiness inside
    // spawnBridge so a boot timeout cannot leak it.
    if (isExpired()) throw laneTimeout("lane-setup");
    bridge = await Promise.race([
      spawnBridge(opts.abtarsRoot, logDir, bridgeEnv, lane, provider),
      laneExpiry,
    ]);

    // 5. Exercise the actual terminal client through a pseudo-terminal. The
    // protocol client below remains separate so later scenarios can assert
    // frames without having a renderer own the socket.
    const tuiSmokeStart = Date.now();
    try {
      await Promise.race([
        runInteractiveTuiSmoke({
          abtarsRoot: opts.abtarsRoot,
          config,
          lane,
          logDir,
          provider,
          runId,
        }),
        laneExpiry,
      ]);
      scenarioResults.push({
        name: "interactive-tui-smoke",
        lane,
        profile,
        state: "passed",
        durationMs: Date.now() - tuiSmokeStart,
        providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      scenarioResults.push({
        name: "interactive-tui-smoke",
        lane,
        profile,
        state: "failed",
        durationMs: Date.now() - tuiSmokeStart,
        providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
        failure: { stage: "interactive-tui-smoke", code: "tui_renderer_failed", message: message.slice(0, 2000) },
      });
      throw err;
    }

    // 6. TUI readiness + one smoke exchange through the real Pi/SSE path.
    if (isExpired()) throw laneTimeout("lane-setup");
    tui = new TuiAcceptanceClient(config.abtarsHome);
    await Promise.race([tui.connect("new"), laneExpiry]);
    const smokeMarker = `PI-SMOKE-${runId}`;
    const smokeReply = `PI-SMOKE-OK-${runId}`;
    provider.enqueue({ candidate: FIXTURE_MODEL_A, expectation: undefined, action: { kind: "text", chunks: [smokeReply] } });
    const smokeReplyFrame = await Promise.race([
      tui.sendAndAwaitReply(smokeMarker, Math.min(TIMEOUTS.turnMs, remainingMs() || 1)),
      laneExpiry,
    ]);
    if (!smokeReplyFrame.markdown.includes(smokeReply)) {
      throw new Error(`smoke exchange failed: reply did not contain ${smokeReply} (got: ${smokeReplyFrame.markdown.slice(0, 200)})`);
    }

    // 7. Scenarios serially against the isolated state.
    const laneProvider = provider;
    const currentOwner = owner;
    const currentTui = tui;
    const restartBridge = async (): Promise<SpawnedChild> => {
      // #1900: check deadline before spawning a replacement; no late
      // continuation may restart a bridge after teardown.
      if (laneTornDown || isExpired()) throw laneTimeout("restart");
      if (bridge && !bridge.exited) await bridge.terminate();
      if (laneTornDown || isExpired()) throw laneTimeout("restart");
      bridge = await Promise.race([
        spawnBridge(opts.abtarsRoot, logDir, bridgeEnv, lane, laneProvider),
        laneExpiry,
      ]);
      return bridge;
    };

    const ctx: PiAcceptanceContext = {
      lane,
      provider,
      owner: currentOwner,
      tui: currentTui,
      bridge,
      runId,
      markers: new MarkerFactory(runId),
      scenarioStart: Date.now(),
      restartBridge,
      abtarsHome: config.abtarsHome,
      readBridgeLog: (): string => {
        try {
          const bridgeLogDir = join(config.abtarsHome, "logs");
          const files = readdirSync(bridgeLogDir).filter((f) => f.startsWith("bridge-") && f.endsWith(".log")).sort();
          if (files.length === 0) return "";
          const content = readFileSync(join(bridgeLogDir, files[files.length - 1]!), "utf-8");
          return content.length > 262144 ? content.slice(-262144) : content;
        } catch {
          return "";
        }
      },
      writeArtifact: (name: string, data: string): void => {
        // #1900: fence writes after lane teardown; #1548: a failed write must
        // fail the scenario, never silently pass.
        if (laneTornDown || isExpired()) {
          throw laneTimeout("artifact-write");
        }
        const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_");
        writeFileSync(join(writer.relativeDirectory, `${lane}-${safe}`), data, "utf-8");
      },
    };

    for (const scenario of scenariosForProfile(profile)) {
      // #1900: encode the scheduled pair's dependency without a workflow
      // engine — a failed predecessor blocks its restart successor.
      if (shouldBlockScheduledRestart(scenario.name, scenarioResults)) {
        const first = scenarioResults.find((s) => s.name === "scheduled-orc-round-limit");
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: "blocked",
          durationMs: 0,
          providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
          failure: {
            stage: scenario.name,
            code: "prereq_missing",
            message: `blocked: predecessor scheduled-orc-round-limit ${first?.state ?? "missing"}`,
          },
        });
        continue;
      }
      if (isExpired()) {
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: "blocked",
          durationMs: 0,
          providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
          failure: {
            stage: scenario.name,
            code: "timeout",
            message: laneTimeout(scenario.name).message.slice(0, 2000),
          },
        });
        // Block all further unstarted cells after expiry.
        const startedNames = new Set(scenarioResults.map((s) => s.name));
        for (const remaining of scenariosForProfile(profile)) {
          if (!startedNames.has(remaining.name)) {
            scenarioResults.push({
              name: remaining.name,
              lane,
              profile,
              state: "blocked",
              durationMs: 0,
              providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
              failure: {
                stage: remaining.name,
                code: "timeout",
                message: `blocked: lane deadline exceeded before start`,
              },
            });
            startedNames.add(remaining.name);
          }
        }
        break;
      }
      const scenarioStart = Date.now();
      try {
        await Promise.race([scenario.run(ctx), laneExpiry]);
        // #1900: check deadline before accepting a success.
        if (isExpired() || laneTornDown) throw laneTimeout(scenario.name);
        // Sync the outer bridge handle with restarts performed inside the
        // scenario so cleanup owns the latest child.
        bridge = ctx.bridge;
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: "passed",
          durationMs: Date.now() - scenarioStart,
          providerRequestIds: provider.summaries.map((s) => `seq${s.seq}`),
        });
      } catch (err) {
        bridge = ctx.bridge;
        const message = err instanceof Error ? err.message : String(err);
        const isTimeout = /lane execution deadline exceeded/i.test(message);
        scenarioResults.push({
          name: scenario.name,
          lane,
          profile,
          state: isTimeout ? "blocked" : "failed",
          durationMs: Date.now() - scenarioStart,
          providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
          failure: {
            stage: scenario.name,
            code: isTimeout ? "timeout" : "scenario_failed",
            message: message.slice(0, 2000),
          },
        });
        if (isTimeout) {
          // Expiry fails the active stage and blocks the rest without
          // starting new work.
          const started = new Set(scenarioResults.map((s) => s.name));
          for (const remaining of scenariosForProfile(profile)) {
            if (!started.has(remaining.name)) {
              scenarioResults.push({
                name: remaining.name,
                lane,
                profile,
                state: "blocked",
                durationMs: 0,
                providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
                failure: {
                  stage: remaining.name,
                  code: "timeout",
                  message: `blocked: lane deadline exceeded during ${scenario.name}`,
                },
              });
              started.add(remaining.name);
            }
          }
          break;
        }
        // Ordinary failures keep the lane alive for independent successors;
        // the failed lane is reported in the matrix.
      }
    }
  } catch (err) {
    if (err instanceof FixtureLaneBlockedError) {
      // Whole-lane blocked (e.g., controller lane material missing). The
      // finally below still cleans up the owned provider.
      setupError = err;
    } else {
      const message = err instanceof Error ? err.message : String(err);
      // Lane-setup failure — record after cleanup derives the final outcome.
      setupError = err instanceof Error ? err : new Error(message);
    }
  } finally {
    if (laneExpiryTimer) clearTimeout(laneExpiryTimer);
    // #1900: fence late continuations as soon as teardown begins.
    laneTornDown = true;
    let cleanupError: Error | null = null;
    let cleanupUnconfirmed = false;
    try {
      // #1900: independent 60s cleanup budget, not charged against execution.
      await Promise.race([
        cleanupLane({ provider, owner, bridge, tui }, writer, lane),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("lane cleanup deadline exceeded after 60000ms (unconfirmed)")), TIMEOUTS.laneCleanupMs),
        ),
      ]);
      // Confirm owned work stopped; otherwise block remaining lanes.
      if ((bridge && !bridge.exited) || (owner && owner.isAlive)) {
        cleanupUnconfirmed = true;
        cleanupError = new Error(
          `lane cleanup unconfirmed: bridge exited=${bridge?.exited ?? "none"} owner alive=${owner?.isAlive ?? "none"} (unconfirmed)`,
        );
      }
    } catch (cleanupErr) {
      cleanupError = cleanupErr as Error;
      if (/unconfirmed|still alive|deadline exceeded/i.test(cleanupError.message)) {
        cleanupUnconfirmed = true;
      }
      degradedCleanup = true;
    }
    // #1900: derive the returned lane outcome after cleanup. Preserve
    // completed scenario facts and append a distinct cleanup failure rather
    // than relabeling passes.
    if (setupError instanceof FixtureLaneBlockedError) {
      // Whole-lane blocked takes precedence; scenarioResults stays empty.
      try {
        if (provider || owner || bridge || tui) {
          writer.copyFailureArtifacts(lane, "lane-failure", [logDir]);
        }
      } catch {
        // best effort — blocked result still stands
      }
      if (!opts.keepArtifacts && !degradedCleanup && !cleanupUnconfirmed) {
        try {
          rmSync(runRoot, { recursive: true, force: true });
        } catch {
          // best effort
        }
      }
      // Never remove a fixture root still in use.
      return blockedResult(lane, profile, setupError.message);
    }
    if (setupError) {
      const message = setupError.message;
      scenarioResults.push({
        name: "lane-setup",
        lane,
        profile,
        state: "failed",
        durationMs: 0,
        providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
        failure: { stage: "lane-setup", code: "setup_failed", message: message.slice(0, 2000) },
      });
    }
    if (cleanupError) {
      scenarioResults.push({
        name: "lane-cleanup",
        lane,
        profile,
        state: "failed",
        durationMs: 0,
        providerRequestIds: provider?.summaries.map((s) => `seq${s.seq}`) ?? [],
        failure: {
          stage: "lane-cleanup",
          code: "cleanup_failed",
          message: `${cleanupError.message.slice(0, 2000)}${cleanupUnconfirmed ? " (unconfirmed)" : ""}`,
        },
      });
      degradedCleanup = true;
    }
    // Writer failures must not be hidden by earlier results.
    try {
      if (degradedCleanup || cleanupError || scenarioResults.some((s) => s.state !== "passed")) {
        writer.copyFailureArtifacts(lane, "lane-failure", [logDir]);
      }
    } catch (err) {
      throw new Error(`result/artifact write failed: ${(err as Error).message}`);
    }
    // Never remove a fixture root still in use.
    if (!opts.keepArtifacts && !degradedCleanup && !cleanupUnconfirmed) {
      try {
        rmSync(runRoot, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    // #1900: a lane passes only when all executed scenarios pass and cleanup
    // succeeds. Blocked counts as non-green for the lane state.
    const state = deriveLaneState(scenarioResults);
    return { lane, profile, state, scenarios: scenarioResults };
  }
}

export interface LaneHandles {
  provider: ScriptedProvider | null;
  owner: OwnerControllerClient | null;
  bridge: SpawnedChild | null;
  tui: TuiAcceptanceClient | null;
}

/** Cleanup in reverse ownership order; exact PIDs only, bounded grace. */
export async function cleanupLane(
  handles: LaneHandles,
  writer: ResultWriter,
  lane: PiAcceptanceLane,
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
      // #1900: per-lane provider evidence without overwriting prior lanes.
      writer.writeProviderSummaries(handles.provider.summaries, lane);
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
    args: [resolve(abtarsRoot, "bundle/abtars.js")],
    cwd: abtarsRoot,
    env,
    logDir,
    name: `bridge-${lane}`,
  });
  // #1900: own the child before readiness — a boot timeout must not leak it.
  try {
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
  } catch (err) {
    try {
      await bridge.terminate();
    } catch {
      // best effort — caller still sees the original boot failure
    }
    throw err;
  }
  return bridge;
}
