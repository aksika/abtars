/**
 * Paused session guard middleware — blocks normal inbound messages
 * when the selected effective session is paused, while commands
 * remain usable via the command middleware that runs before this.
 *
 * #1336: reads ctx.session (set by session-selection middleware)
 * instead of re-resolving by (userId, platform).
 */
import type { Middleware } from "./middleware.js";

export const pausedGuardMiddleware: Middleware = async (ctx, next) => {
  // #1336: prefer the effective session from session-selection middleware;
  // fall back to platform-active resolution for backward compat / tests.
  const session = ctx.session ?? (await import("../spin.js")).spin.getActiveSession(ctx.userId, ctx.msg.platform);
  if (!session) { await next(); return; }

  if (session.status === "paused") {
    await ctx.reply(`Session #${session.shortIndex} is paused. Use /session resume or switch sessions.`);
    ctx.handled = true;
    return;
  }

  await next();
};
