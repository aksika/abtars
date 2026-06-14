/**
 * Command middleware — handles slash commands and transport commands.
 *
 * Interrupt commands (/stop, /new, /reset, /restart) run immediately even when busy.
 * All other commands defer to the busy guard when the chat is busy.
 * Non-master: leading bangs stripped (#157), injection scanned pre-sendPrompt.
 */

import type { Middleware } from "./middleware.js";
import { handleCommand } from "../commands/index.js";
import type { CommandContext } from "../commands/types.js";
import { logInfo } from "../logger.js";
import { loadUsers } from "../user-registry.js";

const BANG_PREFIX = /^[!！ǃ❗❕‼⁉]+/u;

const INTERRUPT_COMMANDS = new Set(["/stop", "/ctrlc", "/reset", "/restart"]);
const DESTRUCTIVE_COMMANDS = new Set(["/stop", "/ctrlc", "/reset", "/restart", "/compact", "/coding", "/default"]);

export const commandMiddleware: Middleware = async (ctx, next) => {
  const { msg, deps } = ctx;
  const { transport, config, startedAt, memory, memoryConfig, nlmConfig,
    idleSave, sessions, sessionManager,
    updateCtxStart, conversationBuffer } = deps;

  // #157: strip leading bangs for non-master (kiro-cli executes ! as shell)
  const registry = loadUsers();
  const resolvedUserId = msg.userId;
  const user = registry.byUserId.get(resolvedUserId);
  const isMaster = user?.role === "master";
  if (!isMaster && BANG_PREFIX.test(ctx.text)) {
    const original = ctx.text;
    ctx.text = ctx.text.replace(BANG_PREFIX, "");
    logInfo("commands", `Defanged bang prefix from ${user?.userId ?? "unknown"}: "${original.slice(0, 25)}"`);
    if (!ctx.text.trim()) {
      ctx.handled = true;
      return;
    }
  }

  const trimmed = ctx.text.trim();
  const cmd = trimmed.split(/\s/)[0]!.toLowerCase();

  // Interrupt commands: kill in-progress response first, then handle
  const activeId = sessionManager.getActiveSessionId(msg.userId, msg.platform);
  if (INTERRUPT_COMMANDS.has(cmd) && sessions.get(activeId)?.busy) {
    logInfo("commands", `Interrupt command ${cmd} while busy — stopping current response`);
    await transport.sendInterrupt();
    sessions.getOrCreate(activeId).busy = false;
  }

  // Non-interrupt destructive commands while busy: defer to busy guard (will be queued)
  if (!INTERRUPT_COMMANDS.has(cmd) && DESTRUCTIVE_COMMANDS.has(cmd) && sessions.get(activeId)?.busy) {
    const deferredWording: Record<string, string> = {
      "/compact": "⏳ Will /compact after current response finishes.",
      "/coding": "⏳ Will switch to coding mode after current response finishes.",
      "/default": "⏳ Will switch to default mode after current response finishes.",
    };
    const specific = deferredWording[cmd];
    if (specific) {
      await ctx.reply(specific);
      ctx.deferReply = true;
    }
    await next();
    return;
  }

  const { adapter } = ctx;
  const editReply = adapter.editMessage
    ? async (messageId: number | string, text: string): Promise<void> => { await adapter.editMessage!(msg.channelId, messageId, text); }
    : undefined;

  const cmdCtx: CommandContext = {
    sessionKey: activeId, chatId: ctx.chatId, userId: ctx.userId ?? "master", platform: msg.platform, reply: ctx.reply,
    editReply,
    transport, config, startedAt,
    memory, memoryConfig, nlmConfig,
    idleSave,
    sessions,
    sessionManager: deps.sessionManager,
    updateCtxStart,
    cronCurrentJob: deps.cronCurrentJob?.() ?? null,
    enqueueCron: deps.enqueueCron,
    requestShutdown: deps.requestShutdown,
    sleepProgress: deps.sleepProgress,
    loadedCapabilities: deps.loadedCapabilities,
    selfHealerTask: deps.selfHealerTask,
    hailMary: deps.hailMary,
    rebuildTransport: deps.rebuildTransport,
    phaseHealth: deps.phaseHealth,
    registry: deps.registry,
    bridgeLockPath: deps.bridgeLockPath,
    conversationBuffer: msg.isGroup ? conversationBuffer : undefined,
    bufKey: msg.isGroup ? `${msg.platform}:${msg.channelId}` : undefined,
  };

  if (await handleCommand(ctx.text, cmdCtx)) {
    ctx.handled = true;
    return;
  }

  // // prefix → pass-through (strip one /)
  if (ctx.text.startsWith("//")) {
    ctx.text = ctx.text.slice(1);
  }

  // Transport-specific commands
  if (transport.transportCommands.includes(cmd) && transport.executeCommand) {
    const result = await transport.executeCommand(ctx.text);
    await ctx.reply(result);
    ctx.handled = true;
    return;
  }

  await next();
};
