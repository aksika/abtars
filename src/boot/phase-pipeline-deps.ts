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
import { logWarn } from "../components/logger.js";
import { loadTransport, resolveAgent } from "../components/transport-config.js";
import { updateCtxStart } from "./ctx-start.js";
import type { BootCtx, PhaseResult } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { TaskCompleteCallback } from "../components/tasks/task-queue.js";
import { sanitizeOutbound } from "../components/sanitize-outbound.js";
import { getEnv } from "../components/env-schema.js";

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
        ctx.telegramAdapter.sendNotification(String(getEnv().mainChatId), `🔧 Calling self-healing agent`);
      }
      const msg = `[System] You ARE the self-healing agent. A scheduled task failed:\nTask: "${entryId}"\nCommand: ${command}\nResult: ${result}${pending}\n\nDiagnose the root cause. If you can fix it programmatically (config change, script fix, token refresh), do it. If the fix requires human action (manual browser login, external service down), state clearly: "Requires human intervention: <reason>" — do NOT create a skill or suggest adding error handling (you ARE the error handling). Be concise.`;
      void (async () => {
        try {
          const { SubagentRuntime } = await import("../components/subagent-runtime.js");
          const runtime = new SubagentRuntime();
          await runtime.complete("coding", msg, { sessionType: "S" });
          await runtime.shutdown();
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
  const { setEnqueueCron, setSecretGetDb } = await import("../components/transport/tool-registry.js");
  setEnqueueCron((id, manual) => {
    try {
      const entry = cronReadEntry(id);
      if (!entry) return `❌ Entry ${id} not found`;
      return cronQueue.enqueue(entry, cronCallback, manual);
    } catch (err) {
      return `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  // Wire secret_get tool to memory DB
  const db = ctx.memory?.getDb();
  if (db) setSecretGetDb(db as any);

  // Wire session manager to runtime for agent session creation (#521)
  ctx.sessionManager.restore(); // #540: restore persisted sessions before pipeline starts
  ctx.sessionManager.setRuntime(ctx.runtime);

  // Build pipelineDeps. References ctx fields; later phases mutate ctx.sleepHandle /
  // pipelineDeps.loadedCapabilities / pipelineDeps.selfHealerTask in place.
  const pipelineDeps: PipelineDeps = {
    transport,
    memory: ctx.memory,
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
    sessions: ctx.sessions,
    sessionManager: ctx.sessionManager,
    updateCtxStart,
    cronCurrentJob: () => cronQueue.currentJob,
    enqueueCron: (entryId, manual) => {
      try {
        const entry = cronReadEntry(entryId);
        if (!entry) return `❌ Entry ${entryId} not found`;
        return cronQueue.enqueue(entry, cronCallback, manual);
      } catch (err) {
        return `❌ ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    requestShutdown: (code?: number) => ctx.requestShutdownWithCode(code ?? 0),
    sleepProgress: () => ctx.sleepHandle?.progress ?? null,
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
          const prof = resolveAgent("professor", tc);
          if (prof?.contextWindow) return prof.contextWindow;
        }
      } catch { /* fallback */ }
      return 128000;
    },
  };
  ctx.pipelineDeps = pipelineDeps;
  return "ran";
}

/** Export cronCallback factory for phase-heartbeat's age-check task re-enqueue. */
export function createCronCallback(ctx: BootCtx): TaskCompleteCallback {
  return (chatId, message, result, dodFiles) => {
    if (!ctx.platforms.telegram || !ctx.telegramAdapter) return;
    const adapter = ctx.telegramAdapter;

    adapter.sendMessage(String(chatId), sanitizeOutbound(result)).catch(err => {
      logWarn("main", `Cron task TG report failed: ${err}`);
    });

    if (dodFiles?.length) {
      for (const file of dodFiles) {
        adapter.sendDocument(String(chatId), file, message.slice(0, 1024)).catch(err => {
          logWarn("main", `Cron task TG sendDocument failed: ${err}`);
        });
      }
    }
  };
}
