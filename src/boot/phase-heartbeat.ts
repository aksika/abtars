import { getEnv } from "../components/env-schema.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
/**
 * phase-heartbeat — boot phase 9: HeartbeatSystem + all periodic tasks + watchdog.
 *
 * Longest phase. Handles:
 * - bridge.lock write (pid, startedAt, version, sleepStatus)
 * - HeartbeatSystem construction with standby-resume handler
 * - Task registrations: tasks (cron dispatch), reminder-injector, idle-compact,
 *   age-check (daily cycle), db-integrity, transport-health, restart-check,
 *   self-healer, model-health
 * - sendSystemMessage via spin.inject()
 * - In-proc watchdog setInterval (WD_THRESHOLD_MS = hbInterval × 3)
 * - Capability-registered commands + heartbeat tasks
 * - Nerve card:done subscription for instant kanban delivery
 * - heartbeat.start() + memory.setHeartbeat()
 *
 * Must run after phase-platforms (tasks read ctx.telegramAdapter lazily via closures).
 * Must run after phase-pipeline-deps (selfHealerTask mutates pipelineDeps in place).
 *
 * Populates ctx: heartbeat, selfHealerTask.
 *   message-pipeline.resetIdleCompactFlag is set indirectly via createIdleCompactTask.
 */

import { join } from "node:path";
import { HeartbeatSystem } from "../components/heartbeat-system.js";
import { classifyResume } from "../components/platform-detect.js";
import {
  writeRestartReason, readAndClearRestartRequested, readBridgeLockField, updateBridgeLockField, writeSleepStatus,
} from "../components/transport/bridge-lock-transport.js";
import { createSelfHealerTask } from "../components/self-healer.js";
import { createIdleCompactTask, createAgeCheckTask, createDbIntegrityTask, createUpdateCheckTask, createSkillStatsFlushTask, createSkillTrashPruneTask, createKanbanDeliveryTask, createKanbanCleanupTask, createUserSessionExpiryTask } from "../components/heartbeat-tasks.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "../components/tasks/task-checker.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn, logDebug } from "../components/logger.js";
import { abtarsHome } from "../paths.js";
import { createCronCallback } from "./phase-pipeline-deps.js";
import type { BootCtx, PhaseResult } from "./context.js";
import { readEnvWithDefault } from "../components/env.js";
import { startInProcWatchdog } from "./heartbeat-watchdog.js";
import { createModelHealthTask } from "./heartbeat-model-health.js";

const TAG = "heartbeat";

