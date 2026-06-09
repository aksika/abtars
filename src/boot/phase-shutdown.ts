/**
 * phase-shutdown — boot phase 13 (final): install SIGINT/SIGTERM handlers.
 *
 * Signals trigger shutdown with exit code 1 (don't restart).
 * /restart triggers shutdown with exit code 0 (restart via main.ts loop).
 */

import type { BootCtx, PhaseResult } from "./context.js";
import type { Bridge } from "../bridge-app.js";

export async function phaseShutdown(ctx: BootCtx, bridge: Bridge): Promise<PhaseResult> {
  const shutdown = (code: number): void => {
    // #478: Kill sandboxed containers on bridge exit
    if (ctx.sandboxEnabled) {
      import("../components/sandbox-runtime.js").then(m => m.killAllSandboxes()).catch(() => {});
    }
    bridge.requestShutdown(code);
  };
  process.on("SIGINT", () => shutdown(1));
  process.on("SIGTERM", () => shutdown(1));
  return "ran";
}
