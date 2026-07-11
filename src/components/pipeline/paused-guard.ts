/**
 * Paused session guard middleware — blocks normal inbound messages
 * when the selected session is paused, while commands remain usable.
 *
 * Runs after commandMiddleware (so /session resume, /session N, etc.
 * work) and before busyGuardMiddleware.
 */
import type { Middleware } from "./middleware.js";

export const pausedGuardMiddleware: Middleware = async (ctx, next) => {
  const { spin } = await import("../spin.js");
  const session = spin.getActiveSession(ctx.userId, ctx.msg.platform);

  if (session.status === "paused") {
    await ctx.reply(`Session #${session.shortIndex} is paused. Use /session resume or switch sessions.`);
    ctx.handled = true;
    return;
  }

  await next();
};
