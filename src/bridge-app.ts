import { execFileSync } from "node:child_process";

import { logInfo, logWarn } from "./components/logger.js";
import type { BootCtx } from "./boot/context.js";
import { createBootCtx } from "./boot/context.js";
import { phaseConfig } from "./boot/phase-config.js";
import { phaseMemory } from "./boot/phase-memory.js";
import { phaseTransport } from "./boot/phase-transport.js";
import { phaseMemoryIpc } from "./boot/phase-memory-ipc.js";
import { phasePipelineDeps } from "./boot/phase-pipeline-deps.js";
import { phasePlatforms } from "./boot/phase-platforms.js";
import { phaseCapabilities } from "./boot/phase-capabilities.js";
import { phaseStartupNotification } from "./boot/phase-startup-notification.js";
import { phaseHeartbeat } from "./boot/phase-heartbeat.js";
import { phaseSleep } from "./boot/phase-sleep.js";
import { phaseDashboard } from "./boot/phase-dashboard.js";
import { phaseAgentApi } from "./boot/phase-agent-api.js";
import { phaseShutdown } from "./boot/phase-shutdown.js";

/**
 * Bridge — owns shutdown orchestration.
 *
 * After #164 + #195 the Bridge class is a thin wrapper around BootCtx.
 * All subsystem refs live on ctx; Bridge's only job is to run shutdown
 * steps in the right order and install the SIGINT/SIGTERM handlers
 * (done from phaseShutdown, which passes this instance in).
 */
export class Bridge {
  constructor(private readonly ctx: BootCtx) {}

  async shutdown(): Promise<void> {
    logInfo("main", "🛑 Shutting down...");
    const forceTimer = setTimeout(() => {
      logWarn("main", "⚠️  Shutdown timed out — forcing exit");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    const step = (name: string, fn: () => Promise<void> | void, ms = 3000): Promise<void> =>
      Promise.race([
        Promise.resolve(fn()).catch(() => {}),
        new Promise<void>(r => {
          const t = setTimeout(() => {
            logWarn("main", `Shutdown step '${name}' timed out (${ms}ms) — skipping`);
            r();
          }, ms);
          (t as NodeJS.Timeout).unref?.();
        }),
      ]);

    await step("agent-api", () => this.ctx.agentApiServer?.stop());
    await step("dashboard", () => this.ctx.dashboardServer?.stop());
    await step("services", () => this.ctx.registry.stopAll());
    await step("heartbeat", () => this.ctx.heartbeat?.stop());
    await step("runtime", () => this.ctx.runtime.shutdown());
    await step("memory", () => this.ctx.memory?.close());
    await step("transport", () => this.ctx.transport?.destroy());
    if (this.ctx.mcpDaemonStarted) {
      await step("mcp-daemon", () => { execFileSync("mcporter", ["daemon", "stop"], { stdio: "pipe" }); });
    }
    process.exit(0);
  }
}

/**
 * Boot phase sequence. Each phase receives the BootCtx and populates
 * fields used by later phases. Order must not change without updating
 * the boot log expectations and phase-order.test.ts.
 *
 * Phases that need the Bridge instance (phase-platforms, phase-shutdown)
 * receive it as a second arg via the dispatcher in startBridge().
 */
export const BOOT_PHASES = [
  phaseConfig,
  phaseMemory,
  phaseTransport,
  phaseMemoryIpc,
  phasePipelineDeps,
  phasePlatforms,
  phaseCapabilities,
  phaseStartupNotification,
  phaseHeartbeat,
  phaseSleep,
  phaseDashboard,
  phaseAgentApi,
  phaseShutdown,
] as const;

export async function startBridge(): Promise<void> {
  const ctx = createBootCtx();

  // Phase 1: config — must run first so Bridge can be constructed
  {
    const t = Date.now();
    await phaseConfig(ctx);
    logInfo("boot", `✓ phaseConfig (${Date.now() - t}ms)`);
  }

  const bridge = new Bridge(ctx);
  // Lazy isSleepActive closure — reads ctx.sleepHandle after phase-sleep sets it
  ctx.isSleepActive = (): boolean => ctx.sleepHandle?.child !== null && ctx.sleepHandle?.child !== undefined && !ctx.sleepHandle.child.killed;

  // Run remaining phases 2-13. Only phase-shutdown needs the bridge (to wire signal handlers);
  // all other phases populate ctx directly.
  for (const phase of BOOT_PHASES.slice(1)) {
    const t = Date.now();
    if (phase === phaseShutdown) {
      await phaseShutdown(ctx, bridge);
    } else {
      await (phase as (ctx: BootCtx) => Promise<void>)(ctx);
    }
    logInfo("boot", `✓ ${phase.name} (${Date.now() - t}ms)`);
  }
}
