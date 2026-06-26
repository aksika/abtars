/**
 * heartbeat-tier3.ts — Register Tier 3 heartbeat tasks.
 *
 * Called from phasePipelineDeps after transport+platforms+cronQueue are ready.
 * These tasks need transport, memory, cronQueue, or platform adapters.
 */

import { getEnv } from "../components/env-schema.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import { join } from "node:path";
import { createSelfHealerTask } from "../components/self-healer.js";
import {
  createIdleCompactTask, createAgeCheckTask, createDbIntegrityTask,
  createKanbanDeliveryTask, createKanbanCleanupTask, createUserSessionExpiryTask, createMetricsTask,
} from "../components/heartbeat-tasks.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "../components/tasks/task-checker.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn } from "../components/logger.js";
import { abtarsHome, abtarsRoot } from "../paths.js";
import { createCronCallback } from "./phase-pipeline-deps.js";
import { createModelHealthTask } from "./heartbeat-model-health.js";
import { readEnvWithDefault } from "../components/env.js";
import type { BootCtx } from "./context.js";

const TAG = "heartbeat";

export async function registerTier3Tasks(ctx: BootCtx): Promise<void> {
  const { heartbeat, transport, cronQueue, memory, memoryConfig, config, pipelineDeps, capabilities } = ctx;
  if (!heartbeat || !transport || !cronQueue || !pipelineDeps) return;

  const cronCallback = createCronCallback(ctx);

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
        logInfo("main", `Injecting reminder for chat ${r.chatId}: "${r.message}"`);
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

  if (getEnv().ctxIdleCompactMin > 0) {
    heartbeat.registerTask(createIdleCompactTask({
      transport, memory, memoryDir: memoryConfig.memoryDir,
      allowedUserIds: config.telegram.allowedUserIds,
      isSleepActive: ctx.isSleepActive,
    }));
  }

  heartbeat.registerTask(createAgeCheckTask({
    memory,
    bridgeLockPath: ctx.bridgeLockPath,
    sleepAuditDir: ctx.sleepAuditDir,
    sleepHour: SLEEP_HOUR,
    sleepMinute: SLEEP_MINUTE,
    isSleepActive: ctx.isSleepActive,
    doctorPath: join(abtarsRoot(), "scripts", "doctor.sh"),
    startSleep: () => { ctx.sleepHandle?.spawn(); },
    checkHwSleep: () => { ctx.sleepHandle?.checkHwSleep(); },
    checkStaleSleep: () => { ctx.sleepHandle?.checkStale(); },
    cronBusy: () => cronQueue.currentJob !== null || cronQueue.pending > 0,
  }));

  heartbeat.registerTask(createDbIntegrityTask(memory));

  const masterChatId = [...config.telegram.allowedUserIds][0] ?? 0;
  heartbeat.registerTask(createKanbanDeliveryTask({
    sendSystemMessage: ctx.sendSystemMessage!,
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

  // Nerve-driven instant delivery
  import("../components/nerve.js").then(({ nerve }) => {
    nerve.on("card:done", async (cardId: number) => {
      try {
        const { kanbanPending, kanbanSetDelivering, kanbanMarkDelivered } = await import("../components/tasks/kanban-board.js");
        const pending = kanbanPending();
        const card = pending.find((c: { id: number }) => c.id === cardId);
        if (!card) return;

        kanbanSetDelivering(card.id);
        const targetChat = card.chat_id || String(masterChatId);

        if (card.delivery_mode === "silent") {
          kanbanMarkDelivered(card.id);
          return;
        }

        if (card.delivery_mode === "deliver") {
          if (ctx.telegramAdapter) {
            if (card.result_path) await ctx.telegramAdapter.sendDocument(targetChat, card.result_path, card.title);
          }
          if (ctx.sendSystemMessage) {
            await ctx.sendSystemMessage(`[SYSTEM] Task "${card.title}" complete. File delivered: ${card.result_path ?? "(no file)"}`);
          }
          kanbanMarkDelivered(card.id);
          return;
        }

        // "announce" — inject into agent for natural delivery
        if (ctx.sendSystemMessage) {
          await ctx.sendSystemMessage(
            `[TASK COMPLETE] "${card.title}" done.\nResult:\n${card.result_summary ?? "(no output)"}\n\nDeliver this to the user naturally.`
          );
        }
        kanbanMarkDelivered(card.id);
      } catch (err) { logAndSwallow(TAG, "nerve:card:done delivery", err); }
    });

    nerve.on("channel:message", async (_cardId: number, meta?: Record<string, unknown>) => {
      if (!meta || (meta.to as string)?.toUpperCase() !== "MASTER") return;
      if (!ctx.telegramAdapter) return;
      try {
        const from = meta.from as string ?? "agent";
        await ctx.telegramAdapter.sendMessage(String(masterChatId), `[${from}->MASTER] card:${_cardId}\n${String(meta.message ?? "").slice(0, 200)}`);
      } catch (err) { logAndSwallow(TAG, "nerve:channel:message TG notify", err); }
    });
  }).catch(err => logAndSwallow(TAG, "nerve import", err));

  heartbeat.registerTask(createKanbanCleanupTask());

  import("../components/metrics-collector.js").then(({ initMetrics }) => {
    initMetrics(abtarsHome());
  }).catch(() => {});
  heartbeat.registerTask(createMetricsTask(() => cronQueue.pending));

  heartbeat.registerTask(createUserSessionExpiryTask());

  // Reconciler
  import("../components/reconciler.js").then(({ startReconciler }) => {
    startReconciler();
  }).catch(err => logAndSwallow(TAG, "reconciler", err));

  // Spin tick
  import("../components/spin.js").then(({ spin }) => {
    heartbeat.registerTask({ name: "spin-tick", execute: () => spin.tick() });
  }).catch(err => logAndSwallow(TAG, "spin-tick", err));

  // Busy-unstick
  {
    const { spin: spinRef } = require("../components/spin.js") as typeof import("../components/spin.js");
    heartbeat.registerTask({ name: "busy-unstick", execute: () => {
      const now = Date.now();
      for (const s of spinRef.listAllSessions()) {
        if (s.busy && s.lastActiveAt && now - s.lastActiveAt > 60_000) {
          if (transport && "sendInterrupt" in transport) {
            (transport as { sendInterrupt: (r?: string) => Promise<void> }).sendInterrupt("timeout").catch(() => {});
          }
          s.busy = false;
          logWarn(TAG, `Force-cleared stuck busy on ${s.id} (>60s) — interrupted`);
        }
      }
    }});
  }

  // Gossip
  import("../components/peer-transport/gossip.js").then(({ gossipBroadcast, setGossipInterval }) => {
    setGossipInterval(heartbeat.intervalMs);
    heartbeat.registerTask({ name: "gossip-health", execute: async () => { gossipBroadcast(); } });
  }).catch(err => logAndSwallow(TAG, "gossip", err));

  if (transport.healthCheck) {
    heartbeat.registerTask({ name: "transport-health", execute: () => transport.healthCheck!() });
  }

  // Self-healer
  let selfHealerTask: ReturnType<typeof createSelfHealerTask> | null = null;
  if (getEnv().selfhealEnabled) {
    selfHealerTask = createSelfHealerTask(() => ctx.telegramAdapter, config.telegram.allowedUserIds);
    heartbeat.registerTask(selfHealerTask);
  }
  ctx.selfHealerTask = selfHealerTask;
  pipelineDeps.selfHealerTask = selfHealerTask;

  // Capability tasks + commands
  const { registerCommand } = await import("../components/commands/index.js");
  for (const [name, handler] of capabilities.commands) {
    registerCommand(name, handler);
  }
  for (const task of capabilities.heartbeatTasks) {
    heartbeat.registerTask(task);
  }

  // Model health
  const { task: modelHealthTask, runNow: runModelHealth } = createModelHealthTask(ctx);
  heartbeat.registerTask(modelHealthTask);
  queueMicrotask(() => { runModelHealth().catch(err => logAndSwallow(TAG, "runModelHealth boot", err)); });
}
