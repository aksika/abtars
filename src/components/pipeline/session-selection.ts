/**
 * session-selection.ts — #1336: Select and authorize the effective session.
 *
 * Runs after voice middleware and before command middleware.
 * Without targetSessionId, preserves platform-local active selection.
 * With a target, authorizes only when the concrete adapter is TUI,
 * platform is "tui", user is the configured master, and the session
 * belongs to that master and is not ended.
 *
 * #1432: an exact K skill binding outranks ordinary platform-local A for
 * untargeted messages; an explicit TUI target keeps its authorization
 * precedence. A cleared/expired binding falls through to A unchanged.
 *
 * Selection is synchronous and transport-free — transport creation
 * happens later, after paused and busy guards.
 */

import type { Middleware } from "./middleware.js";
import { getMasterUserId } from "../master-user.js";
import { sessionTypeOf } from "../spin-types.js";
import { isTrustedScheduledAnnouncement } from "../../types/platform.js";

export const sessionSelectionMiddleware: Middleware = async (ctx, next) => {
  const { spin } = await import("../spin.js");
  const targetId = ctx.msg.targetSessionId;

  // #1724: a trusted scheduled-announcement event always targets the user's
  // general A session for the resolved platform/channel. An explicit K skill
  // binding MUST NOT capture a background scheduler event, and external
  // platform input can never forge the internal metadata that reaches this
  // branch.
  if (isTrustedScheduledAnnouncement(ctx.msg.internal)) {
    const session = spin.getActiveSession(ctx.userId, ctx.msg.platform);
    const channelMatches = session ? String(session.chatId) === ctx.msg.channelId : false;
    if (
      !session
      || session.userId !== ctx.userId
      || sessionTypeOf(session.id) !== "A"
      || session.status === "ended"
      || !channelMatches
    ) {
      ctx.handled = true;
      return;
    }
    ctx.session = session;
    ctx.sessionId = session.id;
    await next();
    return;
  }

  if (targetId) {
    // Targeted routing — authorize before selection
    if (ctx.adapter.name !== "tui" || ctx.msg.platform !== "tui") {
      ctx.handled = true;
      return;
    }
    const master = getMasterUserId();
    if (ctx.userId !== master) {
      ctx.handled = true;
      return;
    }
    const session = spin.getSessionById(targetId);
    if (!session || session.userId !== master || session.status === "ended") {
      ctx.handled = true;
      return;
    }
    ctx.session = session;
    ctx.sessionId = session.id;
    await next();
    return;
  }

  // #1432: exact K skill binding → the skill's own persistent session.
  const { skillSessionManager } = await import("../skill-session.js");
  const route = await skillSessionManager.resolveForInbound({
    userId: ctx.userId,
    platform: ctx.msg.platform,
    chatId: ctx.msg.channelId,
    threadId: ctx.msg.threadId,
  });
  if (route.kind === "active") {
    const session = spin.getSessionById(route.sessionId);
    if (session && session.status !== "ended") {
      ctx.session = session;
      ctx.sessionId = session.id;
      await next();
      return;
    }
    // The K session died out-of-band — drop the stale binding and fall
    // through to the ordinary A selection below.
    void skillSessionManager.stop({ userId: ctx.userId, platform: ctx.msg.platform, chatId: ctx.msg.channelId, threadId: ctx.msg.threadId }, "replaced");
  }
  // fallback_to_main / none → platform-local active session (existing behavior)

  // Normal (untargeted) — platform-local active session
  const session = spin.getActiveSession(ctx.userId, ctx.msg.platform);
  ctx.session = session;
  ctx.sessionId = session.id;
  await next();
};
