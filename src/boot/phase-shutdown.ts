/**
 * phase-shutdown — boot phase 13 (final): install SIGINT/SIGTERM handlers.
 *
 * Signals trigger shutdown with exit code 1 (don't restart).
 * /restart triggers shutdown with exit code 0 (restart via main.ts loop).
 */

import { logWarn } from "../components/logger.js";
import { readFileSync } from "node:fs";
import type { BootCtx, PhaseResult } from "./context.js";
import type { Bridge } from "../bridge-app.js";

export async function phaseShutdown(ctx: BootCtx, bridge: Bridge): Promise<PhaseResult> {
  const shutdown = (code: number, signal?: string): void => {
    if (signal) {
      // Log forensics: who might have sent it
      let parent = "";
      try { parent = readFileSync(`/proc/${process.ppid}/cmdline`, "utf-8").replace(/\0/g, " ").trim(); } catch {}
      logWarn("main", `${signal} received (pid=${process.pid} ppid=${process.ppid} parent="${parent}")`);
    }
    if (ctx.sandboxEnabled) {
      import("../components/sandbox-runtime.js").then(m => m.killAllSandboxes()).catch(() => {});
    }
    bridge.requestShutdown(code);
  };
  process.on("SIGINT", () => shutdown(1, "SIGINT"));
  process.on("SIGTERM", () => shutdown(1, "SIGTERM"));
  return "ran";
}
