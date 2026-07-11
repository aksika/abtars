/**
 * session-selection.ts — #1336: Select and authorize the effective session.
 *
 * Runs after voice middleware and before command middleware.
 * Without targetSessionId, preserves platform-local active selection.
 * With a target, authorizes only when the concrete adapter is TUI,
 * platform is "tui", user is the configured master, and the session
 * belongs to that master and is not ended.
 *
 * Selection is synchronous and transport-free — transport creation
 * happens later, after paused and busy guards.
 */

import type { Middleware } from "./middleware.js";
import { getMasterUserId } from "../master-user.js";

export const sessionSelectionMiddleware: Middleware = async (ctx, next) => {
  const { spin } = await import("../spin.js");
  const targetId = ctx.msg.targetSessionId;

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

  // Normal (untargeted) — platform-local active session
  const session = spin.getActiveSession(ctx.userId, ctx.msg.platform);
  ctx.session = session;
  ctx.sessionId = session.id;
  await next();
};
