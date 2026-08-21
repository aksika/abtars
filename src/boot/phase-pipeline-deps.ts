/**
 * phase-pipeline-deps — boot phase 5: construct CronQueue + pipelineDeps object.
 *
 * Must run after phase-transport (uses ctx.transport). Runs before
 * phase-platforms (platforms' adapters close over ctx.pipelineDeps).
 *
 * - Constructs CodingMode, IdleSave, CronQueue
 * - Wires setEnqueueCron singleton (tool-registry)
 * - Builds the PipelineDeps object — closes over ctx fields so later phases
 *   can populate sleepHandle, selfHealerTask, loadedCapabilities via ctx
 *   mutation without rewiring
 * - cronCallback closes over ctx so it reads telegramAdapter when fired
 *
 * Owns singleton: tool-registry._enqueueCron (via setEnqueueCron).
 *
 * Populates ctx: cronQueue, idleSave, pipelineDeps.
 */

import { readEntry as cronReadEntry } from "../components/tasks/task-store.js";
import { CronQueue } from "../components/tasks/task-queue.js";
import { IdleSave } from "../components/idle-save.js";
import { logInfo, logWarn } from "../components/logger.js";
import { formatTaskLabel } from "../components/tasks/task-types.js";
import { formatTaskFailureDetail } from "../components/tasks/task-failure.js";
import type { ScheduledFailureEvent } from "../components/sha/sha-types.js";
import type { TaskFailureDiagnosticV1 } from "../components/tasks/task-failure.js";
import { loadTransport, resolveAgent } from "../components/transport-config.js";
import { updateCtxStart } from "./ctx-start.js";
import { clearMemoryToolDependencies, type BootCtx, type PhaseResult } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";

import { getEnv } from "../components/env-schema.js";
import { unavailable } from "../capabilities/sleep/index.js";
import { requestReconcileForProject } from "../components/reconciler.js";

/** #1297: credit exhaustion cannot be self-healed — SHA must stop before any
 *  state read/write. Identified by exact structured fields, never message text. */
export function skipSelfHealForDiagnostic(diagnostic: TaskFailureDiagnosticV1): boolean {
  return diagnostic.category === "execution" && diagnostic.code === "credits_exhausted";
}

/** #1588: operator failure notification — category/code + lane breakdown. */
export function buildFailureNotification(event: ScheduledFailureEvent): string {
  const { entryId, diagnostic } = event;
  // #1297: credit exhaustion is actionable, not self-healable — the operator
  // notification carries the remediation ask.
  const base = `[warn] ${formatTaskLabel(entryId)} failed - ${diagnostic.category}/${diagnostic.code}\n${formatTaskFailureDetail(diagnostic)}`;
  if (skipSelfHealForDiagnostic(diagnostic)) {
    return `${base}\nRequires human intervention: restore provider credits, then run /models reset.`;
  }
  return base;
}

