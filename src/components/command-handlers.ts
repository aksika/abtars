import { logAndSwallow } from "./log-and-swallow.js";
import { getEnv } from "./env-schema.js";
/**
 * Unified command handlers for all platforms (Telegram, Discord).
 * Platform-specific commands check ctx.platform internally.
 */

import { execFile, spawn } from "node:child_process";
import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { logInfo, logError } from "./logger.js";
import { writeSleepStatus, readBridgeLockField, writeForceSleep } from "./transport/bridge-lock-transport.js";

import { readEntries as cronReadEntries } from "./cron/cron-store.js";
import { handleNLMCommand } from "./nlm-command-handler.js";
import { abtarsHome } from "../paths.js";
// Legacy compaction removed — /compact now uses context orchestrator via transport
import { resetAndPrepare } from "./message-pipeline.js";
import type { PipelineDeps } from "./message-pipeline.js";
import type { RunningJob } from "./cron/cron-queue.js";

import type { Platform } from "../types/platform.js";
export type { Platform };
export type Reply = (text: string, opts?: { parseMode?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => Promise<number | undefined>;

export interface CommandContext {
  sessionKey: string;
  chatId: number;
  userId: string;
  platform: Platform;
  reply: Reply;
  /** Edit a previously-sent message by id (for placeholder → result pattern). Undefined if platform lacks editMessage. */
  editReply?: (messageId: number, text: string) => Promise<void>;
  // From PipelineDeps
  transport: PipelineDeps["transport"];
  config: PipelineDeps["config"];
  startedAt: PipelineDeps["startedAt"];
  memory: PipelineDeps["memory"];
  memoryConfig: PipelineDeps["memoryConfig"];
  nlmConfig: PipelineDeps["nlmConfig"];
  codingMode: PipelineDeps["codingMode"];
  idleSave: PipelineDeps["idleSave"];
  sessions: PipelineDeps["sessions"];
  updateCtxStart: PipelineDeps["updateCtxStart"];
  cronCurrentJob?: RunningJob | null;
  enqueueCron?: PipelineDeps["enqueueCron"];
  requestShutdown?: PipelineDeps["requestShutdown"];
  sleepProgress?: PipelineDeps["sleepProgress"];
  loadedCapabilities?: PipelineDeps["loadedCapabilities"];
  selfHealerTask?: { enabled: boolean } | null;
  hailMary?: PipelineDeps["hailMary"];
  rebuildTransport?: PipelineDeps["rebuildTransport"];
  phaseHealth?: PipelineDeps["phaseHealth"];
  registry?: PipelineDeps["registry"];
  bridgeLockPath?: PipelineDeps["bridgeLockPath"];
  // Per-message (optional)
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}

type CommandHandler = (text: string, ctx: CommandContext) => Promise<boolean>;

const TAG = "cmd";

// ── Exact-match commands ────────────────────────────────────────────────────

const exactCommands: Record<string, CommandHandler> = {
  "/new": handleNewReset,
  "/reset": handleNewReset,
  "/compact": handleCompact,
  "/coding": handleCoding,
  "/default": handleDefault,
  "/status": handleStatus,
  "/doctor": handleDoctor,
  "/stop": handleStop,
  "/ctrlc": handleStop,
  "/restart": handleRestart,
  "/full": handleFull,
  "/short": handleShort,
  "/healing": handleHealing,
  "/facts": handleFacts,
  "/tasks": handleTasksList,
  "/task": handleTasksList,
  "/cron": handleTasksList,
  "/memory": handleMemory,
  "/heartbeat": handleHeartbeat,
  "/models": handleModels,
  "/model": handleModels,
  "/emergency": handleEmergencyAlias,
  "/a2a-reset": handleA2aReset,
  "/help": handleHelp,
  "/users": handleUsers,
  "/skills": handleSkills,
  "/skill": handleSkills,
  "/wakeup": handleWakeup,
  "/sleep": handleSleep,
  "/mcp": handleMcp,
  "/hooks": handleHooks,
};

// ── Prefix-match commands ───────────────────────────────────────────────────

const prefixCommands: ReadonlyArray<{ prefix: string; handler: CommandHandler }> = [
  { prefix: "/tasks trigger ", handler: handleTasksTrigger },
  { prefix: "/cron trigger ", handler: handleTasksTrigger },
  { prefix: "/tasks log ", handler: handleTasksLog },
  { prefix: "/cron log ", handler: handleTasksLog },
  { prefix: "/nlm", handler: handleNlm },
  { prefix: "/sleep ", handler: handleSleepSub },
];

const KNOWN_COMMANDS = new Set([...Object.keys(exactCommands), ...prefixCommands.map(p => p.prefix.split(" ")[0]!)]);

/** Register an additional exact-match command (used by capability system). */
export function registerCommand(name: string, handler: CommandHandler): void {
  exactCommands[name] = handler;
  KNOWN_COMMANDS.add(name);
}

/** Returns true if command was handled. */
/** Commands allowed for non-master users. Everything else is master-only. */
const NON_MASTER_COMMANDS = new Set(["/new", "/reset", "/stop", "/ctrlc", "/status", "/help"]);

export async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  // Role-based command gating
  const isMaster = !ctx.userId || ctx.userId === "master" ||
    (await import("./user-registry.js")).loadUsers().byUserId.get(ctx.userId)?.role === "master";

  if (!isMaster) {
    const cmd = text.split(/\s/)[0]!;
    if (cmd.startsWith("/") && !NON_MASTER_COMMANDS.has(cmd)) {
      await ctx.reply("⛔ Owner-only command.");
      return true;
    }
  }

  const exact = exactCommands[text];
  if (exact) return exact(text, ctx);

  for (const { prefix, handler } of prefixCommands) {
    if (text.startsWith(prefix)) return handler(text, ctx);
  }

  // Fallback: match by first word for commands that accept subcommands (e.g. "/transport change")
  const firstWord = text.split(/\s/)[0]!;
  if (text !== firstWord) {
    const byFirstWord = exactCommands[firstWord];
    // Only if no prefix command matched (prefix commands take priority)
    if (byFirstWord) return byFirstWord(text, ctx);
  }

  // Unknown command guard
  if (text.startsWith("/") && /^\/\w+/.test(text) && !text.startsWith("//")) {
    const cmd = text.split(/\s/)[0]!;
    if (!KNOWN_COMMANDS.has(cmd)) {
      await ctx.reply(`❓ Unknown command: ${cmd}\nType /help for available commands.`);
      return true;
    }
  }

  return false;
}

// ── Handler implementations ─────────────────────────────────────────────────

/** Core new-session logic — reusable from model-switch paths. */
export async function triggerNewSession(ctx: CommandContext, reason = "new-session"): Promise<void> {
  // SessionEnd hook before teardown
  const { hasHooks, fire: fireHook } = await import("./hooks/hook-system.js");
  if (hasHooks("SessionEnd")) {
    await fireHook("SessionEnd", { event: "SessionEnd", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason }).catch(() => {});
  }
  await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
  await resetAndPrepare({
    transport: ctx.transport, sessionKey: ctx.sessionKey,
    reason, sessions: ctx.sessions, conversationBuffer: ctx.conversationBuffer, bufKey: ctx.bufKey,
  });
  if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.userId);
  // SessionStart hook after reset
  if (hasHooks("SessionStart")) {
    await fireHook("SessionStart", { event: "SessionStart", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason }).catch(() => {});
  }
}

