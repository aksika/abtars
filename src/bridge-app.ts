import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEntry as cronReadEntry } from "./components/cron/cron-db.js";
import { execFileSync, execSync } from "node:child_process";
import { loadAndValidateConfig } from "./components/config.js";
import { agentBridgeHome } from "./paths.js";

import { TmuxClient } from "./components/transport/tmux-client.js";
import { createAgentTransport } from "./components/agent-registry.js";
import { writeRestartReason, readAndClearRestartRequested, readBridgeLockField, writeSleepStatus } from "./components/transport/bridge-lock-transport.js";
import { createSelfHealerTask } from "./components/self-healer.js";
import { createIdleCompactTask, createAgeCheckTask, createDbIntegrityTask } from "./components/heartbeat-tasks.js";
import type { SttConfig } from "./components/stt.js";
import type { TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, logDebug } from "./components/logger.js";
import { loadMemoryConfig, MemoryManager, setLogger as setMemoryLogger } from "abmind/index.js";
import { ConversationBuffer } from "./components/conversation-buffer.js";
import type { IKiroTransport } from "./components/transport/kiro-transport.js";
import { parsePlatformFlags } from "./components/cli-flags.js";
import { loadDashboardConfig, validateDashboardConfig, buildStatusSnapshot } from "./components/dashboard/dashboard-config.js";
import type { SubsystemRefs } from "./components/dashboard/dashboard-config.js";
import { AuthGate } from "./components/auth-gate.js";
import { ServiceRegistry } from "./components/service-registry.js";
import { MemorySearchController } from "./components/memory-search-controller.js";
import { DashboardServer } from "./components/dashboard/dashboard-server.js";
import { renderDashboardHtml } from "./components/dashboard/dashboard-ui.js";
import { loadNLMConfig } from "./components/nlm-command-handler.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { classifyResume } from "./components/platform-detect.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { loadAgentApiConfig } from "./components/agent-api-config.js";
import { BrowserManager } from "./capabilities/browser/browser-manager.js";
import { BrowserIpcServer } from "./capabilities/browser/browser-ipc-server.js";
import { CodingMode } from "./components/coding-mode.js";
import { IdleSave } from "./components/idle-save.js";
import { checkCron, readPendingReminders, clearPendingReminders } from "./components/cron/cron-checker.js";
import { CronQueue } from "./components/cron/cron-queue.js";
import { startSession } from "./components/message-pipeline.js";


/** Update context-window-start timestamp for a chat. Used by recall fallback stages. */
function updateCtxStart(memoryDir: string, chatId: number, ts = Date.now()): void {
  const p = join(memoryDir, "context-window-start.json");
  let data: Record<string, number> = {};
  try { data = JSON.parse(readFileSync(p, "utf-8")); } catch { /* new file */ }
  data[String(chatId)] = ts;
  writeFileSync(p, JSON.stringify(data), "utf-8");
}

/** Set all context-window-start entries to now (called after sleep). */
function resetAllCtxStarts(memoryDir: string): void {
  const p = join(memoryDir, "context-window-start.json");
  let data: Record<string, number> = {};
  try { data = JSON.parse(readFileSync(p, "utf-8")); } catch { return; }
  const now = Date.now();
  for (const key of Object.keys(data)) data[key] = now;
  writeFileSync(p, JSON.stringify(data), "utf-8");
}

