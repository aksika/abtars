import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { readEntry as cronReadEntry } from "./components/cron-db.js";
import { spawn, execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAndValidateConfig } from "./components/config.js";
import { AGENT_BRIDGE_HOME } from "./components/config.js";

import { TmuxClient } from "./components/tmux-client.js";
import { AcpTransport } from "./components/acp-transport.js";
import { createWatchdogTask } from "./components/watchdog.js";
import { createSelfHealerTask } from "./components/self-healer.js";
import type { SttConfig } from "./components/stt.js";
import type { TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, logDebug } from "./components/logger.js";
import { loadMemoryConfig } from "./components/memory-config.js";
import { MemoryManager } from "./components/memory-manager.js";
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
import { hasSleepAuditToday } from "./components/sleep-trigger.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { SkillWatcher } from "./components/skill-watcher.js";
import { writeRestartReason } from "./components/restart-reason.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { loadAgentApiConfig } from "./components/agent-api-config.js";
import { BrowserManager } from "./components/browser-manager.js";
import { BrowserTool } from "./components/browser-tool.js";
import { BrowserIpcServer } from "./components/browser-ipc-server.js";
import { DomainAllowlist } from "./components/domain-allowlist.js";
import { CodingMode } from "./components/coding-mode.js";
import { IdleSave } from "./components/idle-save.js";
import { checkCron, checkBrowseTasks, readPendingReminders, clearPendingReminders } from "./components/cron-checker.js";
import { CronQueue } from "./components/cron-queue.js";
import { runCompaction } from "./components/compaction.js";
import { compactingSessions, setIdleCompactReset, startSession } from "./components/message-pipeline.js";


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

