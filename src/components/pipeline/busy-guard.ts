/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug } from "../logger.js";

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
      entry.queue.push({ msg, adapter });
      logDebug("busy-guard", `Queued "${ctx.text.slice(0, 40)}" for ${msg.sessionKey} (${entry.queue.length} pending)`);
      // Log only — don't spam the user with queue notifications
      if (!ctx.deferReply) {
        logDebug("busy-guard", `Queue notification: ${entry.compacting ? "compacting" : `queued (${entry.queue.length})`} for ${msg.sessionKey}`);
      }
      ctx.handled = true;
      return;
    }
  }

  await next();
};
