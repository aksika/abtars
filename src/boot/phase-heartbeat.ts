import { logAndSwallow } from "../components/log-and-swallow.js";
import { getEnv } from "../components/env-schema.js";
/**
 * phase-heartbeat — boot phase 9: HeartbeatSystem + all periodic tasks + watchdog.
 *
 * Longest phase. Handles:
 * - bridge.lock write (pid, startedAt, version, sleepStatus)
 * - HeartbeatSystem construction with standby-resume handler
 * - Task registrations: tasks (cron dispatch), reminder-injector, idle-compact,
 *   age-check (daily cycle), db-integrity, transport-health, restart-check,
 *   self-healer, model-health
 * - initSystemMessage singleton wire
 * - In-proc watchdog setInterval (WD_THRESHOLD_MS = hbInterval × 3)
 * - Capability-registered commands + heartbeat tasks
 * - heartbeat.start() + memory.setHeartbeat()
 * - checkBrowseTasks once on startup
 *
 * Must run after phase-platforms (tasks read ctx.telegramAdapter lazily via closures).
 * Must run after phase-pipeline-deps (selfHealerTask mutates pipelineDeps in place).
 *
 * Populates ctx: heartbeat, selfHealerTask.
 * Owns singletons: system-message._sender (via initSystemMessage).
 *   message-pipeline.resetIdleCompactFlag is set indirectly via createIdleCompactTask.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HeartbeatSystem } from "../components/heartbeat-system.js";
import { classifyResume } from "../components/platform-detect.js";
import {
  writeRestartReason, readAndClearRestartRequested, readBridgeLockField, writeSleepStatus,
  appendRestartTimestamp, readRestartTimestamps,
} from "../components/transport/bridge-lock-transport.js";
import { createSelfHealerTask } from "../components/self-healer.js";
import { createIdleCompactTask, createAgeCheckTask, createDbIntegrityTask } from "../components/heartbeat-tasks.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "../components/cron/cron-checker.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn, logDebug } from "../components/logger.js";
import { agentBridgeHome } from "../paths.js";
import { createCronCallback } from "./phase-pipeline-deps.js";
import type { BootCtx } from "./context.js";
import { readEnvWithDefault } from "../components/env.js";

export async function phaseHeartbeat(ctx: BootCtx): Promise<void> {
  const { config, memoryConfig, memory, transport, cronQueue, pipelineDeps, capabilities } = ctx;
  if (!transport || !cronQueue || !pipelineDeps) {
    ctx.phaseHealth.set(phaseHeartbeat.name, { status: "skipped", error: "no transport/cronQueue/pipelineDeps" }); logWarn("boot", `${phaseHeartbeat.name}: skipping — deps not available`); return;
  }

  const cronCallback = createCronCallback(ctx);

  // bridge.lock — track bridge lifecycle
  try {
    writeFileSync(ctx.bridgeLockPath, JSON.stringify({ pid: process.pid, startedAt: ctx.startedAt, version: `${ctx.version}-${ctx.commit}`, sleepStatus: "awake", argv: process.argv.slice(2), lastHeartbeat: Date.now() }), "utf-8");
  } catch (err) { logAndSwallow("phase_heartbeat", "op", err); }

  const hbIntervalMs = parseInt(readEnvWithDefault("HEARTBEAT_INTERVAL_SEC", "300", "heartbeat tick interval"), 10) * 1000;

  // Watchdog: wall-clock comparison (immune to setInterval batching after sleep)
  const WD_THRESHOLD_MS = hbIntervalMs * 3;
  let lastKickAt = Date.now();
  let lastCheckAt = Date.now();
  const kickWatchdog = (): void => { lastKickAt = Date.now(); };

  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepActive: ctx.isSleepActive,
    onTick: kickWatchdog,
    onStandbyResume: (gapMs) => {
      const resumeKind = classifyResume();
      if (resumeKind === "dark") {
        logDebug("main", `⏸️ Darkwake resume (${Math.round(gapMs / 60000)}min) — skipping tick`);
        return;
      }
      logInfo("main", `⏸️ Standby resume (${Math.round(gapMs / 60000)}min, ${resumeKind}) — continuing`);
      // Morning restart: first full wake after hardware sleep → fresh process
      if (resumeKind === "full" && readBridgeLockField("sleepStatus") === "hw_sleep") {
        writeSleepStatus("awake");
        writeRestartReason("morning restart after hw_sleep");
        logInfo("main", "🌅 Morning wake detected — restarting for fresh process");
        process.exit(0);
      }
    },
  });
  ctx.heartbeat = heartbeat;

  heartbeat.registerTask({
    name: "tasks",
    execute: async () => {
      const dueTasks = checkCron();
      for (const entry of dueTasks) cronQueue.enqueue(entry, cronCallback);
    },
  });

  heartbeat.registerTask({
    name: "reminder-injector",
    execute: async () => {
      const reminders = readPendingReminders();
      if (reminders.length === 0) return;
      clearPendingReminders();
      for (const r of reminders) {
        logInfo("main", `⏰ Injecting reminder for chat ${r.chatId}: "${r.message}"`);
        if (ctx.telegramAdapter) {
          ctx.telegramAdapter.injectMessage({
            platform: "telegram",
            channelId: String(r.chatId),
            sessionKey: (loadUsers().byPlatformId.get("telegram:" + r.chatId)?.userId ?? "master") + ":telegram",
            senderId: String(r.chatId),
            senderName: "cron",
            text: `[Scheduled reminder] ${r.message}`,
            timestamp: Date.now(),
            threadId: r.threadId ? String(r.threadId) : undefined,
            isGroup: false,
            isVoice: false,
          });
        }
      }
    },
  });

  const SLEEP_HOUR = parseInt(readEnvWithDefault("BED_TIME", "2", "bedtime hour").split(":")[0] ?? "2", 10);
  const SLEEP_MINUTE = parseInt(readEnvWithDefault("BED_TIME", "2", "bedtime hour").split(":")[1] ?? "0", 10);

  // Floating compaction (idle-triggered) — createIdleCompactTask internally calls
  // setIdleCompactReset → sets message-pipeline.resetIdleCompactFlag singleton.
  if (getEnv().ctxIdleCompactMin > 0) {
    heartbeat.registerTask(createIdleCompactTask({
      transport, memory, memoryDir: memoryConfig.memoryDir,
      allowedUserIds: config.telegram.allowedUserIds,
      sessions: ctx.sessions,
      isSleepActive: ctx.isSleepActive,
    }));
  }

  // System message sender — singleton: system-message._sender
  const { initSystemMessage, sendSystemMessage } = await import("../components/system-message.js");
  const primaryChatId = String(config.mainChatId ?? "");
  initSystemMessage(async (prompt: string) => {
    try {
      const response = await transport.sendPrompt(primaryChatId, `[SYSTEM] ${prompt}`);
      if (response) {
        const { sendNotification } = await import("../components/notification.js");
        sendNotification(ctx, response);
      }
    } catch (err) {
      logWarn("main", `System message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Daily cycle: spawn Dreamy after BED_TIME + quiet ticks
  heartbeat.registerTask(createAgeCheckTask({
    memory,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepAuditDir: ctx.sleepAuditDir,
    sleepHour: SLEEP_HOUR,
    sleepMinute: SLEEP_MINUTE,
    sessions: ctx.sessions,
    isSleepActive: ctx.isSleepActive,
    doctorPath: join(agentBridgeHome(), "scripts", "doctor.sh"),
    startSleep: () => { ctx.sleepHandle?.spawn(); },
    checkHwSleep: () => { ctx.sleepHandle?.checkHwSleep(); },
    cronBusy: () => cronQueue.currentJob !== null || cronQueue.pending > 0,
  }));

  heartbeat.registerTask(createDbIntegrityTask(memory));

  if (transport.healthCheck) {
    heartbeat.registerTask({ name: "transport-health", execute: () => transport.healthCheck!() });
  }

  // In-proc watchdog: wall-clock comparison every 60s
  const WD_CHECK_INTERVAL = 60_000;
  const WD_UNKNOWN_SUPPRESS_MS = 60 * 60_000;
  const CIRCUIT_BREAKER_MAX = 3;
  const CIRCUIT_BREAKER_WINDOW_MS = 5 * 60_000;

  // Check if we're in a restart loop — suppress if so
  const recentTimestamps = readRestartTimestamps();
  const recentCount = recentTimestamps.filter(t => Date.now() - t < CIRCUIT_BREAKER_WINDOW_MS).length;
  const watchdogSuppressed = recentCount >= CIRCUIT_BREAKER_MAX;
  if (watchdogSuppressed) {
    logWarn("watchdog", `⚡ Circuit breaker: ${recentCount} restarts in last 5min — in-process watchdog suppressed this session`);
  }

  setInterval(() => {
    const now = Date.now();
    const checkGap = now - lastCheckAt;
    lastCheckAt = now;
    // Suspend detection: if timer fired much later than expected, process was suspended
    if (checkGap > WD_CHECK_INTERVAL * 3) {
      lastKickAt = now;
      return;
    }
    const elapsed = now - lastKickAt;
    if (elapsed <= WD_THRESHOLD_MS) return;
    const kind = classifyResume();
    if (kind === "dark" || (kind === "unknown" && elapsed < WD_UNKNOWN_SUPPRESS_MS)) {
      lastKickAt = Date.now();
      return;
    }
    if (watchdogSuppressed) {
      lastKickAt = Date.now();
      return;
    }
    logWarn("watchdog", `No heartbeat kick for ${Math.round(elapsed / 60000)}min (${kind}) — forcing restart`);
    appendRestartTimestamp();
    writeRestartReason("watchdog: no heartbeat kick");
    process.exit(1);
  }, WD_CHECK_INTERVAL);

  // Restart flag check
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

  // Self-healing agent (optional)
  let selfHealerTask: ReturnType<typeof createSelfHealerTask> | null = null;
  if (getEnv().selfhealEnabled) {
    selfHealerTask = createSelfHealerTask(() => ctx.telegramAdapter, config.telegram.allowedUserIds);
    heartbeat.registerTask(selfHealerTask);
  }
  ctx.selfHealerTask = selfHealerTask;
  pipelineDeps.selfHealerTask = selfHealerTask;

  // Wire capability-registered commands + tasks
  const { registerCommand } = await import("../components/command-handlers.js");
  for (const [name, handler] of capabilities.commands) {
    registerCommand(name, handler);
  }
  for (const task of capabilities.heartbeatTasks) {
    heartbeat.registerTask(task);
  }

  // Model health check — runs once on first tick
  let modelHealthDone = false;
  const runModelHealth = async (): Promise<void> => {
      if (modelHealthDone) return;
      modelHealthDone = true;
      const { loadTransport, resolveAgent, consumeRepairs } = await import("../components/transport-config.js");
      const tc = loadTransport();
      if (!tc) return;

      // Consume any invariant auto-repairs from boot
      const repairs = consumeRepairs();
      const warnings: string[] = [];
      if (repairs.length > 0) {
        for (const r of repairs) warnings.push(`🔧 ${r.agent} auto-repaired: was ${r.oldProvider} — ${r.reason}`);
      }

      const prof = resolveAgent("professor", tc);
      if (!prof) return;
      const profType = prof.provider.transport ?? "api";

      if (profType === "api") {
        // Per-agent HTTP probe
        const agents = ["professor", "dreamy", "browsie", "coding"] as const;
        const probed = new Set<string>();
        for (const a of agents) {
          const r = resolveAgent(a, tc);
          if (!r || probed.has(r.model)) continue;
          probed.add(r.model);
          const endpoint = r.provider.endpoint ?? "http://localhost:11434/v1";
          const apiKey = getEnv().getApiKey(r.provider.apiKeyEnv ?? "API_KEY");
          try {
            const res = await fetch(`${endpoint}/chat/completions`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
              body: JSON.stringify({ model: r.model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
              warnings.push(`⚠️ ${a}=${r.model} — ${res.status} ${res.statusText}`);
              logWarn("model-health", `${a}=${r.model} failed: ${res.status}`);
            } else {
              logInfo("model-health", `✓ ${a}=${r.model}`);
            }
          } catch (err) {
            warnings.push(`⚠️ ${a}=${r.model} — ${err instanceof Error ? err.message : String(err)}`);
            logWarn("model-health", `${a}=${r.model} unreachable: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else if (profType === "acp" || profType === "tmux") {
        // Lightweight: check if transport is connected
        const transport = ctx.transport;
        if (transport && "isConnected" in transport && typeof (transport as { isConnected?: () => boolean }).isConnected === "function") {
          const connected = (transport as { isConnected: () => boolean }).isConnected();
          if (connected) {
            logInfo("model-health", `✓ ${profType} transport connected`);
          } else {
            warnings.push(`⚠️ ${profType} transport not connected`);
            logWarn("model-health", `${profType} transport not connected`);
          }
        } else {
          logInfo("model-health", `✓ ${profType} transport (no isConnected check available)`);
        }
      }

      if (warnings.length > 0) {
        const { sendNotification } = await import("../components/notification.js");
        sendNotification(ctx, `🏥 Model health check:\n${warnings.join("\n")}\nSubagents will fall back to main model.`);
      }
  };
  heartbeat.registerTask({ name: "model-health", execute: runModelHealth });

  // #318: fire model-health immediately at boot (don't wait for first tick)
  queueMicrotask(() => { runModelHealth().catch(() => {}); });

  // checkBrowseTasks once on startup, then heartbeat.start
  const { checkBrowseTasks } = await import("../capabilities/browser/browse-delivery.js");
  checkBrowseTasks();
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", "💓 Heartbeat started (5-min interval)");

  // Expose sendSystemMessage for phase-sleep
  ctx.sendSystemMessage = sendSystemMessage;
}