export async function startBridge(): Promise<void> {
  const startedAt = Date.now();
  const platforms = parsePlatformFlags();
  const config = await loadAndValidateConfig();
  if (platforms.transport) config.agentTransport = platforms.transport;
  setLogLevel(config.logLevel);

  const enabledList = [
    platforms.telegram && "telegram",
    platforms.discord && "discord",
  ].filter(Boolean).join(", ");
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${config.logLevel})`);

  // === CRITICAL PATH: Memory → Transport → Telegram (fastest path to accepting messages) ===

  // Initialize memory layer
  const memoryConfig = loadMemoryConfig();
  let memory: MemoryManager | null = null;
  if (memoryConfig.memoryEnabled) {
    memory = new MemoryManager(memoryConfig);
    await memory.initialize();
    logInfo("main", `🧠 Memory enabled (dir=${memoryConfig.memoryDir})`);
  } else {
    logInfo("main", "🧠 Memory disabled");
  }

  const conversationBuffer = new ConversationBuffer(50);

  // --- Pre-flight: start external services ---
  if (config.agentTransport === "tmux") {
    logInfo("main", `♻️  Starting tmux session '${config.tmuxSession}'...`);
    try {
      execFileSync(join(import.meta.dirname, "..", "scripts", "tmux-session.sh"), { stdio: "pipe" });
    } catch (err) {
      logError("main", "tmux session start failed", err);
    }
  }

  let transport: IKiroTransport;
  if (config.agentTransport === "tmux") {
    logInfo("main", `🖥️  tmux transport (session: ${config.tmuxSession})`);
    transport = new TmuxClient(
      config.tmuxSession,
      config.tmuxCaptureDelaySec,
      config.tmuxMaxWaitSec,
    );
  } else {
    // Kill orphaned processes from previous runs
    try { execSync("pkill -f 'kiro-cli.*acp.*professor' 2>/dev/null || true", { timeout: 3000 }); } catch { /* ok */ }
    logInfo("main", `🔌 ACP transport (${config.agentCli})`);

    // Build CLI args based on which CLI is selected
    const cliArgs = config.agentCli === "gemini"
      ? ["--acp", "-y"]
      : undefined; // kiro and custom CLIs use default "acp" subcommand

    transport = new AcpTransport(config.agentCliPath, config.workingDir, {
      model: config.agentModel || undefined,
      cliArgs,
    });
  }
  await transport.initialize();
  logInfo("main", "✅ Transport ready");

  // Initialize context-window-start for all known chats
  if (memoryConfig.memoryEnabled) {
    for (const uid of config.allowedUserIds) updateCtxStart(memoryConfig.memoryDir, uid, startedAt);
  }

  // Sleep state
  let sleepChild: import("node:child_process").ChildProcess | null = null;
  const platformAdapters = new Map<string, import("./types/platform.js").PlatformAdapter>();
  const sleepAuditDir = join(memoryConfig.memoryDir, "sleep");

  const busyChats = new Set<string>();
  const pendingSessionStart = new Set<string>();
  const seenSessions = new Set<string>();
  const fullModeChats = new Set<string>();
  const codingModeManager = new CodingMode(config.agentCliPath, config.workingDir, config.agentCodingModel);
  const idleSave = new IdleSave(transport, memoryConfig.memoryDir, memoryConfig.memoryEnabled);
  const registry = new ServiceRegistry();

  // STT/TTS config (lightweight — just reads env vars)
  const sttConfig: SttConfig | null = config.sttEnabled
    ? { provider: "groq", apiKey: config.groqApiKey, model: config.sttModel }
    : null;
  const ttsConfig: TtsConfig | null = config.ttsEnabled
    ? { voice: config.ttsVoice }
    : null;

  const nlmConfig = loadNLMConfig();

  // CronQueue must be initialized before pipelineDeps (which references it)
  const cronQueue = new CronQueue(config.agentCliPath, config.workingDir, (entryId, command, result) => {
    const msg = `[System] Cron task "${entryId}" failed:\nCommand: ${command}\nResult: ${result}\n\nDiagnose and fix if possible. If you can't fix it, tell the user.`;
    transport.sendPrompt("system:cron-fix", msg).catch(err => {
      logWarn("main", `Cron auto-fix inject failed: ${err}`);
    });
  });

  // Build pipeline deps (needed before platform start)
  const pipelineDeps: import("./components/message-pipeline.js").PipelineDeps = {
    transport, codingMode: codingModeManager, memory, memoryConfig, nlmConfig,
    idleSave, conversationBuffer, config, startedAt,
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
  };

  // Wire LLM callback into memory so compaction and context assembly can use the LLM
  if (memory) {
    memory.setLlmCall(async (prompt: string, content: string) => {
      return transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
    });
    memory.setIsBusy(() => busyChats.size > 0);
    logInfo("main", "🧠 Memory LLM callback registered");
  }

    // Unified heartbeat — single 5-min timer for all periodic tasks

  // --- Telegram service ---
  let telegramAdapter: import("./platforms/telegram-adapter.js").TelegramAdapter | null = null;

  registry.register("telegram", {
    configured: Boolean(config.telegramBotToken && config.allowedUserIds.size > 0),
    async create() {
      const { TelegramAdapter } = await import("./platforms/telegram-adapter.js");
      telegramAdapter = new TelegramAdapter(
        { botToken: config.telegramBotToken, allowedUserIds: config.allowedUserIds, pollTimeoutS: config.pollTimeoutS },
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
    configured: Boolean(config.discordEnabled && config.discordBotToken),
    async create() {
      const { DiscordAdapter } = await import("./platforms/discord-adapter.js");
      discordAdapter = new DiscordAdapter(
        {
          botToken: config.discordBotToken!,
          appId: config.discordAppId!,
          allowedUserIds: config.discordAllowedUserIds!,
          allowedChannelIds: config.discordAllowedChannelIds!,
          a2aEnabled: config.discordA2aEnabled,
          a2aChannelId: config.discordA2aChannelId,
          a2aPeerBotId: config.discordA2aPeerBotId,
          a2aRateLimitMs: config.discordA2aRateLimitMs,
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

  // Browser (lazy — IPC starts on first browse task)
  const browserManager = new BrowserManager();
  const allowlist = DomainAllowlist.fromEnv();
  const browserTool = new BrowserTool(browserManager, allowlist);
  let browserIpc: BrowserIpcServer | null = null;
  const ensureBrowserIpc = async (): Promise<void> => {
    if (browserIpc || process.env["BROWSER_DOCKER"] === "1") return;
    browserIpc = new BrowserIpcServer(browserTool);
    await browserIpc.start();
    logInfo("main", `🔌 Browser IPC listening on ${browserIpc.socketPath}`);
  };

  // MCP daemon
  let mcpDaemonStarted = false;
  if (config.mcpDaemon) {
    try {
      execFileSync("mcporter", ["daemon", "start"], { stdio: "pipe" });
      mcpDaemonStarted = true;
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
      const chatId = [...config.allowedUserIds][0];
      if (chatId) await telegramAdapter!.sendMessage(String(chatId), msg);
    } : undefined;
    const dcSend = discordAdapter ? async (msg: string): Promise<void> => {
      const channelId = config.discordAllowedChannelIds ? [...config.discordAllowedChannelIds][0] : undefined;
      if (channelId) await discordAdapter!.sendMessage(channelId, msg);
    } : undefined;
    sendBackOnline(tgSend, dcSend).catch((err) => {
      logWarn("main", `Back online notification error: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Start session: inject SOUL + context + greeting, push response to Telegram
    if (telegramAdapter && memory) {
      const chatId = [...config.allowedUserIds][0];
      if (chatId) {
        const sessionKey = `telegram:${chatId}`;
        seenSessions.add(sessionKey);
        let sessionReady = false;
        startSession(
          transport, memory, chatId, sessionKey,
          "You just came online. Output ONLY a personalized greeting message.",
          (text) => (telegramAdapter as import("./platforms/telegram-adapter.js").TelegramAdapter).sendMessage(String(chatId), text),
        ).then(() => { sessionReady = true; })
         .catch(err => { sessionReady = true; logWarn("main", `Startup greeting failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`); });
        // Wait for session to be ready before accepting messages (Gemini can take minutes for large SOUL)
        const waitStart = Date.now();
        while (!sessionReady && Date.now() - waitStart < 5 * 60 * 1000) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (!sessionReady) logWarn("main", "Startup session timed out (5min) — proceeding anyway");
      }
    }
  }

  // bridge.lock — track bridge lifecycle + standby grace period
  const bridgeLockPath = join(AGENT_BRIDGE_HOME, "bridge.lock");
  const STANDBY_GRACE_MS = 3 * 60 * 1000; // 3 minutes
  try {
    const prevLock = existsSync(bridgeLockPath) ? JSON.parse(readFileSync(bridgeLockPath, "utf-8")) : null;
    if (prevLock?.exitReason === "standby" && prevLock.exitedAt && (Date.now() - prevLock.exitedAt) < 30 * 60 * 1000) {
      logInfo("main", `⏸️  Standby wake detected — ${STANDBY_GRACE_MS / 1000}s grace period before starting`);
      await new Promise(resolve => setTimeout(resolve, STANDBY_GRACE_MS));
      logInfo("main", `⏸️  Grace period complete — proceeding with startup`);
    }
  } catch { /* corrupt lock, proceed normally */ }
  try { writeFileSync(bridgeLockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), "utf-8"); } catch { /* */ }

  const hbIntervalMs = (parseInt(process.env["HEARTBEAT_INTERVAL"] ?? "", 10) || 300) * 1000;
  const heartbeat = new HeartbeatSystem({
    enabled: true,
    intervalMs: hbIntervalMs,
    sleepActive: () => sleepChild !== null && !sleepChild.killed,
    onStandbyResume: (gapMs) => {
      logInfo("main", `🔄 Standby resume (${Math.round(gapMs / 60000)}min) — doctor --fix + restart`);
      writeRestartReason(`standby-resume: ${Math.round(gapMs / 60000)}min`);
      try { execSync(`${join(AGENT_BRIDGE_HOME, "scripts", "doctor.sh")} --fix`, { timeout: 30000 }); } catch { /* */ }
      try {
        const lock = { pid: process.pid, startedAt, exitReason: "standby", exitedAt: Date.now() };
        writeFileSync(bridgeLockPath, JSON.stringify(lock), "utf-8");
      } catch { /* */ }
      process.exit(0);
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

  heartbeat.registerTask({
    name: "browse-checker",
    execute: async () => { await ensureBrowserIpc(); checkBrowseTasks(); },
  });

  // --- Skill hot-reload ---
  const skillWatcher = new SkillWatcher(
    join(AGENT_BRIDGE_HOME, "skills"),
    join(AGENT_BRIDGE_HOME, "skills", "TOOLS.md"),
  );
  heartbeat.registerTask({
    name: "skill-reloader",
    execute: async () => {
      const changed = skillWatcher.checkForChanges();
      for (const skill of changed) {
        skillWatcher.appendToTools(skill);
        const chatId = [...config.allowedUserIds][0];
        if (chatId) {
          const msg = `[NEW SKILL AVAILABLE] ${skill.name}: ${skill.description}. Read ${skill.path} if you need it.`;
          await transport.sendPrompt(`telegram:${chatId}`, msg);
          logInfo("skill-reloader", `Injected: ${skill.name}`);
        }
      }
    },
  });

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
  let dbCheckCounter = 0;
  const CTX_IDLE_COMPACT_PCT = parseInt(process.env["CTX_IDLE_COMPACT_PCT"] ?? "65", 10);
  const CTX_IDLE_COMPACT_MIN = parseInt(process.env["CTX_IDLE_COMPACT_MIN"] ?? "10", 10);
  let compactedThisIdle = false;
  setIdleCompactReset(() => { compactedThisIdle = false; });

  // --- Floating compaction (idle-triggered) ---
  if (CTX_IDLE_COMPACT_MIN > 0) {
    heartbeat.registerTask({
      name: "idle-compact",
      heavy: true,
      execute: async () => {
        if (transport.contextPercent < 0) return false;
        const pct = transport.contextPercent;
        if (pct < CTX_IDLE_COMPACT_PCT) return false;
        if (compactedThisIdle) return false;
        if (busyChats.size > 0) return false;
        if (sleepChild && !sleepChild.killed) return false;

        // Check idle time
        let lastMsgTs = 0;
        try {
          const row = memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages WHERE content NOT LIKE '%[SYSTEM%'").get() as { latest: number | null } | undefined;
          lastMsgTs = row?.latest ?? 0;
        } catch { return false; }
        if (Date.now() - lastMsgTs < CTX_IDLE_COMPACT_MIN * 60 * 1000) return false;

        // Find active session
        const chatId = [...config.allowedUserIds][0];
        if (!chatId) return false;
        const sessionKey = `telegram:${chatId}`;

        logInfo("main", `☕ Floating compaction — ctx at ${pct}%, idle ${Math.round((Date.now() - lastMsgTs) / 60000)}min`);
        busyChats.add(sessionKey);
        compactingSessions.add(sessionKey);
        try {
          await runCompaction(transport, sessionKey, memory?.getDb() ?? null, memoryConfig.memoryDir);
          pendingSessionStart.add(sessionKey);
          compactedThisIdle = true;
          logInfo("main", "☕ Floating compaction complete");
        } catch (err) {
          logWarn("main", `☕ Floating compaction failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          busyChats.delete(sessionKey);
          compactingSessions.delete(sessionKey);
        }
        return true;
      },
    });
  }

  // --- Daily cycle: restart after SLEEP_TIME if bridge started before today's SLEEP_TIME ---
  heartbeat.registerTask({
    name: "age-check",
    execute: async () => {
      const now = new Date();
      if (now.getHours() < SLEEP_HOUR) return; // before SLEEP_TIME
      try {
        const lockData = JSON.parse(readFileSync(bridgeLockPath, "utf-8"));
        const todaySleepTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), SLEEP_HOUR).getTime();
        if (lockData.startedAt >= todaySleepTime) return; // started after today's SLEEP_TIME
      } catch { return; }
      // Check idle
      let lastMsgTs = 0;
      try {
        const row = memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages WHERE content NOT LIKE '%[SYSTEM%'").get() as { latest: number | null } | undefined;
        lastMsgTs = row?.latest ?? 0;
      } catch { return; }
      if (Date.now() - lastMsgTs < 60 * 60 * 1000) return; // <1h idle
      if (busyChats.size > 0 || (sleepChild && !sleepChild.killed)) return;

      logInfo("main", `🔄 Past SLEEP_TIME (${SLEEP_HOUR}:00) + bridge started before today — daily restart`);
      writeRestartReason(`daily-cycle: SLEEP_TIME ${SLEEP_HOUR}:00`);
      try { execSync(`${join(AGENT_BRIDGE_HOME, "scripts", "doctor.sh")} --fix`, { timeout: 30000 }); } catch { /* */ }
      try { unlinkSync(bridgeLockPath); } catch { /* */ }
      process.exit(0);
    },
  });

  heartbeat.registerTask({
    name: "db-integrity",
    execute: async () => {
      dbCheckCounter++;
      if (dbCheckCounter % 12 !== 0) return; // every 12 ticks ≈ 1hr
      if (!memory?.getDb()) return;
      try {
        const result = memory.getDb()!.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
        if (result?.integrity_check !== "ok") {
          logError("db-integrity", `Memory DB integrity check failed: ${result?.integrity_check}`);
        }
      } catch (e) {
        logError("db-integrity", "Integrity check error", e);
      }
    },
  });

  // --- Watchdog: detect stuck agent ---
  if (transport instanceof AcpTransport) {
    heartbeat.registerTask(createWatchdogTask(transport));
  }

  // --- Restart flag check ---
  heartbeat.registerTask({
    name: "restart-check",
    execute: async () => {
      const flag = join(AGENT_BRIDGE_HOME, ".restart-requested");
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
    heartbeat.registerTask(createSelfHealerTask(() => telegramAdapter, config.allowedUserIds));
  }

  // Run once on startup, then start periodic
  checkBrowseTasks();
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", "💓 Heartbeat started (5-min interval)");

  // --- Startup sleep (background, with retry) ---
  const SLEEP_MAX_RETRIES = 3;
  const SLEEP_RETRY_MS = 5 * 60 * 1000;
  const SLEEP_HOUR = parseInt(process.env["SLEEP_TIME"]?.split(":")[0] ?? "6", 10);
  let sleepAttempts = 0;

  function spawnSleep(): void {
    if (new Date().getHours() < SLEEP_HOUR) {
      logDebug("main", `😴 Before SLEEP_TIME (${SLEEP_HOUR}:00) — skip`);
      return;
    }
    if (hasSleepAuditToday(sleepAuditDir)) {
      logDebug("main", "😴 Sleep already done today — skip");
      return;
    }
    if (sleepChild && !sleepChild.killed) return;
    sleepAttempts++;
    try {
      const sleepScript = join(dirname(fileURLToPath(import.meta.url)), "cli", "agentbridge-sleep.js");
      const child = spawn(process.execPath, [sleepScript], { stdio: "ignore" });
      sleepChild = child;
      child.on("exit", (code) => {
        sleepChild = null;
        if (code === 0) {
          logInfo("main", `😴 Sleep finished successfully (attempt ${sleepAttempts})`);
          if (memoryConfig.memoryEnabled) resetAllCtxStarts(memoryConfig.memoryDir);
        } else if (sleepAttempts < SLEEP_MAX_RETRIES) {
          logWarn("main", `😴 Sleep failed (code=${code}, attempt ${sleepAttempts}/${SLEEP_MAX_RETRIES}) — retry in 5min`);
          setTimeout(spawnSleep, SLEEP_RETRY_MS);
        } else {
          logWarn("main", `😴 Sleep failed (code=${code}) — exhausted ${SLEEP_MAX_RETRIES} attempts`);
        }
      });
      logInfo("main", `😴 Sleep spawned (pid=${child.pid}, attempt ${sleepAttempts})`);
    } catch (err) {
      logWarn("main", `😴 Sleep spawn failed: ${err instanceof Error ? err.message : String(err)}`);
      if (sleepAttempts < SLEEP_MAX_RETRIES) setTimeout(spawnSleep, SLEEP_RETRY_MS);
    }
  }
  spawnSleep();

  // --- Web Dashboard wiring (conditional) ---
  let dashboardServer: DashboardServer | null = null;

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
          type: config.agentTransport as "tmux" | "acp",
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
  let agentApiServer: AgentApiServer | null = null;
  const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);

  registry.register("agent-api", {
    configured: Boolean(agentConfig.port),
    async create() {
      agentApiServer = new AgentApiServer({
        config: agentConfig,
        cliPath: config.agentCliPath,
        workingDir: config.workingDir,
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

  async function shutdown(): Promise<void> {
    logInfo("main", "🛑 Shutting down...");
    const forceTimer = setTimeout(() => {
      logWarn("main", "⚠️  Shutdown timed out — forcing exit");
      process.exit(1);
    }, 15_000);
    forceTimer.unref();

    const step = (name: string, fn: () => Promise<void> | void, ms = 3000): Promise<void> =>
      Promise.race([
        Promise.resolve(fn()).catch(() => {}),
        new Promise<void>(r => { const t = setTimeout(() => { logWarn("main", `Shutdown step '${name}' timed out (${ms}ms) — skipping`); r(); }, ms); (t as any).unref?.(); }),
      ]);

    await step("agent-api", () => agentApiServer?.stop());
    await step("dashboard", () => dashboardServer?.stop());
    await step("services", () => registry.stopAll());
    await step("heartbeat", () => heartbeat.stop());
    await step("browser-ipc", () => browserIpc?.shutdown());
    await step("browser", () => browserManager.shutdown(), 5000);
    await step("memory", () => memory?.close());
    await step("transport", () => transport.destroy());
    if (mcpDaemonStarted) {
      await step("mcp-daemon", () => { execFileSync("mcporter", ["daemon", "stop"], { stdio: "pipe" }); });
    }
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