export async function phasePipelineDeps(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memoryConfig, transport } = ctx;
  if (!transport) { ctx.phaseHealth.set(phasePipelineDeps.name, { status: "skipped", error: "no transport" }); logWarn("boot", `${phasePipelineDeps.name}: skipping — transport not available`); return "skipped"; }

  // #1527: a memory-enabled Pi route without the negotiated durable-context
  // capability is context-blind by construction. Refuse to serve rather than
  // let durable requests degrade to suffix-only answers. Throwing is required:
  // bootGraph marks any non-throwing phase "ok" and replaces phaseHealth with
  // its report, so a "skipped" return would let downstream nodes boot against
  // a null pipelineDeps and hide the refusal from the degraded-boot report.
  if (ctx.memoryRuntime.state === "ready" && !ctx.memoryRuntime.supports("durableContext")) {
    const route = typeof transport.getRuntimeStatus === "function" ? transport.getRuntimeStatus().route : undefined;
    if (route === "pi-ai") {
      const { logError } = await import("../components/logger.js");
      logError("boot", "memory-enabled Pi route negotiated no durable-context capability — refusing to boot context-blind");
      try { await transport.destroy(); } catch (err) { logWarn("boot", `transport destroy during refusal failed: ${err instanceof Error ? err.message : String(err)}`); }
      ctx.transport = null;
      throw new Error("memory-enabled Pi route without durable context capability");
    }
  }

  ctx.idleSave = new IdleSave(transport, memoryConfig.memoryDir, memoryConfig.memoryEnabled);

  // #1539: construct the lifecycle wake scheduler and the scheduled-run
  // coordinator before the queue. The coordinator owns execution, deadlines,
  // cancellation, and recovery; the queue only orders admission.
  const { LifecycleWakeScheduler } = await import("../components/lifecycle-wake-scheduler.js");
  const wakeScheduler = new LifecycleWakeScheduler();
  const { ScheduledRunCoordinator, wireCardProgressProjection } = await import("../components/tasks/scheduled-run-coordinator.js");

  // #1688: the SHA coordinator owns admission, classification, and the
  // durable incident lifecycle. This phase wires it and the operator notice
  // sink; it no longer owns SHA state or dispatches S sessions.
  const { ShaIncidentCoordinator } = await import("../components/sha/sha-incident-coordinator.js");
  const { shaAdmissionNotice } = await import("../components/sha/sha-admission-notice.js");
  const shaCoordinator = new ShaIncidentCoordinator({
    modeProvider: () => getEnv().selfhealMode,
    noticeSink: {
      send: (notice) => {
        if (ctx.telegramAdapter) {
          ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), `[warn] ${notice.message}`);
        }
      },
    },
  });
  ctx.shaCoordinator = shaCoordinator;
  ctx._shaStageSubscriberDisposer = shaCoordinator.subscribe();

  // #1588/#1688: the exactly-once failure cascade. Fires once per settled
  // failed/timed_out run, delivering the structured diagnostic to the
  // operator; SHA admission runs through the coordinator and emits exactly
  // one bounded outcome line after the durable decision.
  const onFailure = (event: ScheduledFailureEvent): void => {
    if (ctx.telegramAdapter) {
      ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), buildFailureNotification(event));
    }
    const outcome = shaCoordinator.admit(event);
    const notice = shaAdmissionNotice(event, outcome);
    if (notice && ctx.telegramAdapter) {
      ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), notice);
    }
  };
  const onTaskPaused = (chatId: number, _title: string, _reason: string, notice: import("../components/tasks/task-run-settler.js").PauseNotice): void => {
    if (!ctx.telegramAdapter) return;
    // #1609: the pause notice carries the exact operator facts — task id,
    // diagnostic category/code, failure count, pause time, 12-hour recovery
    // window, and the resume command.
    const at = new Date(notice.pausedAt).toISOString();
    const recoverAt = new Date(notice.pausedAt + notice.resumeAfterMs).toISOString();
    const msg = `[warn] Task "${notice.taskId}" auto-paused.\n` +
      `Cause: ${notice.category}/${notice.code}\n` +
      `Failures: ${notice.failures}\n` +
      `Paused at: ${at}\n` +
      `Auto-resume eligible: ${recoverAt}\n` +
      `Resume now: ${notice.resumeCommand}`;
    ctx.telegramAdapter.sendNotification(String(chatId), msg);
  };

  // #1609: automatic-resume and cap-escalation notifications ride the
  // existing coordinator composition — one notifier, wired once in boot. The
  // state transition commits before the hook runs; delivery failure is
  // fire-and-forget and never undoes the committed transition.
  const { setPausedRecoveryHook } = await import("../components/tasks/task-checker.js");
  setPausedRecoveryHook((event) => {
    if (!ctx.telegramAdapter) return;
    const entry = cronReadEntry(event.entryId);
    const chatId = entry?.chatId ?? String(getEnv().mainChatId);
    if (event.kind === "resumed") {
      const at = event.nextRunAt ? new Date(event.nextRunAt).toISOString() : "next scheduled occurrence";
      ctx.telegramAdapter.sendNotification(chatId, `[info] Task "${event.entryId}" auto-resumed after cooldown — next run: ${at}`);
    } else {
      ctx.telegramAdapter.sendNotification(chatId, `[warn] Task "${event.entryId}" remains paused — automatic resume cap reached. Manual action: /task resume ${event.entryId}`);
    }
  });

  // #1540: the coordinator shares the facade's single execution supervisor —
  // never a second live registry — so scheduled agent runs and the worker
  // adapter resolve the same handles.
  const { spin } = await import("../components/spin.js");
  const coordinator = new ScheduledRunCoordinator({ onFailure, onTaskPaused, executions: spin.executionSupervisor });

  const cronQueue = new CronQueue(coordinator);
  ctx.cronQueue = cronQueue;
  ctx.scheduledRunCoordinator = coordinator;

  // #1554: the wake scheduler and the scheduled-run projection ports are
  // bridge-generation owned and stored on BootCtx. The Reconciler composes
  // them in phase-reconciler — no setter wiring here.
  ctx.lifecycleWakeScheduler = wakeScheduler;
  ctx.reconcilerInputs = {
    projectRunProgress: (cardId: number) => coordinator.projectCardProgress(cardId),
    failureCascade: coordinator.failureCallback,
  };

  const { createRunDeadlineSource, createTaskAdmissionSource, createKanbanRetrySource } = await import("../components/tasks/due-sources.js");
  wakeScheduler.register(createKanbanRetrySource((cardId: number) => {
    requestReconcileForProject(cardId);
  }, () => {
    const { spin } = require("../components/spin.js") as typeof import("../components/spin.js");
    spin.drainQueuedCards();
  }));
  wakeScheduler.register(createTaskAdmissionSource(async () => {
    const { runTaskTick } = await import("./heartbeat-tier3.js");
    await runTaskTick(ctx);
  }));
  wakeScheduler.register(createRunDeadlineSource(coordinator));

  const { setTaskDueChangedHook } = await import("../components/tasks/task-state-store.js");
  // #1539: any durable task-state mutation can change admission due times AND
  // active-run deadline arming — both sources re-scan and re-arm.
  setTaskDueChangedHook(() => {
    wakeScheduler.sourceChanged("task-admission");
    wakeScheduler.sourceChanged("run-deadline");
  });
  const { setKanbanDueChangedHook } = await import("../components/tasks/kanban-board.js");
  setKanbanDueChangedHook(() => wakeScheduler.sourceChanged("kanban-retry"));
  wireCardProgressProjection(coordinator);

  // Wire task_manage --run to the cron queue (singleton: _enqueueCron)
  const { setEnqueueCron } = await import("../components/transport/tool-registry.js");
  const enqueueCron = (id: string, manual?: boolean): string | null => {
    try {
      const entry = cronReadEntry(id);
      if (!entry) return `❌ Entry ${id} not found`;
      return cronQueue.enqueue(entry, manual);
    } catch (err) {
      return `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  setEnqueueCron(enqueueCron);

  // Wire secret_get tool to memory DB

  // #894: Wire Spin (which IS the session manager now) to runtime
  spin.setRuntime(ctx.runtime);

  // #1319: Create Orc activity feed and wire Spin producer + Nerve bridge
  const { OrcActivityFeed } = await import("../components/orc-activity-feed.js");
  const feed = new OrcActivityFeed();
  spin.setOrcActivityFeed(feed);
  ctx.orcActivityFeed = feed;

  // #1338: Create the live attached-session output feed and wire Spin producer.
  const { SessionOutputFeed } = await import("../components/session-output-feed.js");
  const outputFeed = new SessionOutputFeed();
  spin.setSessionOutputFeed(outputFeed);
  ctx.sessionOutputFeed = outputFeed;
  const { bridgeNerveToFeed } = await import("../components/orc-activity-bridge.js");
  ctx._orcActivityBridgeCleanup = bridgeNerveToFeed(feed, () =>
    spin.listAllSessions().filter(s => s.id.includes("_O_") && s.status !== "ended"),
  );

  // #936: Register master session in Spin
  const { loadUsers } = await import("../components/user-registry.js");
  const registry = loadUsers();
  const masterUser = registry.users.find(u => u.role === "master");
  if (masterUser && transport) {
    const masterChatId = masterUser.platforms.telegram ?? masterUser.platforms.discord;
    if (masterChatId) {
      // #1515: preload at most one pending dream question BEFORE
      // registerMasterSession() — either registration or the later
      // setGreetingAdapter() may fire the automatic greeting, so the question
      // must be installed first. Absent support, unavailable memory, or any
      // failure produces an ordinary greeting and leaves the row pending.
      if (ctx.memoryRuntime.state === "ready" && ctx.memoryRuntime.supports("dreamQuestionsNextPending")) {
        try {
          const pending = await ctx.memoryRuntime.dreamQuestions.nextPending(masterUser.userId);
          if (pending) {
            spin.setBootGreetingQuestion({ id: pending.id, text: pending.question });
            logInfo("boot", `Dream question preloaded for automatic boot greeting (${pending.id})`);
          }
        } catch (err) {
          logWarn("boot", `Dream question preload skipped: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      spin.registerMasterSession({
        userId: masterUser.userId,
        chatId: typeof masterChatId === "number" ? masterChatId : parseInt(String(masterChatId), 10),
        platform: masterUser.platforms.telegram ? "telegram" : "discord",
        transport,
      });
    }
  }

  // #998: Set system prompt AFTER memory state is known
  if (transport && "setSystemPrompt" in transport && typeof (transport as any).setSystemPrompt === "function") {
    const { buildSoulBundle } = await import("../components/soul-bundle.js");
    const masterUserId = registry.users.find(u => u.role === "master")?.userId ?? "master";
    const sessionContext = ctx.memoryRuntime.state === "ready"
      ? await ctx.memoryRuntime.assembleSessionContext({ identity: { principalId: masterUserId, executionId: "boot" }, maxChars: 4096 }).catch(() => null)
      : null;
    const bundle = buildSoulBundle("A", sessionContext?.soulBundle);
    if (bundle) (transport as { setSystemPrompt: (p: string) => void }).setSystemPrompt(bundle);
  }

  // #1527: compose the durable context provider once memory state is known.
  // Transport and memory boot in parallel, so the holder (captured by every
  // Pi transport at construction) is populated here, after both resolved.
  const { createDurableContextProvider } = await import("../components/transport/pi-core-context.js");
  if (ctx.memoryRuntime.state === "ready" && ctx.memoryRuntime.supports("durableContext")) {
    ctx.durableContextProvider.current = createDurableContextProvider(ctx.memoryRuntime);
    spin.setContextProvider(ctx.durableContextProvider);
    ctx.runtime.setContextProvider(ctx.durableContextProvider);
    logInfo("boot", "Durable context provider composed into Pi transports");
  } else {
    logWarn("boot", `Durable context provider not composed (memory=${ctx.memoryRuntime.state}) — durable Pi requests will fail closed`);
  }

  // #1552: compose the memory-tool dependency holder (runtime + durable
  // quota) once memory initialization has resolved. A stale quota service
  // from a prior boot is closed first; tool turns always read the current
  // holder, so a null holder after shutdown fails closed with
  // private_write_unavailable.
  clearMemoryToolDependencies(ctx);
  const { MemoryStoreQuota } = await import("../components/memory-store-quota.js");
  const quota = new MemoryStoreQuota();
  ctx.memoryStoreQuota = quota;
  ctx.memoryToolDependencies.current = { runtime: ctx.memoryRuntime, quota };
  ctx.runtime.setMemoryToolDependencies(ctx.memoryToolDependencies);
  logInfo("boot", "Memory-tool dependencies composed (runtime + store quota)");

  // #907: Register Nerve notification listeners for Orc
  await import("../components/spin-notifications.js");

  // Build pipelineDeps. References ctx fields; later phases mutate ctx.sleepHandle /
  // pipelineDeps.loadedCapabilities / pipelineDeps.selfHealerTask in place.
  const pipelineDeps: PipelineDeps = {
    transport,
    memoryRuntime: ctx.memoryRuntime,
    memoryConfig,
    nlmConfig: ctx.nlmConfig,
    idleSave: ctx.idleSave,
    conversationBuffer: ctx.conversationBuffer,
    config: {
      workingDir: config.transport.workingDir,
    },
    startedAt: ctx.startedAt,
    sttConfig: ctx.sttConfig,
    ttsConfig: ctx.ttsConfig,
    sessionManager: ctx.sessionManager,
    updateCtxStart,
    cronCurrentJob: () => cronQueue.currentJob,
    cronCurrentJobs: () => cronQueue.currentJobs,
    cronQueueView: () => cronQueue.describe(),
    enqueueCron,
    requestShutdown: (code?: number) => ctx.requestShutdownWithCode(code ?? 0),
    sleepProgress: () => ctx.sleepHandle?.progress ?? null,
    startSleep: (o) => {
      if (ctx.sleepHandle) return ctx.sleepHandle.startManual(o);
      if (ctx.sleepUnavailable) return ctx.sleepUnavailable;
      logWarn("sleep", "sleep handle absent without boot availability reason");
      return unavailable("sleep_not_initialized");
    },
    loadedCapabilities: [],
    selfHealerTask: null,
    hailMary: ctx.hailMary,
    // #1468: same boot-owned instance the recovery handler uses; the service
    // itself stays independent of every other dependency in this object.
    emergencyExecution: ctx.emergencyExecution,
    // #1515: optional question settlement after durable assistant recording.
    // Must never throw through the pipeline; failure leaves the row pending
    // and the server CAS makes a later retry safe.
    settleDreamQuestion: async ({ id, userId, deliveryKey }) => {
      if (ctx.memoryRuntime.state === "ready" && ctx.memoryRuntime.supports("dreamQuestions")) {
        await ctx.memoryRuntime.dreamQuestions.markAsked(userId, id, deliveryKey);
      }
    },
    rebuildTransport: async () => {
      const { rebuildTransport } = await import("./phase-transport.js");
      await rebuildTransport(ctx);
    },
    phaseHealth: ctx.phaseHealth,
    registry: ctx.registry,
    bridgeLockPath: ctx.bridgeLockPath,
    get maxContext() {
      try {
        const tc = loadTransport();
        if (tc) {
          const prof = resolveAgent("main", tc);
          if (prof?.contextWindow) return prof.contextWindow;
        }
      } catch { /* fallback */ }
      return 128000;
    },
  };
  ctx.pipelineDeps = pipelineDeps;

  // #944 Step C + #1306: Wire full message handler on already-connected platforms.
  // Extracted into wire-platform.ts so the retry path in phasePlatformsConnect can
  // call the same functions when a new adapter is created after this phase completes.
  const { wireTelegram, wireDiscord, wireTui, drainRecoveryQueue } = await import("./wire-platform.js");
  await wireTelegram(ctx);
  await wireDiscord(ctx);
  await wireTui(ctx);
  await drainRecoveryQueue(ctx);

  // #1000: "Back online" notification moved to bridge-app.ts (fires before greeting)

  // #949: Wire channel→remote sync listener
  const { initChannelSync } = await import("../components/tasks/kanban-channel.js");
  initChannelSync();

  // #1554: scheduled-run recovery and the wake-scheduler start moved to
  // phase-reconciler AFTER the Reconciler generation exists. Both trigger
  // admission of scheduled projects, and a project admitted before the
  // generation would fail its coordinator check. Recovery still completes
  // before the scheduler starts, exactly as today.
  // Register Tier 3 heartbeat tasks (cron, housekeeping, self-healer, etc.)
  const { registerTier3Tasks } = await import("./heartbeat-tier3.js");
  await registerTier3Tasks(ctx);

  return "ran";
}
