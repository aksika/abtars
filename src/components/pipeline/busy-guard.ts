/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug } from "../logger.js";

/** Sessions currently in compaction (exported for context manager). */
export const compactingSessions = new Set<string>();

export const busyGuardMiddleware: Middleware = async (ctx, next) => {
  const { msg, adapter, deps } = ctx;
  const { busyChats } = deps;

  if (busyChats.has(msg.sessionKey)) {
    const isWait = ctx.text.trim().toLowerCase().startsWith("wait");
    if (isWait) {
      logInfo("busy-guard", `WAIT interrupt — cancelling current prompt for ${msg.sessionKey}`);
      await deps.transport.sendInterrupt();
      busyChats.delete(msg.sessionKey);
      // Fall through to process this message
    } else {
      const queue = deps.messageQueue.get(msg.sessionKey) ?? [];
      queue.push({ msg, adapter });
      deps.messageQueue.set(msg.sessionKey, queue);
      logDebug("busy-guard", `Queued "${ctx.text.slice(0, 40)}" for ${msg.sessionKey} (${queue.length} pending)`);
      const queueMsg = compactingSessions.has(msg.sessionKey)
        ? "☕ Hold on, just tidying up my thoughts over coffee... I'll get to you in a moment!"
        : `⏳ Queued (${queue.length}) — will process after current response.`;
      try { await adapter.sendMessage(msg.channelId, queueMsg, { threadId: msg.threadId }); }
      catch { logDebug("busy-guard", `Queue notification failed for ${msg.sessionKey} — message still queued`); }
      ctx.handled = true;
      return;
    }
  }

  await next();
};
