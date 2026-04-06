/**
 * Unified command handlers for all platforms (Telegram, Discord).
 * Platform-specific commands check ctx.platform internally.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo, logError } from "./logger.js";
import { readEntries as cronReadEntries } from "./cron/cron-db.js";
import { handleNLMCommand } from "./nlm-command-handler.js";
import { agentBridgeHome } from "../paths.js";
import { runCompaction } from "./compaction.js";
import { resetAndPrepare } from "./message-pipeline.js";
import type { PipelineDeps } from "./message-pipeline.js";
import type { RunningJob } from "./cron/cron-queue.js";

import type { Platform } from "../types/platform.js";
export type { Platform };
export type Reply = (text: string, opts?: { parseMode?: string; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } }) => Promise<unknown>;

export interface CommandContext {
  sessionKey: string;
  chatId: number;
  platform: Platform;
  reply: Reply;
  // From PipelineDeps
  transport: PipelineDeps["transport"];
  config: PipelineDeps["config"];
  startedAt: PipelineDeps["startedAt"];
  memory: PipelineDeps["memory"];
  memoryConfig: PipelineDeps["memoryConfig"];
  nlmConfig: PipelineDeps["nlmConfig"];
  codingMode: PipelineDeps["codingMode"];
  idleSave: PipelineDeps["idleSave"];
  busyChats: PipelineDeps["busyChats"];
  fullModeChats: PipelineDeps["fullModeChats"];
  pendingSessionStart: PipelineDeps["pendingSessionStart"];
  updateCtxStart: PipelineDeps["updateCtxStart"];
  cronCurrentJob?: RunningJob | null;
  enqueueCron?: PipelineDeps["enqueueCron"];
  requestShutdown?: PipelineDeps["requestShutdown"];
  sleepProgress?: PipelineDeps["sleepProgress"];
  loadedCapabilities?: PipelineDeps["loadedCapabilities"];
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
  "/stop": handleStop,
  "/ctrlc": handleStop,
  "/restart": handleRestart,
  "/full": handleFull,
  "/short": handleShort,
  "/facts": handleFacts,
  "/tasks": handleTasksList,
  "/task": handleTasksList,
  "/cron": handleTasksList,
  "/memory": handleMemory,
  "/heartbeat": handleHeartbeat,
  "/models": handleModels,
  "/a2a-reset": handleA2aReset,
  "/help": handleHelp,
  "/skills": handleSkills,
  "/skill": handleSkills,
};

// ── Prefix-match commands ───────────────────────────────────────────────────

const prefixCommands: ReadonlyArray<{ prefix: string; handler: CommandHandler }> = [
  { prefix: "/tasks trigger ", handler: handleTasksTrigger },
  { prefix: "/cron trigger ", handler: handleTasksTrigger },
  { prefix: "/tasks log ", handler: handleTasksLog },
  { prefix: "/cron log ", handler: handleTasksLog },
  { prefix: "/nlm", handler: handleNlm },
];

const KNOWN_COMMANDS = new Set([...Object.keys(exactCommands), ...prefixCommands.map(p => p.prefix.split(" ")[0]!)]);

/** Register an additional exact-match command (used by capability system). */
export function registerCommand(name: string, handler: CommandHandler): void {
  exactCommands[name] = handler;
  KNOWN_COMMANDS.add(name);
}

/** Returns true if command was handled. */
export async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const exact = exactCommands[text];
  if (exact) return exact(text, ctx);

  for (const { prefix, handler } of prefixCommands) {
    if (text.startsWith(prefix)) return handler(text, ctx);
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

async function handleNewReset(text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
  if (text === "/reset" && ctx.codingMode.has(ctx.sessionKey)) {
    await ctx.codingMode.stop(ctx.sessionKey);
  }
  const activeTransport = ctx.codingMode.has(ctx.sessionKey) && ctx.codingMode.getTransport()
    ? ctx.codingMode.getTransport()! : ctx.transport;
  await resetAndPrepare({
    transport: activeTransport, sessionKey: ctx.sessionKey, reason: "user-reset",
    pendingSessionStart: ctx.pendingSessionStart, conversationBuffer: ctx.conversationBuffer, bufKey: ctx.bufKey,
  });
  if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.chatId);
  const label = text === "/reset" ? "🔄 Reset to default." : ctx.codingMode.has(ctx.sessionKey) ? "🔄 New coding session." : "🔄 New session started.";
  await ctx.reply(label);
  logInfo(TAG, `Session ${text} (${ctx.platform}, mode=${ctx.codingMode.has(ctx.sessionKey) ? "coding" : "default"})`);
  return true;
}

