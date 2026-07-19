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
import { logWarn, logInfo } from "../components/logger.js";
import { loadTransport, resolveAgent } from "../components/transport-config.js";
import { updateCtxStart } from "./ctx-start.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { TaskCompleteCallback } from "../components/tasks/task-queue.js";
import { getEnv } from "../components/env-schema.js";
import { unavailable } from "../capabilities/sleep/index.js";

export async function phasePipelineDeps(ctx: BootCtx): Promise<PhaseResult> {
  const { config, memoryConfig, transport } = ctx;
  if (!transport) { ctx.phaseHealth.set(phasePipelineDeps.name, { status: "skipped", error: "no transport" }); logWarn("boot", `${phasePipelineDeps.name}: skipping — transport not available`); return "skipped"; }

  ctx.idleSave = new IdleSave(transport, memoryConfig.memoryDir, memoryConfig.memoryEnabled);

  // CronQueue first — pipelineDeps references it
  let shaState: "idle" | "running" | "cooldown" = "idle";
  const shaPending: string[] = [];
  const cronQueue = new CronQueue(
    config.transport.agentCliPath,
    config.transport.workingDir,
    (entryId, command, result) => {
      // Three-state SHA guard (#719)
      if (shaState === "running") return; // drop entirely — SHA might be fixing it
      if (ctx.telegramAdapter) {
        ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), `⚠️ ${entryId} failed`);
      }
      if (!getEnv().selfhealEnabled) return;
      if (shaState === "cooldown") {
        shaPending.push(entryId);
        return;
      }
      // SHA idle → fire
      shaState = "running";
      const pending = shaPending.length > 0 ? `\nAlso failed recently: ${shaPending.join(", ")}` : "";
      shaPending.length = 0;
      if (ctx.telegramAdapter) {
        ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), `🔧 Calling SHA, reason: "${entryId}" failed`);
      }
      const msg = `[System] You ARE the self-healing agent. A scheduled task failed:\nTask: "${entryId}"\nCommand: ${command}\nResult: ${result}${pending}\n\nDiagnose the root cause. If you can fix it programmatically (script fix, token refresh, pause task), do it. If the fix requires human action (manual browser login, external service down), state clearly: "Requires human intervention: <reason>" — do NOT create a skill or suggest adding error handling (you ARE the error handling). Be concise.\n\nFORBIDDEN: Do NOT modify vital config files unless the bridge is in a crash loop or cannot boot:\n- transport.json\n- .env / .env.skills\n- peers.json\n- users.json\nException: fixing JSON structural corruption (invalid syntax, parse errors) is always allowed.\n\nA single task failure is NOT grounds for config changes. Investigate root cause, report findings.`;
      void (async () => {
        try {
          // #1271: SHA goes through the unified spin() chokepoint (S profile =
          // coding agent, call-terminate — session is created and deleted).
          await ctx.sessionManager.spin({
            type: "S",
            prompt: msg,
            await: true,
          });
        } catch (err) {
          logWarn("main", `SHA session failed: ${err}`);
        } finally {
          shaState = "cooldown";
          setTimeout(() => { shaState = "idle"; }, 60_000);
        }
      })();
    },
    (chatId, title, _reason) => {
      if (!ctx.telegramAdapter) return;
      const msg = `⛔ "${title}" needs manual fix, further errors suppressed.\nResume with: /task resume <id>`;
      ctx.telegramAdapter.sendNotification(String(chatId), msg);
    },
  );
  ctx.cronQueue = cronQueue;

  // cronCallback closes over ctx — reads telegramAdapter lazily (set in phase-platforms)
  const cronCallback: TaskCompleteCallback = (_chatId, _message, _result, _dodFiles) => {
    // #857: delivery handled by kanban board poll in heartbeat-tasks.
    // Board was already updated by task-queue (kanbanComplete/kanbanFail).
    // Main agent picks up done cards and delivers on next interaction.
  };

  // Wire task_manage --run to the cron queue (singleton: _enqueueCron)
  const { setEnqueueCron } = await import("../components/transport/tool-registry.js");
  const enqueueCron = (id: string, manual?: boolean): string | null => {
    try {
      const entry = cronReadEntry(id);
      if (!entry) return `❌ Entry ${id} not found`;
      return cronQueue.enqueue(entry, cronCallback, manual);
    } catch (err) {
      return `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  setEnqueueCron(enqueueCron);

  // Wire secret_get tool to memory DB

  // #894: Wire Spin (which IS the session manager now) to runtime
  const { spin } = await import("../components/spin.js");
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

  // #907: Register Nerve notification listeners for Orc
  await import("../components/spin-notifications.js");

  // #540: Resume Orc if it was active before crash
  const { readBridgeLockField } = await import("../components/transport/bridge-lock-transport.js");
  const orcCard = readBridgeLockField<number>("orc_active");
  if (orcCard) {
    logInfo("boot", `Orc was active (card #${orcCard}) — resuming`);
    spin.dispatch({ type: "O", goal: "Resume: reconcile kanban state for your active project", source: "agent", cardId: orcCard });
  }

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
  const { wireTelegram, wireDiscord, wireIrc, wireTui, drainRecoveryQueue } = await import("./wire-platform.js");
  await wireTelegram(ctx);
  await wireDiscord(ctx);
  await wireIrc(ctx);
  await wireTui(ctx);
  await drainRecoveryQueue(ctx);

  // #1000: "Back online" notification moved to bridge-app.ts (fires before greeting)

  // #949: Wire channel→remote sync listener
  const { initChannelSync } = await import("../components/tasks/kanban-channel.js");
  initChannelSync();

  // Register Tier 3 heartbeat tasks (cron, kanban, self-healer, model-health, etc.)
  const { registerTier3Tasks } = await import("./heartbeat-tier3.js");
  await registerTier3Tasks(ctx);

  return "ran";
}

/** Export cronCallback factory for phase-heartbeat's age-check task re-enqueue. */
export function createCronCallback(_ctx: BootCtx): TaskCompleteCallback {
  return (_chatId, _message, _result, _dodFiles) => {
    // #857/#1020: delivery handled exclusively by kanban board (phase-heartbeat card:done handler).
  };
}
