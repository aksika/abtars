import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { logInfo, logWarn, logError } from "./components/logger.js";
import { MemoryManager } from "abmind/index.js";
import type { IKiroTransport } from "./components/transport/kiro-transport.js";
import { loadDashboardConfig, validateDashboardConfig, buildStatusSnapshot } from "./components/dashboard/dashboard-config.js";
import type { SubsystemRefs } from "./components/dashboard/dashboard-config.js";
import { AuthGate } from "./components/auth-gate.js";
import { ServiceRegistry } from "./components/service-registry.js";
import { MemorySearchController } from "./components/memory-search-controller.js";
import { DashboardServer } from "./components/dashboard/dashboard-server.js";
import type { IDashboardSlot, DashboardSlotOpts } from "./components/skeleton.js";
import { renderDashboardHtml } from "./components/dashboard/dashboard-ui.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { loadAgentApiConfig } from "./components/agent-api-config.js";
import { BrowserManager } from "./capabilities/browser/browser-manager.js";
import { BrowserIpcServer } from "./capabilities/browser/browser-ipc-server.js";
import { CronQueue } from "./components/cron/cron-queue.js";
import { resetAllCtxStarts } from "./boot/ctx-start.js";


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

  /** Initialize web dashboard. */
  async initDashboard(
    platforms: { web: boolean; agent: boolean },
    heartbeat: HeartbeatSystem,
    nlmConfig: { enabled: boolean },
  ): Promise<void> {
    if (!platforms.web) return;

    const dashConfig = loadDashboardConfig(process.env);
    try {
      validateDashboardConfig(dashConfig, true);
    } catch (err) {
      logError("main", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    let logoBase64 = "";
    try {
      const logoPath = join(process.cwd(), "logo", "KiroProfessor.jpg");
      logoBase64 = readFileSync(logoPath).toString("base64");
    } catch {
      // Logo is optional — dashboard works without it
    }

    const agentApiOpts = platforms.agent
      ? (() => { try { return loadAgentApiConfig(process.env as Record<string, string | undefined>); } catch { return undefined; } })()
      : undefined;
    const dashboardHtml = renderDashboardHtml(logoBase64, agentApiOpts ? { agentApi: { port: agentApiOpts.port, allowedIps: agentApiOpts.allowedIps } } : undefined);

    const getStatus = () => {
      const svcStates = this.registry.getStates();
      const refs: SubsystemRefs = {
        startedAt: this.startedAt,
        telegramPoller: { running: svcStates.telegram?.running ?? false },
        discordPoller: { started: svcStates.discord?.running ?? false },
        services: svcStates,
        transport: {
          type: this.config.transport.agentTransport as "tmux" | "acp" | "api",
          isReady: this.transport.isReady,
          contextPercent: this.transport.contextPercent,
        },
        memory: this.memory ? { getStats: (userId?: string) => this.memory!.getStats(userId) } : null,
        heartbeat: this.memory
          ? { running: this.memory.getStats()?.heartbeatRunning ?? false, intervalMs: heartbeat.intervalMs, tasks: heartbeat.getTaskNames().map(n => ({ name: n })) }
          : null,
        notebooklm: nlmConfig.enabled,
        agentApi: this.agentApiServer ? { getTrafficLog: () => this.agentApiServer!.getTrafficLog() } : null,
      };
      return buildStatusSnapshot(refs);
    };

    const authGate = new AuthGate(dashConfig.webAuthToken);
    const memorySearchController = this.memory
      ? new MemorySearchController({ memory: this.memory })
      : null;

    const customModule = process.env["DASHBOARD_MODULE"];
    if (customModule) {
      const mod = await import(customModule);
      const Ctor = mod.Dashboard ?? mod.default;
      if (typeof Ctor?.prototype?.start !== "function" || typeof Ctor?.prototype?.stop !== "function") {
        throw new Error(`DASHBOARD_MODULE (${customModule}) does not implement IDashboardSlot (missing start/stop)`);
      }
      const opts: DashboardSlotOpts = { getStatus, port: dashConfig.webPort, host: dashConfig.webHost, authToken: dashConfig.webAuthToken };
      this.dashboardServer = new Ctor(opts) as IDashboardSlot;
    } else {
      this.dashboardServer = new DashboardServer({
        config: dashConfig,
        authGate,
        getStatus,
        registry: this.registry,
        memorySearchController,
        dashboardHtml,
      });
    }

    await this.dashboardServer.start();
    logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort}${customModule ? ` (custom: ${customModule})` : ""}`);
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
  const platforms = ctx.platforms;
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
  const memory = ctx.memory;

  // ── Phase 3: transport ──
  {
    const t = Date.now();
    await phaseTransport(ctx);
    logInfo("boot", `✓ phaseTransport (${Date.now() - t}ms)`);
  }
  bridge.transport = ctx.transport!;
  // isSleepActive reads ctx.sleepHandle (set later in phase-sleep / post-heartbeat)
  ctx.isSleepActive = (): boolean => ctx.sleepHandle?.child !== null && ctx.sleepHandle?.child !== undefined && !ctx.sleepHandle.child.killed;

  const registry = bridge.registry;

  // STT/TTS/NLM config (already loaded in phase-config; locals for legacy refs)
  const sttConfig = ctx.sttConfig;
  const ttsConfig = ctx.ttsConfig;
  const nlmConfig = ctx.nlmConfig;

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

  // --- Sleep capability (background, with retry) ---
  const { createSleepHandle } = await import("./capabilities/sleep/index.js");
  const { killWakeInhibit } = await import("./components/command-handlers.js");
  const SLEEP_HOUR = parseInt(process.env["BED_TIME"]?.split(":")[0] ?? "2", 10);
  const sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir: ctx.sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    onComplete: () => resetAllCtxStarts(memoryConfig.memoryDir),
    getLastMsgTs: () => memory?.getLastMessageTimestamp(true) ?? 0,
    sendSystemMessage: ctx.sendSystemMessage!,
    killWakeInhibit,
  });
  ctx.sleepHandle = sleepHandle;
  bridge.sleepHandle = sleepHandle;

  // --- Web Dashboard wiring (conditional) ---
  await bridge.initDashboard(platforms, heartbeat, nlmConfig);

  // --- Agent API service ---
  let agentApiServer: AgentApiServer | null = null; // local ref, wired to bridge at end
  const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);

  registry.register("agent-api", {
    configured: Boolean(agentConfig.port),
    async create() {
      agentApiServer = new AgentApiServer({
        config: agentConfig,
        cliPath: config.transport.agentCliPath,
        workingDir: config.transport.workingDir,
        memory,
        runtime: bridge.runtime,
      });
      return {
        async start() { await agentApiServer!.start(); },
        stop() { agentApiServer?.stop(); agentApiServer = null; },
      };
    },
  });

  if (platforms.agent) {
    const result = await registry.start("agent-api");
    if (result.ok) {
      logInfo("main", `🤖 Agent API enabled on 0.0.0.0:${agentConfig.port} (allowed: ${agentConfig.allowedIps.join(", ")})`);
    } else {
      logError("main", `Agent API failed to start: ${result.error}`);
    }
  }

  // Wire bridge fields for shutdown
  bridge.agentApiServer = agentApiServer;
  bridge.heartbeat = heartbeat;
  bridge.cronQueue = cronQueue;

  process.on("SIGINT", () => void bridge.shutdown());
  process.on("SIGTERM", () => void bridge.shutdown());
}