async function handleCompact(_text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.reply("📦 Compacting...");
  try {
    await runCompaction(ctx.transport, ctx.sessionKey, ctx.memory ?? null, ctx.memoryConfig.memoryDir);
    ctx.pendingSessionStart.add(ctx.sessionKey);
    if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.chatId);
    await ctx.reply("📦 Compaction complete.");
    logInfo(TAG, `Manual compaction done`);
  } catch (err) {
    logError(TAG, "Manual compaction failed", err);
    await ctx.reply("❌ Compaction failed. Try /reset to start fresh.");
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

async function handleStatus(_text: string, ctx: CommandContext): Promise<boolean> {
  const lines = await buildStatusLines(ctx);
  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleStop(_text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.transport.sendInterrupt();
  ctx.busyChats.delete(ctx.sessionKey);
  await ctx.reply("🛑 Ctrl+C sent to Kiro.");
  logInfo(TAG, "Ctrl+C interrupt sent");
  return true;
}

async function handleRestart(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.transport.restartSession) {
    await ctx.reply("♻️ Restarting Kiro...");
    ctx.busyChats.delete(ctx.sessionKey);
    await ctx.transport.restartSession(ctx.config.workingDir, process.env["AGENT_MODEL"]);
    ctx.pendingSessionStart.add(ctx.sessionKey);
    await ctx.reply("✅ Kiro restarted.");
  } else {
    await ctx.reply("♻️ Restarting bridge...");
    setTimeout(() => ctx.requestShutdown?.(), 500);
  }
  return true;
}

async function handleFull(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") return false;
  ctx.fullModeChats.add(ctx.sessionKey);
  await ctx.reply("📺 Full mode — sending raw output, TTS disabled.");
  return true;
}

async function handleShort(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") return false;
  ctx.fullModeChats.delete(ctx.sessionKey);
  await ctx.reply("✂️ Short mode — clean responses, TTS enabled.");
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
    const raw = await execAsync("agentbridge-task", ["list"], 5000);
    if (!raw) throw new Error("empty");
    const entries = JSON.parse(raw).entries ?? JSON.parse(raw);
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
      const label = e.message.split("\n")[0].replace(/[~\/][\w.\/-]+\//g, "").slice(0, 30);
      return `${tick}  ${e.id}  ${sched.padEnd(15)}  ${label}`;
    });
    listing = lines.length > 0 ? "```\n" + lines.join("\n") + "\n```" : "(no active entries)";
  } catch { listing = "(failed to read cron)"; }
  let running = "";
  if (ctx.cronCurrentJob) {
    const j = ctx.cronCurrentJob;
    const ago = Math.round((Date.now() - j.startedAt) / 1000);
    running = `\n▶ Running: ${j.type} (pid ${j.pid}, ${ago}s ago)\n   ${j.message}`;
  }
  await ctx.reply(`⏰ ${now}\n\n${listing}${running}`, { parseMode: "Markdown" });
  return true;
}

async function handleTasksTrigger(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks|cron) trigger /, "").trim();
  if (!id) { await ctx.reply("Usage: /trigger <cron-id>"); return true; }
  const err = ctx.enqueueCron?.(id);
  await ctx.reply(err ?? `✅ Triggered ${id}`);
  return true;
}

async function handleTasksLog(text: string, ctx: CommandContext): Promise<boolean> {
  const id = text.replace(/^\/(tasks|cron) log /, "").trim();
  try {
    const raw = await execAsync("agentbridge-task", ["history", id], 5000);
    if (!raw) throw new Error("empty");
    const data = JSON.parse(raw);
    if (!data.ok) { await ctx.reply(`❌ ${data.error}`); return true; }
    const runs = (data.runs as { ranAt: string; exitCode?: number }[]).slice(-5);
    const lines = runs.map(r => `${r.ranAt}  exit=${r.exitCode ?? "?"}`);
    await ctx.reply(`📋 ${data.message}\n\n\`\`\`\n${lines.join("\n") || "(no runs)"}\n\`\`\``, { parseMode: "Markdown" });
  } catch { await ctx.reply("❌ Failed to read history"); }
  return true;
}

