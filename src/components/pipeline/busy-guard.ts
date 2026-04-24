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
      const queueMsg = entry.compacting
        ? "☕ Hold on, just tidying up my thoughts over coffee... I'll get to you in a moment!"
        : `⏳ Queued (${entry.queue.length}) — will process after current response.`;
      try { await adapter.sendMessage(msg.channelId, queueMsg, { threadId: msg.threadId }); }
      catch { logDebug("busy-guard", `Queue notification failed for ${msg.sessionKey} — message still queued`); }
      ctx.handled = true;
      return;
    }
  }

  await next();
};
