import { execFileSync } from "node:child_process";
import { initBridgeLock } from "./components/transport/bridge-lock-transport.js";

import { logInfo, logWarn, logError } from "./components/logger.js";
import type { BootCtx } from "./boot/context.js";
import { createBootCtx } from "./boot/context.js";
import { phaseConfig } from "./boot/phase-config.js";
import { phaseMemory } from "./boot/phase-memory.js";
import { phaseTransport } from "./boot/phase-transport.js";
import { phaseMemoryIpc } from "./boot/phase-memory-ipc.js";
import { phasePipelineDeps } from "./boot/phase-pipeline-deps.js";
import { phasePlatforms } from "./boot/phase-platforms.js";
import { phasePlatformsConnect } from "./boot/phase-platforms-connect.js";
import { phaseCapabilities } from "./boot/phase-capabilities.js";
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
  private _exitCode = 1;
  private _resolve: ((code: number) => void) | null = null;

  constructor(private readonly ctx: BootCtx) {}

  /** Set the exit code and trigger shutdown. Called by /restart (0) or signals (1). */
  requestShutdown(code: number): void {
    this._exitCode = code;
    void this.shutdown();
  }

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
    await step("pi-executor", () => this.ctx.piExecutorService?.executor.interruptAll());
    await step("heartbeat", () => this.ctx.heartbeat?.stop());
    await step("runtime", () => this.ctx.runtime.shutdown());
    await step("memory", () => this.ctx.memory?.close());
    await step("transport", () => this.ctx.transport?.destroy());
    this.ctx.sessionManager.clearAll();
    if (this.ctx.mcpDaemonStarted) {
      await step("mcp-daemon", () => { execFileSync("mcporter", ["daemon", "stop"], { stdio: "pipe" }); });
    }
    const { flushUsage } = await import("./components/usage-tracker.js");
    flushUsage();
    const { flushCacheTelemetry, pruneCacheTelemetryFile } = await import("./components/cache-telemetry.js");
    flushCacheTelemetry();
    pruneCacheTelemetryFile();
    clearTimeout(forceTimer);
    this._resolve?.(this._exitCode);
  }

  /** Returns a promise that resolves with the exit code when shutdown completes. */
  waitForExit(): Promise<number> {
    return new Promise(resolve => { this._resolve = resolve; });
  }
}

import { bootGraph } from "./boot/boot-graph.js";
import { BOOT_NODES } from "./boot/boot-nodes.js";

/**
 * Boot phase sequence — retained for phase-order.test.ts compatibility.
 * The actual dispatcher is bootGraph() which uses BOOT_NODES.
 */
export const BOOT_PHASES = [
  phaseConfig,
  phaseMemory,
  phaseTransport,
  phaseMemoryIpc,
  phasePipelineDeps,
  phasePlatforms,
  phasePlatformsConnect,
  phaseCapabilities,
  phaseHeartbeat,
  phaseSleep,
  phaseDashboard,
  phaseAgentApi,
  phaseShutdown,
] as const;