async function handleModels(_text: string, ctx: CommandContext): Promise<boolean> {
  const transport = ctx.transport;
  const isApi = ctx.config.agentTransport === "api";

  // Get current model
  const currentModel = isApi && "getModel" in transport
    ? (transport as { getModel(): string }).getModel()
    : process.env["AGENT_MODEL"] ?? "unknown";

  // Fetch available models for API transport
  let models: string[] = [];
  if (isApi) {
    const endpoint = process.env["API_ENDPOINT"] ?? "http://localhost:20128/v1";
    const apiKey = process.env["API_KEY"];
    try {
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
      const res = await fetch(`${endpoint}/models`, { headers, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ id: string }> };
        models = (data.data ?? []).map(m => m.id).sort();
      }
    } catch { /* endpoint doesn't support /models */ }
  }

  if (models.length > 0) {
    // Send inline keyboard
    const COLS = 2;
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < models.length; i += COLS) {
      const row = models.slice(i, i + COLS).map(m => ({
        text: m === currentModel ? `✓ ${m}` : m,
        callback_data: `model:${m}`,
      }));
      buttons.push(row);
    }
    await ctx.reply(`📋 Models (${models.length}) — tap to switch:`, {
      reply_markup: { inline_keyboard: buttons },
    });
  } else {
    await ctx.reply(`🤖 Model: ${currentModel}\n\nModel list not available for ${ctx.config.agentTransport} transport.`);
  }
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
    const hbTs = parseInt(readFileSync(join(agentBridgeHome(), "memory", ".heartbeat"), "utf-8"), 10);
    if (hbTs > 0) {
      const agoMin = Math.round((Date.now() - hbTs) / 60000);
      lines.push("", `🫀 Last tick: ${agoMin}min ago`);
    }
  } catch { /* */ }

  await ctx.reply(lines.join("\n"));
  return true;
}

async function handleMemory(_text: string, ctx: CommandContext): Promise<boolean> {
  if (!ctx.memory) { await ctx.reply("🧠 Memory is disabled."); return true; }
  const stats = ctx.memory.getStats(ctx.chatId);
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

async function handleHelp(_text: string, ctx: CommandContext): Promise<boolean> {
  const cmds = [
    "/new — Fresh session (keeps current mode)",
    "/reset — Fresh session + exit coding mode",
    "/compact — Compact context window (summarize + fresh session)",
    "/status — Bridge status, transport, heartbeat",
    "/stop, /ctrlc — Stop current response",
    "/memory — Memory storage statistics",
    "/heartbeat — Heartbeat diagnostics (tasks, last tick)",
    "/tasks — Scheduled tasks",
    "/tasks log <id> — Last 5 runs for a task",
    "/tasks trigger <id> — Manually fire a task",
    "/facts — Core knowledge (user profile + agent notes)",
    "/coding — Switch to coding agent",
    "/default — Switch back to default agent",
    "/nlm — Knowledge base (list/create/sources/query)",
    "/restart — Restart CLI session",
  ];
  if (ctx.platform === "telegram") {
    cmds.push("/full — Raw output, TTS disabled", "/short — Clean responses (default)");
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
  const dir = join(agentBridgeHome(), "skills");
  try {
    const files = readdirSync(dir).filter(f => f.endsWith(".md") && f !== "TOOLS.md").sort();
    const lines = files.map(f => {
      const name = f.replace(/\.md$/, "");
      try {
        const content = readFileSync(join(dir, f), "utf-8");
        const first = content.split("\n").find(l => l.trim() && !l.startsWith("#") && !l.startsWith("---") && l.trim().length > 5);
        return `• ${name}${first ? ` — ${first.trim().slice(0, 80)}` : ""}`;
      } catch { return `• ${name}`; }
    });
    await ctx.reply(`📚 Available Skills (${files.length}):\n\n${lines.join("\n")}`);
  } catch { await ctx.reply("📚 No skills directory found."); }
  return true;
}
function execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: "utf-8" }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
    child.stderr?.resume(); // drain stderr
  });
}

