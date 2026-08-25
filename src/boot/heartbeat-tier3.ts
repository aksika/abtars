import { getEnv } from "../components/env-schema.js";
import { logAndSwallow } from "../components/log-and-swallow.js";
import { createSelfHealerTask } from "../components/self-healer.js";
import { shaAdmissionNotice } from "../components/sha/sha-admission-notice.js";
import { createUserSessionExpiryTask } from "../components/heartbeat-tasks.js";
import { createHousekeepingTask } from "../components/heartbeat-housekeeping.js";
import { logInfo, logWarn } from "../components/logger.js";
import { abtarsHome } from "../paths.js";
import { runModelHealthCheck } from "./heartbeat-model-health.js";
import type { BootCtx } from "./context.js";

const TAG = "heartbeat";

export interface TaskTickResult {
  state: "ran" | "idle";
  detail?: string;
}

/**
 * #1358 review — Round-robin peer selection for `remote-pi-drain`.
 *
 * Pure helper so the budget contract is unit-testable: at most `maxPeers`
 * peers per tick, starting from the persisted cursor and wrapping around the
 * connected set, so no peer starves behind a noisy one. Returns the peers to
 * touch and the next cursor value (persisted for the following tick).
 */
export function selectDrainPeers(
  connectedPeers: readonly string[],
  cursor: number,
  maxPeers: number,
): { peers: string[]; nextCursor: number } {
  if (connectedPeers.length === 0) return { peers: [], nextCursor: cursor };
  const startIdx = cursor % connectedPeers.length;
  const peers: string[] = [];
  for (let i = 0; i < Math.min(connectedPeers.length, maxPeers); i++) {
    const peer = connectedPeers[(startIdx + i) % connectedPeers.length];
    if (peer) peers.push(peer);
  }
  return { peers, nextCursor: startIdx + peers.length };
}

/**
 * #1520: the tier-3 scheduled-task tick body, exposed as an injected callable
 * used by both production (heartbeat) and the production-shaped E2E harness.
 * Due discovery/reservation, queue execution, settlement, and delivery are
 * all real; only external boundaries are doubled in the harness.
 *
 * #1539: admission only. Active-run ownership, deadline policy, and recovery
 * live in the ScheduledRunCoordinator and the lifecycle wake scheduler; the
 * heartbeat tick never reconciles stale runs.
 */
