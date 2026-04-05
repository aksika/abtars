import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readEntry as cronReadEntry } from "./components/cron-db.js";
import { execFileSync, execSync } from "node:child_process";
import { loadAndValidateConfig } from "./components/config.js";
import { agentBridgeHome } from "./paths.js";

import { TmuxClient } from "./components/tmux-client.js";
import { AcpTransport } from "./components/acp-transport.js";
import { createWatchdogTask } from "./components/watchdog.js";
import { createSelfHealerTask } from "./components/self-healer.js";
import { createIdleCompactTask, createAgeCheckTask, createDbIntegrityTask } from "./components/heartbeat-tasks.js";
import type { SttConfig } from "./components/stt.js";
import type { TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, logDebug } from "./components/logger.js";
import { loadMemoryConfig } from "./memory/memory-config.js";
import { MemoryManager } from "./memory/memory-manager.js";
import { ConversationBuffer } from "./components/conversation-buffer.js";
import type { IKiroTransport } from "./components/kiro-transport.js";
import { parsePlatformFlags } from "./components/cli-flags.js";
import { loadDashboardConfig, validateDashboardConfig, buildStatusSnapshot } from "./components/dashboard-config.js";
import type { SubsystemRefs } from "./components/dashboard-config.js";
import { AuthGate } from "./components/auth-gate.js";
import { ServiceRegistry } from "./components/service-registry.js";
import { MemorySearchController } from "./components/memory-search-controller.js";
import { DashboardServer } from "./components/dashboard-server.js";
import { renderDashboardHtml } from "./components/dashboard-ui.js";
import { loadNLMConfig } from "./components/nlm-command-handler.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { writeRestartReason } from "./components/restart-reason.js";
import { isDailyCycleDue } from "./components/daily-cycle.js";
import { classifyResume } from "./components/platform-detect.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { loadAgentApiConfig } from "./components/agent-api-config.js";
import { BrowserManager } from "./components/browser-manager.js";
import { BrowserIpcServer } from "./components/browser-ipc-server.js";
import { CodingMode } from "./components/coding-mode.js";
import { IdleSave } from "./components/idle-save.js";
import { checkCron, checkBrowseTasks, readPendingReminders, clearPendingReminders } from "./components/cron-checker.js";
import { CronQueue } from "./components/cron-queue.js";
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
import type { MemoryConfig } from "./memory/memory-config.js";
import type { PipelineDeps } from "./components/message-pipeline.js";
import { createCapabilityRegistry, createCapabilityApi } from "./capabilities/capability.js";
import type { CapabilityRegistry, CapabilityRegisterFn } from "./capabilities/capability.js";

/**
 * Bridge — owns the lifecycle of all subsystems.
 * Created by startBridge(), exposes subsystems for the future plugin system.
 */
export class Bridge {
  readonly config: Config;
  readonly memoryConfig: MemoryConfig;
  readonly startedAt = Date.now();

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

