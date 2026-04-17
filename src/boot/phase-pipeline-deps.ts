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
 * Populates ctx: cronQueue, codingMode, idleSave, pipelineDeps.
 */

import { readEntry as cronReadEntry } from "../components/cron/cron-db.js";
import { CronQueue } from "../components/cron/cron-queue.js";
import { CodingMode } from "../components/coding-mode.js";
import { IdleSave } from "../components/idle-save.js";
import { loadUsers } from "../components/user-registry.js";
import { logWarn } from "../components/logger.js";
import { updateCtxStart } from "./ctx-start.js";
import type { BootCtx } from "./context.js";
import type { PipelineDeps } from "../components/message-pipeline.js";
import type { TaskCompleteCallback } from "../components/cron/cron-queue.js";

export async function phasePipelineDeps(ctx: BootCtx): Promise<void> {
  const { config, memoryConfig, transport } = ctx;
  if (!transport) throw new Error("phase-pipeline-deps: ctx.transport not set (phase-transport must run first)");

  ctx.codingMode = new CodingMode(ctx.runtime);
  ctx.idleSave = new IdleSave(transport, memoryConfig.memoryDir, memoryConfig.memoryEnabled);

  // CronQueue first — pipelineDeps references it
  const cronQueue = new CronQueue(
    config.transport.agentCliPath,
    config.transport.workingDir,
    (entryId, command, result) => {
      const msg = `[System] Cron task "${entryId}" failed:\nCommand: ${command}\nResult: ${result}\n\nDiagnose and fix if possible. If you can't fix it, tell the user.`;
      transport.sendPrompt("system:cron-fix", msg).catch(err => {
        logWarn("main", `Cron auto-fix inject failed: ${err}`);
      });
    },
  );
  ctx.cronQueue = cronQueue;

  // cronCallback closes over ctx — reads telegramAdapter lazily (set in phase-platforms)
  const cronCallback: TaskCompleteCallback = (chatId, message, result, resultPath) => {
    if (ctx.platforms.telegram && ctx.telegramAdapter) {
      ctx.telegramAdapter.sendMessage(String(chatId), `Cron: ${message}\n\n${result}`).catch(err => {
        logWarn("main", `Cron task TG report failed: ${err}`);
      });
    }
    if (resultPath) {
      const masterUser = loadUsers().users.find(u => u.role === "master");
      const sessionKey = `${masterUser?.userId ?? "master"}:telegram`;
      transport.sendPrompt(sessionKey, `[SYSTEM] Task "${message}" completed. If user asks for the result, use: cat ${resultPath}`).catch(() => {});
    }
  };

  // Wire task_manage --run to the cron queue (singleton: _enqueueCron)
  const { setEnqueueCron } = await import("../components/transport/tool-registry.js");
  setEnqueueCron((id, manual) => {
    try {
      const entry = cronReadEntry(id);
      if (!entry) return `❌ Entry ${id} not found`;
      return cronQueue.enqueue(entry, cronCallback, manual);
    } catch (err) {
      return `❌ ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  // Build pipelineDeps. References ctx fields; later phases mutate ctx.sleepHandle /
  // pipelineDeps.loadedCapabilities / pipelineDeps.selfHealerTask in place.
  const pipelineDeps: PipelineDeps = {
    transport,
    codingMode: ctx.codingMode,
    memory: ctx.memory,
    memoryConfig,
    nlmConfig: ctx.nlmConfig,
    idleSave: ctx.idleSave,
    conversationBuffer: ctx.conversationBuffer,
    config: {
      agentTransport: config.transport.agentTransport,
      workingDir: config.transport.workingDir,
      discordA2aEnabled: config.discord.a2aEnabled,
      discordA2aChannelId: config.discord.a2aChannelId,
    },
    startedAt: ctx.startedAt,
    sttConfig: ctx.sttConfig,
    ttsConfig: ctx.ttsConfig,
    busyChats: ctx.busyChats,
    fullModeChats: ctx.fullModeChats,
    pendingSessionStart: ctx.pendingSessionStart,
    seenSessions: ctx.seenSessions,
    updateCtxStart,
    messageQueue: ctx.messageQueue,
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
    requestShutdown: () => process.exit(0),
    sleepProgress: () => ctx.sleepHandle?.progress ?? null,
    loadedCapabilities: [],
    selfHealerTask: null,
  };
  ctx.pipelineDeps = pipelineDeps;
}

/** Export cronCallback factory for phase-heartbeat's age-check task re-enqueue. */
export function createCronCallback(ctx: BootCtx): TaskCompleteCallback {
  return (chatId, message, result, resultPath) => {
    if (ctx.platforms.telegram && ctx.telegramAdapter) {
      ctx.telegramAdapter.sendMessage(String(chatId), `Cron: ${message}\n\n${result}`).catch(err => {
        logWarn("main", `Cron task TG report failed: ${err}`);
      });
    }
    if (resultPath && ctx.transport) {
      const masterUser = loadUsers().users.find(u => u.role === "master");
      const sessionKey = `${masterUser?.userId ?? "master"}:telegram`;
      ctx.transport.sendPrompt(sessionKey, `[SYSTEM] Task "${message}" completed. If user asks for the result, use: cat ${resultPath}`).catch(() => {});
    }
  };
}
