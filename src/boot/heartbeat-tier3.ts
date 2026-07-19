/**
 * heartbeat-tier3.ts — Register Tier 3 heartbeat tasks.
 *
 * Called from phasePipelineDeps after transport+platforms+cronQueue are ready.
 * These tasks need transport, memory, cronQueue, or platform adapters.
 */

import { getEnv } from "../components/env-schema.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import { createSelfHealerTask } from "../components/self-healer.js";
import {
  createIdleCompactTask, createDbIntegrityTask,
  createKanbanCleanupTask, createUserSessionExpiryTask, createMetricsTask,
} from "../components/heartbeat-tasks.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "../components/tasks/task-checker.js";
import { loadUsers } from "../components/user-registry.js";
import { logInfo, logWarn } from "../components/logger.js";
import { abtarsHome } from "../paths.js";
import { createCronCallback } from "./phase-pipeline-deps.js";
import { createModelHealthTask } from "./heartbeat-model-health.js";
import type { BootCtx } from "./context.js";

const TAG = "heartbeat";
let _lastCapabilityHash = "";
let _lastInventoryBroadcast = 0;

export async function registerTier3Tasks(ctx: BootCtx): Promise<void> {
  const { heartbeat, transport, cronQueue, memoryRuntime, memoryConfig, config, pipelineDeps, capabilities } = ctx;
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

  // #1353: the in-cycle stuck-run guard was removed. abmind's runSleepCycle
  // now owns its own wall-clock timeout internally (combined into the
  // request signal) and its returned promise always settles — the host's
  // `running` flag can no longer desync from an actually-stuck cycle without
  // the host reading abmind's private lock-file format, which the contract
  // forbids. See src/capabilities/sleep/index.ts.

  if (getEnv().ctxIdleCompactMin > 0) {
  heartbeat.registerTask(createIdleCompactTask({
      transport, memoryDir: memoryConfig.memoryDir,
      memoryRuntime,
      allowedUserIds: config.telegram.allowedUserIds,
      isSleepActive: ctx.isSleepActive,
    }));
  }

  heartbeat.registerTask(createDbIntegrityTask(memoryRuntime));

  const masterChatId = [...config.telegram.allowedUserIds][0] ?? 0;

  // Nerve-driven instant delivery — sole delivery trigger (#1298: polling backstop removed)
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

  heartbeat.registerTask(createKanbanCleanupTask());

  import("../components/metrics-collector.js").then(({ initMetrics }) => {
    initMetrics(abtarsHome());
  }).catch(() => {});
  heartbeat.registerTask(createMetricsTask(() => cronQueue.pending));

  heartbeat.registerTask(createUserSessionExpiryTask());

  // Reconciler — boot scan + periodic resync (#1414)
  import("../components/reconciler.js").then(({ startReconciler, scanActiveProjects }) => {
    startReconciler();
    heartbeat.registerTask({
      name: "reconciler-resync",
      execute: async () => { scanActiveProjects(); },
    });
  }).catch(err => logAndSwallow(TAG, "reconciler", err));

  // Spin tick
  import("../components/spin.js").then(({ spin }) => {
    heartbeat.registerTask({ name: "spin-tick", execute: () => spin.tick() });
  }).catch(err => logAndSwallow(TAG, "spin-tick", err));

  // Busy-unstick
  {
    const { spin: spinRef } = require("../components/spin.js") as typeof import("../components/spin.js");
    heartbeat.registerTask({ name: "busy-unstick", execute: async () => {
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

  // #1434: Inventory anti-entropy — broadcast when capability hash changes
  import("../components/peer-transport/index.js").then(async ({ getPeerTransport }) => {
    const transport = getPeerTransport() as import("../components/peer-transport/http-transport.js").HttpTransport;
    heartbeat.registerTask({ name: "peer-inventory", execute: async () => {
      if (typeof transport.broadcastInventory !== "function") return;
      try {
        const { getInventoryCapabilityHash } = await import("../components/peer-transport/peer-inventory.js");
        const { loadPeerConfig } = await import("../components/peer-config.js");
        const { getLocalCapabilities } = await import("../components/peer-transport/peer-health.js");
        const cfg = loadPeerConfig();
        const caps = getLocalCapabilities();
        const hash = getInventoryCapabilityHash(cfg.self.signingKey, cfg.self.name, process.env["npm_package_version"] ?? "0.0.0", caps, ["wss", "https"]);
        const now = Date.now();
        const INVENTORY_ANTIENTROPY_MS = 4 * 60 * 60 * 1000;
        if (hash !== _lastCapabilityHash || (now - _lastInventoryBroadcast) > INVENTORY_ANTIENTROPY_MS) {
          _lastCapabilityHash = hash;
          _lastInventoryBroadcast = now;
          transport.broadcastInventory();
        }
      } catch { /* best effort */ }
    } });
  }).catch(err => logAndSwallow(TAG, "peer-inventory", err));

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
