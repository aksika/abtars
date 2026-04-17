import { execFileSync } from "node:child_process";

import { logInfo, logWarn } from "./components/logger.js";
import { MemoryManager } from "abmind/index.js";
import type { IKiroTransport } from "./components/transport/kiro-transport.js";
import { ServiceRegistry } from "./components/service-registry.js";
import type { IDashboardSlot } from "./components/skeleton.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { BrowserManager } from "./capabilities/browser/browser-manager.js";
import { BrowserIpcServer } from "./capabilities/browser/browser-ipc-server.js";
import { CronQueue } from "./components/cron/cron-queue.js";


import type { Config } from "./types/index.js";
import type { MemoryConfig } from "abmind/index.js";
import type { PipelineDeps } from "./components/message-pipeline.js";
import { createCapabilityRegistry, createCapabilityApi } from "./capabilities/capability.js";
import type { CapabilityRegistry, CapabilityRegisterFn } from "./capabilities/capability.js";

import { SubagentRuntime } from "./components/subagent-runtime.js";

/**
 * Bridge — the skeleton. Owns all subsystem lifecycles.
 * Implements the slot-based architecture: memory, transport, runtime, tasks, skills, platforms.
 */
export class Bridge {
  readonly config: Config;
  readonly memoryConfig: MemoryConfig;
  readonly startedAt = Date.now();
  readonly runtime = new SubagentRuntime();

  transport!: IKiroTransport;
  memory: MemoryManager | null = null;
  heartbeat!: HeartbeatSystem;
  registry = new ServiceRegistry();
  pipelineDeps!: PipelineDeps;

  dashboardServer: IDashboardSlot | null = null;
  agentApiServer: AgentApiServer | null = null;
  browserIpc: BrowserIpcServer | null = null;
  /** @deprecated Browser is now a capability — this field is only used by shutdown. */
  browserManager: BrowserManager | null = null;
  mcpDaemonStarted = false;
  cronQueue!: CronQueue;
  sleepHandle: import("./capabilities/sleep/index.js").SleepHandle | null = null;
  selfHealerTask: { enabled: boolean } | null = null;
  telegramAdapter: import("./platforms/telegram/telegram-adapter.js").TelegramAdapter | null = null;
  discordAdapter: import("./platforms/discord/discord-adapter.js").DiscordAdapter | null = null;

  constructor(config: Config, memoryConfig: MemoryConfig) {
    this.config = config;
    this.memoryConfig = memoryConfig;
  }

  /** Collected registrations from all capabilities. */
  readonly capabilities: CapabilityRegistry = createCapabilityRegistry();

  /** Register a capability before start(). */
  registerCapability(fn: CapabilityRegisterFn): void {
    const api = createCapabilityApi(this.capabilities, this.config, this.memory, this.transport, this.runtime);
    fn(api);
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
        new Promise<void>(r => { const t = setTimeout(() => { logWarn("main", `Shutdown step '${name}' timed out (${ms}ms) — skipping`); r(); }, ms); (t as NodeJS.Timeout).unref?.(); }),
      ]);

    await step("agent-api", () => this.agentApiServer?.stop());
    await step("dashboard", () => this.dashboardServer?.stop());
    await step("services", () => this.registry.stopAll());
    await step("heartbeat", () => this.heartbeat.stop());
    await step("browser-ipc", () => this.browserIpc?.shutdown());
    await step("browser", () => this.browserManager?.shutdown(), 5000);
    await step("runtime", () => this.runtime.shutdown());
    await step("memory", () => this.memory?.close());
    await step("transport", () => this.transport.destroy());
    if (this.mcpDaemonStarted) {
      await step("mcp-daemon", () => { execFileSync("mcporter", ["daemon", "stop"], { stdio: "pipe" }); });
    }
    process.exit(0);
  }
}

import { createBootCtx } from "./boot/context.js";
import type { BootCtx } from "./boot/context.js";
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

  const bridge = new Bridge(ctx.config, ctx.memoryConfig);
  // Sync capabilities from ctx (readonly field — cast)
  (bridge as unknown as { capabilities: typeof ctx.capabilities }).capabilities = ctx.capabilities;
  // Lazy isSleepActive closure — reads ctx.sleepHandle after phase-sleep sets it
  ctx.isSleepActive = (): boolean => ctx.sleepHandle?.child !== null && ctx.sleepHandle?.child !== undefined && !ctx.sleepHandle.child.killed;

  // Run remaining phases 2-13
  for (const phase of BOOT_PHASES.slice(1)) {
    const t = Date.now();
    // phase-platforms and phase-shutdown take bridge as second arg; all others just ctx
    await (phase as (ctx: BootCtx, bridge?: Bridge) => Promise<void>)(ctx, bridge);
    logInfo("boot", `✓ ${phase.name} (${Date.now() - t}ms)`);
    // Sync ctx → bridge for phases that populate fields used by Bridge.shutdown
    syncBridgeFromCtx(bridge, ctx);
  }
}

/** Copy ctx fields consumed by Bridge.shutdown() onto the bridge instance. */
function syncBridgeFromCtx(bridge: Bridge, ctx: BootCtx): void {
  if (ctx.memory) bridge.memory = ctx.memory;
  if (ctx.transport) bridge.transport = ctx.transport;
  if (ctx.heartbeat) bridge.heartbeat = ctx.heartbeat;
  if (ctx.cronQueue) bridge.cronQueue = ctx.cronQueue;
  if (ctx.pipelineDeps) bridge.pipelineDeps = ctx.pipelineDeps;
  if (ctx.sleepHandle) bridge.sleepHandle = ctx.sleepHandle;
  if (ctx.selfHealerTask) bridge.selfHealerTask = ctx.selfHealerTask;
  if (ctx.dashboardServer) bridge.dashboardServer = ctx.dashboardServer;
  if (ctx.agentApiServer) bridge.agentApiServer = ctx.agentApiServer;
  bridge.mcpDaemonStarted = ctx.mcpDaemonStarted;
}