async function buildStatusLines(ctx: CommandContext): Promise<string[]> {
  let version = "?";
  try {
    const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
    version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch { /* */ }

  // Fire async checks in parallel
  const [modelRaw, mcpRaw] = await Promise.all([
    process.env["AGENT_MODEL"]
      ? Promise.resolve("")
      : execAsync("kiro-cli", ["settings", "list", "--format", "json"], 3000),
    execAsync("mcporter", ["list", "--json"], 15_000),
  ]);

  let model = process.env["AGENT_MODEL"] || "";
  if (!model) {
    try { model = JSON.parse(modelRaw)["chat.defaultModel"] || "unknown"; } catch { model = "unknown"; }
  }

  const transportStatus = ctx.transport.isReady ? "✅ Connected" : "❌ Disconnected";
  const mode = ctx.config.agentTransport.toUpperCase();
  const uptime = formatUptime(Date.now() - ctx.startedAt);
  const ctxPct = ctx.transport.contextPercent >= 0
    ? `${ctx.transport.contextPercent}%`
    : "n/a";
  const cronInfo = ctx.memory?.getCronInfo();

  // Transport details
  const endpoint = process.env["API_ENDPOINT"];
  const provider = mode === "API" && endpoint ? endpoint.replace(/^https?:\/\//, "").replace(/\/v1$/, "") : (process.env["AGENT_CLI"] || "kiro");
  const transportLine = `🔌 Transport: ${mode} (${provider}) — ${transportStatus}`;

  // Fallback model(s)
  const fallbackModels: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const fm = process.env[`API_FALLBACK_${i}_MODEL`];
    if (fm) fallbackModels.push(fm);
  }

  // Fallback transport
  const fallbackTransport = process.env["TRANSPORT_FALLBACK"];

  const lines = [
    `Kiro Professor v${version}`,
    `🤖 Model: ${model}`,
    ...(fallbackModels.length > 0 ? [`   Fallback model: ${fallbackModels.join(", ")}`] : []),
    `📊 Context window: ${ctxPct}`,
    `⏱️ Uptime: ${uptime}`,
    transportLine,
    ...(fallbackTransport ? [`   Fallback transport: ${fallbackTransport}`] : []),
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
      const hbTs = parseInt(readFileSync(join(agentBridgeHome(), "memory", ".heartbeat"), "utf-8"), 10);
      if (hbTs > 0) lines.push(`🫀 Last tick: ${Math.round((Date.now() - hbTs) / 60000)}min ago`);
    } catch { /* */ }
    try {
      const ce = cronReadEntries();
      const r = ce.filter(e => e.schedule && !e.paused).length;
      const p = ce.filter(e => !e.fired && !e.schedule).length;
      const pa = ce.filter(e => e.paused).length;
      lines.push(`⏰ Tasks: ${r} recurring, ${p} pending${pa ? `, ${pa} paused` : ""}`);
    } catch { /* */ }
    try {
      const bd = join(homedir(), ".backup-agentbridge");
      const bk = readdirSync(bd).filter(f => f.startsWith("agentbridge-")).sort();
      if (bk.length > 0) lines.push(`💾 Last backup: ${bk[bk.length - 1]}`);
    } catch { /* */ }
  }

  // MCP status (already fetched async)
  if (mcpRaw) {
    try {
      const data = JSON.parse(mcpRaw);
      const servers = data.servers ?? [];
      const ok = servers.filter((s: Record<string, unknown>) => s.status === "ok").length;
      lines.push(`📦 MCP: ${ok}/${servers.length} servers online`);
    } catch {
      lines.push("📦 MCP: installed, list failed");
    }
  } else {
    const hasCmd = await execAsync("mcporter", ["--version"], 5000);
    lines.push(hasCmd ? "📦 MCP: installed, list failed" : "📦 MCP: not installed");
  }

  return lines;
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
