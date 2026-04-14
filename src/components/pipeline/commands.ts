/**
 * Command middleware — handles slash commands and transport commands.
 *
 * Interrupt commands (/stop, /new, /reset, /restart) run immediately even when busy.
 * All other commands defer to the busy guard when the chat is busy.
 */

import type { Middleware } from "./middleware.js";
import { handleCommand } from "../command-handlers.js";
import type { CommandContext } from "../command-handlers.js";
import { logInfo } from "../logger.js";

const INTERRUPT_COMMANDS = new Set(["/stop", "/ctrlc", "/new", "/reset", "/restart"]);

export const commandMiddleware: Middleware = async (ctx, next) => {
  const { msg, deps } = ctx;
  const { transport, config, startedAt, memory, memoryConfig, nlmConfig,
    codingMode, idleSave, busyChats, fullModeChats, pendingSessionStart,
    updateCtxStart, conversationBuffer } = deps;

  const trimmed = ctx.text.trim();
  const cmd = trimmed.split(/\s/)[0]!.toLowerCase();

  // Interrupt commands: kill in-progress response first, then handle
  if (INTERRUPT_COMMANDS.has(cmd) && busyChats.has(msg.sessionKey)) {
    logInfo("commands", `Interrupt command ${cmd} while busy — stopping current response`);
    await transport.sendInterrupt();
    busyChats.delete(msg.sessionKey);
  }

  // Non-interrupt commands while busy: defer to busy guard (will be queued)
  if (!INTERRUPT_COMMANDS.has(cmd) && cmd.startsWith("/") && busyChats.has(msg.sessionKey)) {
    await next();
    return;
  }

  const cmdCtx: CommandContext = {
    sessionKey: msg.sessionKey, chatId: ctx.chatId, platform: msg.platform, reply: ctx.reply,
    transport, config, startedAt,
    memory, memoryConfig, nlmConfig,
    codingMode, idleSave,
    busyChats, fullModeChats, pendingSessionStart,
    updateCtxStart,
    cronCurrentJob: deps.cronCurrentJob?.() ?? null,
    enqueueCron: deps.enqueueCron,
    requestShutdown: deps.requestShutdown,
    sleepProgress: deps.sleepProgress,
    loadedCapabilities: deps.loadedCapabilities,
    selfHealerTask: deps.selfHealerTask,
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
