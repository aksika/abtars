import { HeartbeatSystem, setHeartbeatInstance } from "../components/heartbeat-system.js";
import { classifyResume } from "../components/platform-detect.js";
import {
  writeRestartReason, readAndClearRestartRequested, updateBridgeLockField,
} from "../components/transport/bridge-lock-transport.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn, logDebug } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { readEnvWithDefault } from "../components/env.js";
import { startInProcWatchdog } from "./heartbeat-watchdog.js";

export async function phaseHeartbeat(ctx: BootCtx): Promise<PhaseResult> {
  const { init: initSkillStats } = await import("../components/skill-stats.js");
  initSkillStats();

  updateBridgeLockField("startedAt", ctx.startedAt);

  const hbIntervalMs = Math.max(60, parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "60", "heartbeat tick interval"), 10)) * 1000;

  const WD_THRESHOLD_MS = hbIntervalMs * 3;
  const watchdog = startInProcWatchdog({ thresholdMs: WD_THRESHOLD_MS });

  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepActive: ctx.isSleepActive,
    onTick: watchdog.kick,
    onStandbyResume: (gapMs) => {
      const gapMin = Math.round(gapMs / 60000);
      const resumeKind = classifyResume();
      if (resumeKind === "dark") {
        logDebug("main", `⏸️ Darkwake resume (${gapMin}min) — skipping tick`);
        return;
      }
      writeRestartReason(`resume after ${gapMin}min suspend`);
      logInfo("main", `⏸️ Resume (${gapMin}min, ${resumeKind}) — restarting for clean state`);
      process.exit(0);
    },
  });
  ctx.heartbeat = heartbeat;
  setHeartbeatInstance(heartbeat);

  heartbeat.registerTask({
    name: "restart-check",
    execute: async () => {
      const req = readAndClearRestartRequested();
      if (req) {
        logInfo("restart-check", `Restart requested: ${req}`);
        process.exit(0);
      }
      return { state: "idle" as const };
    },
  });

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
