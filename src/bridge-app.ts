import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { readEntry as cronReadEntry } from "./components/cron-db.js";
import { spawn, execFileSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAndValidateConfig } from "./components/config.js";
import { AGENT_BRIDGE_HOME } from "./components/config.js";

import { TmuxClient } from "./components/tmux-client.js";
import { AcpTransport } from "./components/acp-transport.js";
import type { SttConfig } from "./components/stt.js";
import type { TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, localIso, getLogFile } from "./components/logger.js";
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
import { SleepTrigger } from "./components/sleep-trigger.js";
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
import { SleepQueue } from "./components/sleep-queue.js";
import { buildSessionStartContext } from "./components/session-context.js";
import { loadSoulBundle } from "./components/soul-loader.js";
import { checkCron, checkBrowseTasks, readPendingReminders, clearPendingReminders } from "./components/cron-checker.js";
import { CronQueue } from "./components/cron-queue.js";


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

/** Send a platform context announcement to the transport so the LLM knows which platform is active. */
async function announcePlatform(
  transport: IKiroTransport,
  platform: string,
): Promise<void> {
  // Skip for ACP — creating a system session wastes the --agent first-session slot
  if (transport instanceof AcpTransport) return;
  const ts = localIso();
  const msg = `[SYSTEM] Platform: ${platform} | Connected at: ${ts} | Refer to your CHATS.md steering for ${platform}-specific behavior.`;
  const sessionKey = `system:${platform.toLowerCase()}`;
  try {
    await transport.sendPrompt(sessionKey, msg);
    logInfo("main", `📢 Announced ${platform} platform to transport`);
  } catch (err) {
    logWarn("main", `Failed to announce ${platform} platform: ${err instanceof Error ? err.message : String(err)}`);
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
      ? ["--experimental-acp"]
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
  const sleepQueue = new SleepQueue();
  const platformAdapters = new Map<string, import("./types/platform.js").PlatformAdapter>();
  const sleepTrigger = new SleepTrigger(join(memoryConfig.memoryDir, "sleep"));

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
  const cronQueue = new CronQueue(config.agentCliPath, config.workingDir);

  // Build pipeline deps (needed before platform start)
  const pipelineDeps: import("./components/message-pipeline.js").PipelineDeps = {
    transport, codingMode: codingModeManager, memory, memoryConfig, nlmConfig,
    sleepQueue, idleSave, conversationBuffer, config, startedAt,
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

    // Sleep is handled by the heartbeat sleep-trigger task — no startup special case.

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
      announcePlatform(transport, "TELEGRAM").catch(() => {});
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
      announcePlatform(transport, "DISCORD").catch(() => {});
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
  if (memory) memory.setBrowserManager(browserManager);
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

    // Send greeting prompt to kiro-cli (with session context) so KP greets personally
    if (telegramAdapter) {
      const chatId = [...config.allowedUserIds][0];
      if (chatId) {
        const sessionKey = `telegram:${chatId}`;
        let greetPrompt = "[Telegram] You just woke up. Output ONLY a personalized greeting message.";
        const soul = loadSoulBundle();
        if (soul) greetPrompt = soul + "\n\n" + greetPrompt;
        const ctx = buildSessionStartContext(memory!, chatId);
        if (ctx) greetPrompt = ctx + "\n\n" + greetPrompt;
        seenSessions.add(sessionKey);
        transport.sendPrompt(sessionKey, greetPrompt).then(async (response) => {
          if (response) {
            await telegramAdapter!.sendMessage(String(chatId), response);
          }
        }).catch((err) => {
          logWarn("main", `Startup greeting failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }

  const hbIntervalMs = (parseInt(process.env["HEARTBEAT_INTERVAL"] ?? "", 10) || 300) * 1000;
  const heartbeat = new HeartbeatSystem({ enabled: true, intervalMs: hbIntervalMs });

  const cronCallback = (chatId: number, message: string, result: string): void => {
    if (platforms.telegram && telegramAdapter) {
      const icon = result.startsWith("✅") || result.includes("DoD: PASSED") ? "✅" : "❌";
      const cleanResult = result.replace(/^[✅❌]\s*/, "").trim();
      telegramAdapter.sendMessage(String(chatId), `${icon} Cron: ${message}\n\n${cleanResult}`).catch(err => {
        logWarn("main", `Cron task TG report failed: ${err}`);
      });
    }
  };

  heartbeat.registerTask({
    name: "cron",
    execute: async () => {
      const dueTasks = checkCron();
      for (const entry of dueTasks) cronQueue.enqueue(entry, cronCallback);
    },
  });

  heartbeat.registerTask({
    name: "sleep-trigger",
    heavy: true,
    execute: async () => {
      if (busyChats.size > 0) return false;
      let lastMessageTs = 0;
      try {
        const row = memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages").get() as { latest: number | null } | undefined;
        lastMessageTs = row?.latest ?? 0;
      } catch { return false; }
      if (!sleepTrigger.shouldRunFromCron(lastMessageTs)) return false;
      sleepTrigger.writeLock();
      sleepQueue.activate();
      try {
        const sleepScript = join(dirname(fileURLToPath(import.meta.url)), "cli", "agentbridge-sleep.js");
        const child = spawn(process.execPath, [sleepScript], { stdio: "ignore", detached: true });
        child.on("exit", (code) => {
          if (code === 0) {
            logInfo("main", `😴 Cron sleep routine finished successfully at ${localIso()}`);
            sleepTrigger.reportSuccess();
            if (memoryConfig.memoryEnabled) resetAllCtxStarts(memoryConfig.memoryDir);
            const chatId = [...config.allowedUserIds][0];
            if (chatId && telegramAdapter) {
              telegramAdapter.injectMessage({
                platform: "telegram", channelId: String(chatId), sessionKey: `telegram:${chatId}`,
                senderId: String(chatId), senderName: "system", text: "You just woke up.. how did you sleep buddy?",
                timestamp: Date.now(), isGroup: false, isVoice: false,
              });
            }
          } else if (code === 2) {
            logWarn("main", `😴 Sleep partial — some steps failed, will retry at ${localIso()}`);
            sleepTrigger.reportFailure();
          } else {
            logWarn("main", `😴 Cron sleep routine failed (exit code ${code}) at ${localIso()}`);
            sleepTrigger.reportFailure();
          }
          sleepQueue.deactivate();
          sleepQueue.replay(platformAdapters);
        });
        child.unref();
        logInfo("main", `😴 Sleep routine spawned from cron (pid=${child.pid}) at ${localIso()}`);
        return true;
      } catch (err) {
        logWarn("main", `sleep-trigger: failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
        sleepTrigger.reportFailure();
        return false;
      }
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
  let watchdogDoctorRan = false;
  let watchdogDidReset = false;
  let watchdogLastActionAt = 0;
  const WATCHDOG_COOLDOWN = 60 * 60 * 1000; // 1 hour
  const WATCHDOG_CYCLES = parseInt(process.env["WATCHDOG_CYCLES"] ?? "2", 10);

  if (transport instanceof AcpTransport) {
    heartbeat.registerTask({
      name: "watchdog",
      execute: async () => {
        const acp = transport as AcpTransport;
        // Only trigger if a prompt is in-flight
        if (acp.promptStartedAt <= acp.lastSuccessAt) {
          // Prompt completed — reset flags
          watchdogDoctorRan = false;
          watchdogDidReset = false;
          return;
        }

        const staleMs = Date.now() - acp.promptStartedAt;
        const stuckCycles = Math.floor(staleMs / hbIntervalMs);
        const now = Date.now();

        // Cooldown check
        if (now - watchdogLastActionAt < WATCHDOG_COOLDOWN && watchdogDidReset) return;

        // Level 0: doctor --fix (first stuck detection)
        if (stuckCycles >= 1 && !watchdogDoctorRan) {
          logWarn("watchdog", `Prompt stuck ${Math.round(staleMs / 1000)}s — running doctor --fix`);
          watchdogDoctorRan = true;
          try {
            const { execSync } = await import("node:child_process");
            execSync(`${join(AGENT_BRIDGE_HOME, "scripts", "doctor.sh")} --fix`, { timeout: 30000 });
          } catch { /* doctor may not exist or fail — continue */ }
          return;
        }

        // Level 1: reset ACP session
        if (stuckCycles >= WATCHDOG_CYCLES && !watchdogDidReset) {
          logWarn("watchdog", `Prompt stuck ${stuckCycles} cycles — Level 1: cancelling + resetting ACP session`);
          watchdogDidReset = true;
          watchdogLastActionAt = now;
          writeRestartReason(`watchdog-reset: prompt stuck ${Math.round(staleMs / 1000)}s`);
          try {
            await acp.sendInterrupt(); // cancel first
            const sessionKey = [...config.allowedUserIds].map(id => `telegram:${id}`)[0];
            if (sessionKey) await acp.resetSession(sessionKey);
          } catch (e) {
            logError("watchdog", "Reset failed", e);
          }
          return;
        }

        // Level 2: restart bridge (next tick after reset)
        if (watchdogDidReset && stuckCycles > WATCHDOG_CYCLES) {
          logWarn("watchdog", `Still stuck after reset — Level 2: restarting bridge`);
          writeRestartReason(`watchdog-restart: prompt stuck after reset, ${Math.round(staleMs / 1000)}s`);
          process.exit(0);
        }
      },
    });
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
  const SELFHEAL_MAX = parseInt(process.env["SELFHEAL_MAX_REPORTS"] ?? "1", 10);
  const SELFHEAL_COOLDOWN_MS = (parseInt(process.env["SELFHEAL_COOLDOWN_MIN"] ?? "30", 10)) * 60 * 1000;
  let lastSelfhealTs = new Date().toISOString().slice(0, 23); // start from now — don't re-scan old errors
  const selfhealSeen = new Map<string, number>(); // errorKey → lastReportedAt

  if (process.env["SELFHEAL_ENABLED"] !== "false") {
    heartbeat.registerTask({
      name: "self-healer",
      execute: async () => {
        const logFile = getLogFile();
        try {
          const content = readFileSync(logFile, "utf-8");
          const lines = content.split("\n");
          const now = Date.now();
          let reported = 0;

          for (let i = lines.length - 1; i >= 0 && reported < SELFHEAL_MAX; i--) {
            const line = lines[i]!;
            if (line.length < 24 || !line.includes(" ERROR ")) continue;
            const ts = line.slice(0, 23);
            if (ts <= lastSelfhealTs) break;
            if (line.includes("TEST ")) continue;
            // Blacklist — skip noise, transient errors, and self-references
            const SELFHEAL_BLACKLIST = [
              "-32603", "Transient error", "fetch failed",
              "[self-healer]", "[watchdog]", "[db-integrity]",
              "ECONNRESET", "ETIMEDOUT", "socket hang up",
              "auto-approved", "permission",
              "BUG REPORT", "[agentbridge-sleep]",
            ];
            if (SELFHEAL_BLACKLIST.some(b => line.includes(b))) continue;

            // Extract tag + message as dedup key
            const match = line.match(/\[([^\]]+)\] (.+)/);
            if (!match) continue;
            const errorKey = `${match[1]}:${match[2]!.slice(0, 80)}`;

            // Cooldown check
            const lastSeen = selfhealSeen.get(errorKey);
            if (lastSeen && now - lastSeen < SELFHEAL_COOLDOWN_MS) continue;
            selfhealSeen.set(errorKey, now);

            // Inject to KP
            if (telegramAdapter) {
              const chatId = [...config.allowedUserIds][0];
              if (chatId) {
                telegramAdapter.injectMessage({
                  platform: "telegram",
                  channelId: String(chatId),
                  sessionKey: `telegram:${chatId}`,
                  senderId: "system",
                  senderName: "Self-Healing Agent",
                  text: `[SYSTEM BUG REPORT] ${line.slice(0, 500)}`,
                  timestamp: now,
                  isGroup: false,
                  isVoice: false,
                });
                reported++;
                logInfo("self-healer", `Reported error to KP: ${errorKey.slice(0, 80)}`);
              }
            }
          }

          // Advance watermark
          if (lines.length > 1) {
            const lastLine = lines[lines.length - 2] ?? "";
            if (lastLine.length >= 23) lastSelfhealTs = lastLine.slice(0, 23);
          }

          // Evict old cooldown entries
          for (const [key, ts] of selfhealSeen) {
            if (now - ts > SELFHEAL_COOLDOWN_MS * 2) selfhealSeen.delete(key);
          }
        } catch { /* log file not readable — skip */ }
      },
    });
  }

  // Run once on startup, then start periodic
  checkBrowseTasks();
  heartbeat.start();
  memory?.setHeartbeat(heartbeat);
  logInfo("main", "💓 Heartbeat started (5-min interval)");

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
          contextPercent: "contextPercent" in transport ? (transport as TmuxClient).contextPercent : -1,
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
