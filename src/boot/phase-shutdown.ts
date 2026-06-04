/**
 * phase-shutdown — boot phase 13 (final): install SIGINT/SIGTERM handlers.
 *
 * Signals trigger shutdown with exit code 1 (don't restart).
 * /restart triggers shutdown with exit code 0 (restart via main.ts loop).
 */

import type { BootCtx, PhaseResult } from "./context.js";
import type { Bridge } from "../bridge-app.js";

export async function phaseShutdown(ctx: BootCtx, bridge: Bridge): Promise<PhaseResult> {
  void ctx;
  process.on("SIGINT", () => bridge.requestShutdown(1));
  process.on("SIGTERM", () => bridge.requestShutdown(1));
  return "ran";
}
