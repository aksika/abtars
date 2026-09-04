/**
 * Busy guard middleware — queues messages when transport is busy.
 */

import type { Middleware } from "./middleware.js";
import { logInfo, logDebug, logWarn } from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { isTrustedScheduledAnnouncement } from "../../types/platform.js";

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
    // #1724: trusted scheduled-announcement events use an immediate, no-queue
    // admission policy. A busy Main session rejects the event WITHOUT queue
    // mutation and without a parallel turn — the Kanban delivery poll owns
    // retry, so an untracked queued announcement would escape its bounded
    // retry/unknown semantics.
    if (isTrustedScheduledAnnouncement(ctx.msg.internal)) {
      logInfo("busy-guard", `Scheduled announcement rejected for busy ${activeId} (no-queue policy) — delivery will retry`);
      ctx.handled = true;
      return;
    }

    const text = ctx.text.trim();
    const lower = text.toLowerCase();

    // Read-only commands bypass busy guard — produce independent messages (#766)
    const firstWord = lower.split(/\s/)[0]!;
    const READONLY = ["/memory", "/models", "/status", "/help", "/tasks", "/usage", "/sleep", "/sessions", "/session", "/whoami", "/model"];
    if (READONLY.includes(firstWord)) {
      await next();
      return;
    }

    // /stop or /ctrlc — hard interrupt (alternate compositions without the
    // command middleware; #1534: session-aware, boot transport as fallback)
    if (lower === "/stop" || lower === "/ctrlc") {
      logInfo("busy-guard", `STOP interrupt for ${activeId}`);
      await spin.interruptSession(activeId!, ctx.deps.transport, "operator");
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

    // /wait — non-interrupting injection via the generation-bound instruction
    // queue, same path as /steer (#1768: the legacy pendingWait FIFO had no
    // consumer, so queued instructions were silently dropped).
    if (lower.startsWith("/wait")) {
      const body = text.replace(/^\/wait\s*/i, "").trim();
      const steer = body ? `[USER] Wait! ${body}` : "[USER] Wait!";
      const { queueInstruction } = await import("../session-instruction-queue.js");
      const result = queueInstruction(entry, { text: steer, source: "platform" });
      logInfo("busy-guard", `Wait for ${activeId}: ${result.ok ? "queued" : result.reason} — "${body.slice(0, 60)}"`);
      const message = result.ok ? "📌 Noted." : `Wait not accepted: ${result.reason}.`;
      try { await adapter.sendMessage(msg.channelId, message, { threadId: msg.threadId }); } catch { /* */ }
      ctx.handled = true;
      return;
    }

    // Legacy: bare "wait" — treat as /stop for backward compat
    if (lower === "wait") {
      logInfo("busy-guard", `Legacy WAIT interrupt for ${activeId}`);
      await spin.interruptSession(activeId!, ctx.deps.transport, "operator");
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
