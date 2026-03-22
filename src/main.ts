import { readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAndValidateConfig } from "./components/config.js";
import { SecurityGate } from "./components/security-gate.js";
import { ResponseFormatter } from "./components/response-formatter.js";
import { TelegramApi } from "./components/telegram-api.js";
import { TelegramPoller } from "./components/telegram-poller.js";
import { TmuxClient } from "./components/tmux-client.js";
import { AcpTransport } from "./components/acp-transport.js";
import { transcribeAudio, type SttConfig } from "./components/stt.js";
import { synthesizeSpeech, type TtsConfig } from "./components/tts.js";
import { setLogLevel, logInfo, logWarn, logError, logDebug } from "./components/logger.js";
import { loadMemoryConfig } from "./components/memory-config.js";
import { MemoryManager } from "./components/memory-manager.js";
import { ConversationBuffer } from "./components/conversation-buffer.js";
import { DiscordApi } from "./components/discord-api.js";
import { DiscordPoller } from "./components/discord-poller.js";
import { DiscordSecurityGate } from "./components/discord-security-gate.js";
import { ChannelAdapter } from "./components/channel-adapter.js";
import { B2BRouter } from "./components/b2b-router.js";
import type { IKiroTransport } from "./components/kiro-transport.js";
import { formatReactionSignal } from "./components/reaction-signal.js";
import { routeReaction } from "./components/reaction-router.js";
import { emojiToScore } from "./components/emotion-utils.js";
import type { TelegramUpdate, DiscordInboundMessage } from "./types/index.js";
import { parsePlatformFlags } from "./components/cli-flags.js";
import { loadDashboardConfig, validateDashboardConfig, buildStatusSnapshot } from "./components/dashboard-config.js";
import type { SubsystemRefs } from "./components/dashboard-config.js";
import { AuthGate } from "./components/auth-gate.js";
import { PlatformController } from "./components/platform-controller.js";
import { TransportController } from "./components/transport-controller.js";
import { MemorySearchController } from "./components/memory-search-controller.js";
import { DashboardServer } from "./components/dashboard-server.js";
import { renderDashboardHtml } from "./components/dashboard-ui.js";
import { handleNLMCommand, loadNLMConfig } from "./components/nlm-command-handler.js";
import { SleepTrigger } from "./components/sleep-trigger.js";
import { HeartbeatSystem } from "./components/heartbeat-system.js";
import { AgentApiServer } from "./components/agent-api-server.js";
import { interceptLargeMessage } from "./components/message-interceptor.js";
import { loadAgentApiConfig } from "./components/agent-api-config.js";
import { detectIngestSourceType } from "./components/ingest-source-detect.js";
import { BrowserManager } from "./components/browser-manager.js";
import { BrowserTool } from "./components/browser-tool.js";
import { BrowserIpcServer } from "./components/browser-ipc-server.js";
import { DomainAllowlist } from "./components/domain-allowlist.js";
import { checkCron, checkBrowseTasks, readPendingReminders, clearPendingReminders } from "./components/cron-checker.js";

/** Strip the bot's own Discord mention tag from text. Other mentions are preserved. */
function stripDiscordMentions(text: string, botAppId: string): string {
  return text.replace(new RegExp(`<@!?${botAppId}>`, "g"), "").replace(/\s{2,}/g, " ").trim();
}


/** Run mcporter list and return a status summary. */
function getMcporterStatus(): string {
  try {
    const raw = execSync("mcporter list --json 2>/dev/null", { timeout: 15_000 }).toString();
    const data = JSON.parse(raw);
    const servers = data.servers ?? [];
    const ok = servers.filter((s: Record<string, unknown>) => s.status === "ok").length;
    const total = servers.length;
    const names = servers
      .slice(0, 10)
      .map((s: Record<string, unknown>) => `  ${s.status === "ok" ? "✅" : "❌"} ${s.name}`)
      .join("\n");
    return [
      "📦 mcporter Status",
      "",
      `Servers: ${ok}/${total} online`,
      "",
      names,
      total > 10 ? `  ... and ${total - 10} more` : "",
    ].filter(Boolean).join("\n");
  } catch {
    try {
      const ver = execSync("mcporter --version 2>/dev/null", { timeout: 5_000 }).toString().trim();
      return `📦 mcporter v${ver} — installed but list failed (check config)`;
    } catch {
      return "📦 mcporter — not installed or not in PATH";
    }
  }
}

/** Format milliseconds as human-readable uptime (e.g. "2d 5h 13m"). */
function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function buildStatusLines(opts: {
  transport: IKiroTransport;
  config: { kiroTransport: string };
  startedAt: number;
  memory: { getCronInfo: () => { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; lastSleepAudit: string | null } } | null;
}): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  let version = "?";
  try { version = JSON.parse(readFileSync(join(thisDir, "..", "package.json"), "utf-8")).version; } catch { /* */ }
  let model = process.env["KIRO_MODEL"] || "";
  if (!model) {
    try { model = JSON.parse(execSync("kiro-cli settings list --format json 2>/dev/null", { timeout: 3000, encoding: "utf-8" }))["chat.defaultModel"] || "unknown"; } catch { model = "unknown"; }
  }
  const status = opts.transport.isReady ? "✅ Connected" : "❌ Disconnected";
  const mode = opts.config.kiroTransport.toUpperCase();
  const uptime = formatUptime(Date.now() - opts.startedAt);
  const ctxPct = ("contextPercent" in opts.transport && (opts.transport as TmuxClient).contextPercent >= 0)
    ? `${(opts.transport as TmuxClient).contextPercent}%`
    : "n/a";
  const cronInfo = opts.memory?.getCronInfo();
  const lines = [
    `Kiro Professor v${version}`,
    `🤖 Model: ${model}`,
    `📊 Context window: ${ctxPct}`,
    `⏱️ Uptime: ${uptime}`,
    `🔌 Transport: ${mode} — ${status}`,
  ];
  if (cronInfo) {
    const mins = Math.round(cronInfo.intervalMs / 60000);
    lines.push(
      `💓 Heartbeat: ${cronInfo.heartbeatRunning ? "running" : "stopped"} (${mins}min)`,
      `📋 Tasks: ${cronInfo.tasks.join(", ") || "(none)"}`,
      `😴 Last sleep: ${cronInfo.lastSleepAudit ?? "(never)"}`,
    );
    try {
      const hbTs = parseInt(readFileSync(join(homedir(), ".agentbridge", "memory", ".heartbeat"), "utf-8"), 10);
      if (hbTs > 0) lines.push(`🫀 Last tick: ${Math.round((Date.now() - hbTs) / 60000)}min ago`);
    } catch { /* */ }
    try {
      const ce = JSON.parse(readFileSync(join(homedir(), ".agentbridge", "memory", "cron.json"), "utf-8")) as Array<{ fired: boolean; schedule?: string; paused?: boolean }>;
      const r = ce.filter(e => e.schedule && !e.paused).length;
      const p = ce.filter(e => !e.fired && !e.schedule).length;
      const pa = ce.filter(e => e.paused).length;
      lines.push(`⏰ Cron: ${r} recurring, ${p} pending${pa ? `, ${pa} paused` : ""}`);
    } catch { /* */ }
    try {
      const bd = join(homedir(), ".backup-agentbridge");
      const bk = readdirSync(bd).filter(f => f.startsWith("agentbridge-")).sort();
      if (bk.length > 0) lines.push(`💾 Last backup: ${bk[bk.length - 1]}`);
    } catch { /* */ }
  }
  return lines;
}

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
  const results = await Promise.allSettled([sendTelegram?.(msg), sendDiscord?.(msg)]);
  for (const r of results) {
    if (r.status === "rejected") logWarn("main", `Back online send failed: ${r.reason}`);
  }
}

import { buildSessionStartContext } from "./components/session-context.js";

/** Prepare prompt for sending: inject session-start context if pending, record message. */
function preparePrompt(
  prompt: string,
  memory: MemoryManager,
  chatId: number,
  sessionKey: string,
  text: string,
  pending: Set<string>,
  seen: Set<string>,
  platformMessageId?: number,
): string {
  const isSessionStart = pending.has(sessionKey) || !seen.has(sessionKey);
  if (isSessionStart) {
    const ctx = buildSessionStartContext(memory, chatId);
    if (ctx) {
      prompt = ctx + "\n\n" + prompt;
      logInfo("main", `Injected session-start context (${ctx.length} chars)`);
    }
  }
  seen.add(sessionKey);
  pending.delete(sessionKey);
  memory.recordMessage({ role: "user", content: text, timestamp: Date.now(), chatId, sessionId: sessionKey, platformMessageId });
  return prompt;
}

