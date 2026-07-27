import { getEnv } from "../components/env-schema.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import { createSelfHealerTask } from "../components/self-healer.js";
import { createUserSessionExpiryTask } from "../components/heartbeat-tasks.js";
import { createHousekeepingTask } from "../components/heartbeat-housekeeping.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "../components/tasks/task-checker.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo } from "../components/logger.js";
import { abtarsHome } from "../paths.js";
import { runModelHealthCheck } from "./heartbeat-model-health.js";
import type { BootCtx } from "./context.js";

const TAG = "heartbeat";

export async function registerTier3Tasks(ctx: BootCtx): Promise<void> {
  const { heartbeat, transport, cronQueue, memoryRuntime, config, pipelineDeps, capabilities } = ctx;
  if (!heartbeat || !transport || !cronQueue || !pipelineDeps) return;

  heartbeat.registerTask({
    name: "tasks",
    execute: async () => {
      const dueTasks = checkCron();
      let ran = false;
      for (const reserved of dueTasks) {
        cronQueue.enqueue(reserved.entry, false, reserved.run);
        ran = true;
      }

      const reminders = readPendingReminders();
      if (reminders.length > 0) {
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
        ran = true;
      }

      return ran
        ? { state: "ran" as const, detail: `${dueTasks.length} cron, ${reminders.length} reminder(s)` }
        : { state: "idle" as const };
    },
  });

  const masterChatId = [...config.telegram.allowedUserIds][0] ?? 0;

  import("../components/nerve.js").then(({ nerve }) => {
    nerve.on("card:done", async (cardId: number) => {
      try {
        const { kanbanPending } = await import("../components/tasks/kanban-board.js");
        const { deliverCard } = await import("../components/tasks/kanban-delivery.js");
        const pending = kanbanPending();
        const card = pending.find((c: { id: number }) => c.id === cardId);
        if (!card) return;
        await deliverCard(card, {
          sendMessage: async (chatId, text) => {
            if (!ctx.telegramAdapter) return;
            await ctx.telegramAdapter.sendMessage(chatId, text);
          },
          sendDocument: async (chatId, filePath, caption) => {
            if (!ctx.telegramAdapter) return;
            await ctx.telegramAdapter.sendDocument(chatId, filePath, caption);
          },
          announce: async (prompt) => {
            if (ctx.sendSystemMessage) await ctx.sendSystemMessage(prompt);
          },
          chatIdFor: (card) => card.chat_id || String(masterChatId),
        });
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

  heartbeat.registerTask(createUserSessionExpiryTask());

  import("../components/reconciler.js").then(({ startReconciler, scanActiveProjects, retryPendingReviewRequests }) => {
    startReconciler();
    heartbeat.registerTask({
      name: "reconciler-resync",
      execute: async () => {
        scanActiveProjects();
        const { ProjectReviewStore } = await import("../components/project-acceptance/project-review-store.js");
        const expired = new ProjectReviewStore().abandonExpiredRequests();
        return { state: expired > 0 ? "ran" : "idle" as const };
      },
    });
    heartbeat.registerTask({
      name: "review-request-retry",
      execute: async () => {
        const count = retryPendingReviewRequests();
        return { state: count > 0 ? "ran" : "idle" as const };
      },
    });
    heartbeat.registerTask({
      name: "project-acceptance-outbox",
      execute: async () => {
        const { drainAcceptanceOutbox } = await import("../components/project-acceptance/project-review-service.js");
        const count = await drainAcceptanceOutbox();
        return { state: count > 0 ? "ran" : "idle" as const };
      },
    });
  }).catch(err => logAndSwallow(TAG, "reconciler", err));

  // #1358: Drain unacknowledged remote Pi events for all connected peers
  // on each heartbeat tick. This is the reconciliation mechanism: events
  // that were produced but couldn't be pushed (origin offline, transient
  // WS failure) are retried here. No independent timer — reuses heartbeat.
  // The delivery manager is resolved lazily inside execute() so this task
  // survives boot-order races where phasePiExecutor hasn't run yet.
  heartbeat.registerTask({
    name: "remote-pi-drain",
    execute: async () => {
      try {
        const { getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
        const delivery = getRemotePiDelivery();
        if (!delivery || typeof delivery.drainPeer !== "function") return { state: "idle" };
        const { getRemotePiProducer } = await import("../components/peer-transport/remote-pi-registry.js");
        await getRemotePiProducer()?.recoverMissingEvents();
        const { getPeerWsBroker } = await import("../components/peer-transport/peer-ws-broker.js");
        const broker = getPeerWsBroker();
        const connectedPeers = broker.getConnectedPeers();
        for (const peer of connectedPeers) {
          try {
            await delivery.drainPeer(peer);
          } catch { /* isolated — one peer failure does not block others */ }
        }
        return { state: "ran" as const };
      } catch {
        return { state: "idle" };
      }
    },
  });

  import("../components/spin.js").then(({ spin }) => {
    heartbeat.registerTask({
      name: "spin-tick",
      execute: async () => {
        await spin.tick();
        return { state: "ran" as const };
      },
    });
  }).catch(err => logAndSwallow(TAG, "spin-tick", err));

  if (transport.healthCheck) {
    heartbeat.registerTask({
      name: "transport-health",
      execute: async () => {
        await transport.healthCheck!();
        return { state: "ran" as const };
      },
    });
  }

  let selfHealerTask: ReturnType<typeof createSelfHealerTask> | null = null;
  if (getEnv().selfhealEnabled) {
    selfHealerTask = createSelfHealerTask(() => ctx.telegramAdapter, config.telegram.allowedUserIds);
    heartbeat.registerTask(selfHealerTask);
  }
  ctx.selfHealerTask = selfHealerTask;
  pipelineDeps.selfHealerTask = selfHealerTask;

  const { registerCommand } = await import("../components/commands/index.js");
  for (const [name, handler] of capabilities.commands) {
    registerCommand(name, handler);
  }
  for (const task of capabilities.heartbeatTasks) {
    heartbeat.registerTask(task);
  }

  try {
    const { initMetrics } = await import("../components/metrics-collector.js");
    initMetrics(abtarsHome());
  } catch (err) {
    logAndSwallow(TAG, "initMetrics", err, "warn");
  }

  const hbIntervalMs = heartbeat.intervalMs;
  heartbeat.registerTask(createHousekeepingTask({
    heartbeatIntervalMs: hbIntervalMs,
    memoryRuntime,
    cronQueueDepth: () => cronQueue.pending,
    notifyUpdate: (msg) => {
      import("../components/notification.js").then(({ sendNotification }) =>
        sendNotification(ctx, msg),
      ).catch(err => logAndSwallow(TAG, "sendNotification update-check", err));
    },
  }));

  queueMicrotask(() => {
    runModelHealthCheck(ctx).catch(err => logAndSwallow(TAG, "runModelHealth boot", err));
  });
}
