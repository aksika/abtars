/**
 * emergency-route.ts — #1468 first-pipeline emergency fast path.
 *
 * Sits before voice, session selection, coding routing, commands, paused/busy
 * guards, and BeforeMessage. It delegates to the boot-owned emergency service
 * and marks the message handled on "handled"; on "pass" the unchanged pipeline
 * continues.
 */

import type { Middleware } from "./middleware.js";
import { logError } from "../logger.js";

const TAG = "emergency";

export const emergencyRouteMiddleware: Middleware = async (ctx, next) => {
  const service = ctx.deps.emergencyExecution;
  if (!service) {
    await next();
    return;
  }
  try {
    if ((await service.handleInbound(ctx.msg, ctx.adapter)) === "handled") {
      ctx.handled = true;
      return;
    }
  } catch (err) {
    // A service fault must never wedge the inbound path; the message falls
    // through to the unchanged pipeline.
    logError(TAG, `Emergency middleware failed (content-free): ${err instanceof Error ? err.message : String(err)}`);
  }
  await next();
};
