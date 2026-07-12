/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { randomBytes } from "node:crypto";

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

    // /steer — use the generalized generation-bound instruction queue
    if (lower.startsWith("/steer")) {
      const body = text.replace(/^\/steer\s*/i, "").trim();
      const { queueInstruction } = await import("../session-instruction-queue.js");
      const result = queueInstruction(entry, { text: body, source: "platform" });
      logInfo("busy-guard", `Steer for ${activeId}: ${result.ok ? "queued" : result.reason} — "${body.slice(0, 60)}"`);
      const message = result.ok ? "📌 Noted." : `Steering not accepted: ${result.reason}.`;
      try { await adapter.sendMessage(msg.channelId, message, { threadId: msg.threadId }); } catch { /* */ }
      ctx.handled = true;
      return;
    }

    // /wait — legacy non-interrupting injection (#1248: bounded FIFO)
    if (lower.startsWith("/wait")) {
      const body = text.replace(/^\/wait\s*/i, "").trim();
      const steer = body ? `[USER] Wait! ${body}` : "[USER] Wait!";
      const { MAX_WAIT_ITEMS, MAX_WAIT_ITEM_BYTES, MAX_WAIT_TOTAL_BYTES } = await import("../spin-types.js");
      const bytes = Buffer.byteLength(steer, "utf8");
      if (bytes > MAX_WAIT_ITEM_BYTES) {
        logWarn("busy-guard", `Wait item too large for ${activeId}: ${bytes} bytes > ${MAX_WAIT_ITEM_BYTES}`);
        try { await adapter.sendMessage(msg.channelId, "⚠️ That message is too long for a /wait instruction.", { threadId: msg.threadId }); } catch { /* */ }
        ctx.handled = true;
        return;
      }
      if (entry.pendingWait.length >= MAX_WAIT_ITEMS) {
        logWarn("busy-guard", `Wait queue full for ${activeId}: ${entry.pendingWait.length} items`);
        try { await adapter.sendMessage(msg.channelId, "⚠️ Too many /wait instructions already queued.", { threadId: msg.threadId }); } catch { /* */ }
        ctx.handled = true;
        return;
      }
      const totalBytes = entry.pendingWait.reduce((s, i) => s + i.bytes, 0);
      if (totalBytes + bytes > MAX_WAIT_TOTAL_BYTES) {
        logWarn("busy-guard", `Wait aggregate bytes exceeded for ${activeId}: ${totalBytes + bytes} > ${MAX_WAIT_TOTAL_BYTES}`);
        try { await adapter.sendMessage(msg.channelId, "⚠️ Too many /wait bytes queued already.", { threadId: msg.threadId }); } catch { /* */ }
        ctx.handled = true;
        return;
      }
      entry.pendingWait.push({
        id: `wait_${randomBytes(4).toString("hex")}`,
        text: steer,
        createdAt: Date.now(),
        bytes,
      });
      logInfo("busy-guard", `Wait queued for ${activeId}: "${body || "(no message)"}" (${entry.pendingWait.length} items, ${totalBytes + bytes} bytes)`);
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