export async function runTaskTick(ctx: Pick<BootCtx, "cronQueue" | "telegramAdapter">): Promise<TaskTickResult> {
  const { checkCron, readPendingReminders, clearPendingReminders } = await import("../components/tasks/task-checker.js");
  const { loadUsers } = await import("../components/user-registry.js");
  if (!ctx.cronQueue) return { state: "idle" };
  const dueTasks = checkCron();
  let ran = false;
  for (const reserved of dueTasks) {
    ctx.cronQueue.enqueue(reserved.entry, false, reserved.run);
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
}

export async function registerTier3Tasks(ctx: BootCtx): Promise<void> {
  const { heartbeat, transport, cronQueue, memoryRuntime, config, pipelineDeps, capabilities } = ctx;
  if (!heartbeat || !transport || !cronQueue || !pipelineDeps) return;

  heartbeat.registerTask({
    name: "tasks",
    execute: () => runTaskTick(ctx),
  });

  // #1539: R3 bounded safety scan — a no-op whenever the lifecycle wake
  // scheduler is healthy. No acceptance criterion may depend on it.
  // #1554: reads the scheduler from BootCtx (bridge-generation owned), not a
  // Reconciler getter.
  heartbeat.registerTask({
    name: "lifecycle-due-safety-scan",
    execute: async () => {
      try {
        ctx.lifecycleWakeScheduler?.safetyScan();
        return { state: "idle" as const };
      } catch (err) { logAndSwallow(TAG, "lifecycle-due-safety-scan", err); return { state: "idle" as const }; }
    },
  });

  const masterChatId = [...config.telegram.allowedUserIds][0] ?? 0;

  // #1724: compose the trusted scheduled-announcement ingress once. Adapters
  // and pipeline deps resolve lazily at delivery time — later boot phases
  // populate both after this registration.
  const { MainConversationIngress } = await import("../components/main-conversation-ingress.js");
  ctx.mainIngress = new MainConversationIngress({
    getPipelineDeps: () => ctx.pipelineDeps,
    getAdapter: (platform) => ctx.platformAdapters.get(platform) ?? null,
  });

  const { loadUsers } = await import("../components/user-registry.js");

  // #1724: resolve the announcement target identity from the durable card
  // chat id at delivery time. Platform-neutral at this boundary: the user
  // registry owns the platform↔chat mapping; no platform is named here.
  const resolveAnnouncementTarget = (chatId: string): { userId: string; platform: string; chatId: string } | null => {
    const registry = loadUsers();
    for (const user of registry.users) {
      for (const [platform, id] of Object.entries(user.platforms)) {
        if (String(id) === chatId) return { userId: user.userId, platform, chatId };
      }
    }
    return null;
  };

  const deliveryDeps = () => ({
    sendMessage: async (chatId: string, text: string): Promise<import("../components/tasks/kanban-delivery.js").SendOutcome> => {
      if (!ctx.telegramAdapter) return "not_sent";
      try {
        await ctx.telegramAdapter.sendMessage(chatId, text);
        return "sent";
      } catch (err) {
        logAndSwallow(TAG, "delivery sendMessage", err);
        return "unknown";
      }
    },
    sendDocument: async (chatId: string, filePath: string, caption: string): Promise<import("../components/tasks/kanban-delivery.js").SendOutcome> => {
      if (!ctx.telegramAdapter) return "not_sent";
      try {
        await ctx.telegramAdapter.sendDocument(chatId, filePath, caption);
        return "sent";
      } catch (err) {
        logAndSwallow(TAG, "delivery sendDocument", err);
        return "unknown";
      }
    },
    announce: async (prompt: string) => {
      if (ctx.sendSystemMessage) await ctx.sendSystemMessage(prompt);
    },
    chatIdFor: (card: import("../components/tasks/kanban-board.js").KanbanCard) => card.chat_id || String(masterChatId),
    // #1724: Main-owned announcement route for scheduled one-shot T announce
    // cards. Resolves identity now (never from the display title), derives
    // the stable card-derived event ID, and waits for Main's definite
    // delivery outcome before the card state advances.
    announceToMain: async (card: import("../components/tasks/kanban-board.js").KanbanCard): Promise<import("../types/platform.js").MainDeliveryResult> => {
      const ingress = ctx.mainIngress;
      if (!ingress) {
        logWarn(TAG, `Card ${card.id}: no Main ingress composed — announcement not sent`);
        return "not_sent";
      }
      const chatId = card.chat_id || String(masterChatId);
      const target = resolveAnnouncementTarget(chatId);
      if (!target) {
        logWarn(TAG, `Card ${card.id}: no registered user for chat ${chatId} — announcement not sent`);
        return "not_sent";
      }
      return ingress.announceToMain({
        eventId: `scheduled-card:${card.id}`,
        cardId: card.id,
        title: card.title,
        userId: target.userId,
        platform: target.platform,
        chatId: target.chatId,
        result: card.result_summary ?? "",
      });
    },
  });

  // #1520: the delivery poll — a periodic bounded claim over done cards.
  // Delivery is strictly downstream of settlement; failures never rerun work.
  heartbeat.registerTask({
    name: "kanban-delivery-poll",
    execute: async () => {
      try {
        const { pollPendingDeliveries } = await import("../components/tasks/kanban-delivery.js");
        const attempted = await pollPendingDeliveries(deliveryDeps());
        return attempted > 0 ? { state: "ran" as const, detail: `${attempted} delivery polled` } : { state: "idle" as const };
      } catch (err) { logAndSwallow(TAG, "kanban-delivery-poll", err); return { state: "idle" as const }; }
    },
  });

  import("../components/nerve.js").then(({ nerve }) => {
    nerve.on("card:done", async (cardId: number) => {
      try {
        const { kanbanPending } = await import("../components/tasks/kanban-board.js");
        const { deliverCard } = await import("../components/tasks/kanban-delivery.js");
        const pending = kanbanPending();
        const card = pending.find((c: { id: number }) => c.id === cardId);
        if (!card) return;
        await deliverCard(card, deliveryDeps());
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

  // #1554 (approved heartbeat move): project-acceptance-outbox is registered
  // independently of Reconciler startup so a Reconciler failure can never
  // suppress durable outbox delivery. reconciler-resync and review-request-
  // retry register in phase-reconciler only after a successful generation
  // start (Reconciler-owned safety/retry work must not exist without one).
  heartbeat.registerTask({
    name: "project-acceptance-outbox",
    execute: async () => {
      const { drainAcceptanceOutbox } = await import("../components/project-acceptance/project-review-service.js");
      const count = await drainAcceptanceOutbox();
      return { state: count > 0 ? "ran" : "idle" as const };
    },
  });

  // #1358 review — Drain unacknowledged remote Pi events for connected peers
  // on each heartbeat tick, under the declared DRAIN_BUDGET (spec #1358
  // "Heartbeat budget requirements", separately approved):
  //   - absolute 5s per-tick wall-clock budget measured from task entry;
  //   - at most 4 peers touched per tick, round-robin over a persisted peer
  //     cursor so no peer starves behind a noisy one;
  //   - per-peer isolation: a hung peer consumes only its own share (5s
  //     request timeout clamped to the remaining tick budget);
  //   - at most one drain in flight per peer — overlapping ticks are skipped;
  //   - never throws out of execute(); leftover backlog resumes next tick;
  //   - `bridge.lock.lastHeartbeat` is updated by HeartbeatSystem at the top
  //     of every tick, before this task runs, so a hung drain cannot starve
  //     the L3 staleness check.
  // Events are produced atomically with their transitions (mechanism A), so
  // this task only re-drives delivery of already-persisted events — it never
  // fabricates facts from current run state.
  heartbeat.registerTask({
    name: "remote-pi-drain",
    execute: async () => {
      try {
        const { getRemotePiDelivery } = await import("../components/peer-transport/remote-pi-registry.js");
        const delivery = getRemotePiDelivery();
        if (!delivery || typeof delivery.drainPeer !== "function") return { state: "idle" };
        const { DRAIN_BUDGET } = await import("../components/peer-transport/remote-pi-delivery.js");
        const { getPeerWsBroker } = await import("../components/peer-transport/peer-ws-broker.js");
        const broker = getPeerWsBroker();
        const connectedPeers = broker.getConnectedPeers();
        if (connectedPeers.length === 0) return { state: "idle" };

        const deadline = Date.now() + DRAIN_BUDGET.tickWallClockMs;
        // Round-robin over a persisted peer cursor (survives restarts).
        const { peers: selectedPeers, nextCursor } = selectDrainPeers(
          connectedPeers,
          delivery.getDrainCursor(),
          DRAIN_BUDGET.maxPeersPerTick,
        );
        let touched = 0;
        for (const peer of selectedPeers) {
          if (Date.now() >= deadline) break;
          try {
            await delivery.drainPeer(peer, {
              deadlineMs: deadline,
              maxRunsPerPeer: DRAIN_BUDGET.maxRunsPerPeerPerTick,
              maxEventsPerRun: DRAIN_BUDGET.maxEventsPerRunPerTick,
              requestTimeoutMs: DRAIN_BUDGET.requestTimeoutMs,
            });
          } catch { /* isolated — one peer failure does not block others */ }
          touched++;
        }
        delivery.setDrainCursor(nextCursor);
        return touched > 0
          ? { state: "ran" as const, detail: `${touched}/${connectedPeers.length} peer(s) drained` }
          : { state: "idle" as const };
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
  // #1688 (approved predicate change, 2026-08-21): register the log scanner
  // only when mode is not off. No other heartbeat behavior changed. The task
  // emits typed LogFailureEvents into the SHA coordinator; it owns no agent
  // state, clone, or dispatch.
  if (getEnv().selfhealMode !== "off") {
    selfHealerTask = createSelfHealerTask((event) => {
      if (!ctx.shaCoordinator) return;
      const outcome = ctx.shaCoordinator.admit(event);
      const notice = shaAdmissionNotice(event, outcome);
      if (notice && ctx.telegramAdapter) {
        ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), notice);
      }
    });
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