export async function phaseHeartbeat(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memoryConfig, memory, transport, cronQueue, pipelineDeps, capabilities } = ctx;
  if (!transport || !cronQueue || !pipelineDeps) {
    ctx.phaseHealth.set(phaseHeartbeat.name, { status: "skipped", error: "no transport/cronQueue/pipelineDeps" }); logWarn("boot", `${phaseHeartbeat.name}: skipping — deps not available`); return "skipped";
  }

  const cronCallback = createCronCallback(ctx);

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
      if (readBridgeLockField("sleepStatus") === "hw_sleep") {
        writeSleepStatus("awake");
      }
      writeRestartReason(`resume after ${gapMin}min suspend`);
      logInfo("main", `⏸️ Resume (${gapMin}min, ${resumeKind}) — restarting for clean state`);
      process.exit(0);
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
            userId: loadUsers().byPlatformId.get("telegram:" + r.chatId)?.userId ?? "master",
            senderId: String(r.chatId),
            senderName: "task",
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

  // System message sender — uses spin.inject() (#943)
  const { spin } = await import("../components/spin.js");
  const masterUser = loadUsers().users.find(u => u.role === "master");
  const masterUserId = masterUser?.userId ?? "master";
  const sendSystemMessage = async (prompt: string): Promise<void> => {
    try {
      const response = await spin.inject(masterUserId, `[SYSTEM] ${prompt}`, { deliver: true });
      if (response) {
        const { sendNotification } = await import("../components/notification.js");
        sendNotification(ctx, response);
      }
    } catch (err) {
      logWarn("main", `System message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Daily cycle: spawn Dreamy after BED_TIME + quiet ticks
  heartbeat.registerTask(createAgeCheckTask({
    memory,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepAuditDir: ctx.sleepAuditDir,
    sleepHour: SLEEP_HOUR,
    sleepMinute: SLEEP_MINUTE,
    sessions: ctx.sessions,
    isSleepActive: ctx.isSleepActive,
    doctorPath: join(abtarsHome(), "scripts", "doctor.sh"),
    startSleep: () => { ctx.sleepHandle?.spawn(); },
    checkHwSleep: () => { ctx.sleepHandle?.checkHwSleep(); },
    cronBusy: () => cronQueue.currentJob !== null || cronQueue.pending > 0,
  }));

  heartbeat.registerTask(createDbIntegrityTask(memory));

  // #613: skill usage stats flush + trash pruning
  heartbeat.registerTask(createSkillStatsFlushTask());
  heartbeat.registerTask(createSkillTrashPruneTask());

  // #857: kanban board — deliver completed cards + cleanup old ones
  const masterChatId = [...config.telegram.allowedUserIds][0] ?? 0;
  heartbeat.registerTask(createKanbanDeliveryTask({
    sendSystemMessage,
    sendMessage: async (chatId, text) => {
      if (!ctx.telegramAdapter) return;
      await ctx.telegramAdapter.sendMessage(chatId, text);
    },
    sendDocument: async (chatId, filePath, caption) => {
      if (!ctx.telegramAdapter) return;
      await ctx.telegramAdapter.sendDocument(chatId, filePath, caption);
    },
    chatId: () => String(masterChatId),
  }));

  // #900: Nerve-driven instant delivery — fires on card:done without waiting for heartbeat tick
  import("../components/nerve.js").then(({ nerve }) => {
    nerve.on("card:done", async (cardId: number) => {
      try {
        const { kanbanPending, kanbanSetDelivering, kanbanMarkDelivered } = await import("../components/tasks/kanban-board.js");
        const pending = kanbanPending();
        const card = pending.find((c: { id: number }) => c.id === cardId);
        if (!card) return; // already delivered or silent
        if (card.delivery_mode === "silent") { kanbanMarkDelivered(card.id); return; }
        kanbanSetDelivering(card.id);
        if (ctx.telegramAdapter) {
          await ctx.telegramAdapter.sendMessage(String(masterChatId), `✅ "${card.title}" complete.\n${card.result_summary ?? ""}`);
          if (card.result_path) await ctx.telegramAdapter.sendDocument(String(masterChatId), card.result_path, `📄 ${card.title}`);
        }
        kanbanMarkDelivered(card.id);
      } catch (err) { logAndSwallow(TAG, "nerve:card:done delivery", err); }
    });
  }).catch(err => logAndSwallow(TAG, "nerve import", err));

  heartbeat.registerTask(createKanbanCleanupTask());

  // #936: Expire idle user sessions
  heartbeat.registerTask(createUserSessionExpiryTask());

  // #896: Orc reconciliation loop — self-healing via Nerve events
  import("../components/reconciler.js").then(({ startReconciler }) => startReconciler()).catch(err => logAndSwallow(TAG, "reconciler", err));

  // #440: update check (npm registry, notify if newer version)
  heartbeat.registerTask(createUpdateCheckTask((msg) => {
    import("../components/notification.js").then(({ sendNotification }) => sendNotification(ctx, msg)).catch(err => logAndSwallow(TAG, "sendNotification update-check", err));
  }));

  if (transport.healthCheck) {
    heartbeat.registerTask({ name: "transport-health", execute: () => transport.healthCheck!() });
  }

  // In-proc watchdog: wall-clock comparison every 60s
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
  const { registerCommand } = await import("../components/commands/index.js");
  for (const [name, handler] of capabilities.commands) {
    registerCommand(name, handler);
  }
  for (const task of capabilities.heartbeatTasks) {
    heartbeat.registerTask(task);
  }

  // Model health check — runs once on first tick
  // Model health check (#263: extracted to heartbeat-model-health.ts)
  const { task: modelHealthTask, runNow: runModelHealth } = createModelHealthTask(ctx);
  heartbeat.registerTask(modelHealthTask);

  // #318: fire model-health immediately at boot (don't wait for first tick)
  queueMicrotask(() => { runModelHealth().catch(err => logAndSwallow(TAG, "runModelHealth boot", err)); });

  // heartbeat.start
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", `💓 Heartbeat started (${Math.round(hbIntervalMs / 1000)}s interval)`);

  // Expose sendSystemMessage for phase-sleep
  ctx.sendSystemMessage = sendSystemMessage;
  return "ran";
}
