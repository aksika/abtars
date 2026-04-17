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

export async function startBridge(): Promise<void> {
  // ── Phase 1: config ──
  const { createBootCtx } = await import("./boot/context.js");
  const { phaseConfig } = await import("./boot/phase-config.js");
  const { phaseMemory } = await import("./boot/phase-memory.js");
  const { phaseTransport } = await import("./boot/phase-transport.js");
  const { phaseMemoryIpc } = await import("./boot/phase-memory-ipc.js");
  const { phasePipelineDeps } = await import("./boot/phase-pipeline-deps.js");
  const { phasePlatforms } = await import("./boot/phase-platforms.js");
  const { phaseCapabilities } = await import("./boot/phase-capabilities.js");
  const { phaseStartupNotification } = await import("./boot/phase-startup-notification.js");
  const { phaseHeartbeat } = await import("./boot/phase-heartbeat.js");
  const ctx = createBootCtx();
  {
    const t = Date.now();
    await phaseConfig(ctx);
    logInfo("boot", `✓ phaseConfig (${Date.now() - t}ms)`);
  }

  // Legacy procedural boot — references ctx fields instead of re-reading
  const config = ctx.config;
  const memoryConfig = ctx.memoryConfig;
  const bridge = new Bridge(config, memoryConfig);
  // === CRITICAL PATH: Memory → Transport → Telegram (fastest path to accepting messages) ===

  // ── Phase 2: memory ──
  {
    const t = Date.now();
    await phaseMemory(ctx);
    logInfo("boot", `✓ phaseMemory (${Date.now() - t}ms)`);
  }
  bridge.memory = ctx.memory;

  // ── Phase 3: transport ──
  {
    const t = Date.now();
    await phaseTransport(ctx);
    logInfo("boot", `✓ phaseTransport (${Date.now() - t}ms)`);
  }
  bridge.transport = ctx.transport!;
  // isSleepActive reads ctx.sleepHandle (set later in phase-sleep / post-heartbeat)
  ctx.isSleepActive = (): boolean => ctx.sleepHandle?.child !== null && ctx.sleepHandle?.child !== undefined && !ctx.sleepHandle.child.killed;

  // STT/TTS config (already loaded in phase-config; locals for legacy refs)
  const sttConfig = ctx.sttConfig;
  const ttsConfig = ctx.ttsConfig;

  // ── Phase 5: pipeline deps ──
  {
    const t = Date.now();
    await phasePipelineDeps(ctx);
    logInfo("boot", `✓ phasePipelineDeps (${Date.now() - t}ms)`);
  }
  const cronQueue = ctx.cronQueue!;
  const pipelineDeps = ctx.pipelineDeps!;
  bridge.cronQueue = cronQueue;
  bridge.pipelineDeps = pipelineDeps;

  // Wire memory LLM callback + IPC server
  // ── Phase 4: memory IPC ──
  {
    const t = Date.now();
    await phaseMemoryIpc(ctx);
    logInfo("boot", `✓ phaseMemoryIpc (${Date.now() - t}ms)`);
  }

    // Unified heartbeat — single 5-min timer for all periodic tasks

  // ── Phase 6: platforms (Telegram + Discord) ──
  {
    const t = Date.now();
    await phasePlatforms(ctx, bridge);
    logInfo("boot", `✓ phasePlatforms (${Date.now() - t}ms)`);
  }

  // === DEFERRED INIT: non-critical services (after platforms are accepting messages) ===

  // ── Phase 7: capabilities + MCP daemon ──
  // Sync bridge.capabilities with ctx.capabilities so command-handlers can read from either
  // (transitional — once Bridge.shutdown reads from ctx, bridge.capabilities field is removable)
  (bridge as unknown as { capabilities: typeof ctx.capabilities }).capabilities = ctx.capabilities;
  {
    const t = Date.now();
    await phaseCapabilities(ctx);
    logInfo("boot", `✓ phaseCapabilities (${Date.now() - t}ms)`);
  }
  bridge.mcpDaemonStarted = ctx.mcpDaemonStarted;

  if (sttConfig) logInfo("main", `🎤 STT enabled (${sttConfig.provider}/${sttConfig.model || "whisper-large-v3"})`);
  if (ttsConfig) logInfo("main", `🔊 TTS enabled (Edge TTS / ${ttsConfig.voice})`);

  // ── Phase 8: startup notification ──
  {
    const t = Date.now();
    await phaseStartupNotification(ctx);
    logInfo("boot", `✓ phaseStartupNotification (${Date.now() - t}ms)`);
  }

  // ── Phase 9: heartbeat + all periodic tasks ──
  {
    const t = Date.now();
    await phaseHeartbeat(ctx);
    logInfo("boot", `✓ phaseHeartbeat (${Date.now() - t}ms)`);
  }
  const heartbeat = ctx.heartbeat!;
  bridge.heartbeat = heartbeat;
  bridge.selfHealerTask = ctx.selfHealerTask;

  // ── Phase 10: sleep ──
  {
    const t = Date.now();
    const { phaseSleep } = await import("./boot/phase-sleep.js");
    await phaseSleep(ctx);
    logInfo("boot", `✓ phaseSleep (${Date.now() - t}ms)`);
  }
  bridge.sleepHandle = ctx.sleepHandle;

  // ── Phase 11: dashboard (web) ──
  {
    const t = Date.now();
    const { phaseDashboard } = await import("./boot/phase-dashboard.js");
    await phaseDashboard(ctx);
    logInfo("boot", `✓ phaseDashboard (${Date.now() - t}ms)`);
  }
  bridge.dashboardServer = ctx.dashboardServer;

  // ── Phase 12: agent-api ──
  {
    const t = Date.now();
    const { phaseAgentApi } = await import("./boot/phase-agent-api.js");
    await phaseAgentApi(ctx);
    logInfo("boot", `✓ phaseAgentApi (${Date.now() - t}ms)`);
  }
  bridge.agentApiServer = ctx.agentApiServer;

  // Wire bridge fields for shutdown
  bridge.heartbeat = heartbeat;
  bridge.cronQueue = cronQueue;

  process.on("SIGINT", () => void bridge.shutdown());
  process.on("SIGTERM", () => void bridge.shutdown());
}