export async function startBridge(): Promise<number> {
  const ctx = createBootCtx();

  // Phase 1: config — own try/catch, falls back to empty defaults (#331)
  {
    const t = Date.now();
    try {
      const result = await phaseConfig(ctx);
      ctx.phaseHealth.set(phaseConfig.name, { status: result === "skipped" ? "skipped" : "ok" });
      logInfo("boot", result === "skipped" ? `⊘ ${phaseConfig.name} (skipped)` : `✓ ${phaseConfig.name} (${Date.now() - t}ms)`);
    } catch (err) {
      ctx.phaseHealth.set(phaseConfig.name, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      logError("boot", `✗ ${phaseConfig.name} failed — continuing with empty defaults`, err);
    }
  }

  // Boot-time doctor fix — chmod secrets, fix dirs (#1180)
  try {
    const { runFixes } = await import("./cli/commands/doctor-probes.js");
    await runFixes();
  } catch { /* non-fatal */ }

  // Populate version/commit from manifest.json
  const deployed = (await import("./paths.js")).getDeployedVersion();
  ctx.version = deployed.version;
  ctx.commit = deployed.commit;

  // Write bridge.lock immediately — watchdog lifeline, before any phase that could hang
  const startReason = process.env["ABTARS_START_REASON"] ?? "unknown";
  initBridgeLock({ pid: process.pid, startedAt: Date.now(), version: `${ctx.version}${ctx.commit ? "-" + ctx.commit : ""}`, argv: process.argv.slice(2), startReason });

  const bridge = new Bridge(ctx);
  ctx.isSleepActive = (): boolean => ctx.sleepHandle?.isActive === true;
  ctx.requestShutdownWithCode = (code: number) => bridge.requestShutdown(code);

  // Run boot graph — all phases execute in dependency order (#944)
  await bootGraph(BOOT_NODES, ctx);

  // phaseShutdown is special (needs Bridge instance) — run after graph
  {
    const t = Date.now();
    try {
      const result = await phaseShutdown(ctx, bridge);
      ctx.phaseHealth.set(phaseShutdown.name, { status: result === "skipped" ? "skipped" : "ok" });
      logInfo("boot", `✓ ${phaseShutdown.name} (${Date.now() - t}ms)`);
    } catch (err) {
      ctx.phaseHealth.set(phaseShutdown.name, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      logError("boot", `✗ ${phaseShutdown.name} failed`, err);
    }
  }

  // Fire BridgeStart hook after all phases complete
  const { hasHooks, fire } = await import("./components/hooks/hook-system.js");
  if (hasHooks("BridgeStart")) {
    await fire("BridgeStart", { event: "BridgeStart", timestamp: new Date().toISOString(), sessionKey: "", platform: "", userId: "" });
  }

  // #1000: Back online notification FIRST, then greeting
  if (ctx.telegramAdapter || ctx.discordAdapter) {
    try {
      const { sendToMainChat } = await import("./components/main-chat.js");
      const version = ctx.commit && ctx.commit !== "?" && !ctx.version.includes(ctx.commit)
        ? `v${ctx.version}-${ctx.commit}` : `v${ctx.version}`;
      // #1202: Include update result if deploy just completed
      let deployNote = "";
      try {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const state = JSON.parse(readFileSync(join(process.env["HOME"] ?? "", ".abtars", "deploy.state"), "utf-8"));
        if (state.completedAt && Date.now() - new Date(state.completedAt).getTime() < 5 * 60_000) {
          deployNote = state.status === "success" ? " (updated)" : ` (update ${state.status})`;
        }
      } catch {}
      await sendToMainChat({ telegram: ctx.telegramAdapter, discord: ctx.discordAdapter }, `🔄 Back online. ${version}${deployNote}`);
      logInfo("main", "Startup: Back online notification sent");
      const failed = [...ctx.phaseHealth].filter(([, h]) => h.status === "failed" || h.status === "skipped");
      if (failed.length > 0) {
        const lines = failed.map(([name, h]) => `  ${h.status === "failed" ? "✗" : "»"} ${name}${h.error ? `: ${h.error}` : ""}`);
        await sendToMainChat({ telegram: ctx.telegramAdapter, discord: ctx.discordAdapter }, `⚠️ Degraded boot (${failed.length} subsystem${failed.length > 1 ? "s" : ""} down):\n${lines.join("\n")}`);
      }
    } catch (err) { logWarn("main", `Back online notification failed: ${err}`); }
  }

  // #980: Greeting fires via Spin when session is ready (not here — transport may not be handshaked yet)
  if (ctx.telegramAdapter) {
    const { spin } = await import("./components/spin.js");
    spin.setGreetingAdapter(ctx.telegramAdapter);
  }

  return bridge.waitForExit();
}
