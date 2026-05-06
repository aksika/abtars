/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug, logWarn } from "../logger.js";

const MAX_QUEUE_DEPTH = 20;

export const busyGuardMiddleware: Middleware = async (ctx, next) => {
  const { msg, adapter, deps } = ctx;
  const entry = deps.sessions.getOrCreate(msg.sessionKey);

  if (entry.busy) {
    const isWait = ctx.text.trim().toLowerCase().startsWith("wait");
    if (isWait) {
      logInfo("busy-guard", `WAIT interrupt — cancelling current prompt for ${msg.sessionKey}`);
      await deps.transport.sendInterrupt();
      entry.busy = false;
      // Fall through to process this message
    } else {
      if (entry.queue.length >= MAX_QUEUE_DEPTH) {
        const dropped = entry.queue.length - MAX_QUEUE_DEPTH + 1;
        entry.queue.splice(0, dropped);
        logWarn("busy-guard", `Queue overflow for ${msg.sessionKey} — dropped ${dropped} oldest message(s)`);
      }
      entry.queue.push({ msg, adapter });
      logDebug("busy-guard", `Queued "${ctx.text.slice(0, 40)}" for ${msg.sessionKey} (${entry.queue.length} pending)`);
      if (!ctx.deferReply) {
        if (entry.compacting) {
          try { await adapter.sendMessage(msg.channelId, "☕ Hold on, just tidying up my thoughts over coffee... I'll get to you in a moment!", { threadId: msg.threadId }); }
          catch { /* */ }
        }
        logDebug("busy-guard", `Queue: ${entry.compacting ? "compacting" : `queued (${entry.queue.length})`} for ${msg.sessionKey}`);
      }
      ctx.handled = true;
      return;
    }
  }

  await next();
};
