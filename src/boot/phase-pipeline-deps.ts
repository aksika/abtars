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
import { formatTaskFailureDetail, formatTaskFailureRootCause } from "../components/tasks/task-failure.js";
import type { TaskFailureDiagnosticV1 } from "../components/tasks/task-failure.js";
import { loadTransport, resolveAgent } from "../components/transport-config.js";
import { updateCtxStart } from "./ctx-start.js";
import { clearMemoryToolDependencies, type BootCtx, type PhaseResult } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";

import { getEnv } from "../components/env-schema.js";
import { unavailable } from "../capabilities/sleep/index.js";

/** #1297: credit exhaustion cannot be self-healed — SHA must stop before any
 *  state read/write. Identified by exact structured fields, never message text. */
export function skipSelfHealForDiagnostic(diagnostic: TaskFailureDiagnosticV1): boolean {
  return diagnostic.category === "execution" && diagnostic.code === "credits_exhausted";
}

/** #1588: operator failure notification — category/code + lane breakdown. */
export function buildFailureNotification(entryId: string, diagnostic: TaskFailureDiagnosticV1): string {
  // #1297: credit exhaustion is actionable, not self-healable — the operator
  // notification carries the remediation ask.
  const base = `[warn] ${formatTaskLabel(entryId)} failed - ${diagnostic.category}/${diagnostic.code}\n${formatTaskFailureDetail(diagnostic)}`;
  if (skipSelfHealForDiagnostic(diagnostic)) {
    return `${base}\nRequires human intervention: restore provider credits, then run /models reset.`;
  }
  return base;
}