/** Core reset-session logic — clears cache, rebuilds transport, resets session. */
export async function triggerResetSession(ctx: CommandContext): Promise<void> {
  const { hasHooks, fire: fireHook } = await import("./hooks/hook-system.js");
  if (hasHooks("SessionEnd")) {
    await fireHook("SessionEnd", { event: "SessionEnd", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason: "reset-transport" }).catch(() => {});
  }
  await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
  const { clearTransportCache } = await import("./transport-config.js");
  clearTransportCache();
  if (ctx.rebuildTransport) await ctx.rebuildTransport();
  await resetAndPrepare({
    transport: ctx.transport, sessionKey: ctx.sessionKey,
    reason: "reset-transport", sessions: ctx.sessions, conversationBuffer: ctx.conversationBuffer, bufKey: ctx.bufKey,
  });
  if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.userId);
  if (hasHooks("SessionStart")) {
    await fireHook("SessionStart", { event: "SessionStart", timestamp: new Date().toISOString(), sessionKey: ctx.sessionKey, platform: ctx.platform, userId: ctx.userId, reason: "reset-transport" }).catch(() => {});
  }
}

async function handleNewReset(text: string, ctx: CommandContext): Promise<boolean> {
  const isReset = text.startsWith("/reset");
  const isResetDefault = text.trim().toLowerCase() === "/reset default";

  if (isReset && ctx.codingMode.has(ctx.sessionKey)) {
    await ctx.codingMode.stop(ctx.sessionKey);
  }

  if (isResetDefault) {
    const { resetToDefaults } = await import("./transport-config.js");
    resetToDefaults();
    await triggerNewSession(ctx, "reset-to-defaults");
  } else if (isReset) {
    try {
      await triggerResetSession(ctx);
    } catch (err) {
      await ctx.reply(`⚠️ Transport rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  } else {
    await triggerNewSession(ctx);
  }

  const label = isResetDefault ? "🔄 Reset to defaults." : isReset ? "🔄 Transport reloaded." : ctx.codingMode.has(ctx.sessionKey) ? "🔄 New coding session." : "🔄 New session started.";
  await ctx.reply(label);

  // Send greeting for /new (not /reset — reset is a technical operation)
  if (!isReset && ctx.memory) {
    const { startSession } = await import("./message-pipeline.js");
    startSession(ctx.transport, ctx.memory, ctx.userId, ctx.sessionKey, "Greet the user briefly. You just started a fresh session.", (text) => ctx.reply(text)).catch(() => {});
  }

  logInfo(TAG, `Session ${text} (${ctx.platform}, mode=${ctx.codingMode.has(ctx.sessionKey) ? "coding" : "default"})`);
  return true;
}

async function handleCompact(_text: string, ctx: CommandContext): Promise<boolean> {
  try {
    // Context engine compaction — force compact via transport's orchestrator
    const transport = ctx.transport as { contextOrchestrator?: { forceCompact(chatId: string, budget: number): Promise<boolean> }; config?: { maxContext: number } };
    if (transport.contextOrchestrator) {
      const budget = (transport as any).config?.maxContext ?? 200000;
      const success = await transport.contextOrchestrator.forceCompact(ctx.sessionKey, budget);
      await ctx.reply(success ? "📦 Compaction complete." : "📦 Nothing to compact.");
    } else {
      await ctx.reply("📦 Context engine not active for this transport.");
    }
  } catch (err) {
    logError(TAG, "Manual compaction failed", err);
    await ctx.reply("❌ Compaction failed.");
  }
  return true;
}

async function handleCoding(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.codingMode.has(ctx.sessionKey)) {
    await ctx.reply("Already in coding mode. Use /default to switch back.");
    return true;
  }
  await ctx.reply("🔧 Switching to coding agent (Opus)...");
  try {
    await ctx.codingMode.start(ctx.sessionKey);
    await ctx.reply("🔧 Coding agent ready. All messages now go to Opus.\nUse /default to switch back to KP.");
    logInfo(TAG, `Coding mode activated for ${ctx.sessionKey}`);
  } catch (err) {
    await ctx.reply(`❌ Failed to start coding agent: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

async function handleDefault(_text: string, ctx: CommandContext): Promise<boolean> {
  if (!ctx.codingMode.has(ctx.sessionKey)) {
    await ctx.reply("Already in default mode (KP).");
    return true;
  }
  await ctx.reply("🔄 Switching back to KP...");
  await ctx.codingMode.stop(ctx.sessionKey);
  await ctx.reply("🔄 Back to KP.");
  logInfo(TAG, `Default mode restored for ${ctx.sessionKey}`);
  return true;
}

async function handleDoctor(_text: string, ctx: CommandContext): Promise<boolean> {
  const arg = _text.replace(/^\/doctor\s*/i, "").trim().toLowerCase();

  // /doctor fix → run doctor.sh --fix
  if (arg === "fix" || arg === "fix-full") {
    const flag = arg === "fix-full" ? "--fix-full" : "--fix";
    try {
      const raw = await execAsync("bash", [join(abtarsHome(), "scripts", "doctor.sh"), flag], 30000);
      await ctx.reply(`🩺 doctor.sh ${flag}:\n${raw || "(no output)"}`);
    } catch (err) {
      await ctx.reply(`❌ doctor.sh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  const { getDoctorReport, renderDoctorText } = await import("./doctor/index.js");
  const force = arg === "force";
  const svcStates = ctx.registry?.getStates() ?? {};
  const report = await getDoctorReport({
    memory: ctx.memory,
    transport: ctx.transport,
    telegramRunning: svcStates.telegram?.running ?? false,
    discordRunning: svcStates.discord?.running ?? false,
    phaseHealth: ctx.phaseHealth,
  }, { force });
  await ctx.reply(renderDoctorText(report));
  return true;
}

async function handleStatus(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.phaseHealth && ctx.registry) {
    const { getSystemStatus, renderStatusText } = await import("./system-status.js");
    const status = await getSystemStatus({
      phaseHealth: ctx.phaseHealth,
      registry: ctx.registry,
      transport: ctx.transport,
      startedAt: ctx.startedAt,
      bridgeLockPath: ctx.bridgeLockPath ?? "",
      heartbeat: null,
    });
    let text = renderStatusText(status);
    // #255: append sanitized env dump on /status full
    if (_text.trim().toLowerCase() === "full") {
      const { envDump } = await import("./env-schema.js");
      const dump = envDump();
      const envLines = Object.entries(dump).slice(0, 30).map(([k, v]) => `  ${k}: ${v}`);
      text += "\n\n📋 Config (top 30):\n" + envLines.join("\n");
    }
    await ctx.reply(text);
  } else {
    const lines = await buildStatusLines(ctx);
    await ctx.reply(lines.join("\n"));
  }
  return true;
}

async function handleStop(_text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.transport.sendInterrupt();
  ctx.sessions.getOrCreate(ctx.sessionKey).busy = false;
  await ctx.reply("🛑 Ctrl+C sent to Kiro.");
  logInfo(TAG, "Ctrl+C interrupt sent");
  return true;
}

async function handleRestart(_text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.reply("♻️ Restarting bridge...");
  setTimeout(() => ctx.requestShutdown?.(0), 500);
  return true;
}

async function handleFull(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") { await ctx.reply("📺 Full mode is only available on Telegram."); return true; }
  ctx.sessions.getOrCreate(ctx.sessionKey).fullMode = true;
  await ctx.reply("📺 Full mode — sending raw output, TTS disabled.");
  return true;
}

async function handleShort(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") { await ctx.reply("✂️ Short mode is only available on Telegram."); return true; }
  ctx.sessions.getOrCreate(ctx.sessionKey).fullMode = false;
  await ctx.reply("✂️ Short mode — clean responses, TTS enabled.");
  return true;
}

async function handleHealing(_text: string, ctx: CommandContext): Promise<boolean> {
  if (!ctx.selfHealerTask) { await ctx.reply("🩺 Self-healer not available."); return true; }
  ctx.selfHealerTask.enabled = !ctx.selfHealerTask.enabled;
  await ctx.reply(ctx.selfHealerTask.enabled ? "🩺 Self-healing ON" : "🩺 Self-healing OFF");
  logInfo(TAG, `Self-healer ${ctx.selfHealerTask.enabled ? "enabled" : "disabled"} by user`);
  return true;
}

async function handleFacts(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.memory) {
    const facts = ctx.memory.readCoreKnowledge();
    await ctx.reply(facts ? `📋 Core knowledge:\n\n${facts}` : "📋 No core knowledge yet.");
  } else {
    await ctx.reply("🧠 Memory is disabled.");
  }
  return true;
}

async function handleTasksList(_text: string, ctx: CommandContext): Promise<boolean> {
  const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/Budapest", dateStyle: "medium", timeStyle: "medium" });
  let listing: string;
  try {
    const { readEntries } = await import("./cron/cron-store.js");
    const entries = readEntries();
    const active = entries.filter((e: any) => !e.fired && !e.paused);
    active.sort((a: any, b: any) => {
      const timeOf = (e: any): number => {
        const s = e.schedule;
        if (!s) return e.fireAt ?? 0;
        const parts = s.split(" ");
        return (parseInt(parts[1] ?? "0", 10) * 60) + parseInt(parts[0] ?? "0", 10);
      };
      return timeOf(a) - timeOf(b);
    });
    const today = new Date();
    const dow = today.getDay();
    const lines = active.map((e: any) => {
      const sched = e.schedule ?? "one-shot";
      let runsToday = true;
      if (sched !== "one-shot") {
        const parts = sched.split(" ");
        const dowField = parts[4] ?? "*";
        if (dowField !== "*") {
          const allowed = new Set<number>();
          for (const seg of dowField.split(",")) {
            if (seg.includes("-")) {
              const [a, b] = seg.split("-").map(Number);
              for (let i = a; i <= b; i++) allowed.add(i);
            } else allowed.add(Number(seg));
          }
          runsToday = allowed.has(dow);
        }
      }
      const succeeded = e.history?.some((h: any) => h.exitCode === 0 && new Date(h.ts).toDateString() === today.toDateString());
      const failed = e.history?.some((h: any) => h.exitCode !== undefined && h.exitCode !== 0 && new Date(h.ts).toDateString() === today.toDateString());
      const started = e.lastRanAt && new Date(e.lastRanAt).toDateString() === today.toDateString();
      const running = ctx.cronCurrentJob?.entryId === e.id;
      const tick = !runsToday ? "—" : succeeded ? "✓" : running ? "~" : failed ? "✗" : started ? "✗" : "+";
      const label = e.title || e.message.split("\n")[0].replace(/[~\/][\w.\/-]+\//g, "").slice(0, 30);
      return `${tick}  ${e.id.padEnd(22)}${sched.padEnd(16)}${label}`;
    });
    listing = lines.length > 0 ? "<pre>" + lines.join("\n") + "</pre>" : "(no active entries)";
  } catch (err) {
    logError("tasks", `Failed to read cron: ${err instanceof Error ? err.message : String(err)}`);
    listing = "(no active entries)";
  }
  let running = "";
  if (ctx.cronCurrentJob) {
    const j = ctx.cronCurrentJob;
    const ago = Math.round((Date.now() - j.startedAt) / 1000);
    running = `\n▶ Running: ${j.type} (pid ${j.pid}, ${ago}s ago)\n   ${j.message}`;
  }
  await ctx.reply(`⏰ ${now}\n\n${listing}${running}`, { parseMode: "HTML" });
  return true;
}

async function handleTasksTrigger(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks|cron) trigger /, "").trim();
  if (!id) { await ctx.reply("Usage: /tasks trigger <cron-id>"); return true; }
  const err = ctx.enqueueCron?.(id, true);
  await ctx.reply(err ?? `⏳ Running: ${id}`);
  return true;
}

async function handleTasksLog(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks|cron) log /, "").trim();
  const placeholderId = await ctx.reply("📋 Loading task log...");
  try {
    const raw = await execAsync("abtars-task", ["history", id], 5000);
    if (!raw) throw new Error("empty");
    const data = JSON.parse(raw);
    if (!data.ok) {
      const msg = `❌ ${data.error}`;
      if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, msg);
      else await ctx.reply(msg);
      return true;
    }
    const runs = (data.runs as { ranAt: string; exitCode?: number }[]).slice(-5);
    const lines = runs.map(r => `${r.ranAt}  exit=${r.exitCode ?? "?"}`);
    const body = `📋 ${data.message}\n\n\`\`\`\n${lines.join("\n") || "(no runs)"}\n\`\`\``;
    if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, body);
    else await ctx.reply(body, { parseMode: "Markdown" });
  } catch {
    const msg = "❌ Failed to read history";
    if (placeholderId !== undefined && ctx.editReply) await ctx.editReply(placeholderId, msg);
    else await ctx.reply(msg);
  }
  return true;
}


async function handleEmergencyAlias(_text: string, ctx: CommandContext): Promise<boolean> {
  return handleModels("/model emergency", ctx);
}

async function handleModels(text: string, ctx: CommandContext): Promise<boolean> {
  const { loadTransport, resolveAgent, getModelsForProvider, writeTransportConfig } = await import("./transport-config.js");
  const tc = loadTransport();
  const prof = tc ? resolveAgent("professor", tc) : null;
  const currentModel = ("currentModel" in ctx.transport
    ? (ctx.transport as unknown as { currentModel: string }).currentModel
    : undefined) ?? prof?.model ?? "unknown";

  const arg = text.replace(/^\/(models?)\s*/i, "").trim().toLowerCase();

  // /model emergency — activate hailMary (paid) until /model restore, /reset, or wake-up
  if (arg === "emergency" || arg === "hailmary") {
    if (!ctx.hailMary) { await ctx.reply("❌ hailMary not configured in transport.json"); return true; }
    const t = ctx.transport as unknown as { setEmergencyMode?: (o: { endpoint: string; apiKey?: string; model: string; maxContext: number } | null) => void };
    if (!t.setEmergencyMode) { await ctx.reply("❌ Transport does not support emergency mode"); return true; }

    // #367 — validate hailMary's provider is ready before switching.
    if (tc) {
      const hmProvider = tc.hailMary ? tc.providers[tc.hailMary.provider] : undefined;
      if (hmProvider) {
        const { validateProviderReady, formatValidationError } = await import("./transport-config.js");
        const { getEnv } = await import("./env-schema.js");
        const result = validateProviderReady(tc.hailMary!.provider, hmProvider, getEnv());
        if (!result.ok) { await ctx.reply(formatValidationError(tc.hailMary!.provider, result)); return true; }
      }
    }

    t.setEmergencyMode({ ...ctx.hailMary, maxContext: 1_000_000 });
    await ctx.reply(`🚨 EMERGENCY MODE: using ${ctx.hailMary.model} (paid). Clears on /model restore, /reset, or wake-up.`);
    return true;
  }

  // /models restore — reset all model health buckets + clear emergency mode
  if (arg === "primary" || arg === "restore") {
    const t = ctx.transport as unknown as {
      policy?: { registry: { resetAll: () => void } };
      setEmergencyMode?: (o: null) => void;
      isEmergencyMode?: boolean;
    };
    const wasEmergency = t.isEmergencyMode;
    t.setEmergencyMode?.(null);
    if (t.policy?.registry) {
      t.policy.registry.resetAll();
      await ctx.reply(wasEmergency
        ? "🔌 Emergency mode cleared + model health reset — free models active."
        : "🔌 Model health reset — all models available.");
    } else {
      await ctx.reply("🔌 No fallback policy configured.");
    }
    return true;
  }

  // /models status — removed, bare /model shows everything now

  // /models quick <model> — instant switch
  if (arg.startsWith("quick ") || arg.startsWith("switch ")) {
    const newModel = arg.split(" ").slice(1).join(" ").trim();
    if (!newModel) { await ctx.reply("Usage: /models quick <model>"); return true; }
    if (!tc || !prof) { await ctx.reply("❌ transport.json not loaded"); return true; }

    // Check if model is available on current provider
    const models = getModelsForProvider(prof.providerName);
    const match = models.find(m => m.id === newModel);
    if (!match) {
      await ctx.reply(`❌ ${newModel} not available on ${prof.providerName}. Use /models change to switch provider.`);
      return true;
    }

    // #367 — validate the provider (same one we're on) is still ready.
    // Belt-and-suspenders: catches the case where the operator rotated/removed
    // the env var since the last switch.
    {
      const { validateProviderReady, formatValidationError } = await import("./transport-config.js");
      const { getEnv } = await import("./env-schema.js");
      const result = validateProviderReady(prof.providerName, prof.provider, getEnv());
      if (!result.ok) { await ctx.reply(formatValidationError(prof.providerName, result)); return true; }
    }

    // Write + switch
    tc.agents["professor"]!.model = newModel;
    writeTransportConfig(tc, `professor model → ${newModel}`);
    if ("setModel" in ctx.transport) {
      await (ctx.transport as unknown as { setModel: (m: string) => Promise<void> }).setModel(newModel);
    }
    await triggerNewSession(ctx, "model-switch");
    await ctx.reply(`✅ Switched to ${newModel}`);
    return true;
  }

  // /models change — 3-step picker
  if (arg === "change") {
    if (ctx.platform !== "telegram") {
      await ctx.reply("🤖 Use /models quick <model> to switch on this platform.\nExample: /models quick claude-sonnet-4");
      return true;
    }
    const AGENT_LABELS: Array<{ key: string; label: string }> = [
      { key: "_provider", label: "🔌 Provider" },
      { key: "professor", label: "Professor (main)" },
      { key: "professor_fb1", label: "Professor fallback 1" },
      { key: "professor_fb2", label: "Professor fallback 2" },
      { key: "dreamy", label: "Dreamy (sleep)" },
      { key: "browsie", label: "Browsie (browse)" },
      { key: "coding", label: "Cody (coding)" },
    ];
    const buttons = AGENT_LABELS.map(a => [{ text: a.label, callback_data: `mslot:${a.key}` }]);
    await ctx.reply("🤖 Which agent to change?", { reply_markup: { inline_keyboard: buttons } });
    return true;
  }

  // /models (no arg) — merged status: model + transport + agents
  const transportStatus = ctx.transport.isReady ? "✓ Connected" : "❌ Disconnected";
  const ctxPct = ctx.transport.contextPercent >= 0 ? `${ctx.transport.contextPercent}%` : "n/a";
  const mode = prof?.provider.transport?.toUpperCase() ?? "ACP";
  const provider = prof?.providerName ?? "unknown";
  const isEmergency = (ctx.transport as unknown as { isEmergencyMode?: boolean }).isEmergencyMode === true;

  const lines = [
    `🔌 Transport: ${mode} (${provider}) — ${transportStatus}`,
    isEmergency ? `🚨 EMERGENCY MODE: ${currentModel} (paid)` : `🤖 Model: ${currentModel}`,
    `📊 Context: ${ctxPct}`,
    "",
    "📋 Agents:",
  ];
  const agents = ["professor", "dreamy", "browsie", "coding"] as const;
  const names: Record<string, string> = { professor: "Professor", dreamy: "Dreamy", browsie: "Browsie", coding: "Cody" };
  for (const a of agents) {
    const r = tc ? resolveAgent(a, tc) : null;
    let line = `  ${names[a]}: ${r?.model ?? "unknown"} (${r?.providerName ?? "?"}, ${r?.provider.transport ?? "?"})`;
    if (a === "professor" && r?.fallbacks.length) {
      line += "\n" + r.fallbacks.map((f, i) => `    ↳ fb${i + 1}: ${f.model} (${f.provider})`).join("\n");
    }
    lines.push(line);
  }
  lines.push("  Cron: inherits Professor");
  if (prof?.provider.fallbackChain?.length) {
    lines.push(`\n🛟 Fallback chain: ${prof.provider.fallbackChain.join(" → ")}`);
  }
  if (ctx.hailMary) {
    lines.push(`🚨 hailMary: ${ctx.hailMary.model} `);
  }
  lines.push("\nUse /models change to switch.");
  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleHeartbeat(_text: string, ctx: CommandContext): Promise<boolean> {
  const cronInfo = ctx.memory?.getCronInfo();
  if (!cronInfo) { await ctx.reply("💓 Heartbeat not available."); return true; }

  const mins = Math.round(cronInfo.intervalMs / 60000);
  const lines = [
    `💓 Heartbeat: ${cronInfo.heartbeatRunning ? "running" : "stopped"} (${mins}min interval)`,
    "",
  ];

  // Task statuses
  if (cronInfo.taskStatuses.size > 0) {
    lines.push("Tasks (last tick):");
    for (const [name, status] of cronInfo.taskStatuses) {
      lines.push(`  ${status} ${name}`);
    }
  }

  // Last tick age
  try {
    const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
    if (lock.lastHeartbeat > 0) {
      const agoMin = Math.round((Date.now() - lock.lastHeartbeat) / 60000);
      lines.push("", `🫀 Last tick: ${agoMin}min ago`);
    }
  } catch (err) { logAndSwallow("command_handlers", "op", err); }

  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleMemory(_text: string, ctx: CommandContext): Promise<boolean> {
  if (!ctx.memory) { await ctx.reply("🧠 Memory is disabled."); return true; }
  const stats = ctx.memory.getStats(ctx.userId);
  if (!stats) { await ctx.reply("⚠️ Could not retrieve memory stats."); return true; }
  const dbMb = (stats.dbSizeBytes / (1024 * 1024)).toFixed(1);
  const types = Object.entries(stats.extractedByType).map(([t, n]) => `  ${t}: ${n}`).join("\n") || "  (none)";
  const msg = [
    "🧠 Memory Status", "",
    `💬 Raw messages: ${stats.totalMessages}`,
    `🧩 Extracted memories: ${stats.extractedMemories}`, types,
    `🔑 Preserved keywords: ${stats.preservedKeywords}`, "",
    `📄 Consolidations:`,
    `  daily: ${stats.consolidationFiles.daily}`,
    `  weekly: ${stats.consolidationFiles.weekly}`,
    `  quarterly: ${stats.consolidationFiles.quarterly}`, "",
    `📄 Ingested documents: ${stats.ingestedDocuments}`,
    `💓 Heartbeat: ${stats.heartbeatRunning ? "running" : "stopped"}`,
    `💾 DB size: ${dbMb} MB`, "",
    `📚 Layer 6 (NotebookLM): ${ctx.nlmConfig.enabled ? "enabled" : "disabled"}`,
  ].join("\n");
  await ctx.reply(msg);
  return true;
}

async function handleNlm(text: string, ctx: CommandContext): Promise<boolean> {
  const args = text.slice("/nlm".length).trim();
  const result = await handleNLMCommand(args, ctx.nlmConfig as any);
  await ctx.reply(result.text);
  return true;
}

async function handleA2aReset(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "discord") return false;
  if (ctx.config.discordA2aEnabled) {
    const a2aSessionKey = `a2a:${ctx.config.discordA2aChannelId}`;
    await ctx.transport.resetSession(a2aSessionKey);
    await ctx.reply("🔄 A2A session reset.");
    logInfo(TAG, `A2A session reset`);
  } else {
    await ctx.reply("A2A is not enabled.");
  }
  return true;
}

let _wakeInhibitPid: number | null = null;

/** Kill the wake inhibitor process (called before hw sleep). */
export function killWakeInhibit(): void {
  if (_wakeInhibitPid) {
    try { process.kill(_wakeInhibitPid); } catch (err) { logAndSwallow("command_handlers", "op", err); }
    logInfo("wakeup", `Killed wake inhibitor pid=${_wakeInhibitPid}`);
    _wakeInhibitPid = null;
  }
}

async function handleWakeup(_text: string, ctx: CommandContext): Promise<boolean> {
  if (readBridgeLockField("sleepStatus") !== "hw_sleep") {
    await ctx.reply("Already awake.");
    return true;
  }
  const os = platform();
  let child: ReturnType<typeof spawn> | null = null;
  if (os === "darwin") {
    child = spawn("caffeinate", ["-d"], { stdio: "ignore", detached: true });
  } else if (os === "linux") {
    child = spawn("systemd-inhibit", ["--what=idle:sleep", "sleep", "infinity"], { stdio: "ignore", detached: true });
  }
  if (child?.pid) {
    child.unref();
    _wakeInhibitPid = child.pid;
    writeSleepStatus("awake");
    const bedTime = getEnv().bedTime.raw;
    await ctx.reply(`☀️ Awake! Will sleep again at ${bedTime} or when requested.`);
    logInfo("wakeup", `Emergency wake — inhibit pid=${child.pid}`);
  } else {
    writeSleepStatus("awake");
    await ctx.reply("☀️ Awake! (sleep inhibitor not available on this platform)");
  }
  return true;
}

// ── /sleep — status + force-trigger ─────────────────────────────────────────

function readLatestSleepLock(auditDir: string): { date: string; status: string; llmCalls: number; steps: Record<string, { status: string }> } | null {
  try {
    const files = readdirSync(auditDir).filter(f => f.startsWith("sleep_") && f.endsWith(".lock")).sort();
    if (files.length === 0) return null;
    const latest = files[files.length - 1]!;
    const raw = JSON.parse(readFileSync(join(auditDir, latest), "utf-8"));
    const dateMatch = latest.match(/sleep_(\d{4})(\d{2})(\d{2})/);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : "unknown";
    return { date, status: raw.status ?? "unknown", llmCalls: raw.llmCalls ?? 0, steps: raw.steps ?? {} };
  } catch { return null; }
}

function todayLockPath(auditDir: string): string {
  const d = new Date();
  const ds = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return join(auditDir, `sleep_${ds}.lock`);
}

async function handleSleep(_text: string, ctx: CommandContext): Promise<boolean> {
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";
  const progress = ctx.sleepProgress?.();
  const force = readBridgeLockField<string>("forceSleep");
  const bedTime = getEnv().bedTime.raw;
  const auditDir = ctx.memoryConfig?.memoryDir ? join(ctx.memoryConfig.memoryDir, "sleep") : "";
  const lock = auditDir ? readLatestSleepLock(auditDir) : null;

  const lines: string[] = ["😴 Sleep status"];
  lines.push(`  State: ${sleepStatus}${progress ? ` (${progress.step} ${progress.percent}%)` : ""}`);
  if (lock) {
    const counts = Object.values(lock.steps);
    const ok = counts.filter(s => s.status === "ok").length;
    const failed = counts.filter(s => s.status === "failed").length;
    const skipped = counts.filter(s => s.status === "skipped").length;
    lines.push(`  Last cycle: ${lock.date} — ${ok} ok, ${failed} failed, ${skipped} skipped (${lock.status}, ${lock.llmCalls} LLM calls)`);
  } else {
    lines.push("  Last cycle: (none found)");
  }
  lines.push(`  Schedule: BED_TIME=${bedTime}`);
  if (force) lines.push(`  Force-trigger: ${force}`);
  lines.push("");
  lines.push("/sleep resume — retry failed steps");
  lines.push("/sleep now — full fresh cycle");
  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleSleepSub(text: string, ctx: CommandContext): Promise<boolean> {
  const sub = text.replace(/^\/sleep\s+/i, "").trim().toLowerCase();
  const sleepStatus = readBridgeLockField<string>("sleepStatus") ?? "awake";

  if (sleepStatus === "sleeping") {
    await ctx.reply("😴 Sleep already running.");
    return true;
  }

  const auditDir = ctx.memoryConfig?.memoryDir ? join(ctx.memoryConfig.memoryDir, "sleep") : "";

  if (sub === "resume") {
    const lock = auditDir ? readLatestSleepLock(auditDir) : null;
    const hasFailed = lock && Object.values(lock.steps).some(s => s.status === "failed");
    if (!lock || lock.status === "completed" || !hasFailed) {
      await ctx.reply("No failed sleep cycle to resume — use /sleep now for a fresh run.");
      return true;
    }
    writeForceSleep("resume via /sleep resume");
    await ctx.reply("⚡ Sleep resume queued — retries failed steps on next heartbeat tick (≤5min)");
    logInfo(TAG, "Sleep resume triggered via /sleep resume");
    return true;
  }

  if (sub === "now") {
    if (auditDir) {
      try { unlinkSync(todayLockPath(auditDir)); } catch (err) { logAndSwallow("command_handlers", "op", err); }
    }
    writeForceSleep("fresh via /sleep now");
    await ctx.reply("⚡ Fresh sleep cycle queued — starts on next heartbeat tick (≤5min)");
    logInfo(TAG, "Fresh sleep triggered via /sleep now");
    return true;
  }

  await ctx.reply("Unknown subcommand. Use /sleep, /sleep resume, or /sleep now.");
  return true;
}

async function handleHelp(_text: string, ctx: CommandContext): Promise<boolean> {
  const cmds = [
    "/new — Fresh session (keeps current mode)",
    "/reset — Reload transport + fresh session",
    "/reset default — Restore transport.default.json + fresh session",
    "/compact — Compact context window (summarize + fresh session)",
    "/status — Bridge status, transport, heartbeat",
    "/doctor — Deep probe all subsystems",
    "/doctor fix — Run safe auto-repairs",
    "/doctor fix-full — Full repair (+ FTS rebuild, WAL checkpoint)",
    "/mcp — MCP server status",
    "/hooks — List configured hooks",
    "/stop, /ctrlc — Stop current response",
    "/memory — Memory storage statistics",
    "/heartbeat — Heartbeat diagnostics (tasks, last tick)",
    "/models — Model, transport & agent status",
    "/models change — Switch model/provider (any agent)",
    "/models quick <model> — Instant switch on same provider",
    "/models emergency — 🚨 Activate paid hailMary model (manual)",
    "/emergency — Shortcut for /models emergency",
    "/models restore — Reset buckets + clear emergency mode",
    "/tasks — Scheduled tasks",
    "/tasks log <id> — Last 5 runs for a task",
    "/tasks trigger <id> — Manually fire a task",
    "/facts — Core knowledge (user profile + agent notes)",
    "/skills — List loaded skills",
    "/coding — Switch to coding agent",
    "/default — Switch back to default agent",
    "/nlm — Knowledge base (list/create/sources/query)",
    "/restart — Restart CLI session",
    "/wakeup — Wake Mac from sleep (cancel hw_sleep)",
    "/sleep — Sleep status",
    "/sleep resume — Retry failed sleep steps",
    "/sleep now — Full fresh sleep cycle",
  ];
  if (ctx.platform === "telegram") {
    cmds.push("/full — Raw output, TTS disabled", "/short — Clean responses (default)", "/healing — Toggle self-healer on/off");
  }
  if (ctx.platform === "discord" && ctx.config.discordA2aEnabled) {
    cmds.push("/a2a-reset — Reset A2A session");
  }
  cmds.push("/help — Show this help");
  cmds.push("/skills — List available skills");
  await ctx.reply(`📋 Available commands:\n\n${cmds.join("\n")}`);
  return true;
}

async function handleSkills(_text: string, ctx: CommandContext): Promise<boolean> {
  const base = join(abtarsHome(), "skills");
  const groups = ["core", "personal", "auto", "downloaded"] as const;
  const sections: string[] = [];
  let total = 0;
  for (const group of groups) {
    const dir = join(base, group);
    try {
      const files = readdirSync(dir, { recursive: true })
        .map(f => String(f))
        .filter(f => f.endsWith(".md") && !f.endsWith("TOOLS.md"))
        .sort();
      if (files.length > 0) {
        total += files.length;
        sections.push(`${group} (${files.length}):\n${files.map(f => `  • ${f.replace(/\.md$/, "")}`).join("\n")}`);
      }
    } catch (err) { logAndSwallow("command_handlers", "op", err); }
  }
  await ctx.reply(total > 0 ? `📚 Skills (${total}):\n\n${sections.join("\n\n")}` : "📚 No skills found.");
  return true;
}

async function handleHooks(_text: string, ctx: CommandContext): Promise<boolean> {
  const { getHookSummary } = await import("./hooks/hook-system.js");
  const summary = getHookSummary();
  const lines = ["🪝 Hooks:"];
  for (const { event, hooks } of summary) {
    if (hooks.length === 0) {
      lines.push(`  ${event}: (none)`);
    } else {
      lines.push(`  ${event}: ${hooks.map(h => `${h.name} (${h.timeout ?? 5000}ms)`).join(", ")}`);
    }
  }
  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleMcp(_text: string, ctx: CommandContext): Promise<boolean> {
  // Preflight: is mcporter installed? Fast check before placeholder.
  let version = await execAsync("mcporter", ["--version"], 2000);
  if (version === null) {
    await ctx.reply("📦 mcporter not installed");
    return true;
  }
  if (!version) version = "unknown";

  const placeholderId = await ctx.reply("📦 Checking MCP servers...");
  const raw = await execAsync("mcporter", ["list", "--json"], 15_000);

  let body: string;
  if (!raw) {
    body = `📦 MCP: mcporter installed (${version.split("\n")[0]}) but list failed`;
  } else {
    try {
      const data = JSON.parse(raw) as { servers?: Array<{ name?: string; status?: string; tools?: number; prompts?: number; error?: string }> };
      const servers = data.servers ?? [];
      const ok = servers.filter(s => s.status === "ok").length;
      const lines = [
        "📦 MCP status",
        `  mcporter: installed (${version.split("\n")[0]})`,
        `  Servers: ${ok}/${servers.length} online`,
      ];
      for (const s of servers) {
        const mark = s.status === "ok" ? "✓" : "✗";
        const detail = s.status === "ok"
          ? `tools: ${s.tools ?? 0}${s.prompts ? `, prompts: ${s.prompts}` : ""}`
          : (s.error ?? s.status ?? "error");
        lines.push(`    ${mark} ${s.name ?? "?"} (${detail})`);
      }
      body = lines.join("\n");
    } catch {
      body = "📦 MCP: installed, list output unparseable";
    }
  }

  if (placeholderId !== undefined && ctx.editReply) {
    await ctx.editReply(placeholderId, body);
  } else {
    await ctx.reply(body);
  }
  return true;
}

function execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: "utf-8" }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
    child.stderr?.resume(); // drain stderr
  });
}

async function buildStatusLines(ctx: CommandContext): Promise<string[]> {
  let version = "?";
  let buildInfo = "";
  try {
    const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
    version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch (err) { logAndSwallow("command_handlers", "op", err); }
  try {
    const biPath = join(import.meta.dirname, "..", "build-info.json");
    const bi = JSON.parse(readFileSync(biPath, "utf-8")) as { hash: string; date: string };
    buildInfo = ` (${bi.hash} ${bi.date.slice(0, 10)})`;
  } catch (err) { logAndSwallow("command_handlers", "op", err); }

  let model = "unknown";
  if ("currentModel" in ctx.transport) {
    model = (ctx.transport as unknown as { currentModel: string }).currentModel;
  } else {
    const { loadTransport, resolveAgent } = await import("./transport-config.js");
    const tc = loadTransport();
    const prof = tc ? resolveAgent("professor", tc) : null;
    model = prof?.model ?? "unknown";
  }

  const transportStatus = ctx.transport.isReady ? "✓ Connected" : "❌ Disconnected";
  const uptime = formatUptime(Date.now() - ctx.startedAt);
  const ctxPct = ctx.transport.contextPercent >= 0
    ? `${ctx.transport.contextPercent}%`
    : "n/a";
  const cronInfo = ctx.memory?.getCronInfo();

  // Transport details from transport.json
  const { loadTransport: lt, resolveAgent: ra } = await import("./transport-config.js");
  const tc = lt();
  const prof = tc ? ra("professor", tc) : null;
  const provider = prof?.providerName ?? "unknown";
  const mode = prof?.provider.transport?.toUpperCase() ?? "ACP";
  const transportLine = `🔌 Transport: ${mode} (${provider}) — ${transportStatus}`;

  // Fallbacks from transport.json
  const fallbackModels = prof?.fallbacks.map(f => `${f.model} (${f.provider})`) ?? [];

  const lines = [
    `Abtars v${version}${buildInfo}`,
    transportLine,
    `🤖 Model: ${model}`,
    ...(fallbackModels.length > 0 ? [`   Fallbacks: ${fallbackModels.join(", ")}`] : []),
    `📊 Context window: ${ctxPct}`,
    `⏱️ Uptime: ${uptime}`,
  ];
  if (cronInfo) {
    const mins = Math.round(cronInfo.intervalMs / 60000);
    lines.push(
      `💓 Heartbeat: ${cronInfo.heartbeatRunning ? "running" : "stopped"} (${mins}min)`,
    );
    if (ctx.loadedCapabilities?.length) {
      lines.push(`🔌 Capabilities: ${ctx.loadedCapabilities.join(", ")}`);
    }
    lines.push(`😴 Last sleep: ${cronInfo.lastSleepAudit ?? "(never)"}`);
    const sp = ctx.sleepProgress?.();
    if (sp) {
      lines.push(`😴 Sleep: ${sp.percent}% (${sp.step})`);
    }
    try {
      const lock = JSON.parse(readFileSync(join(abtarsHome(), "bridge.lock"), "utf-8"));
      if (lock.lastHeartbeat > 0) lines.push(`🫀 Last tick: ${Math.round((Date.now() - lock.lastHeartbeat) / 60000)}min ago`);
    } catch (err) { logAndSwallow("command_handlers", "op", err); }
    try {
      const ce = cronReadEntries();
      const r = ce.filter(e => e.schedule && !e.paused).length;
      const p = ce.filter(e => !e.fired && !e.schedule).length;
      const pa = ce.filter(e => e.paused).length;
      lines.push(`⏰ Tasks: ${r} recurring, ${p} pending${pa ? `, ${pa} paused` : ""}`);
    } catch (err) { logAndSwallow("command_handlers", "op", err); }
    try {
      const bd = join(homedir(), ".backup-abtars");
      const bk = readdirSync(bd).filter(f => f.startsWith("abtars-")).sort();
      if (bk.length > 0) lines.push(`💾 Last backup: ${bk[bk.length - 1]}`);
    } catch (err) { logAndSwallow("command_handlers", "op", err); }
  }

  lines.push("");
  lines.push("Use /mcp for MCP server status.");

  return lines;
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── /users command ──────────────────────────────────────────────────────────

async function handleUsers(text: string, ctx: CommandContext): Promise<boolean> {
  const { loadUsers } = await import("./user-registry.js");
  const parts = text.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === "approve" && parts[2]) {
    const platformId = parts[2];
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { abtarsHome } = await import("../paths.js");
    const configPath = join(abtarsHome(), "config", "users.json");
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const users = Array.isArray(raw.users) ? raw.users : [];
      if (users.some((u: { platforms?: { telegram?: number } }) => String(u.platforms?.telegram) === platformId)) {
        await ctx.reply(`User with platform ID ${platformId} already exists.`);
        return true;
      }
      const guestId = `guest-${platformId}`;
      users.push({ userId: guestId, role: "guest", maxClass: 0, tools: [], platforms: { telegram: parseInt(platformId, 10) || 0 } });
      writeFileSync(configPath, JSON.stringify({ users }, null, 2), "utf-8");
      await ctx.reply(`✅ Approved guest: ${guestId} (platform ID: ${platformId})`);
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (sub === "revoke" && parts[2]) {
    const targetUserId = parts[2];
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { abtarsHome } = await import("../paths.js");
    const configPath = join(abtarsHome(), "config", "users.json");
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const users = (Array.isArray(raw.users) ? raw.users : []).filter((u: { userId: string }) => u.userId !== targetUserId);
      writeFileSync(configPath, JSON.stringify({ users }, null, 2), "utf-8");
      await ctx.reply(`✅ Revoked: ${targetUserId}`);
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // List users
  const registry = loadUsers();
  const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
  const lines = registry.users.map(u =>
    `• ${u.userId} (${u.role}, ${CLASS_NAMES[u.maxClass] ?? `class ${u.maxClass}`}) — tools: ${u.tools.join(", ") || "none"}`
  );
  await ctx.reply(`👥 Users (${registry.users.length}):\n${lines.join("\n")}\n\n/users approve <platformId>\n/users revoke <userId>`);
  return true;
}