/** Send "Back online" notification to all platforms. */
async function sendBackOnline(
  sendTelegram?: (msg: string) => Promise<void>,
  sendDiscord?: (msg: string) => Promise<void>,
): Promise<void> {
  const msg = "🔄 Back online.";
  logInfo("main", "Startup: Back online notification sent");
  const results = await Promise.allSettled([
    sendTelegram?.(msg).catch(() => {}),
    sendDiscord?.(msg).catch(() => {}),
  ]);
  for (const r of results) {
    if (r.status === "rejected") logWarn("main", `Back online send failed: ${r.reason}`);
  }
}

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

  dashboardServer: DashboardServer | null = null;
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

  /** Initialize memory layer + IPC server + LLM callback. */
  async initMemory(): Promise<void> {
    if (!this.memoryConfig.memoryEnabled) {
      logInfo("main", "🧠 Memory disabled");
      return;
    }
    setMemoryLogger({ logInfo, logWarn, logError });

    // Load ABM .env.memory config
    const { loadMemoryEnv } = await import("abmind/mem-config-env.js");
    const memEnv = loadMemoryEnv();
    logInfo("main", `🧠 ABM config: search=${memEnv.searchMode}, maxDB=${memEnv.maxDbSizeMb}MB, aging=${memEnv.agingEnabled}`);

    const memory = new MemoryManager(this.memoryConfig);
    await memory.initialize();
    this.memory = memory;
    logInfo("main", `🧠 Memory enabled (dir=${this.memoryConfig.memoryDir})`);
  }

  /** Wire LLM callback + start memory IPC server. Call after transport is ready. */
  async wireMemory(): Promise<void> {
    if (!this.memory) return;
    this.memory.setLlmCall(async (prompt: string, content: string) => {
      return this.transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
    });
    logInfo("main", "🧠 Memory LLM callback registered");

    const { MemoryIpcServer } = await import("abmind/memory-ipc-server.js");
    const { SqliteBackend } = await import("abmind/sqlite-backend.js");
    const ipcBackend = new SqliteBackend(this.memoryConfig);
    await ipcBackend.initialize();
    const memoryIpc = new MemoryIpcServer(ipcBackend);
    await memoryIpc.start();
  }

  /** Initialize transport (ACP, Direct API, or tmux) + TransportManager + in-process memory. */
  async initTransport(): Promise<void> {
    const config = this.config;

    // Pre-flight: tmux session (resolved below, but need config early for tmux script)
    if (config.transport.agentTransport === "tmux") {
      logInfo("main", `♻️  Starting tmux session '${config.transport.tmuxSession}'...`);
      try {
        execFileSync(join(import.meta.dirname, "..", "scripts", "tmux-session.sh"), { stdio: "pipe" });
      } catch (err) {
        logError("main", "tmux session start failed", err);
      }
    }

    let transport: IKiroTransport;

    // Resolve professor config from transport.json (falls back to .env)
    const { resolveAgent, getEnvFallback, loadTransport } = await import("./components/transport-config.js");
    const tc = loadTransport();
    const prof = tc ? resolveAgent("professor", tc) : null;
    const resolved = prof ?? (() => {
      const fb = getEnvFallback();
      logWarn("main", `⚠️ Using .env fallback: ${fb.model} via ${fb.providerName}`);
      return { model: fb.model, provider: fb.provider, providerName: fb.providerName, contextWindow: fb.contextWindow, maxOutput: fb.maxOutput, fallbacks: [] };
    })();

    if (resolved.provider.transport === "tmux") {
      const defaults = tc?.transportDefaults?.tmux;
      logInfo("main", `🖥️  tmux transport (${resolved.providerName})`);
      transport = new TmuxClient(
        defaults?.session ?? config.transport.tmuxSession,
        defaults?.captureDelaySec ?? config.transport.tmuxCaptureDelaySec,
        defaults?.maxWaitSec ?? config.transport.tmuxMaxWaitSec,
      );
    } else if (resolved.provider.transport === "api") {
      const { DirectApiTransport } = await import("./components/transport/direct-api-transport.js");
      const apiKey = resolved.provider.apiKeyEnv ? process.env[resolved.provider.apiKeyEnv] : process.env["API_KEY"];
      const fallbacks = resolved.fallbacks.map(fb => {
        const fbResolved = tc ? resolveAgent("_fallback", { ...tc, agents: { ...tc.agents, _fallback: { model: fb.model, provider: fb.provider } } }) : null;
        return {
          endpoint: fbResolved?.provider.endpoint ?? resolved.provider.endpoint!,
          apiKey: fbResolved?.provider.apiKeyEnv ? process.env[fbResolved.provider.apiKeyEnv] : apiKey,
          model: fb.model,
          maxContext: fbResolved?.contextWindow,
        };
      });
      transport = new DirectApiTransport({
        endpoint: resolved.provider.endpoint ?? "http://localhost:11434/v1",
        apiKey,
        model: resolved.model,
        maxContext: resolved.contextWindow,
        maxOutput: resolved.maxOutput,
        maxTurns: tc?.maxTurns ?? 50,
        fallbacks: fallbacks.length > 0 ? fallbacks : undefined,
      });
      logInfo("main", `🔌 Direct API transport (${resolved.providerName}, model=${resolved.model})`);
    } else {
      // ACP
      try { execSync("pkill -f 'kiro-cli.*acp.*professor' 2>/dev/null || true", { timeout: 3000 }); } catch { /* ok */ }
      logInfo("main", `🔌 ACP transport (${resolved.provider.cli ?? "kiro-cli"}, model=${resolved.model})`);
      transport = createAgentTransport("professor", {
        cliPath: resolved.provider.cli ?? config.transport.agentCliPath,
        workingDir: config.transport.workingDir,
        agentCli: resolved.provider.cli ?? config.transport.agentCli,
        model: resolved.model,
      });
    }

    await transport.initialize();

    // Set system prompt for direct API transport
    if ("setSystemPrompt" in transport && typeof (transport as { setSystemPrompt: unknown }).setSystemPrompt === "function") {
      const { loadSoulBundle } = await import("./components/soul-loader.js");
      const soul = loadSoulBundle();
      if (soul) (transport as { setSystemPrompt: (p: string) => void }).setSystemPrompt(soul);
    }

    // Wrap with TransportManager if professor has fallbacks
    if (resolved.fallbacks.length > 0 && resolved.provider.transport !== "api") {
      // Non-API transports use TransportManager for fallback (API handles it internally via DirectApiTransport fallbacks)
      const { TransportManager } = await import("./components/transport/transport-manager.js");
      const fb = resolved.fallbacks[0]!;
      transport = new TransportManager(transport, {
        createFallback: async () => {
          const fbAgent = tc ? resolveAgent("_fb", { ...tc, agents: { ...tc.agents, _fb: { model: fb.model, provider: fb.provider } } }) : null;
          if (fbAgent?.provider.transport === "api") {
            const { DirectApiTransport } = await import("./components/transport/direct-api-transport.js");
            return new DirectApiTransport({
              endpoint: fbAgent.provider.endpoint!, apiKey: fbAgent.provider.apiKeyEnv ? process.env[fbAgent.provider.apiKeyEnv] : undefined,
              model: fb.model, maxContext: fbAgent.contextWindow, maxOutput: fbAgent.maxOutput, maxTurns: tc?.maxTurns ?? 50,
            });
          }
          return createAgentTransport("professor", { cliPath: fbAgent?.provider.cli ?? "kiro-cli", workingDir: config.transport.workingDir, model: fb.model });
        },
      });
      logInfo("main", `🛡️ Transport fallback: ${fb.model} via ${fb.provider}`);
    }

    this.transport = transport;
    logInfo("main", "✅ Transport ready");

    // Wire in-process memory for direct API transport
    if (resolved.provider.transport === "api" && this.memory) {
      const { setMemoryBackend } = await import("./components/transport/tool-registry.js");
      const { SqliteBackend } = await import("abmind/sqlite-backend.js");
      const backend = new SqliteBackend(this.memoryConfig);
      await backend.initialize();
      setMemoryBackend(backend);
      logInfo("main", "🧠 In-process memory wired to tool registry");
    }
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
        memory: this.memory ? { getStats: (chatId?: number) => this.memory!.getStats(chatId) } : null,
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

    this.dashboardServer = new DashboardServer({
      config: dashConfig,
      authGate,
      getStatus,
      registry: this.registry,
      memorySearchController,
      dashboardHtml,
    });

    await this.dashboardServer.start();
    logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort} (token: ${dashConfig.webAuthToken})`);
  }

  /** Collected registrations from all capabilities. */
  readonly capabilities: CapabilityRegistry = createCapabilityRegistry();

  /** Register a capability before start(). */
  registerCapability(fn: CapabilityRegisterFn): void {
    const api = createCapabilityApi(this.capabilities, this.config, this.memory, this.transport);
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
  const platforms = parsePlatformFlags();
  const config = await loadAndValidateConfig();
  if (platforms.transport) config.transport.agentTransport = platforms.transport;
  setLogLevel(config.logLevel);

  const memoryConfig = loadMemoryConfig();
  const bridge = new Bridge(config, memoryConfig);
  const startedAt = bridge.startedAt;

  const enabledList = [
    platforms.telegram && "telegram",
    platforms.discord && "discord",
  ].filter(Boolean).join(", ");
  logInfo("main", "──────────── BRIDGE START ────────────");
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${config.logLevel})`);

  // Truncate launchd.log on startup — bridge logger takes over, previous crash output already captured
  try { writeFileSync(join(agentBridgeHome(), "logs", "launchd.log"), "", "utf-8"); } catch { /* */ }
  // === CRITICAL PATH: Memory → Transport → Telegram (fastest path to accepting messages) ===

  await bridge.initMemory();
  const memory = bridge.memory;

  const conversationBuffer = new ConversationBuffer(50);

  // --- Pre-flight + transport init ---
  await bridge.initTransport();
  let transport = bridge.transport;

  // Wire fallback notification for direct API transport
  if ("onFallback" in transport) {
    (transport as unknown as { onFallback: (model: string, ctxPct: number) => void }).onFallback = (model, ctxPct) => {
      const msg = `⚡ Fallback: ${model}${ctxPct >= 0 ? ` (ctx: ~${ctxPct}%)` : ""}`;
      logInfo("main", msg);
      const chatId = [...config.telegram.allowedUserIds][0];
      if (chatId && bridge.telegramAdapter) {
        bridge.telegramAdapter.sendNotification(String(chatId), msg);
      }
    };
  }

  // Initialize context-window-start for all known chats
  if (memoryConfig.memoryEnabled) {
    for (const uid of config.telegram.allowedUserIds) updateCtxStart(memoryConfig.memoryDir, uid, startedAt);
  }

  // Sleep state
  // sleepChild tracked via sleepHandle (created after heartbeat start)
  let sleepHandle: import("./capabilities/sleep/index.js").SleepHandle | null = null;
  const isSleepActive = (): boolean => sleepHandle?.child !== null && sleepHandle?.child !== undefined && !sleepHandle.child.killed;
  const platformAdapters = new Map<string, import("./types/platform.js").PlatformAdapter>();
  const sleepAuditDir = join(memoryConfig.memoryDir, "sleep");

  const busyChats = new Set<string>();
  const pendingSessionStart = new Set<string>();
  const seenSessions = new Set<string>();
  const fullModeChats = new Set<string>();
  const codingModeManager = new CodingMode();
  const idleSave = new IdleSave(transport, memoryConfig.memoryDir, memoryConfig.memoryEnabled);
  const registry = bridge.registry;

  // STT/TTS config (lightweight — just reads env vars)
  const sttConfig: SttConfig | null = config.voice.sttEnabled
    ? { provider: "groq", apiKey: config.voice.groqApiKey, model: config.voice.sttModel }
    : null;
  const ttsConfig: TtsConfig | null = config.voice.ttsEnabled
    ? { voice: config.voice.ttsVoice }
    : null;

  const nlmConfig = loadNLMConfig();

  // CronQueue must be initialized before pipelineDeps (which references it)
  const cronQueue = new CronQueue(config.transport.agentCliPath, config.transport.workingDir, (entryId, command, result) => {
    const msg = `[System] Cron task "${entryId}" failed:\nCommand: ${command}\nResult: ${result}\n\nDiagnose and fix if possible. If you can't fix it, tell the user.`;
    transport.sendPrompt("system:cron-fix", msg).catch(err => {
      logWarn("main", `Cron auto-fix inject failed: ${err}`);
    });
  });

  // Wire task_manage --run to use the cron queue
  const { setEnqueueCron } = await import("./components/transport/tool-registry.js");
  const cronCallback: import("./components/cron/cron-queue.js").TaskCompleteCallback = (chatId, message, result) => {
    if (platforms.telegram && bridge.telegramAdapter) {
      bridge.telegramAdapter.sendMessage(String(chatId), `Cron: ${message}\n\n${result}`).catch(err => {
        logWarn("main", `Cron task TG report failed: ${err}`);
      });
    }
  };
  setEnqueueCron((id, manual) => {
    try {
      const entry = cronReadEntry(id);
      if (!entry) return `❌ Entry ${id} not found`;
      return cronQueue.enqueue(entry, cronCallback, manual);
    } catch (err) { return `❌ ${err instanceof Error ? err.message : String(err)}`; }
  });

  // Build pipeline deps (needed before platform start)
  const pipelineDeps: import("./components/message-pipeline.js").PipelineDeps = {
    transport, codingMode: codingModeManager, memory, memoryConfig, nlmConfig,
    idleSave, conversationBuffer, config: {
      agentTransport: config.transport.agentTransport,
      workingDir: config.transport.workingDir,
      discordA2aEnabled: config.discord.a2aEnabled,
      discordA2aChannelId: config.discord.a2aChannelId,
    }, startedAt,
    sttConfig, ttsConfig,
    busyChats, fullModeChats, pendingSessionStart, seenSessions, updateCtxStart,
    messageQueue: new Map(),
    cronCurrentJob: () => cronQueue.currentJob,
    enqueueCron: (entryId: string, manual?: boolean): string | null => {
      try {
        const entry = cronReadEntry(entryId);
        if (!entry) return `❌ Entry ${entryId} not found`;
        return cronQueue.enqueue(entry, cronCallback, manual);
      } catch (err) { return `❌ ${err instanceof Error ? err.message : String(err)}`; }
    },
    requestShutdown: () => process.exit(0),
    sleepProgress: () => sleepHandle?.progress ?? null,
    loadedCapabilities: [],
    selfHealerTask: null, // set after heartbeat registration
  };

  // Wire memory LLM callback + IPC server
  await bridge.wireMemory();

    // Unified heartbeat — single 5-min timer for all periodic tasks

  // --- Telegram service ---
  

  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("./platforms/telegram/telegram-adapter.js");
      bridge.telegramAdapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: pipelineDeps, conversationBuffer, transport, memory },
      );
      platformAdapters.set("telegram", bridge.telegramAdapter);
      return {
        async start() { await bridge.telegramAdapter!.start(); },
        stop() { bridge.telegramAdapter?.stop(); platformAdapters.delete("telegram"); bridge.telegramAdapter = null; },
      };
    },
  });

  if (platforms.telegram) {
    const result = await registry.start("telegram");
    if (result.ok) {
      logInfo("main", "📡 Telegram polling started");
    } else {
      logError("main", `Telegram failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Telegram disabled (no --telegram flag)");
  }

  // --- Discord service ---
  

  registry.register("discord", {
    configured: Boolean(config.discord.enabled && config.discord.botToken),
    async create() {
      const { DiscordAdapter } = await import("./platforms/discord/discord-adapter.js");
      bridge.discordAdapter = new DiscordAdapter(
        {
          botToken: config.discord.botToken!,
          appId: config.discord.appId!,
          allowedUserIds: config.discord.allowedUserIds!,
          allowedChannelIds: config.discord.allowedChannelIds!,
          a2aEnabled: config.discord.a2aEnabled,
          a2aChannelId: config.discord.a2aChannelId,
          a2aPeerBotId: config.discord.a2aPeerBotId,
          a2aRateLimitMs: config.discord.a2aRateLimitMs,
        },
        { pipeline: pipelineDeps, transport, memory, conversationBuffer },
      );
      platformAdapters.set("discord", bridge.discordAdapter);
      return {
        async start() { await bridge.discordAdapter!.start(); },
        stop() { bridge.discordAdapter?.stop(); platformAdapters.delete("discord"); bridge.discordAdapter = null; },
      };
    },
  });

  if (platforms.discord) {
    const result = await registry.start("discord");
    if (result.ok) {
      logInfo("main", "📡 Discord polling started");
    } else if (result.error?.includes("not configured")) {
      logWarn("main", "Discord flag set but not configured — skipping");
    } else {
      logError("main", `Discord failed to start: ${result.error}`);
    }
  } else {
    logInfo("main", "📡 Discord disabled (no --discord/--all flag)");
  }

  // === DEFERRED INIT: non-critical services (after platforms are accepting messages) ===

  // Auto-discover capabilities (browser, hotskills, etc.)
  const { discoverCapabilities } = await import("./capabilities/capability.js");
  const capDir = join(import.meta.dirname, "capabilities");
  const loaded = await discoverCapabilities(bridge.capabilities, config, memory, transport, capDir);
  if (loaded.length > 0) {
    logInfo("main", `🔌 Capabilities: ${loaded.join(", ")}`);
    pipelineDeps.loadedCapabilities = ["sleep", ...loaded];
  }

  // MCP daemon
  // mcpDaemonStarted is on bridge
  if (config.mcpDaemon) {
    try {
      execFileSync("mcporter", ["daemon", "start"], { stdio: "pipe" });
      bridge.mcpDaemonStarted = true;
      logInfo("main", "🔌 mcporter daemon started");
    } catch {
      logWarn("main", "mcporter not found or daemon start failed — skipping");
    }
  }

  if (sttConfig) logInfo("main", `🎤 STT enabled (${sttConfig.provider}/${sttConfig.model || "whisper-large-v3"})`);
  if (ttsConfig) logInfo("main", `🔊 TTS enabled (Edge TTS / ${ttsConfig.voice})`);

  // --- Startup notification (async, non-blocking) ---
  if (memoryConfig.memoryEnabled) {
    const tgSend = bridge.telegramAdapter ? async (msg: string): Promise<void> => {
      const chatId = [...config.telegram.allowedUserIds][0];
      if (chatId) await bridge.telegramAdapter!.sendMessage(String(chatId), msg);
    } : undefined;
    const dcSend = bridge.discordAdapter ? async (msg: string): Promise<void> => {
      const channelId = config.discord.allowedChannelIds ? [...config.discord.allowedChannelIds][0] : undefined;
      if (channelId) await bridge.discordAdapter!.sendMessage(channelId, msg);
    } : undefined;
    sendBackOnline(tgSend, dcSend).catch((err) => {
      logWarn("main", `Back online notification error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Start session: inject SOUL + context + greeting, push response to Telegram
    if (bridge.telegramAdapter && memory) {
      const chatId = [...config.telegram.allowedUserIds][0];
      if (chatId) {
        const sessionKey = `telegram:${chatId}`;
        seenSessions.add(sessionKey);
        busyChats.add(sessionKey);
        startSession(
          transport, memory, chatId, sessionKey,
          "You just came online. Output ONLY a personalized greeting message.",
          (text) => (bridge.telegramAdapter as import("./platforms/telegram/telegram-adapter.js").TelegramAdapter).sendMessage(String(chatId), text),
        ).then(() => {
          logInfo("main", "✅ Startup session ready");
        }).catch(err => {
          logWarn("main", `Startup greeting failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
        }).finally(() => {
          busyChats.delete(sessionKey);
        });
      }
    }
  }

  // bridge.lock — track bridge lifecycle
  const bridgeLockPath = join(agentBridgeHome(), "bridge.lock");
  try {
    let version = "?";
    try { version = JSON.parse(readFileSync(join(import.meta.dirname, "..", "build-info.json"), "utf-8")).hash; } catch { /* */ }
    writeFileSync(bridgeLockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now(), version, sleepStatus: "awake" }), "utf-8");
  } catch { /* */ }

  const hbIntervalMs = (parseInt(process.env["HEARTBEAT_INTERVAL"] ?? "", 10) || 300) * 1000;

  // Watchdog: wall-clock comparison (immune to setInterval batching after sleep)
  const WD_THRESHOLD_MS = hbIntervalMs * 3;
  let lastKickAt = Date.now();
  const kickWatchdog = (): void => { lastKickAt = Date.now(); };

  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    bridgeLockPath,
    sleepActive: isSleepActive,
    onTick: kickWatchdog,
    onStandbyResume: (gapMs) => {
      const resumeKind = classifyResume();
      if (resumeKind === "dark") {
        logDebug("main", `⏸️ Darkwake resume (${Math.round(gapMs / 60000)}min) — skipping tick`);
        return;
      }
      logInfo("main", `⏸️ Standby resume (${Math.round(gapMs / 60000)}min, ${resumeKind}) — continuing`);
      // Morning restart: first full wake after hardware sleep → fresh process
      if (resumeKind === "full" && readBridgeLockField("sleepStatus") === "hw_sleep") {
        writeSleepStatus("awake");
        writeRestartReason("morning restart after hw_sleep");
        logInfo("main", "🌅 Morning wake detected — restarting for fresh process");
        process.exit(0);
      }
    },
  });

  heartbeat.registerTask({
    name: "tasks",
    execute: async () => {
      const dueTasks = checkCron();
      for (const entry of dueTasks) cronQueue.enqueue(entry, cronCallback);
    },
  });

  // browse-checker is now registered by browser capability

  // skill-reloader is now registered by skills capability

  heartbeat.registerTask({
    name: "reminder-injector",
    execute: async () => {
      const reminders = readPendingReminders();
      if (reminders.length === 0) return;
      clearPendingReminders();
      for (const r of reminders) {
        logInfo("main", `⏰ Injecting reminder for chat ${r.chatId}: "${r.message}"`);
        if (bridge.telegramAdapter) {
          bridge.telegramAdapter.injectMessage({
            platform: "telegram",
            channelId: String(r.chatId),
            sessionKey: `telegram:${r.chatId}`,
            senderId: String(r.chatId),
            senderName: "cron",
            text: `[Scheduled reminder] ${r.message}`,
            timestamp: Date.now(),
            threadId: r.threadId ? String(r.threadId) : undefined,
            isGroup: false,
            isVoice: false,
          });
        }
      }
    },
  });

  // --- DB integrity check (hourly) ---
  const SLEEP_HOUR = parseInt(process.env["BED_TIME"]?.split(":")[0] ?? "2", 10);
  const SLEEP_MINUTE = parseInt(process.env["BED_TIME"]?.split(":")[1] ?? "0", 10);

  // --- Floating compaction (idle-triggered) ---
  if (parseInt(process.env["CTX_IDLE_COMPACT_MIN"] ?? "10", 10) > 0) {
    heartbeat.registerTask(createIdleCompactTask({
      transport, memory, memoryDir: memoryConfig.memoryDir,
      allowedUserIds: config.telegram.allowedUserIds, busyChats, pendingSessionStart, isSleepActive,
    }));
  }

  // --- System message sender (generic, any component can use) ---
  const { initSystemMessage, sendSystemMessage } = await import("./components/system-message.js");
  const primaryChatId = String([...config.telegram.allowedUserIds][0] ?? "");
  initSystemMessage(async (prompt: string) => {
    try {
      const response = await transport.sendPrompt(primaryChatId, `[SYSTEM] ${prompt}`);
      if (response && bridge.telegramAdapter) {
        await bridge.telegramAdapter.sendNotification(primaryChatId, response);
      }
    } catch (err) {
      logWarn("main", `System message failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // --- Daily cycle: spawn Dreamy after BED_TIME + quiet ticks ---
  heartbeat.registerTask(createAgeCheckTask({
    memory, bridgeLockPath, sleepAuditDir, sleepHour: SLEEP_HOUR, sleepMinute: SLEEP_MINUTE, busyChats, isSleepActive,
    doctorPath: join(agentBridgeHome(), "scripts", "doctor.sh"),
    startSleep: () => { sleepHandle?.spawn(); },
    checkHwSleep: (qt, rt) => { sleepHandle?.checkHwSleep(qt, rt); },
  }));

  heartbeat.registerTask(createDbIntegrityTask(memory));

  // --- Watchdog: detect stuck agent ---
  if (transport.healthCheck) {
    heartbeat.registerTask({ name: "transport-health", execute: () => transport.healthCheck!() });
  }

  // --- Heartbeat watchdog timer: wall-clock comparison ---
  const WD_CHECK_INTERVAL = 60_000;
  const WD_UNKNOWN_SUPPRESS_MS = 60 * 60_000; // 1hr

  setInterval(() => {
    const elapsed = Date.now() - lastKickAt;
    if (elapsed <= WD_THRESHOLD_MS) return;
    const kind = classifyResume();
    if (kind === "dark" || (kind === "unknown" && elapsed < WD_UNKNOWN_SUPPRESS_MS)) {
      lastKickAt = Date.now();
      return;
    }
    logWarn("watchdog", `No heartbeat kick for ${Math.round(elapsed / 60000)}min (${kind}) — forcing restart`);
    writeRestartReason("watchdog: no heartbeat kick");
    process.exit(1);
  }, WD_CHECK_INTERVAL);

  // --- Restart flag check ---
  heartbeat.registerTask({
    name: "restart-check",
    execute: async () => {
      const req = readAndClearRestartRequested();
      if (req) {
        logInfo("restart-check", `Restart requested: ${req}`);
        process.exit(0);
      }
    },
  });

  // --- Self-healing agent: error scanner ---
  let selfHealerTask: ReturnType<typeof createSelfHealerTask> | null = null;
  if (process.env["SELFHEAL_ENABLED"] !== "false") {
    selfHealerTask = createSelfHealerTask(() => bridge.telegramAdapter, config.telegram.allowedUserIds);
    heartbeat.registerTask(selfHealerTask);
  }
  bridge.selfHealerTask = selfHealerTask;
  pipelineDeps.selfHealerTask = selfHealerTask;

  // Run once on startup, then start periodic
  // Wire capability-registered commands
  const { registerCommand } = await import("./components/command-handlers.js");
  for (const [name, handler] of bridge.capabilities.commands) {
    registerCommand(name, handler);
  }

  // Wire capability-registered heartbeat tasks
  for (const task of bridge.capabilities.heartbeatTasks) {
    heartbeat.registerTask(task);
  }

  // Model health check — runs once on first tick, skipped on dark wake (dark wake skips all tasks)
  let modelHealthDone = false;
  heartbeat.registerTask({
    name: "model-health",
    execute: async () => {
      if (modelHealthDone) return;
      modelHealthDone = true;
      if (config.transport.agentTransport !== "api") return; // only ping Direct API models
      const { loadTransport, resolveAgent } = await import("./components/transport-config.js");
      const tc = loadTransport();
      if (!tc) return;
      const agents = ["professor", "dreamy", "browsie", "coding"] as const;
      const models: Array<{ label: string; model: string }> = [];
      for (const a of agents) {
        const r = resolveAgent(a, tc);
        if (r && !models.some(m => m.model === r.model)) {
          models.push({ label: a, model: r.model });
        }
      }
      const prof = resolveAgent("professor", tc);
      const endpoint = prof?.provider.endpoint ?? "http://localhost:11434/v1";
      const apiKey = prof?.provider.apiKeyEnv ? process.env[prof.provider.apiKeyEnv] : process.env["API_KEY"];
      const warnings: string[] = [];
      for (const { label, model } of models) {
        try {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            warnings.push(`⚠️ ${label}=${model} — ${res.status} ${res.statusText}`);
            logWarn("model-health", `${label}=${model} failed: ${res.status}`);
          } else {
            logInfo("model-health", `✓ ${label}=${model}`);
          }
        } catch (err) {
          warnings.push(`⚠️ ${label}=${model} — ${err instanceof Error ? err.message : String(err)}`);
          logWarn("model-health", `${label}=${model} unreachable: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (warnings.length > 0 && bridge.telegramAdapter) {
        bridge.telegramAdapter.sendNotification(primaryChatId, `🏥 Model health check:\n${warnings.join("\n")}\nSubagents will fall back to main model.`);
      }
    },
  });

  const { checkBrowseTasks } = await import("./capabilities/browser/browse-delivery.js");
  checkBrowseTasks();
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", "💓 Heartbeat started (5-min interval)");

  // --- Sleep capability (background, with retry) ---
  const { createSleepHandle } = await import("./capabilities/sleep/index.js");
  const { killWakeInhibit } = await import("./components/command-handlers.js");
  sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    onComplete: () => resetAllCtxStarts(memoryConfig.memoryDir),
    getLastMsgTs: () => memory?.getLastMessageTimestamp(true) ?? 0,
    sendSystemMessage,
    killWakeInhibit,
  });
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