  constructor(config: Config, memoryConfig: MemoryConfig) {
    this.config = config;
    this.memoryConfig = memoryConfig;
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
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${config.logLevel})`);

  // === CRITICAL PATH: Memory → Transport → Telegram (fastest path to accepting messages) ===

  // Initialize memory layer
  let memory: MemoryManager | null = null;
  if (memoryConfig.memoryEnabled) {
    memory = new MemoryManager(memoryConfig);
    await memory.initialize();
    bridge.memory = memory;
    logInfo("main", `🧠 Memory enabled (dir=${memoryConfig.memoryDir})`);
  } else {
    logInfo("main", "🧠 Memory disabled");
  }

  const conversationBuffer = new ConversationBuffer(50);

  // --- Pre-flight: start external services ---
  if (config.transport.agentTransport === "tmux") {
    logInfo("main", `♻️  Starting tmux session '${config.transport.tmuxSession}'...`);
    try {
      execFileSync(join(import.meta.dirname, "..", "scripts", "tmux-session.sh"), { stdio: "pipe" });
    } catch (err) {
      logError("main", "tmux session start failed", err);
    }
  }

  let transport: IKiroTransport;
  if (config.transport.agentTransport === "tmux") {
    logInfo("main", `🖥️  tmux transport (session: ${config.transport.tmuxSession})`);
    transport = new TmuxClient(
      config.transport.tmuxSession,
      config.transport.tmuxCaptureDelaySec,
      config.transport.tmuxMaxWaitSec,
    );
  } else {
    // Kill orphaned processes from previous runs
    try { execSync("pkill -f 'kiro-cli.*acp.*professor' 2>/dev/null || true", { timeout: 3000 }); } catch { /* ok */ }
    logInfo("main", `🔌 ACP transport (${config.transport.agentCli})`);

    // Build CLI args based on which CLI is selected
    const cliArgs = config.transport.agentCli === "gemini"
      ? ["--acp", "-y"]
      : undefined; // kiro and custom CLIs use default "acp" subcommand

    transport = new AcpTransport(config.transport.agentCliPath, config.transport.workingDir, {
      model: config.models.agentModel || undefined,
      cliArgs,
    });
  }
  await transport.initialize();
  bridge.transport = transport;
  logInfo("main", "✅ Transport ready");

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
  const codingModeManager = new CodingMode(config.transport.agentCliPath, config.transport.workingDir, config.models.codingModel);
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
    enqueueCron: (entryId: string): string | null => {
      try {
        const entry = cronReadEntry(entryId);
        if (!entry) return `❌ Entry ${entryId} not found`;
        cronQueue.enqueue(entry, cronCallback);
        return null;
      } catch (err) { return `❌ ${err instanceof Error ? err.message : String(err)}`; }
    },
    requestShutdown: () => process.exit(0),
  };

  // Wire LLM callback into memory so compaction and context assembly can use the LLM
  if (memory) {
    memory.setLlmCall(async (prompt: string, content: string) => {
      return transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
    });
    logInfo("main", "🧠 Memory LLM callback registered");
  }

    // Unified heartbeat — single 5-min timer for all periodic tasks

  // --- Telegram service ---
  let telegramAdapter: import("./platforms/telegram-adapter.js").TelegramAdapter | null = null;

  registry.register("telegram", {
    configured: Boolean(config.telegram.botToken && config.telegram.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("./platforms/telegram-adapter.js");
      telegramAdapter = new TelegramAdapter(
        { botToken: config.telegram.botToken, allowedUserIds: config.telegram.allowedUserIds, pollTimeoutS: config.telegram.pollTimeoutS },
        { pipeline: pipelineDeps, conversationBuffer, transport, memory },
      );
      platformAdapters.set("telegram", telegramAdapter);
      return {
        async start() { await telegramAdapter!.start(); },
        stop() { telegramAdapter?.stop(); platformAdapters.delete("telegram"); telegramAdapter = null; },
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
  let discordAdapter: import("./platforms/discord-adapter.js").DiscordAdapter | null = null;

  registry.register("discord", {
    configured: Boolean(config.discord.enabled && config.discord.botToken),
    async create() {
      const { DiscordAdapter } = await import("./platforms/discord-adapter.js");
      discordAdapter = new DiscordAdapter(
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
      platformAdapters.set("discord", discordAdapter);
      return {
        async start() { await discordAdapter!.start(); },
        stop() { discordAdapter?.stop(); platformAdapters.delete("discord"); discordAdapter = null; },
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

  // Browser capability (lazy — IPC starts on first browse task)
  const { register: registerBrowser } = await import("./capabilities/browser/index.js");
  bridge.registerCapability(registerBrowser);

  // Skills capability (hot-reload)
  const { register: registerSkills } = await import("./capabilities/skills/index.js");
  bridge.registerCapability(registerSkills);

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
    const tgSend = telegramAdapter ? async (msg: string): Promise<void> => {
      const chatId = [...config.telegram.allowedUserIds][0];
      if (chatId) await telegramAdapter!.sendMessage(String(chatId), msg);
    } : undefined;
    const dcSend = discordAdapter ? async (msg: string): Promise<void> => {
      const channelId = config.discord.allowedChannelIds ? [...config.discord.allowedChannelIds][0] : undefined;
      if (channelId) await discordAdapter!.sendMessage(channelId, msg);
    } : undefined;
    sendBackOnline(tgSend, dcSend).catch((err) => {
      logWarn("main", `Back online notification error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Start session: inject SOUL + context + greeting, push response to Telegram
    if (telegramAdapter && memory) {
      const chatId = [...config.telegram.allowedUserIds][0];
      if (chatId) {
        const sessionKey = `telegram:${chatId}`;
        seenSessions.add(sessionKey);
        busyChats.add(sessionKey);
        startSession(
          transport, memory, chatId, sessionKey,
          "You just came online. Output ONLY a personalized greeting message.",
          (text) => (telegramAdapter as import("./platforms/telegram-adapter.js").TelegramAdapter).sendMessage(String(chatId), text),
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
  try { writeFileSync(bridgeLockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8"); } catch { /* */ }

  const hbIntervalMs = (parseInt(process.env["HEARTBEAT_INTERVAL"] ?? "", 10) || 300) * 1000;
  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    sleepActive: isSleepActive,
    onStandbyResume: (gapMs) => {
      // L1: Platform-specific check
      const resumeKind = classifyResume();
      if (resumeKind === "dark") {
        logDebug("main", `⏸️ Darkwake resume (${Math.round(gapMs / 60000)}min) — skipping`);
        return;
      }

      // L2: Daily cycle check
      if (isDailyCycleDue({ sleepHour: SLEEP_HOUR, bridgeLockPath, memory, busyChats, isSleepActive })) {
        logInfo("main", `🔄 Standby resume (${Math.round(gapMs / 60000)}min) + daily cycle due — restarting`);
        writeRestartReason(`daily-cycle: standby-resume ${Math.round(gapMs / 60000)}min`);
        try { unlinkSync(bridgeLockPath); } catch { /* */ }
        process.exit(0);
      }

      logDebug("main", `⏸️ Standby resume (${Math.round(gapMs / 60000)}min) — continuing`);
    },
  });

  const cronCallback = (chatId: number, message: string, result: string): void => {
    if (platforms.telegram && telegramAdapter) {
      telegramAdapter.sendMessage(String(chatId), `Cron: ${message}\n\n${result}`).catch(err => {
        logWarn("main", `Cron task TG report failed: ${err}`);
      });
    }
  };

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
        if (telegramAdapter) {
          telegramAdapter.injectMessage({
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
  const SLEEP_HOUR = parseInt(process.env["SLEEP_TIME"]?.split(":")[0] ?? "6", 10);

  // --- Floating compaction (idle-triggered) ---
  if (parseInt(process.env["CTX_IDLE_COMPACT_MIN"] ?? "10", 10) > 0) {
    heartbeat.registerTask(createIdleCompactTask({
      transport, memory, memoryDir: memoryConfig.memoryDir,
      allowedUserIds: config.telegram.allowedUserIds, busyChats, pendingSessionStart, isSleepActive,
    }));
  }

  // --- Daily cycle: restart after SLEEP_TIME ---
  heartbeat.registerTask(createAgeCheckTask({
    memory, bridgeLockPath, sleepHour: SLEEP_HOUR, busyChats, isSleepActive,
    doctorPath: join(agentBridgeHome(), "scripts", "doctor.sh"),
  }));

  heartbeat.registerTask(createDbIntegrityTask(memory));

  // --- Watchdog: detect stuck agent ---
  if (transport instanceof AcpTransport) {
    heartbeat.registerTask(createWatchdogTask(transport, () => process.exit(0)));
  }

  // --- Restart flag check ---
  heartbeat.registerTask({
    name: "restart-check",
    execute: async () => {
      const flag = join(agentBridgeHome(), ".restart-requested");
      if (existsSync(flag)) {
        const reason = readFileSync(flag, "utf-8").trim();
        logInfo("restart-check", `Restart requested: ${reason}`);
        unlinkSync(flag);
        process.exit(0);
      }
    },
  });

  // --- Self-healing agent: error scanner ---
  if (process.env["SELFHEAL_ENABLED"] !== "false") {
    heartbeat.registerTask(createSelfHealerTask(() => telegramAdapter, config.telegram.allowedUserIds));
  }

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

  checkBrowseTasks();
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", "💓 Heartbeat started (5-min interval)");

  // --- Sleep capability (background, with retry) ---
  const { createSleepHandle } = await import("./capabilities/sleep/index.js");
  sleepHandle = createSleepHandle({
    sleepHour: SLEEP_HOUR,
    sleepAuditDir,
    memoryEnabled: memoryConfig.memoryEnabled,
    onComplete: () => resetAllCtxStarts(memoryConfig.memoryDir),
  });
  sleepHandle.spawn();

  // --- Web Dashboard wiring (conditional) ---
  let dashboardServer: DashboardServer | null = null; // local ref, wired to bridge at end

  if (platforms.web) {
    const dashConfig = loadDashboardConfig(process.env);
    try {
      validateDashboardConfig(dashConfig, true);
    } catch (err) {
      logError("main", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    // Read logo and base64-encode
    let logoBase64 = "";
    try {
      const logoPath = join(process.cwd(), "logo", "KiroProfessor.jpg");
      logoBase64 = readFileSync(logoPath).toString("base64");
    } catch (err) {
      logWarn("main", `Could not read logo: ${err instanceof Error ? err.message : String(err)}`);
    }

    const agentApiOpts = platforms.agent
      ? (() => { try { return loadAgentApiConfig(process.env as Record<string, string | undefined>); } catch { return undefined; } })()
      : undefined;
    const dashboardHtml = renderDashboardHtml(logoBase64, agentApiOpts ? { agentApi: { port: agentApiOpts.port, allowedIps: agentApiOpts.allowedIps } } : undefined);

    // Build getStatus function that assembles StatusSnapshot from all subsystem refs
    const getStatus = () => {
      const svcStates = registry.getStates();
      const refs: SubsystemRefs = {
        startedAt,
        telegramPoller: {
          running: svcStates.telegram?.running ?? false,
        },
        discordPoller: {
          started: svcStates.discord?.running ?? false,
        },
        services: svcStates,
        transport: {
          type: config.transport.agentTransport as "tmux" | "acp",
          isReady: transport.isReady,
          contextPercent: transport.contextPercent,
        },
        memory: memory
          ? { getStats: (chatId?: number) => memory!.getStats(chatId) }
          : null,
        heartbeat: memory
          ? {
              running: memory.getStats()?.heartbeatRunning ?? false,
              intervalMs: heartbeat.intervalMs,
              tasks: heartbeat.getTaskNames().map(n => ({ name: n })),
            }
          : null,
        notebooklm: nlmConfig.enabled,
        agentApi: agentApiServer ? { getTrafficLog: () => agentApiServer!.getTrafficLog() } : null,
      };
      return buildStatusSnapshot(refs);
    };

    const authGate = new AuthGate(dashConfig.webAuthToken);
    const memorySearchController = memory
      ? new MemorySearchController({
          memoryIndex: memory.getMemoryIndex()!,
          db: memory.getDatabase()!,
          memoryDir: memoryConfig.memoryDir,
          ctxStartPath: join(memoryConfig.memoryDir, "context-window-start.json"),
        })
      : null;

    dashboardServer = new DashboardServer({
      config: dashConfig,
      authGate,
      getStatus,
      registry,
      memorySearchController,
      dashboardHtml,
    });

    await dashboardServer.start();
    logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort} (token: ${dashConfig.webAuthToken})`);
  }

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
  bridge.dashboardServer = dashboardServer;
  bridge.agentApiServer = agentApiServer;
  bridge.heartbeat = heartbeat;
  bridge.cronQueue = cronQueue;

  process.on("SIGINT", () => void bridge.shutdown());
  process.on("SIGTERM", () => void bridge.shutdown());
}
