import { HeartbeatSystem, setHeartbeatInstance } from "../components/heartbeat-system.js";
import { classifyResume } from "../components/platform-detect.js";
import type { ResumeKind } from "../components/platform-detect.js";
import {
  writeRestartReason, readAndClearRestartRequested, updateOwnedBridgeLockField,
} from "../components/transport/bridge-lock-transport.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn, logDebug } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { HeartbeatTask, HeartbeatTaskOutcome } from "../types/index.js";
import { readEnvWithDefault } from "../components/env.js";
import { packagePaths, readManifest } from "../cli/deploy-lib-import.js";

/** Resume policy knob (INSTALL_TYPE): server restarts on resume when a
 * supervisor can respawn; notebook always continues in place. */
export type InstallType = "server" | "notebook";

/** Resume outcome: exit for a supervised restart, continue in place. */
export type StandbyResumeAction = "exit" | "continue";

/** Launch context the resume decision depends on. installMode comes from
 * manifest.json; supervised proves a supervisor actually spawned this
 * process (watchdog sets ABTARS_WATCHDOG_PID, OS services set
 * SUPERVISION) — a manifest that claims daemon while nobody supervises
 * must not exit, or the bridge suicides with no one to respawn it. */
export interface StandbyResumeContext {
  readonly installMode: string;
  readonly installType: InstallType;
  readonly supervised: boolean;
}

/** Normalize raw INSTALL_TYPE input; missing or unrecognized values fail
 * safe to server (today's behavior). */
export function normalizeInstallType(raw: string | undefined): InstallType {
  const normalized = raw?.trim().toLowerCase();
  return normalized === "notebook" ? "notebook" : "server";
}

/** Pure resume decision: exit only for daemon + server + attached
 * supervisor; every other combination continues in place. */
export function decideStandbyResumeAction(ctx: StandbyResumeContext): StandbyResumeAction {
  if (ctx.installMode === "daemon" && ctx.installType === "server" && ctx.supervised) {
    return "exit";
  }
  return "continue";
}

export interface StandbyResumeHandlerDeps extends StandbyResumeContext {
  readonly classify?: () => ResumeKind;
  readonly exit?: (code: number) => void;
  readonly writeReason?: (reason: string) => void;
}

/** Build the HeartbeatSystem resume callback with injectable classification
 * and effects, so the exit-vs-continue wiring (including restartReason) is
 * testable without killing the test process. Defaults are production. */
export function createStandbyResumeHandler(deps: StandbyResumeHandlerDeps): (gapMs: number) => void {
  const {
    classify = classifyResume,
    exit = process.exit,
    writeReason = writeRestartReason,
  } = deps;
  return (gapMs: number): void => {
    const gapMin = Math.round(gapMs / 60000);
    const resumeKind = classify();
    if (resumeKind === "dark") {
      logDebug("main", `⏸️ Darkwake resume (${gapMin}min) — skipping tick`);
      return;
    }
    if (decideStandbyResumeAction(deps) === "continue") {
      logInfo("main", `⏸️ Resume (${gapMin}min, ${resumeKind}) — continuing in place (installMode=${deps.installMode}, INSTALL_TYPE=${deps.installType}, supervised=${deps.supervised})`);
      return;
    }
    writeReason(`resume after ${gapMin}min suspend`);
    logInfo("main", `⏸️ Resume (${gapMin}min, ${resumeKind}) — restarting for clean state`);
    exit(0);
  };
}

/** installMode from the owned manifest; absent or unreadable defaults to
 * daemon — the same default status/start/stop use, and today's behavior. */
async function readInstallMode(): Promise<string> {
  try {
    const manifest = await readManifest(packagePaths("abtars").manifest);
    return manifest?.installMode ?? "daemon";
  } catch (err) {
    // A corrupt manifest breaks install tooling loudly elsewhere; resume
    // behavior here must stay exactly today's (exit path eligible).
    logWarn("main", `Manifest unreadable, assuming installMode=daemon: ${err instanceof Error ? err.message : String(err)}`);
    return "daemon";
  }
}

export interface RestartCheckDeps {
  /** True when a supervisor (watchdog or OS service) respawns a hard exit. */
  readonly supervised: boolean;
  readonly exit?: (code: number) => void;
  readonly requestRestart?: (code: number) => void;
}

/** Handle a requested restart (flag file written by `abtars restart`). A
 * hard exit only survives when a supervisor respawns the process; without
 * one, route through the in-process restart loop (exit code 0) so simple
 * and manually started bridges come back instead of dying. */
export function createRestartCheckTask(
  ctx: Pick<BootCtx, "requestShutdownWithCode">,
  deps: RestartCheckDeps,
): HeartbeatTask {
  const exit = deps.exit ?? process.exit;
  const requestRestart = deps.requestRestart ?? ctx.requestShutdownWithCode;
  return {
    name: "restart-check",
    execute: async (): Promise<HeartbeatTaskOutcome> => {
      const req = readAndClearRestartRequested();
      if (req) {
        logInfo("restart-check", `Restart requested: ${req}`);
        if (deps.supervised) exit(0);
        else requestRestart(0);
      }
      return { state: "idle" };
    },
  };
}

export async function phaseHeartbeat(ctx: BootCtx): Promise<PhaseResult> {
  const { init: initSkillStats } = await import("../components/skill-stats.js");
  initSkillStats();

  updateOwnedBridgeLockField("startedAt", ctx.startedAt);

  const hbIntervalMs = Math.max(60, parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "60", "heartbeat tick interval"), 10)) * 1000;

  const installTypeRaw = readEnvWithDefault("INSTALL_TYPE", "server", "resume policy after suspend");
  const installType = normalizeInstallType(installTypeRaw);
  if (installTypeRaw.trim().toLowerCase() !== installType) {
    logWarn("main", `Unrecognized INSTALL_TYPE=${installTypeRaw.trim().slice(0, 32)} — using server`);
  }
  const installMode = await readInstallMode();
  const supervised = (process.env["ABTARS_WATCHDOG_PID"]?.trim() ?? "") !== ""
    || (process.env["SUPERVISION"]?.trim() ?? "") !== "";
  logInfo("main", `Resume policy: installMode=${installMode}, INSTALL_TYPE=${installType}, supervised=${supervised}`);

  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepActive: ctx.isSleepActive,
    onStandbyResume: createStandbyResumeHandler({ installMode, installType, supervised }),
  });
  ctx.heartbeat = heartbeat;
  setHeartbeatInstance(heartbeat);

  heartbeat.registerTask(createRestartCheckTask(ctx, { supervised }));

  const { spin } = await import("../components/spin.js");
  const masterUser = loadUsers().users.find(u => u.role === "master");
  const masterUserId = masterUser?.userId ?? "master";
  ctx.sendSystemMessage = async (prompt: string): Promise<void> => {
    try {
      await spin.injectGreeting(masterUserId, `[SYSTEM] ${prompt}`);
    } catch (err) {
      logWarn("main", `System message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  heartbeat.start();
  logInfo("main", `💓 Heartbeat started (${Math.round(hbIntervalMs / 1000)}s interval)`);

  heartbeat.registerTask({
    name: "snapshot-refresh",
    execute: async () => {
      const { refreshHeartbeatSnapshot } = await import("../components/runtime-health-snapshot.js");
      refreshHeartbeatSnapshot(spin.getActiveCardIds());
      return { state: "ran" as const };
    },
  });

  return "ran";
}
