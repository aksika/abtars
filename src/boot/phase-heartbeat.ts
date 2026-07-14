import { logAndSwallow } from "../components/log-and-swallow.js";
/**
 * phase-heartbeat — Tier 1 heartbeat: create, register core tasks, start.
 *
 * Runs with deps:[] — starts before transport/pipeline. Watchdog kick from tick 1.
 * Tier 3 tasks (cron, kanban, self-healer etc.) registered later by heartbeat-tier3.ts
 * called from phasePipelineDeps.
 *
 * Populates ctx: heartbeat, sendSystemMessage.
 */

import { HeartbeatSystem, setHeartbeatInstance } from "../components/heartbeat-system.js";
import { classifyResume } from "../components/platform-detect.js";
import {
  writeRestartReason, readAndClearRestartRequested, updateBridgeLockField,
} from "../components/transport/bridge-lock-transport.js";
import { createUpdateCheckTask, createSkillStatsFlushTask, createSkillReloadTask } from "../components/heartbeat-tasks.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn, logDebug } from "../components/logger.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { readEnvWithDefault } from "../components/env.js";
import { startInProcWatchdog } from "./heartbeat-watchdog.js";

const TAG = "heartbeat";

export async function phaseHeartbeat(ctx: BootCtx): Promise<PhaseResult> {
  // Tier 3 deps registered later in phasePipelineDeps via registerTier3Tasks()

  // #613: initialize skill usage stats from disk
  const { init: initSkillStats } = await import("../components/skill-stats.js");
  initSkillStats();

  // bridge.lock already written at process start (bridge-app.ts) — just update startedAt from ctx
  updateBridgeLockField("startedAt", ctx.startedAt);

  const hbIntervalMs = Math.max(60, parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "60", "heartbeat tick interval"), 10)) * 1000;

  // In-proc watchdog (#263: extracted to heartbeat-watchdog.ts)
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
      // #548: any non-dark resume → restart for clean state
      // In-flight prompts are dead, sessions stuck busy, connections dropped.
      writeRestartReason(`resume after ${gapMin}min suspend`);
      logInfo("main", `⏸️ Resume (${gapMin}min, ${resumeKind}) — restarting for clean state`);
      process.exit(0);
    },
  });
  ctx.heartbeat = heartbeat;
  setHeartbeatInstance(heartbeat);

  // --- Tier 1 tasks (no transport/pipeline deps) ---
  heartbeat.registerTask(createSkillStatsFlushTask());
  heartbeat.registerTask(createSkillReloadTask());
  heartbeat.registerTask(createUpdateCheckTask((msg) => {
    import("../components/notification.js").then(({ sendNotification }) => sendNotification(ctx, msg)).catch(err => logAndSwallow(TAG, "sendNotification update-check", err));
  }));
  heartbeat.registerTask({
    name: "restart-check",
    execute: async () => {
      const req = readAndClearRestartRequested();
      if (req) {
        logInfo("restart-check", `Restart requested: ${req}`);
        process.exit(0);
      }
    },
  });

  // sendSystemMessage — #1106: use injectGreeting (routes through pipeline,
  // model response is delivered to master user via standard adapter path).
  // Replaces spin.inject() which generated a response but never delivered it.
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

  // Start heartbeat immediately — watchdog kick from tick 1 (Tier 1)
  heartbeat.start();
  logInfo("main", `💓 Heartbeat started (${Math.round(hbIntervalMs / 1000)}s interval)`);

  // #1293: Per-tick ws-outbound reconnect check (no new timer — driven by HB)
  heartbeat.registerTask({
    name: "ws-reconnect-check",
    execute: async () => {
      try {
        const { getPeerTransport } = await import("../components/peer-transport/index.js");
        const transport = getPeerTransport() as import("../components/peer-transport/http-transport.js").HttpTransport;
        if (typeof transport.checkWsConnections === "function") {
          transport.checkWsConnections();
        }
      } catch { /* best effort — transport may not be up yet */ }

      // #1358: Drain unacknowledged remote Pi lifecycle events to connected peers.
      // Uses the existing HB tick — no new recurring timer.
      try {
        const { getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
        const delivery = getRemotePiDelivery();
        if (delivery) {
          // Register WS clients from the transport so delivery can push
          const { getPeerTransport } = await import("../components/peer-transport/index.js");
          const transport = getPeerTransport() as any;
          if (transport?.wsClients) {
            for (const [name, client] of transport.wsClients as Map<string, any>) {
              delivery.registerWsClient(name, client);
            }
          }
          await delivery.drainOutbox();
        }
      } catch { /* best effort */ }
    },
  });

  return "ran";
}

