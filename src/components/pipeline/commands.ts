/**
 * Command middleware — handles slash commands and transport commands.
 *
 * Interrupt commands (/stop, /new, /reset, /restart) run immediately even when busy.
 * All other commands defer to the busy guard when the chat is busy.
 * Non-master messages must start with letter, digit, emoji, or /command (#145).
 */

import type { Middleware } from "./middleware.js";
import { handleCommand } from "../command-handlers.js";
import type { CommandContext } from "../command-handlers.js";
import { logInfo } from "../logger.js";
import { loadUsers } from "../user-registry.js";

const SAFE_FIRST_CHAR = /^\s*(\p{L}|\p{N}|\p{So}|\/\p{L})/u;

const INTERRUPT_COMMANDS = new Set(["/stop", "/ctrlc", "/new", "/reset", "/restart"]);
const DESTRUCTIVE_COMMANDS = new Set(["/stop", "/ctrlc", "/new", "/reset", "/restart", "/compact", "/coding", "/default"]);

export const commandMiddleware: Middleware = async (ctx, next) => {
  const { msg, deps } = ctx;
  const { transport, config, startedAt, memory, memoryConfig, nlmConfig,
    codingMode, idleSave, busyChats, fullModeChats, pendingSessionStart,
    updateCtxStart, conversationBuffer } = deps;

  // #145: block unsafe prefixes for non-master (!, //, shell escapes)
  const registry = loadUsers();
  const platformKey = `${msg.platform}:${msg.channelId}`;
  const user = registry.byPlatformId.get(platformKey);
  const isMaster = user?.role === "master";
  if (!isMaster && !SAFE_FIRST_CHAR.test(ctx.text)) {
    logInfo("commands", `Blocked unsafe input from ${user?.userId ?? "unknown"}: "${ctx.text.slice(0, 20)}"`);
    await ctx.reply("⛔ Message blocked — unsafe prefix.");
    ctx.handled = true;
    return;
  }

  const trimmed = ctx.text.trim();
  const cmd = trimmed.split(/\s/)[0]!.toLowerCase();

  // Interrupt commands: kill in-progress response first, then handle
  if (INTERRUPT_COMMANDS.has(cmd) && busyChats.has(msg.sessionKey)) {
    logInfo("commands", `Interrupt command ${cmd} while busy — stopping current response`);
    await transport.sendInterrupt();
    busyChats.delete(msg.sessionKey);
  }

  // Non-interrupt destructive commands while busy: defer to busy guard (will be queued)
  if (!INTERRUPT_COMMANDS.has(cmd) && DESTRUCTIVE_COMMANDS.has(cmd) && busyChats.has(msg.sessionKey)) {
    await next();
    return;
  }

  const cmdCtx: CommandContext = {
    sessionKey: msg.sessionKey, chatId: ctx.chatId, userId: ctx.userId ?? "master", platform: msg.platform, reply: ctx.reply,
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