/** Send a platform context announcement to the transport so the LLM knows which platform is active. */
async function announcePlatform(
  transport: IKiroTransport,
  platform: string,
): Promise<void> {
  // Skip for ACP — creating a system session wastes the --agent first-session slot
  if (transport instanceof AcpTransport) return;
  const ts = new Date().toISOString();
  const msg = `[SYSTEM] Platform: ${platform} | Connected at: ${ts} | Refer to your CHATS.md steering for ${platform}-specific behavior.`;
  const sessionKey = `system:${platform.toLowerCase()}`;
  try {
    await transport.sendPrompt(sessionKey, msg);
    logInfo("main", `📢 Announced ${platform} platform to transport`);
  } catch (err) {
    logWarn("main", `Failed to announce ${platform} platform: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const platforms = parsePlatformFlags();
  const config = await loadAndValidateConfig();
  if (platforms.transport) config.kiroTransport = platforms.transport;
  setLogLevel(config.logLevel);

  const enabledList = [
    platforms.telegram && "telegram",
    platforms.discord && "discord",
  ].filter(Boolean).join(", ");
  logInfo("main", `🚀 Bridge starting (platforms=${enabledList}, log=${config.logLevel})`);

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

  // Initialize NLM (calls `nlm` CLI directly — no wrapper)
  const nlmConfig = loadNLMConfig();
  logInfo("main", `📚 NLM Layer 6 ${nlmConfig.enabled ? "enabled" : "disabled"}`);

  // Initialize BrowserManager singleton for browser tool and webpage ingestion
  const browserManager = new BrowserManager();
  if (memory) {
    memory.setBrowserManager(browserManager);
  }
  logInfo("main", "🌐 BrowserManager initialized");

  // Start browser IPC server — skip if Docker container owns the socket
  const allowlist = DomainAllowlist.fromEnv();
  const browserTool = new BrowserTool(browserManager, allowlist);
  let browserIpc: BrowserIpcServer | null = null;
  if (process.env["BROWSER_DOCKER"] === "1") {
    logInfo("main", "🐳 Browser Docker mode — skipping local IPC server");
  } else {
    browserIpc = new BrowserIpcServer(browserTool);
    await browserIpc.start();
    logInfo("main", `🔌 Browser IPC listening on ${browserIpc.socketPath}`);
  }

  const formatter = new ResponseFormatter();

  // Shared conversation buffer for both platforms
  const conversationBuffer = new ConversationBuffer(50);

  let transport: IKiroTransport;
  if (config.kiroTransport === "tmux") {
    logInfo("main", `🖥️  tmux transport (session: ${config.tmuxSession})`);
    transport = new TmuxClient(
      config.tmuxSession,
      config.tmuxCaptureDelaySec,
      config.tmuxMaxWaitSec,
    );
  } else {
    logInfo("main", "🔌 ACP transport");
    transport = new AcpTransport(config.kiroCLIPath, config.workingDir);
  }
  await transport.initialize();
  logInfo("main", "✅ Transport ready");

  // Initialize context-window-start for all known chats
  if (memoryConfig.memoryEnabled) {
    for (const uid of config.allowedUserIds) updateCtxStart(memoryConfig.memoryDir, uid, startedAt);
  }

  // Sleep state: queue messages during sleep, auto-reply "waking up"
  let sleepChild: import("node:child_process").ChildProcess | null = null;
  const pendingMessages: Array<{ chatId: number; text: string; threadId?: number; sessionKey: string }> = [];
  const sleepRepliedChats = new Set<number>();
  const sleepTrigger = new SleepTrigger(join(memoryConfig.memoryDir, "sleep"));

  // Wire LLM callback into memory so compaction and context assembly can use the LLM
  if (memory) {
    memory.setLlmCall(async (prompt: string, content: string) => {
      return transport.sendPrompt("system:memory", `${prompt}\n\n${content}`);
    });
    memory.setIsBusy(() => busyChats.size > 0);
    logInfo("main", "🧠 Memory LLM callback registered");

    // Unified heartbeat — single 5-min timer for all periodic tasks

    // Run sleep on startup if needed (≥8am, no audit today)
    try {
      if (sleepTrigger.shouldRunOnStartup()) {
        logInfo("main", `😴 Startup sleep trigger fired — spawning sleep routine at ${new Date().toISOString()}`);
        sleepTrigger.writeLock();
        const thisDir = dirname(fileURLToPath(import.meta.url));
        const sleepScript = join(thisDir, "cli", "agentbridge-sleep.js");
        sleepChild = spawn(process.execPath, [sleepScript], {
          stdio: "ignore",
          detached: true,
        });
        sleepChild.on("exit", (code) => {
          if (code === 0) {
            logInfo("main", `😴 Sleep routine finished successfully at ${new Date().toISOString()}`);
            sleepTrigger.reportSuccess();
          } else {
            logWarn("main", `😴 Sleep routine failed (exit code ${code}) at ${new Date().toISOString()}`);
            sleepTrigger.reportFailure();
          }
          sleepChild = null;
          processPendingMessages();
        });
        sleepChild.unref();
        logInfo("main", `😴 Sleep routine spawned (pid=${sleepChild.pid}) at ${new Date().toISOString()}`);
      }
    } catch (err) {
      logWarn("main", `Sleep trigger check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // STT config
  const sttConfig: SttConfig | null = config.sttEnabled
    ? { provider: "groq", apiKey: config.groqApiKey, model: config.sttModel }
    : null;
  if (sttConfig) {
    logInfo("main", `🎤 STT enabled (${sttConfig.provider}/${sttConfig.model || "whisper-large-v3"})`);
  }

  // TTS config
  const ttsConfig: TtsConfig | null = config.ttsEnabled
    ? { voice: config.ttsVoice }
    : null;
  if (ttsConfig) {
    logInfo("main", `🔊 TTS enabled (Edge TTS / ${ttsConfig.voice})`);
  }

  const busyChats = new Set<string>();
  const pendingSessionStart = new Set<string>();
  const seenSessions = new Set<string>(); // tracks sessions that have sent at least one message
  const fullModeChats = new Set<string>();

  // --- Coding agent mode ---
  const codingMode = new Set<string>(); // sessionKeys currently in coding mode
  let codingTransport: AcpTransport | null = null;

  async function startCodingMode(sessionKey: string): Promise<void> {
    if (!codingTransport) {
      codingTransport = new AcpTransport(config.kiroCLIPath, config.workingDir, {
        agent: "coding-agent",
        model: config.codingAgentModel,
      });
      await codingTransport.initialize();
    }
    codingMode.add(sessionKey);
    // Inject project facts as first message
    await codingTransport.sendPrompt(sessionKey, [
      "[SYSTEM] You are the coding agent for AgentBridge.",
      `Project root: ${config.workingDir}`,
      "Read docs/specs/system.asbuilt.md and docs/specs/memory.asbuilt.md before making changes.",
      "Always create a new git branch before coding. Switch back to main when done.",
    ].join("\n"));
  }

  async function stopCodingMode(sessionKey: string): Promise<void> {
    codingMode.delete(sessionKey);
    if (codingTransport && codingMode.size === 0) {
      // Ask it to switch back to main before killing
      try { await codingTransport.sendPrompt(sessionKey, "Run: git checkout main"); } catch { /* ok */ }
      codingTransport.destroy();
      codingTransport = null;
    }
  }

  // Idle chat-save: after 10min inactivity, save kiro-cli conversation to working dir
  const CHAT_SAVE_IDLE_MS = 10 * 60 * 1000;
  const idleSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async function saveChatToWorking(sessionKey: string, chatId: number): Promise<void> {
    if (!memoryConfig.memoryEnabled) return;
    const today = new Date().toISOString().slice(0, 10);
    const dir = join(memoryConfig.memoryDir, "working", today);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `transcript_${chatId}.chat`);
    try {
      await transport.sendPrompt(sessionKey, `/chat save ${dest}`);
      logInfo("main", `Chat saved to ${dest}`);
    } catch (e) {
      logWarn("main", `Chat save failed: ${e}`);
    }
  }

  function resetIdleSaveTimer(sessionKey: string, chatId: number): void {
    const existing = idleSaveTimers.get(sessionKey);
    if (existing) clearTimeout(existing);
    idleSaveTimers.set(sessionKey, setTimeout(() => {
      idleSaveTimers.delete(sessionKey);
      saveChatToWorking(sessionKey, chatId);
    }, CHAT_SAVE_IDLE_MS));
  }

  // Process messages that were queued during sleep
  const processPendingMessages = (): void => {
    sleepRepliedChats.clear();
    if (pendingMessages.length === 0) return;
    logInfo("main", `Processing ${pendingMessages.length} message(s) queued during sleep`);
    // Re-inject each pending message by simulating the update flow
    // We do this asynchronously so the bridge can handle them normally
    const queued = [...pendingMessages];
    pendingMessages.length = 0;
    // Group by sessionKey so multiple messages from the same chat are merged
    // into one synthetic update, avoiding busyChats collision
    const grouped = new Map<string, typeof queued>();
    for (const msg of queued) {
      const group = grouped.get(msg.sessionKey);
      if (group) group.push(msg);
      else grouped.set(msg.sessionKey, [msg]);
    }
    for (const msgs of grouped.values()) {
      const first = msgs[0]!;
      const combinedText = msgs.map((m) => m.text).join("\n\n");
      const syntheticUpdate = {
        update_id: 0,
        message: {
          message_id: 0,
          from: { id: first.chatId, is_bot: false, first_name: "queued" },
          chat: { id: first.chatId, first_name: "queued", type: "private" as const },
          date: Math.floor(Date.now() / 1000),
          text: combinedText,
          ...(first.threadId ? { message_thread_id: first.threadId } : {}),
        },
      };
      if (telegramPoller) {
        telegramPoller.injectUpdate(syntheticUpdate);
      }
    }
  };

  // --- Telegram wiring (conditional) ---
  let telegramPoller: TelegramPoller | null = null;

  if (platforms.telegram) {
    const telegramApi = new TelegramApi(config.telegramBotToken);
    const securityGate = new SecurityGate(config.allowedUserIds);

    const botInfo = await telegramApi.getMe();
    const botUsername = botInfo.username?.toLowerCase() ?? "";
    logInfo("main", `🤖 Telegram bot: @${botInfo.username}`);

    // Register command menu so Telegram shows picker when user types /
    await telegramApi.setMyCommands([
      { command: "new", description: "Start a fresh session" },
      { command: "reset", description: "Start a fresh session" },
      { command: "status", description: "Connection & uptime info" },
      { command: "stop", description: "Send Ctrl+C to Kiro" },
      { command: "restart", description: "Restart Kiro (tmux only)" },
      { command: "full", description: "Raw output mode, TTS off" },
      { command: "short", description: "Clean output mode, TTS on" },
      { command: "memory", description: "Memory system stats" },
      { command: "facts", description: "Show core knowledge" },
      { command: "reflect", description: "Generate a reflection" },
      { command: "ingest", description: "Ingest a document or URL" },
      { command: "forget", description: "Forget topic or date range" },
      { command: "coding", description: "Switch to Opus coding agent" },
      { command: "default", description: "Switch back to KP" },
    ]).catch((err) => logWarn("main", `setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`));

    const react = async (chatId: number, messageId: number, emoji: string): Promise<void> => {
      if (messageId <= 0) return;
      try {
        const reaction = emoji ? [{ type: "emoji" as const, emoji }] : [];
        await telegramApi.setMessageReaction(chatId, messageId, reaction);
      } catch (err) {
        logDebug("main", `React failed (${emoji || "remove"}): ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const tgBufferKey = (chatId: number, threadId?: number): string =>
      threadId != null ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;

    const handleUpdate = async (update: TelegramUpdate): Promise<void> => {
      logDebug("main", `Update: ${JSON.stringify(update).slice(0, 200)}`);

      if (update.callback_query) {
        await telegramApi.answerCallbackQuery(update.callback_query.id);
        return;
      }

      if (update.message_reaction) {
        const reaction = update.message_reaction;
        const user = reaction.user;
        if (!user) {
          logDebug("main", "Reaction update missing user field, ignoring");
          return;
        }
        if (user.is_bot) return;

        const oldEmojis = new Set(reaction.old_reaction.map((r) => r.emoji));
        const added = reaction.new_reaction.filter((r) => !oldEmojis.has(r.emoji));
        if (added.length === 0) return;

        const senderName = user.first_name || user.username || `id:${user.id}`;
        const emojis = added.map((r) => r.emoji);
        logInfo("main", `Reaction ${emojis.join("")} from ${senderName} on msg ${reaction.message_id}`);

        const isAuthorized = securityGate.authorizeUserId(user.id);
        const signal = formatReactionSignal(senderName, emojis);
        const chatId = reaction.chat.id;
        const route = routeReaction(isAuthorized, reaction.chat.type);

        // Update emotion_score on the reacted message (authorized users only)
        if (isAuthorized && memory) {
          const score = emojiToScore(emojis[0]!);
          const updated = memory.updateEmotionByPlatformId(chatId, reaction.message_id, score);
          if (updated) logDebug("main", `Emotion score ${score} set on platform msg ${reaction.message_id}`);
        }

        if (route === "discard") {
          logDebug("main", `Unauthorized reaction from user ${user.id}, discarding`);
          return;
        }

        if (route === "buffer") {
          const bufKey = tgBufferKey(chatId);
          conversationBuffer.push(bufKey, senderName, signal);
          logDebug("main", `Buffered reaction signal for group ${chatId}`);
        } else {
          const sessionKey = `telegram:${chatId}`;
          try {
            await transport.sendPrompt(sessionKey, signal);
            logDebug("main", `Sent reaction signal to transport for chat ${chatId}`);
          } catch (err) {
            logError("main", `Failed to send reaction signal for chat ${chatId}`, err);
          }
        }
        return;
      }

      const message = update.message;
      if (!message?.from) return;

      const hasText = Boolean(message.text);
      const hasVoice = Boolean(message.voice || message.audio);
      if (!hasText && !hasVoice) return;

      const chatId = message.chat.id;
      const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";
      const threadId = isGroup ? message.message_thread_id : undefined;
      const messageId = message.message_id;
      const senderName = message.from.first_name || message.from.username || `id:${message.from.id}`;
      const bufKey = tgBufferKey(chatId, threadId);

      let text = message.text ?? "";
      let isVoiceNote = false;

      // --- Voice note handling ---
      if (hasVoice && !hasText) {
        if (!sttConfig) {
          if (isGroup) {
            conversationBuffer.push(bufKey, senderName, "[voice note - STT disabled]");
          } else if (securityGate.authorize(message)) {
            await telegramApi.sendMessage(chatId, "🎤 Voice notes require STT (set GROQ_API_KEY).", { message_thread_id: threadId });
          }
          return;
        }

        if (!securityGate.authorize(message)) {
          if (isGroup) conversationBuffer.push(bufKey, senderName, "[voice note]");
          return;
        }

        try {
          await react(chatId, messageId, "👀");
          const voiceFile = message.voice || message.audio;
          const fileInfo = await telegramApi.getFile(voiceFile!.file_id);
          if (!fileInfo.file_path) throw new Error("No file_path returned");
          const audioBuffer = await telegramApi.downloadFile(fileInfo.file_path);
          const transcript = await transcribeAudio(audioBuffer, "voice.ogg", sttConfig);

          if (!transcript) {
            await react(chatId, messageId, "");
            if (isGroup) {
              conversationBuffer.push(bufKey, senderName, "[voice note - empty]");
            } else {
              await telegramApi.sendMessage(chatId, "🤷 Couldn't transcribe the voice note.", { message_thread_id: threadId });
            }
            return;
          }

          if (isGroup) {
            const mentionRe = new RegExp(`@?${botUsername}\\b`, "i");
            if (!mentionRe.test(transcript) && !transcript.startsWith("/")) {
              await react(chatId, messageId, "");
              conversationBuffer.push(bufKey, senderName, `[voice] ${transcript}`);
              logDebug("main", `Buffered voice transcript: "${transcript.slice(0, 60)}"`);
              return;
            }
            text = transcript.replace(mentionRe, "").trim();
          } else {
            text = transcript;
          }

          isVoiceNote = true;
          if (!text) { await react(chatId, messageId, ""); return; }
        } catch (err) {
          logError("main", "Voice transcription failed", err);
          await react(chatId, messageId, "");
          if (!isGroup) {
            await telegramApi.sendMessage(chatId, "❌ Voice transcription failed.", { message_thread_id: threadId });
          }
          return;
        }
      }

      // --- Text message group filtering ---
      if (!isVoiceNote && isGroup) {
        const mentionRe = new RegExp(`@${botUsername}\\b`, "i");
        const isMention = mentionRe.test(text);
        const isCommand = text.startsWith("/");

        if (!isMention && !isCommand) {
          conversationBuffer.push(bufKey, senderName, text);
          logDebug("main", `Buffered group msg from ${senderName}: "${text.slice(0, 60)}"`);
          return;
        }

        if (isMention) {
          text = text.replace(mentionRe, "").trim();
          if (!text) return;
        }
      }

      if (!isVoiceNote && !securityGate.authorize(message)) {
        if (isGroup) conversationBuffer.push(bufKey, senderName, text);
        logWarn("main", `Unauthorized user ${message.from.id}`);
        return;
      }

      const sessionKey = `telegram:${chatId}`;

      if (text === "/new" || text === "/reset") {
        const timer = idleSaveTimers.get(sessionKey);
        if (timer) { clearTimeout(timer); idleSaveTimers.delete(sessionKey); }
        await saveChatToWorking(sessionKey, chatId);
        if (text === "/reset" && codingMode.has(sessionKey)) {
          await stopCodingMode(sessionKey);
        }
        if (codingMode.has(sessionKey) && codingTransport) {
          await codingTransport.resetSession(sessionKey);
        } else {
          await transport.resetSession(sessionKey);
        }
        if (isGroup) conversationBuffer.clear(bufKey);
        pendingSessionStart.add(sessionKey);
        if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, chatId);
        const modeLabel = text === "/reset" ? "🔄 Reset to KP." : codingMode.has(sessionKey) ? "🔄 New coding session." : "🔄 New session started.";
        await telegramApi.sendMessage(chatId, modeLabel, { message_thread_id: threadId });
        logInfo("main", `Session ${text} (mode=${codingMode.has(sessionKey) ? "coding" : "default"})`);
        return;
      }

      if (text === "/coding") {
        if (codingMode.has(sessionKey)) {
          await telegramApi.sendMessage(chatId, "Already in coding mode. Use /default to switch back.", { message_thread_id: threadId });
          return;
        }
        await telegramApi.sendMessage(chatId, "🔧 Switching to coding agent (Opus)...", { message_thread_id: threadId });
        try {
          await startCodingMode(sessionKey);
          await telegramApi.sendMessage(chatId, "🔧 Coding agent ready. All messages now go to Opus.\nUse /default to switch back to KP.", { message_thread_id: threadId });
          logInfo("main", `Coding mode activated for ${sessionKey}`);
        } catch (err) {
          await telegramApi.sendMessage(chatId, `❌ Failed to start coding agent: ${err instanceof Error ? err.message : String(err)}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/default") {
        if (!codingMode.has(sessionKey)) {
          await telegramApi.sendMessage(chatId, "Already in default mode (KP).", { message_thread_id: threadId });
          return;
        }
        await telegramApi.sendMessage(chatId, "🔄 Switching back to KP...", { message_thread_id: threadId });
        await stopCodingMode(sessionKey);
        await telegramApi.sendMessage(chatId, "🔄 Back to KP.", { message_thread_id: threadId });
        logInfo("main", `Default mode restored for ${sessionKey}`);
        return;
      }

      if (text === "/status") {
        const lines = buildStatusLines({ transport, config, startedAt, memory });
        await telegramApi.sendMessage(chatId, lines.join("\n"), { message_thread_id: threadId });
        return;
      }

      if (text === "/stop" || text === "/cancel") {
        await transport.sendInterrupt();
        busyChats.delete(sessionKey);
        await telegramApi.sendMessage(chatId, "🛑 Ctrl+C sent to Kiro.", { message_thread_id: threadId });
        logInfo("main", "Ctrl+C interrupt sent");
        return;
      }

      if (text === "/restart") {
        if (transport instanceof TmuxClient) {
          await telegramApi.sendMessage(chatId, "\u267b\ufe0f Restarting Kiro...", { message_thread_id: threadId });
          busyChats.delete(sessionKey);
          await (transport as TmuxClient).restartSession(config.workingDir, process.env["KIRO_MODEL"]);
          pendingSessionStart.add(sessionKey);
          await telegramApi.sendMessage(chatId, "\u2705 Kiro restarted.", { message_thread_id: threadId });
        } else {
          await telegramApi.sendMessage(chatId, "\u26a0\ufe0f /restart only works with tmux transport.", { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/full") {
        fullModeChats.add(sessionKey);
        await telegramApi.sendMessage(chatId, "📺 Full mode — sending raw output, TTS disabled.", { message_thread_id: threadId });
        return;
      }

      if (text === "/short") {
        fullModeChats.delete(sessionKey);
        await telegramApi.sendMessage(chatId, "✂️ Short mode — clean responses, TTS enabled.", { message_thread_id: threadId });
        return;
      }

      if (text === "/facts") {
        if (memory) {
          const facts = memory.readCoreKnowledge();
          const msg = facts ? `📋 Core knowledge:\n\n${facts}` : "📋 No core knowledge yet.";
          await telegramApi.sendMessage(chatId, msg, { message_thread_id: threadId });
        } else {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/cron") {
        const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/Budapest", dateStyle: "medium", timeStyle: "medium" });
        let crontab: string;
        try { crontab = execSync("crontab -l 2>/dev/null || echo '(no crontab)'", { timeout: 3000, encoding: "utf-8" }).trim(); } catch { crontab = "(failed to read crontab)"; }
        await telegramApi.sendMessage(chatId, `⏰ ${now}\n\n${crontab}`, { message_thread_id: threadId });
        return;
      }

      if (text === "/memory") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const stats = memory.getStats(chatId);
        if (!stats) {
          await telegramApi.sendMessage(chatId, "⚠️ Could not retrieve memory stats.", { message_thread_id: threadId });
          return;
        }
        const dbMb = (stats.dbSizeBytes / (1024 * 1024)).toFixed(1);
        const types = Object.entries(stats.extractedByType)
          .map(([t, n]) => `  ${t}: ${n}`)
          .join("\n") || "  (none)";
        const msg = [
          "🧠 Memory Status",
          "",
          `💬 Raw messages: ${stats.totalMessages}`,
          `🧩 Extracted memories: ${stats.extractedMemories}`,
          types,
          `🔑 Preserved keywords: ${stats.preservedKeywords}`,
          "",
          `📄 Consolidations:`,
          `  daily: ${stats.consolidationFiles.daily}`,
          `  weekly: ${stats.consolidationFiles.weekly}`,
          `  quarterly: ${stats.consolidationFiles.quarterly}`,
          "",
          `📄 Ingested documents: ${stats.ingestedDocuments}`,
          `💓 Heartbeat: ${stats.heartbeatRunning ? "running" : "stopped"}`,
          `💾 DB size: ${dbMb} MB`,
          "",
          `📚 Layer 6 (NotebookLM): ${nlmConfig.enabled ? "enabled" : "disabled"}`,
        ].join("\n");
        await telegramApi.sendMessage(chatId, msg, { message_thread_id: threadId });
        return;
      }

      if (text === "/ingest list") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const docs = memory.listIngestedDocuments(chatId);
          if (docs.length === 0) {
            await telegramApi.sendMessage(chatId, "📄 No ingested documents yet.", { message_thread_id: threadId });
          } else {
            const lines = docs.map((d) => {
              const date = new Date(d.ingestedAt).toISOString().slice(0, 10);
              return `• [${d.sourceType}] ${d.identifier} — ${d.chunkCount} chunks (${date})`;
            });
            await telegramApi.sendMessage(chatId, `📄 Ingested documents:\n\n${lines.join("\n")}`, { message_thread_id: threadId });
          }
        } catch (err) {
          logError("main", "Failed to list ingested documents", err);
          await telegramApi.sendMessage(chatId, "❌ Failed to list ingested documents.", { message_thread_id: threadId });
        }
        return;
      }

      if (text.startsWith("/ingest ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const arg = text.slice("/ingest ".length).trim();
        if (!arg) {
          await telegramApi.sendMessage(chatId, "Usage: /ingest <url_or_path> or /ingest list", { message_thread_id: threadId });
          return;
        }
        // Auto-detect source type
        const sourceType = detectIngestSourceType(arg);
        try {
          await telegramApi.sendMessage(chatId, `📥 Ingesting ${sourceType} source: ${arg}...`, { message_thread_id: threadId });
          const result = await memory.ingestDocument({ type: sourceType, identifier: arg }, chatId);
          await telegramApi.sendMessage(chatId, `✅ Ingested ${result.chunkCount} chunks from [${result.sourceType}] ${result.identifier}`, { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Ingestion failed", err);
          await telegramApi.sendMessage(chatId, `❌ Ingestion failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reflect list") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const channelKey = String(chatId);
          const reflections = memory.listReflections(channelKey);
          if (reflections.length === 0) {
            await telegramApi.sendMessage(chatId, "🪞 No reflections yet.", { message_thread_id: threadId });
          } else {
            const lines = reflections.map((r) => `• ${r.date} — ${r.preview}`);
            await telegramApi.sendMessage(chatId, `🪞 Reflections:\n\n${lines.join("\n")}`, { message_thread_id: threadId });
          }
        } catch (err) {
          logError("main", "Failed to list reflections", err);
          await telegramApi.sendMessage(chatId, "❌ Failed to list reflections.", { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reflect" || text.startsWith("/reflect ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          const channelKey = String(chatId);
          const arg = text.slice("/reflect".length).trim();
          const windowDays = arg ? parseInt(arg, 10) : undefined;
          if (arg && (isNaN(windowDays!) || windowDays! <= 0)) {
            await telegramApi.sendMessage(chatId, "Usage: /reflect [days] or /reflect list", { message_thread_id: threadId });
            return;
          }
          await telegramApi.sendMessage(chatId, "🪞 Generating reflection...", { message_thread_id: threadId });
          const reflection = await memory.reflect(channelKey, windowDays);
          await telegramApi.sendMessage(chatId, `🪞 Reflection (${reflection.date}):\n\n${reflection.content}`, { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Reflection failed", err);
          await telegramApi.sendMessage(chatId, `❌ Reflection failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text === "/reembed") {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        try {
          await telegramApi.sendMessage(chatId, "🔄 Re-embedding all stored content with current model...", { message_thread_id: threadId });
          let lastReported = 0;
          await memory.reembed((processed, total) => {
            if (total === 0) return;
            const pct = Math.floor((processed / total) * 100);
            if (pct >= lastReported + 25 || processed === total) {
              lastReported = pct;
              telegramApi.sendMessage(chatId, `🔄 Re-embedding: ${processed}/${total} (${pct}%)`, { message_thread_id: threadId }).catch(() => {});
            }
          });
          await telegramApi.sendMessage(chatId, "✅ Re-embedding complete.", { message_thread_id: threadId });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Re-embedding failed", err);
          await telegramApi.sendMessage(chatId, `❌ Re-embedding failed: ${errMsg}`, { message_thread_id: threadId });
        }
        return;
      }

      if (text.startsWith("/forget ")) {
        if (!memory) {
          await telegramApi.sendMessage(chatId, "🧠 Memory is disabled.", { message_thread_id: threadId });
          return;
        }
        const args = text.slice("/forget ".length).trim();

        if (args.startsWith("topic ")) {
          const topic = args.slice("topic ".length).trim();
          if (!topic) {
            await telegramApi.sendMessage(chatId, "Usage: /forget topic <topic>", { message_thread_id: threadId });
            return;
          }
          try {
            const result = await memory.forgetTopic(chatId, topic);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings related to "${topic}".`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget topic failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        if (args.startsWith("range ")) {
          const rangeParts = args.slice("range ".length).trim().split(/\s+/);
          if (rangeParts.length < 2) {
            await telegramApi.sendMessage(chatId, "Usage: /forget range <start-date> <end-date> (YYYY-MM-DD)", { message_thread_id: threadId });
            return;
          }
          const startDate = new Date(rangeParts[0]!);
          const endDate = new Date(rangeParts[1]!);
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            await telegramApi.sendMessage(chatId, "❌ Invalid date format. Use YYYY-MM-DD.", { message_thread_id: threadId });
            return;
          }
          // Set endDate to end of day
          endDate.setHours(23, 59, 59, 999);
          try {
            const result = memory.forgetRange(chatId, startDate, endDate);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings in date range.`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget range failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        if (args.startsWith("session ")) {
          const sessionId = args.slice("session ".length).trim();
          if (!sessionId) {
            await telegramApi.sendMessage(chatId, "Usage: /forget session <session-id>", { message_thread_id: threadId });
            return;
          }
          try {
            const result = memory.forgetSession(chatId, sessionId);
            await telegramApi.sendMessage(chatId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings for session.`, { message_thread_id: threadId });
          } catch (err) {
            logError("main", "Forget session failed", err);
            await telegramApi.sendMessage(chatId, "❌ Forget failed.", { message_thread_id: threadId });
          }
          return;
        }

        // Unknown subcommand
        await telegramApi.sendMessage(chatId, "Usage: /forget topic <topic> | /forget range <start> <end> | /forget session <id>", { message_thread_id: threadId });
        return;
      }

      if (text === "/nlm" || text.startsWith("/nlm ")) {
        const kbArgs = text.slice("/nlm".length).trim();
        const result = await handleNLMCommand(kbArgs, nlmConfig);
        await telegramApi.sendMessage(chatId, result.text, { message_thread_id: threadId });
        return;
      }

      if (text === "/mcporter") {
        await telegramApi.sendMessage(chatId, getMcporterStatus(), { message_thread_id: threadId });
        return;
      }

      if (text === "/help") {
        const helpText = [
          "📋 Available commands:",
          "",
          "/new — Start a new session",
          "/reset — Reset current session",
          "/status — Show bot status",
          "/stop — Stop current response",
          "/cancel — Cancel current request",
          "/facts — Show core knowledge (user profile + agent notes)",
          "/memory — Memory storage statistics",
          "/cron — System crontab",
          "/ingest — Ingest a document (reply to file)",
          "/ingest list — List ingested documents",
          "/reflect — Trigger memory reflection",
          "/reflect list — List reflections",
          "/reflect <days> — Reflect over N days",
          "/reembed — Re-embed all memories",
          "/forget topic <topic> — Forget by topic",
          "/forget range <start> <end> — Forget date range",
          "/forget session <id> — Forget a session",
          "/full — Raw tmux output, no TTS",
          "/short — Clean responses (default)",
          "/nlm — Knowledge base (list/create/sources/query)",
          "/coding — Switch to Opus coding agent",
          "/default — Switch back to KP",
          "/help — Show this help message",
        ].join("\n");
        await telegramApi.sendMessage(chatId, helpText, { message_thread_id: threadId });
        return;
      }

      // // prefix → pass-through to Kiro (e.g. //agent → /agent)
      let passThrough = false;
      if (text.startsWith("//")) {
        text = text.slice(1);
        passThrough = true;
      }

      // Unknown command guard — prevent unrecognized /commands from reaching transport
      if (!passThrough && text.startsWith("/") && /^\/\w+/.test(text)) {
        const cmd = text.split(/\s/)[0]!;
        const known = ["/new", "/reset", "/status", "/stop", "/cancel", "/restart", "/full", "/short", "/facts", "/memory", "/cron", "/ingest", "/reflect", "/reembed", "/forget", "/nlm", "/coding", "/default", "/help"];
        if (!known.includes(cmd)) {
          await telegramApi.sendMessage(chatId, `❓ Unknown command: ${cmd}\nType /help for available commands.`, { message_thread_id: threadId });
          return;
        }
      }

      if (busyChats.has(sessionKey)) {
        await telegramApi.sendMessage(chatId, "⏳ Previous request still in progress...", { message_thread_id: threadId });
        return;
      }

      let typingInterval: ReturnType<typeof setInterval> | undefined;
      try {
        busyChats.add(sessionKey);
        logInfo("main", `← ${isVoiceNote ? "🎤 " : ""}"${text.slice(0, 60)}"`);

        // Queue message if sleep is in progress
        if (sleepChild) {
          if (!sleepRepliedChats.has(chatId)) {
            await telegramApi.sendMessage(chatId, "Oh good morning, I am just waking up, give me a minute please.. I answer you soon ☕", { message_thread_id: threadId });
            sleepRepliedChats.add(chatId);
          }
          pendingMessages.push({ chatId, text, threadId, sessionKey });
          busyChats.delete(sessionKey);
          return;
        }
        // Prepend buffered conversation context
        let prompt = text;
        if (isGroup) {
          const context = conversationBuffer.drain(bufKey);
          if (context) {
            prompt = context + text;
            logDebug("main", `Prepended group context to prompt`);
          }
        }

        if (memory) {
          prompt = preparePrompt(prompt, memory, chatId, sessionKey, text, pendingSessionStart, seenSessions, messageId);
        }

        prompt = interceptLargeMessage(prompt).text;
        const activeTransport = codingMode.has(sessionKey) && codingTransport ? codingTransport : transport;
        const responsePromise = activeTransport.sendPrompt(sessionKey, prompt);

        if (!isVoiceNote) await react(chatId, messageId, "👀");
        await telegramApi.sendChatAction(chatId, "typing", threadId);
        typingInterval = setInterval(() => {
          telegramApi.sendChatAction(chatId, "typing", threadId).catch(() => {});
        }, 8000);

        // Stream intermediate chunks to Telegram as Kiro works
        let intermediateDelivered = false;
        if (transport instanceof TmuxClient) {
          (transport as TmuxClient).onIntermediateResponse = (chunk: string) => {
            intermediateDelivered = true;
            const isFullMode = fullModeChats.has(sessionKey);
            const chunks = formatter.chunkText(isFullMode ? chunk : chunk);
            for (const c of chunks) {
              if (c.trim()) {
                telegramApi.sendChatAction(chatId, "typing", threadId).catch(() => {});
                telegramApi.sendMessage(chatId, c, { message_thread_id: threadId }).catch(() => {});
              }
            }
          };
        }

        const response = await responsePromise;

        if (transport instanceof TmuxClient) {
          (transport as TmuxClient).onIntermediateResponse = undefined;
        }
        logDebug("main", `Response (${response.length} chars): "${response.slice(0, 120)}"`);

        // Prefer the clean answer-only extract (strips system prompts, memory context, thinking indicators)
        const cleanAnswer = ("answerOnly" in transport && (transport as TmuxClient).answerOnly)
          ? (transport as TmuxClient).answerOnly
          : "";
        const userResponse = fullModeChats.has(sessionKey) ? response : (cleanAnswer || response);

        if (!userResponse || !userResponse.trim()) {
          if (!intermediateDelivered) {
            logWarn("main", "Empty response from transport");
            await react(chatId, messageId, "🤷");
            await telegramApi.sendMessage(chatId, "🤷 Kiro returned an empty response. Try again or /reset.", { message_thread_id: threadId });
          }
          return;
        }

        // Reaction-only response: [REACT:emoji] with no other text
        const reactMatch = userResponse.trim().match(/^\[REACT:(.+)\]$/);
        if (reactMatch) {
          await react(chatId, messageId, reactMatch[1]!);
          logDebug("main", `Reaction-only response: ${reactMatch[1]}`);
          return;
        }

        // Only send final response if nothing was streamed, or if there's new content
        let lastSentMsgId: number | undefined;
        if (!intermediateDelivered) {
          const chunks = formatter.chunkText(userResponse);
          logDebug("main", `Sending ${chunks.length} chunk(s)`);
          for (const chunk of chunks) {
            if (chunk.trim()) {
              await telegramApi.sendChatAction(chatId, "typing", threadId);
              lastSentMsgId = await telegramApi.sendMessage(chatId, chunk, { message_thread_id: threadId });
            }
          }
        } else if (transport instanceof TmuxClient) {
          // Intermediate streaming may not have delivered the full answer — send the tail
          const delivered = (transport as TmuxClient).intermediateDeliveredText;
          const finalAnswer = cleanAnswer || response;
          if (delivered && finalAnswer.length > delivered.length && finalAnswer.startsWith(delivered)) {
            const tail = finalAnswer.slice(delivered.length).trim();
            if (tail) {
              logDebug("main", `Sending streamed tail (${tail.length} chars)`);
              const tailChunks = formatter.chunkText(tail);
              for (const chunk of tailChunks) {
                if (chunk.trim()) {
                  await telegramApi.sendChatAction(chatId, "typing", threadId);
                  lastSentMsgId = await telegramApi.sendMessage(chatId, chunk, { message_thread_id: threadId });
                }
              }
            }
          }
        }

        if (memory) {
          memory.recordMessage({ role: "assistant", content: cleanAnswer || response, timestamp: Date.now(), chatId, sessionId: sessionKey, platformMessageId: lastSentMsgId });
        }

        if (isVoiceNote && ttsConfig && !fullModeChats.has(sessionKey)) {
          try {
            await telegramApi.sendChatAction(chatId, "record_voice", threadId);
            const ttsText = cleanAnswer || response;
            const audio = await synthesizeSpeech(ttsText, ttsConfig);
            if (audio) {
              await telegramApi.sendVoice(chatId, audio, { message_thread_id: threadId });
              logInfo("main", `🔊 Voice reply sent (${audio.length} bytes)`);
            }
          } catch (err) {
            logWarn("main", `TTS failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        await react(chatId, messageId, "");
        logInfo("main", `→ Response delivered to chat ${chatId}${intermediateDelivered ? " (streamed)" : ""}`);

        // Auto-compact when context window usage exceeds threshold (percentage-based)
        if (memory && "contextPercent" in transport) {
          const pct = (transport as TmuxClient).contextPercent;
          const threshold = memory.getConfig().searchEnhancements.compactThresholdPct;
          if (pct >= threshold) {
            logInfo("main", `⚠️ Context window at ${pct}% (threshold: ${threshold}%) — auto-compacting`);
            await telegramApi.sendMessage(chatId, `📦 Context window at ${pct}% — auto-compacting...`, { message_thread_id: threadId });
            try {
              await memory.checkAutoCompact({
                chatId,
                sessionId: sessionKey,
                contextPercent: pct,
                sendCompactCommand: (sk, cmd) => transport.sendPrompt(sk, cmd),
              });
              await telegramApi.sendMessage(chatId, "📦 Auto-compaction complete.", { message_thread_id: threadId });
              if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, chatId);
            } catch (err) {
              logError("main", "Auto-compaction failed", err);
            }
          }
        }
      } catch (err) {
        logError("main", `Error for chat ${chatId}`, err);
        await react(chatId, messageId, "");
        await telegramApi.sendMessage(chatId, "❌ Something went wrong. Try /reset to start fresh.", { message_thread_id: threadId });
      } finally {
        clearInterval(typingInterval);
        busyChats.delete(sessionKey);
        resetIdleSaveTimer(sessionKey, chatId);
      }
    };

    telegramPoller = new TelegramPoller(telegramApi, config.pollTimeoutS, handleUpdate);
    try {
      telegramPoller.start();
      logInfo("main", "📡 Telegram polling started");
      announcePlatform(transport, "TELEGRAM").catch(() => {});
    } catch (err) {
      logError("main", "Telegram failed to start", err);
    }
  } else {
    logInfo("main", "📡 Telegram disabled (no --telegram flag)");
  }

  // --- Discord wiring (conditional) ---
  let discordPoller: DiscordPoller | null = null;

  if (platforms.discord && config.discordEnabled) {
    const discordApi = new DiscordApi(config.discordBotToken!);
    const discordSecurityGate = new DiscordSecurityGate(
      config.discordAllowedUserIds!,
      config.discordAllowedChannelIds!,
    );
    const channelAdapter = new ChannelAdapter();

    let b2bRouter: B2BRouter | null = null;
    if (config.discordB2bEnabled) {
      b2bRouter = new B2BRouter({
        discordApi,
        b2bChannelId: config.discordB2bChannelId!,
        peerBotId: config.discordB2bPeerBotId!,
        rateLimitMs: config.discordB2bRateLimitMs,
        onPrompt: (sessionKey, text) => transport.sendPrompt(sessionKey, interceptLargeMessage(text).text),
      });
      logInfo("main", `🤝 B2B router enabled (channel=${config.discordB2bChannelId})`);
    }

    const handleDiscordMessage = async (message: DiscordInboundMessage): Promise<void> => {
      logDebug("main", `Discord message from ${message.authorUsername} in ${message.channelId}`);

      const effectiveChannelId = message.parentChannelId ?? message.channelId;

      // Security gate
      if (!discordSecurityGate.authorize(message.authorId, effectiveChannelId)) {
        logDebug("main", `Discord: unauthorized user=${message.authorId} channel=${effectiveChannelId}`);
        return;
      }

      const bridgeMsg = channelAdapter.fromDiscord(message);
      const sessionKey = channelAdapter.sessionKey("discord", message.channelId);
      const bufKey = `discord:${message.channelId}`;
      const rawText = bridgeMsg.text.trim();

      if (!rawText) return;

      // Pass all messages through — Kiro (the LLM) decides whether to respond
      // based on the DISCORD_SKILL.md steering file. The bridge only handles
      // security (allowed users/channels) and transport.
      // Strip Kiro's own mention tag before forwarding so the model sees clean text.
      let text = stripDiscordMentions(rawText, config.discordAppId!);
      if (!text) return;

      // Include sender context so Kiro knows who's talking
      const senderPrefix = `[${message.authorUsername}${message.authorIsBot ? " (bot)" : ""}] in #${message.channelName ?? "unknown"}: `;

      // B2B routing — peer bot messages in the B2B channel go through the B2B router
      if (b2bRouter && message.authorIsBot && effectiveChannelId === config.discordB2bChannelId) {
        const cleanedMessage = { ...message, content: text };
        await b2bRouter.handleMessage(cleanedMessage);
        return;
      }

      // Command handling
      if (text === "/new" || text === "/reset") {
        const timer = idleSaveTimers.get(sessionKey);
        if (timer) { clearTimeout(timer); idleSaveTimers.delete(sessionKey); }
        const discordChatId = parseInt(message.channelId, 10) || 0;
        await saveChatToWorking(sessionKey, discordChatId);
        if (text === "/reset" && codingMode.has(sessionKey)) {
          await stopCodingMode(sessionKey);
        }
        if (codingMode.has(sessionKey) && codingTransport) {
          await codingTransport.resetSession(sessionKey);
        } else {
          await transport.resetSession(sessionKey);
        }
        conversationBuffer.clear(bufKey);
        pendingSessionStart.add(sessionKey);
        if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, discordChatId);
        const modeLabel = text === "/reset" ? "🔄 Reset to KP." : "🔄 New session started.";
        await discordApi.sendMessage(message.channelId, modeLabel);
        logInfo("main", `Discord session ${text} for ${sessionKey}`);
        return;
      }

      if (text === "/default") {
        if (!codingMode.has(sessionKey)) {
          await discordApi.sendMessage(message.channelId, "Already in default mode (KP).");
          return;
        }
        await discordApi.sendMessage(message.channelId, "🔄 Switching back to KP...");
        await stopCodingMode(sessionKey);
        await discordApi.sendMessage(message.channelId, "🔄 Back to KP.");
        logInfo("main", `Default mode restored for ${sessionKey}`);
        return;
      }

      if (text === "/status") {
        const lines = buildStatusLines({ transport, config, startedAt, memory });
        await discordApi.sendMessage(message.channelId, lines.join("\n"));
        return;
      }

      if (text === "/b2b-reset") {
        if (config.discordB2bEnabled) {
          const b2bSessionKey = `b2b:${config.discordB2bChannelId}`;
          await transport.resetSession(b2bSessionKey);
          await discordApi.sendMessage(message.channelId, "🔄 B2B session reset.");
          logInfo("main", `B2B session reset by user ${message.authorId}`);
        } else {
          await discordApi.sendMessage(message.channelId, "B2B is not enabled.");
        }
        return;
      }

      if (text === "/restart") {
        if (transport instanceof TmuxClient) {
          await discordApi.sendMessage(message.channelId, "\u267b\ufe0f Restarting Kiro...");
          busyChats.delete(sessionKey);
          await (transport as TmuxClient).restartSession(config.workingDir, process.env["KIRO_MODEL"]);
          pendingSessionStart.add(sessionKey);
          await discordApi.sendMessage(message.channelId, "\u2705 Kiro restarted.");
        } else {
          await discordApi.sendMessage(message.channelId, "\u26a0\ufe0f /restart only works with tmux transport.");
        }
        return;
      }

      if (text === "/memory") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        const stats = memory.getStats(chatId);
        if (!stats) {
          await discordApi.sendMessage(message.channelId, "⚠️ Could not retrieve memory stats.");
          return;
        }
        const dbMb = (stats.dbSizeBytes / (1024 * 1024)).toFixed(1);
        const types = Object.entries(stats.extractedByType)
          .map(([t, n]) => `  ${t}: ${n}`)
          .join("\n") || "  (none)";
        const msg = [
          "🧠 Memory Status",
          "",
          `💬 Raw messages: ${stats.totalMessages}`,
          `🧩 Extracted memories: ${stats.extractedMemories}`,
          types,
          `🔑 Preserved keywords: ${stats.preservedKeywords}`,
          "",
          `📄 Consolidations:`,
          `  daily: ${stats.consolidationFiles.daily}`,
          `  weekly: ${stats.consolidationFiles.weekly}`,
          `  quarterly: ${stats.consolidationFiles.quarterly}`,
          "",
          `📄 Ingested documents: ${stats.ingestedDocuments}`,
          `💓 Heartbeat: ${stats.heartbeatRunning ? "running" : "stopped"}`,
          `💾 DB size: ${dbMb} MB`,
          "",
          `📚 Layer 6 (NotebookLM): ${nlmConfig.enabled ? "enabled" : "disabled"}`,
        ].join("\n");
        await discordApi.sendMessage(message.channelId, msg);
        return;
      }

      if (text === "/cron") {
        const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/Budapest", dateStyle: "medium", timeStyle: "medium" });
        let crontab: string;
        try { crontab = execSync("crontab -l 2>/dev/null || echo '(no crontab)'", { timeout: 3000, encoding: "utf-8" }).trim(); } catch { crontab = "(failed to read crontab)"; }
        await discordApi.sendMessage(message.channelId, `⏰ ${now}\n\n${crontab}`);
        return;
      }

      if (text === "/ingest list") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        try {
          const docs = memory.listIngestedDocuments(chatId);
          if (docs.length === 0) {
            await discordApi.sendMessage(message.channelId, "📄 No ingested documents yet.");
          } else {
            const lines = docs.map((d) => {
              const date = new Date(d.ingestedAt).toISOString().slice(0, 10);
              return `• [${d.sourceType}] ${d.identifier} — ${d.chunkCount} chunks (${date})`;
            });
            await discordApi.sendMessage(message.channelId, `📄 Ingested documents:\n\n${lines.join("\n")}`);
          }
        } catch (err) {
          logError("main", "Failed to list ingested documents (Discord)", err);
          await discordApi.sendMessage(message.channelId, "❌ Failed to list ingested documents.");
        }
        return;
      }

      if (text.startsWith("/ingest ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const arg = text.slice("/ingest ".length).trim();
        if (!arg) {
          await discordApi.sendMessage(message.channelId, "Usage: /ingest <url_or_path> or /ingest list");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        // Auto-detect source type
        const sourceType = detectIngestSourceType(arg);
        try {
          await discordApi.sendMessage(message.channelId, `📥 Ingesting ${sourceType} source: ${arg}...`);
          const result = await memory.ingestDocument({ type: sourceType, identifier: arg }, chatId);
          await discordApi.sendMessage(message.channelId, `✅ Ingested ${result.chunkCount} chunks from [${result.sourceType}] ${result.identifier}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Ingestion failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Ingestion failed: ${errMsg}`);
        }
        return;
      }

      if (text === "/reflect list") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          const channelKey = message.channelId;
          const reflections = memory.listReflections(channelKey);
          if (reflections.length === 0) {
            await discordApi.sendMessage(message.channelId, "🪞 No reflections yet.");
          } else {
            const lines = reflections.map((r) => `• ${r.date} — ${r.preview}`);
            await discordApi.sendMessage(message.channelId, `🪞 Reflections:\n\n${lines.join("\n")}`);
          }
        } catch (err) {
          logError("main", "Failed to list reflections (Discord)", err);
          await discordApi.sendMessage(message.channelId, "❌ Failed to list reflections.");
        }
        return;
      }

      if (text === "/reflect" || text.startsWith("/reflect ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          const channelKey = message.channelId;
          const arg = text.slice("/reflect".length).trim();
          const windowDays = arg ? parseInt(arg, 10) : undefined;
          if (arg && (isNaN(windowDays!) || windowDays! <= 0)) {
            await discordApi.sendMessage(message.channelId, "Usage: /reflect [days] or /reflect list");
            return;
          }
          await discordApi.sendMessage(message.channelId, "🪞 Generating reflection...");
          const reflection = await memory.reflect(channelKey, windowDays);
          await discordApi.sendMessage(message.channelId, `🪞 Reflection (${reflection.date}):\n\n${reflection.content}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Reflection failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Reflection failed: ${errMsg}`);
        }
        return;
      }

      if (text === "/reembed") {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        try {
          await discordApi.sendMessage(message.channelId, "🔄 Re-embedding all stored content with current model...");
          let lastReported = 0;
          await memory.reembed((processed, total) => {
            if (total === 0) return;
            const pct = Math.floor((processed / total) * 100);
            if (pct >= lastReported + 25 || processed === total) {
              lastReported = pct;
              discordApi.sendMessage(message.channelId, `🔄 Re-embedding: ${processed}/${total} (${pct}%)`).catch(() => {});
            }
          });
          await discordApi.sendMessage(message.channelId, "✅ Re-embedding complete.");
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logError("main", "Re-embedding failed (Discord)", err);
          await discordApi.sendMessage(message.channelId, `❌ Re-embedding failed: ${errMsg}`);
        }
        return;
      }

      if (text.startsWith("/forget ")) {
        if (!memory) {
          await discordApi.sendMessage(message.channelId, "🧠 Memory is disabled.");
          return;
        }
        const chatId = parseInt(message.channelId, 10) || 0;
        const args = text.slice("/forget ".length).trim();

        if (args.startsWith("topic ")) {
          const topic = args.slice("topic ".length).trim();
          if (!topic) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget topic <topic>");
            return;
          }
          try {
            const result = await memory.forgetTopic(chatId, topic);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings related to "${topic}".`);
          } catch (err) {
            logError("main", "Forget topic failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        if (args.startsWith("range ")) {
          const rangeParts = args.slice("range ".length).trim().split(/\s+/);
          if (rangeParts.length < 2) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget range <start-date> <end-date> (YYYY-MM-DD)");
            return;
          }
          const startDate = new Date(rangeParts[0]!);
          const endDate = new Date(rangeParts[1]!);
          if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
            await discordApi.sendMessage(message.channelId, "❌ Invalid date format. Use YYYY-MM-DD.");
            return;
          }
          // Set endDate to end of day
          endDate.setHours(23, 59, 59, 999);
          try {
            const result = memory.forgetRange(chatId, startDate, endDate);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings in date range.`);
          } catch (err) {
            logError("main", "Forget range failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        if (args.startsWith("session ")) {
          const sessionId = args.slice("session ".length).trim();
          if (!sessionId) {
            await discordApi.sendMessage(message.channelId, "Usage: /forget session <session-id>");
            return;
          }
          try {
            const result = memory.forgetSession(chatId, sessionId);
            await discordApi.sendMessage(message.channelId, `🗑️ Forgot ${result.messagesRemoved} messages, ${result.embeddingsRemoved} embeddings for session.`);
          } catch (err) {
            logError("main", "Forget session failed (Discord)", err);
            await discordApi.sendMessage(message.channelId, "❌ Forget failed.");
          }
          return;
        }

        // Unknown subcommand
        await discordApi.sendMessage(message.channelId, "Usage: /forget topic <topic> | /forget range <start> <end> | /forget session <id>");
        return;
      }

      if (text === "/nlm" || text.startsWith("/nlm ")) {
        const kbArgs = text.slice("/nlm".length).trim();
        const result = await handleNLMCommand(kbArgs, nlmConfig);
        await discordApi.sendMessage(message.channelId, result.text);
        return;
      }

      if (text === "/mcporter") {
        await discordApi.sendMessage(message.channelId, getMcporterStatus());
        return;
      }

      if (text === "/help") {
        const helpText = [
          "📋 Available commands:",
          "",
          "/new — Start a new session",
          "/reset — Reset current session",
          "/status — Show bot status",
          "/stop — Stop current response",
          "/cancel — Cancel current request",
          "/facts — Show core knowledge (user profile + agent notes)",
          "/memory — Memory storage statistics",
          "/cron — System crontab",
          "/ingest — Ingest a document (reply to file)",
          "/ingest list — List ingested documents",
          "/reflect — Trigger memory reflection",
          "/reflect list — List reflections",
          "/reflect <days> — Reflect over N days",
          "/reembed — Re-embed all memories",
          "/forget topic <topic> — Forget by topic",
          "/forget range <start> <end> — Forget date range",
          "/forget session <id> — Forget a session",
          "/full — Raw tmux output, no TTS",
          "/short — Clean responses (default)",
          "/nlm — Knowledge base (list/create/sources/query)",
          "/default — Switch back to KP",
          "/help — Show this help message",
        ].join("\n");
        await discordApi.sendMessage(message.channelId, helpText);
        return;
      }

      // // prefix → pass-through to Kiro (e.g. //agent → /agent)
      let passThrough = false;
      if (text.startsWith("//")) {
        text = text.slice(1);
        passThrough = true;
      }

      // Unknown command guard — prevent unrecognized /commands from reaching transport
      if (!passThrough && text.startsWith("/") && /^\/\w+/.test(text)) {
        const cmd = text.split(/\s/)[0]!;
        const known = ["/new", "/reset", "/status", "/stop", "/cancel", "/restart", "/full", "/short", "/facts", "/memory", "/cron", "/ingest", "/reflect", "/reembed", "/forget", "/nlm", "/default", "/help"];
        if (!known.includes(cmd)) {
          await discordApi.sendMessage(message.channelId, `❓ Unknown command: ${cmd}\nType /help for available commands.`);
          return;
        }
      }

      if (busyChats.has(sessionKey)) {
        await discordApi.sendMessage(message.channelId, "⏳ Previous request still in progress...");
        return;
      }

      try {
        busyChats.add(sessionKey);
        logInfo("main", `← Discord: "${text.slice(0, 60)}"`);

        // Build prompt with sender context
        let prompt = senderPrefix + text;
        const context = conversationBuffer.drain(bufKey);
        if (context) {
          prompt = context + prompt;
          logDebug("main", `Discord: prepended conversation context to prompt`);
        }

        if (memory) {
          const chatId = parseInt(message.channelId, 10) || 0;
          prompt = preparePrompt(prompt, memory, chatId, sessionKey, text, pendingSessionStart, seenSessions);
        }

        prompt = interceptLargeMessage(prompt).text;
        const response = await transport.sendPrompt(sessionKey, prompt);

        // Prefer the clean answer-only extract (strips system prompts, memory context, thinking indicators)
        const cleanAnswer = ("answerOnly" in transport && (transport as TmuxClient).answerOnly)
          ? (transport as TmuxClient).answerOnly
          : "";
        const userResponse = fullModeChats.has(sessionKey) ? response : (cleanAnswer || response);

        if (!userResponse || !userResponse.trim()) {
          logWarn("main", "Empty response from transport (Discord)");
          await discordApi.sendMessage(message.channelId, "🤷 Kiro returned an empty response. Try again or /reset.");
          return;
        }

        // LLM opted out of responding (per CHATS.md steering)
        if (userResponse.trim() === "<NO_REPLY>") {
          logDebug("main", "Discord: LLM returned <NO_REPLY>, skipping");
          return;
        }

        const chunks = formatter.chunkForPlatform(userResponse, "discord");
        logDebug("main", `Discord: sending ${chunks.length} chunk(s)`);
        for (const chunk of chunks) {
          if (chunk.trim()) {
            await discordApi.sendMessage(message.channelId, chunk);
          }
        }
        logInfo("main", `→ Discord: sent ${chunks.length} chunk(s) to ${message.channelId}`);

        // Auto-compact when context window usage exceeds threshold (percentage-based)
        if (memory && "contextPercent" in transport) {
          const pct = (transport as TmuxClient).contextPercent;
          const threshold = memory.getConfig().searchEnhancements.compactThresholdPct;
          if (pct >= threshold) {
            const chatId = parseInt(message.channelId, 10) || 0;
            logInfo("main", `⚠️ Context window at ${pct}% (threshold: ${threshold}%) — auto-compacting (Discord)`);
            await discordApi.sendMessage(message.channelId, `📦 Context window at ${pct}% — auto-compacting...`);
            try {
              await memory.checkAutoCompact({
                chatId,
                sessionId: sessionKey,
                contextPercent: pct,
                sendCompactCommand: (sk, cmd) => transport.sendPrompt(sk, cmd),
              });
              await discordApi.sendMessage(message.channelId, "📦 Auto-compaction complete.");
              if (memoryConfig.memoryEnabled) updateCtxStart(memoryConfig.memoryDir, chatId);
            } catch (err) {
              logError("main", "Auto-compaction failed (Discord)", err);
            }
          }
        }
      } catch (err) {
        logError("main", `Discord error for channel ${message.channelId}`, err);
        await discordApi.sendMessage(message.channelId, "❌ Something went wrong. Try /reset to start fresh.").catch(() => {});
      } finally {
        busyChats.delete(sessionKey);
        resetIdleSaveTimer(sessionKey, parseInt(message.channelId, 10) || 0);
      }
    };

    discordPoller = new DiscordPoller(discordApi, config.discordAppId!, handleDiscordMessage);
    try {
      await discordPoller.start();
      logInfo("main", "📡 Discord polling started");
      announcePlatform(transport, "DISCORD").catch(() => {});
    } catch (err) {
      logError("main", "Discord failed to start", err);
      discordPoller = null;
    }
  } else if (platforms.discord) {
    logWarn("main", "Discord flag set but DISCORD_BOT_TOKEN not configured — skipping");
  } else {
    logInfo("main", "📡 Discord disabled (no --discord/--all flag)");
  }

  // --- Unified heartbeat (5-min interval) ---

  // --- Startup notification (async, non-blocking) ---
  if (memoryConfig.memoryEnabled) {
    const tgSend = telegramPoller ? async (msg: string): Promise<void> => {
      const chatId = [...config.allowedUserIds][0];
      if (chatId) await new TelegramApi(config.telegramBotToken).sendMessage(chatId, msg);
    } : undefined;
    const dcSend = discordPoller ? async (msg: string): Promise<void> => {
      const channelId = config.discordAllowedChannelIds ? [...config.discordAllowedChannelIds][0] : undefined;
      if (channelId) await new DiscordApi(config.discordBotToken!).sendMessage(channelId, msg);
    } : undefined;
    sendBackOnline(tgSend, dcSend).catch((err) => {
      logWarn("main", `Back online notification error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  const heartbeat = new HeartbeatSystem({ enabled: true, intervalMs: 5 * 60 * 1000 });

  heartbeat.registerTask({
    name: "sleep-trigger",
    execute: async () => {
      if (busyChats.size > 0) return;
      let lastMessageTs = 0;
      try {
        const row = memory?.getDb()?.prepare("SELECT MAX(timestamp) as latest FROM messages").get() as { latest: number | null } | undefined;
        lastMessageTs = row?.latest ?? 0;
      } catch { return; }
      if (!sleepTrigger.shouldRunFromCron(lastMessageTs)) return;
      sleepTrigger.writeLock();
      try {
        const sleepScript = join(dirname(fileURLToPath(import.meta.url)), "cli", "agentbridge-sleep.js");
        const child = spawn(process.execPath, [sleepScript], { stdio: "ignore", detached: true });
        child.on("exit", (code) => {
          if (code === 0) {
            logInfo("main", `😴 Cron sleep routine finished successfully at ${new Date().toISOString()}`);
            sleepTrigger.reportSuccess();
            if (memoryConfig.memoryEnabled) resetAllCtxStarts(memoryConfig.memoryDir);
          } else {
            logWarn("main", `😴 Cron sleep routine failed (exit code ${code}) at ${new Date().toISOString()}`);
            sleepTrigger.reportFailure();
          }
        });
        child.unref();
        logInfo("main", `😴 Sleep routine spawned from cron (pid=${child.pid}) at ${new Date().toISOString()}`);
      } catch (err) {
        logWarn("main", `sleep-trigger: failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
        sleepTrigger.reportFailure();
      }
    },
  });

  heartbeat.registerTask({
    name: "cron-checker",
    execute: async () => {
      checkCron((chatId, message, result) => {
        if (platforms.telegram) {
          const api = new TelegramApi(config.telegramBotToken);
          api.sendMessage(chatId, `✅ Cron task completed: ${message}\n\n${result}`).catch(err => {
            logWarn("main", `Cron task TG report failed: ${err}`);
          });
        }
      });
    },
  });

  heartbeat.registerTask({
    name: "browse-checker",
    execute: async () => { checkBrowseTasks(); },
  });

  heartbeat.registerTask({
    name: "reminder-injector",
    execute: async () => {
      const reminders = readPendingReminders();
      if (reminders.length === 0) return;
      clearPendingReminders();
      for (const r of reminders) {
        logInfo("main", `⏰ Injecting reminder for chat ${r.chatId}: "${r.message}"`);
        const syntheticUpdate: TelegramUpdate = {
          update_id: 0,
          message: {
            message_id: 0,
            from: { id: r.chatId, is_bot: false, first_name: "cron" },
            chat: { id: r.chatId, type: "private" },
            date: Math.floor(Date.now() / 1000),
            text: `[Scheduled reminder] ${r.message}`,
            ...(r.threadId ? { message_thread_id: r.threadId } : {}),
          },
        };
        telegramPoller?.injectUpdate(syntheticUpdate);
      }
    },
  });

  // Run once on startup, then start periodic
  checkCron();
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
      const refs: SubsystemRefs = {
        startedAt,
        telegramPoller: telegramPoller
          ? { running: (telegramPoller as unknown as Record<string, boolean>).running ?? false }
          : null,
        discordPoller: discordPoller
          ? { started: (discordPoller as unknown as Record<string, boolean>).started ?? false }
          : null,
        transport: {
          type: config.kiroTransport as "tmux" | "acp",
          isReady: transport.isReady,
          contextPercent: "contextPercent" in transport ? (transport as TmuxClient).contextPercent : -1,
        },
        memory: memory
          ? { getStats: (chatId?: number) => memory!.getStats(chatId) }
          : null,
        heartbeat: memory
          ? {
              running: memory.getStats()?.heartbeatRunning ?? false,
              intervalMs: memoryConfig.heartbeat.intervalMs,
              tasks: [],
            }
          : null,
        notebooklm: nlmConfig.enabled,
        agentApi: agentApiServer ? { getTrafficLog: () => agentApiServer!.getTrafficLog() } : null,
      };
      return buildStatusSnapshot(refs);
    };

    const authGate = new AuthGate(dashConfig.webAuthToken);
    const platformController = new PlatformController({ telegramPoller, discordPoller });
    const transportController = new TransportController({
      config,
      getCurrentTransport: () => transport,
      setTransport: (t) => { transport = t; },
      platformRefs: { telegramPoller, discordPoller },
      memory,
    });
    const memorySearchController = memory
      ? new MemorySearchController({
          memoryIndex: memory.getMemoryIndex()!,
          db: memory.getDatabase()!,
          memoryDir: memoryConfig.memoryDir,
        })
      : null;

    dashboardServer = new DashboardServer({
      config: dashConfig,
      authGate,
      getStatus,
      platformController,
      transportController,
      memorySearchController,
      dashboardHtml,
    });

    await dashboardServer.start();
    logInfo("main", `🌐 Web dashboard enabled on ${dashConfig.webHost}:${dashConfig.webPort} (token: ${dashConfig.webAuthToken})`);
  }

  // --- Agent API wiring (conditional) ---
  let agentApiServer: AgentApiServer | null = null;

  if (platforms.agent) {
    const agentConfig = loadAgentApiConfig(process.env as Record<string, string | undefined>);
    agentApiServer = new AgentApiServer({
      config: agentConfig,
      cliPath: config.kiroCLIPath,
      workingDir: config.workingDir,
      memory,
    });
    await agentApiServer.start();
    logInfo("main", `🤖 Agent API enabled on 0.0.0.0:${agentConfig.port} (allowed: ${agentConfig.allowedIps.join(", ")})`);
  }

  async function shutdown(): Promise<void> {
    logInfo("main", "🛑 Shutting down...");
    const forceTimer = setTimeout(() => {
      logWarn("main", "⚠️  Shutdown timed out — forcing exit");
      process.exit(1);
    }, 5_000);
    forceTimer.unref();

    if (agentApiServer) {
      try { await agentApiServer.stop(); } catch { /* best-effort */ }
    }
    if (dashboardServer) {
      try { await dashboardServer.stop(); } catch { /* best-effort */ }
    }
    if (telegramPoller) telegramPoller.stop();
    if (discordPoller) discordPoller.stop();
    heartbeat.stop();
    try { await browserIpc?.shutdown(); } catch { /* best-effort */ }
    try { await browserManager.shutdown(); } catch { /* best-effort */ }
    memory?.close();
    transport.destroy();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
