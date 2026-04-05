/**
 * Command middleware — handles slash commands and transport commands.
 */

import type { Middleware } from "./middleware.js";
import { handleCommand } from "../command-handlers.js";
import type { CommandContext } from "../command-handlers.js";

export const commandMiddleware: Middleware = async (ctx, next) => {
  const { msg, deps } = ctx;
  const { transport, config, startedAt, memory, memoryConfig, nlmConfig,
    codingMode, idleSave, busyChats, fullModeChats, pendingSessionStart,
    updateCtxStart, conversationBuffer } = deps;

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
  const cmd = ctx.text.split(/\s/)[0]!;
  if (transport.transportCommands.includes(cmd) && transport.executeCommand) {
    const result = await transport.executeCommand(ctx.text);
    await ctx.reply(result);
    ctx.handled = true;
    return;
  }

  await next();
};