/** #1588: self-healer prompt — structured root cause, bounded remediation, FORBIDDEN block. */
export function buildShaFailurePrompt(entryId: string, diagnostic: TaskFailureDiagnosticV1, pending: string): string {
  return `[System] You ARE the self-healing agent. A scheduled task failed.\nTask: "${entryId}"   Category: ${diagnostic.category}/${diagnostic.code}${pending}\n\n${formatTaskFailureRootCause(diagnostic)}\n\nPermitted remediation: task_manage action=adjust (bounded) or action=escalate.\n\nDiagnose the root cause. If an autonomous adjust within the permitted fields fixes it, apply it. If the fix requires human action (manual browser login, external service down, fresh auth cookie), escalate with a concrete ask: "Requires human intervention: <reason>". Do NOT create a skill or suggest adding error handling (you ARE the error handling). Be concise.\n\nFORBIDDEN: Do NOT modify vital config files unless the bridge is in a crash loop or cannot boot:\n- transport.json\n- .env / .env.skills\n- peers.json\n- users.json\nException: fixing JSON structural corruption (invalid syntax, parse errors) is always allowed.\n\nA single task failure is NOT grounds for config changes. Investigate root cause, report findings.`;
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

  let shaState: "idle" | "running" | "cooldown" = "idle";
  const shaPending: string[] = [];
  const shaDailyCounts = new Map<string, { date: string; count: number }>();
  // #1588: the exactly-once failure cascade. Fires once per settled
  // failed/timed_out run for every task kind, delivering the structured
  // diagnostic to the operator and, when enabled, to the self-healer.
  const onFailure = (entryId: string, diagnostic: TaskFailureDiagnosticV1): void => {
    const label = formatTaskLabel(entryId);
    if (ctx.telegramAdapter) {
      ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), buildFailureNotification(entryId, diagnostic));
    }
    // #1297: credit exhaustion cannot be self-healed by any code change. The
    // one actionable operator notification above is sent, then this guard
    // returns BEFORE any SHA state read/write — daily-attempt accounting,
    // cooldown/pending handling, the self-healer notification, and the S
    // session spin. A skipped credit failure must not consume SHA quota.
    if (skipSelfHealForDiagnostic(diagnostic)) {
      logInfo("main", `Skip self-heal for "${entryId}" — credits_exhausted requires human intervention`);
      return;
    }
    // Three-state SHA guard (#719). The operator notification above is still
    // emitted for every settled failure; this guard only serializes SHA work.
    if (shaState === "running") return;
    if (!getEnv().selfhealEnabled) return;
    // Per-day 2-attempt throttle, moved from the coordinator's tryInjectFailure.
    const today = new Date().toISOString().slice(0, 10);
    const fc = shaDailyCounts.get(entryId);
    if (fc && fc.date === today && fc.count >= 2) {
      logInfo("main", `Skip self-heal for "${entryId}" — already 2 attempts today`);
      return;
    }
    shaDailyCounts.set(entryId, { date: today, count: (fc?.date === today ? fc.count : 0) + 1 });
    if (shaState === "cooldown") {
      shaPending.push(entryId);
      return;
    }
    // SHA idle → fire
    shaState = "running";
    const pending = shaPending.length > 0 ? `\nAlso failed recently: ${shaPending.join(", ")}` : "";
    shaPending.length = 0;
    if (ctx.telegramAdapter) {
      ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), `[warn] Calling self-healer, reason: "${label}" failed`);
    }
    const msg = buildShaFailurePrompt(entryId, diagnostic, pending);
    void (async () => {
      try {
        // #1271: SHA goes through the unified spin() chokepoint (S profile =
        // coding agent, call-terminate — session is created and deleted).
        await ctx.sessionManager.spin({
          type: "S",
          prompt: msg,
          settlementOwner: "spin",
          await: true,
        });
      } catch (err) {
        logWarn("main", `SHA session failed: ${err}`);
      } finally {
        shaState = "cooldown";
        setTimeout(() => { shaState = "idle"; }, 60_000);
      }
    })();
  };
  const onTaskPaused = (chatId: number, title: string, _reason: string): void => {
    if (!ctx.telegramAdapter) return;
    const msg = `"${title}" auto-paused.\nResume with: /task resume <id>`;
    ctx.telegramAdapter.sendNotification(String(chatId), msg);
  };

  // #1540: the coordinator shares the facade's single execution supervisor —
  // never a second live registry — so scheduled agent runs and the worker
  // adapter resolve the same handles.
  const { spin } = await import("../components/spin.js");
  const coordinator = new ScheduledRunCoordinator({ onFailure, onTaskPaused, executions: spin.executionSupervisor });

  const cronQueue = new CronQueue(coordinator);
  ctx.cronQueue = cronQueue;

  // #1539: wire the wake scheduler into the reconciler (executor-lease source
  // registers on startReconciler) and register the remaining due sources.
  const { setWakeScheduler, setFailureCascade } = await import("../components/reconciler.js");
  setWakeScheduler(wakeScheduler);
  // #1588: the reconciler's last-resort scheduled settlements ride the same
  // failure cascade as every other failed run.
  setFailureCascade(coordinator.failureCallback);

  const { createRunDeadlineSource, createTaskAdmissionSource, createKanbanRetrySource } = await import("../components/tasks/due-sources.js");
  wakeScheduler.register(createKanbanRetrySource((cardId: number) => {
    const { requestReconcileForProject } = require("../components/reconciler.js") as typeof import("../components/reconciler.js");
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
  const { setRunProgressBridge } = await import("../components/reconciler.js");
  setRunProgressBridge((cardId: number) => coordinator.projectCardProgress(cardId));

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

  // #1505/#1539: recover any active runs from a prior process crash BEFORE
  // the wake scheduler starts, so new due occurrences are never admitted
  // ahead of recovery.
  const taskStoreModule = await import("../components/tasks/task-store.js");
  const entries = taskStoreModule.readEntries();
  await coordinator.recover(entries, (entry, run) => {
    const enqueueResult = cronQueue.enqueue(entry, false, run);
    if (enqueueResult) {
      logWarn("boot", `Could not reattach scheduled project ${entry.id}: ${enqueueResult}`);
      return false;
    }
    return true;
  });

  // #1539: the initial scan is boot recovery — wake every overdue item, then
  // arm the earliest future due item.
  await wakeScheduler.start();

  // Register Tier 3 heartbeat tasks (cron, housekeeping, self-healer, etc.)
  const { registerTier3Tasks } = await import("./heartbeat-tier3.js");
  await registerTier3Tasks(ctx);

  return "ran";
}
