/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";

const MAX_QUEUE_DEPTH = 20;

export const busyGuardMiddleware: Middleware = async (ctx, next) => {
  const { msg, adapter } = ctx;
  // #1336: prefer the effective session from session-selection middleware;
  // fall back to platform-active resolution for backward compat / tests.
  const { spin } = await import("../spin.js");
  const entry = ctx.session ?? spin.getSessionById(ctx.deps.sessionManager.getActiveSessionId(ctx.userId, msg.platform));
  const activeId = entry?.id ?? ctx.sessionId;
  if (!entry) { await next(); return; }

  if (entry.busy) {
    const text = ctx.text.trim();
    const lower = text.toLowerCase();

    // Read-only commands bypass busy guard — produce independent messages (#766)
    const firstWord = lower.split(/\s/)[0]!;
    const READONLY = ["/memory", "/models", "/status", "/help", "/tasks", "/usage", "/sleep", "/sessions", "/session", "/whoami", "/model"];
    if (READONLY.includes(firstWord)) {
      await next();
      return;
    }

    // /stop or /ctrlc — hard interrupt
    if (lower === "/stop" || lower === "/ctrlc") {
      logInfo("busy-guard", `STOP interrupt for ${activeId}`);
      await ctx.deps.transport.sendInterrupt();
      entry.busy = false;
      try { await adapter.sendMessage(msg.channelId, "🛑 Stopped.", { threadId: msg.threadId }); } catch { /* */ }
      ctx.handled = true;
      return;
    }

    // /wait or /steer — non-interrupting injection
    if (lower.startsWith("/wait") || lower.startsWith("/steer")) {
      const body = text.replace(/^\/(wait|steer)\s*/i, "").trim();
      const steer = body ? `[USER] Wait! ${body}` : "[USER] Wait!";
      entry.pendingWait = entry.pendingWait ? entry.pendingWait + "\n" + steer : steer;
      logInfo("busy-guard", `Steer queued for ${activeId}: "${body || "(no message)"}"`);
      try { await adapter.sendMessage(msg.channelId, "📌 Noted.", { threadId: msg.threadId }); } catch { /* */ }
      ctx.handled = true;
      return;
    }

    // Legacy: bare "wait" — treat as /stop for backward compat
    if (lower === "wait") {
      logInfo("busy-guard", `Legacy WAIT interrupt for ${activeId}`);
      await ctx.deps.transport.sendInterrupt();
      entry.busy = false;
      try { await adapter.sendMessage(msg.channelId, "🛑 Stopped.", { threadId: msg.threadId }); } catch { /* */ }
      ctx.handled = true;
      return;
    }

    // Default: queue the message
    if (entry.queue.length >= MAX_QUEUE_DEPTH) {
      const dropped = entry.queue.length - MAX_QUEUE_DEPTH + 1;
      entry.queue.splice(0, dropped);
      logWarn("busy-guard", `Queue overflow for ${activeId} — dropped ${dropped} oldest message(s)`);
    }
    entry.queue.push({ msg, adapter });
    logInfo("busy-guard", `Queued "${ctx.text.slice(0, 40)}" for ${activeId} (${entry.queue.length} pending)`);
    if (!ctx.deferReply) {
      if (entry.compacting) {
        try { await adapter.sendMessage(msg.channelId, "☕ Hold on, just tidying up my thoughts over coffee... I'll get to you in a moment!", { threadId: msg.threadId }); }
        catch { /* */ }
      }
      logDebug("busy-guard", `Queue: ${entry.compacting ? "compacting" : `queued (${entry.queue.length})`} for ${activeId}`);
    }
    ctx.handled = true;
    return;
  }

  await next();
};

/**
 * Release busy flag and drain next queued message.
 * Called from message-pipeline finally block.
 */
export function releaseBusy(
  session: { busy: boolean; queue: Array<{ msg: any; adapter: any }>; lastActiveAt: number },
  pipeline: (msg: any, adapter: any) => Promise<void>,
): void {
  session.busy = false;
  session.lastActiveAt = Date.now();
  if (session.queue.length) {
    const next = session.queue.shift()!;
    pipeline(next.msg, next.adapter).catch((err) => { logAndSwallow("busy-guard", "drain", err); });
  }
}
