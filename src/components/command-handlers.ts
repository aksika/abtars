/**
 * Unified command handlers for all platforms (Telegram, Discord).
 * Platform-specific commands check ctx.platform internally.
 */

import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logInfo } from "./logger.js";
import { handleNLMCommand } from "./nlm-command-handler.js";
import type { IKiroTransport } from "./kiro-transport.js";
import { TmuxClient } from "./tmux-client.js";
import type { MemoryManager } from "./memory-manager.js";
import type { CodingMode } from "./coding-mode.js";
import type { IdleSave } from "./idle-save.js";
import type { RunningJob } from "./cron-queue.js";

import type { Platform } from "../types/platform.js";
export type { Platform };
export type Reply = (text: string, opts?: { parseMode?: string }) => Promise<unknown>;

export interface CommandContext {
  sessionKey: string;
  chatId: number;
  platform: Platform;
  reply: Reply;
  // Transport
  transport: IKiroTransport;
  config: { agentTransport: string; workingDir: string; discordA2aEnabled?: boolean; discordA2aChannelId?: string };
  startedAt: number;
  // Memory
  memory: MemoryManager | null;
  memoryConfig: { memoryEnabled: boolean; memoryDir: string };
  nlmConfig: { enabled: boolean; [k: string]: unknown };
  // Modules
  codingMode: CodingMode;
  idleSave: IdleSave;
  cronCurrentJob?: RunningJob | null;
  enqueueCron?: (entryId: string) => string | null;
  // Mutable state
  busyChats: Set<string>;
  fullModeChats: Set<string>;
  pendingSessionStart: Set<string>;
  // Callbacks
  updateCtxStart: (memoryDir: string, chatId: number) => void;
  // Group/buffer (optional, for group chats)
  conversationBuffer?: { clear: (key: string) => void };
  bufKey?: string;
}

const TAG = "cmd";

/** Returns true if command was handled. */
export async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  // /new, /reset
  if (text === "/new" || text === "/reset") {
    await ctx.idleSave.save(ctx.sessionKey, ctx.chatId);
    if (text === "/reset" && ctx.codingMode.has(ctx.sessionKey)) {
      await ctx.codingMode.stop(ctx.sessionKey);
    }
    const codingTransport = ctx.codingMode.getTransport();
    if (ctx.codingMode.has(ctx.sessionKey) && codingTransport) {
      await codingTransport.resetSession(ctx.sessionKey);
    } else {
      await ctx.transport.resetSession(ctx.sessionKey);
    }
    if (ctx.conversationBuffer && ctx.bufKey) ctx.conversationBuffer.clear(ctx.bufKey);
    ctx.pendingSessionStart.add(ctx.sessionKey);
    if (ctx.memoryConfig.memoryEnabled) ctx.updateCtxStart(ctx.memoryConfig.memoryDir, ctx.chatId);
    const label = text === "/reset" ? "🔄 Reset to KP." : ctx.codingMode.has(ctx.sessionKey) ? "🔄 New coding session." : "🔄 New session started.";
    await ctx.reply(label);
    logInfo(TAG, `Session ${text} (${ctx.platform}, mode=${ctx.codingMode.has(ctx.sessionKey) ? "coding" : "default"})`);
    return true;
  }

  // /coding
  if (text === "/coding") {
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

  // /default
  if (text === "/default") {
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

  // /status (includes mcporter)
  if (text === "/status") {
    const lines = buildStatusLines(ctx);
    await ctx.reply(lines.join("\n"));
    return true;
  }

  // /stop, /cancel
  if (text === "/stop" || text === "/cancel") {
    await ctx.transport.sendInterrupt();
    ctx.busyChats.delete(ctx.sessionKey);
    await ctx.reply("🛑 Ctrl+C sent to Kiro.");
    logInfo(TAG, "Ctrl+C interrupt sent");
    return true;
  }

  // /restart
  if (text === "/restart") {
    if (ctx.transport instanceof TmuxClient) {
      await ctx.reply("♻️ Restarting Kiro...");
      ctx.busyChats.delete(ctx.sessionKey);
      await (ctx.transport as TmuxClient).restartSession(ctx.config.workingDir, process.env["AGENT_MODEL"]);
      ctx.pendingSessionStart.add(ctx.sessionKey);
      await ctx.reply("✅ Kiro restarted.");
    } else {
      await ctx.reply("⚠️ /restart only works with tmux transport.");
    }
    return true;
  }

  // /full (TG-only)
  if (text === "/full") {
    if (ctx.platform !== "telegram") return false;
    ctx.fullModeChats.add(ctx.sessionKey);
    await ctx.reply("📺 Full mode — sending raw output, TTS disabled.");
    return true;
  }

  // /short (TG-only)
  if (text === "/short") {
    if (ctx.platform !== "telegram") return false;
    ctx.fullModeChats.delete(ctx.sessionKey);
    await ctx.reply("✂️ Short mode — clean responses, TTS enabled.");
    return true;
  }

  // /facts
  if (text === "/facts") {
    if (ctx.memory) {
      const facts = ctx.memory.readCoreKnowledge();
      await ctx.reply(facts ? `📋 Core knowledge:\n\n${facts}` : "📋 No core knowledge yet.");
    } else {
      await ctx.reply("🧠 Memory is disabled.");
    }
    return true;
  }

  // /cron
  if (text === "/cron") {
    const now = new Date().toLocaleString("en-GB", { timeZone: "Europe/Budapest", dateStyle: "medium", timeStyle: "medium" });
    let listing: string;
    try {
      const raw = execSync("agentbridge-cron list", { timeout: 5000, encoding: "utf-8" }).trim();
      const entries = JSON.parse(raw).entries ?? JSON.parse(raw);
      const active = entries.filter((e: any) => !e.fired && !e.paused);
      // Sort chronologically by schedule time (hour:minute from cron expr)
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
      const dow = today.getDay(); // 0=Sun
      const lines = active.map((e: any) => {
        const sched = e.schedule ?? "one-shot";
        // Determine if task runs today based on cron day-of-week field
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

  // /cron trigger <id>
  if (text.startsWith("/cron trigger ")) {
    const id = text.slice(14).trim();
    if (!id) { await ctx.reply("Usage: /trigger <cron-id>"); return true; }
    const err = ctx.enqueueCron?.(id);
    await ctx.reply(err ?? `✅ Triggered ${id}`);
    return true;
  }

  // /cron log <id>
  if (text.startsWith("/cron log ")) {
    const id = text.slice(10).trim();
    try {
      const raw = execSync(`agentbridge-cron history ${id}`, { timeout: 5000, encoding: "utf-8" }).trim();
      const data = JSON.parse(raw);
      if (!data.ok) { await ctx.reply(`❌ ${data.error}`); return true; }
      const runs = (data.runs as { ranAt: string; exitCode?: number }[]).slice(-5);
      const lines = runs.map(r => `${r.ranAt}  exit=${r.exitCode ?? "?"}`);
      await ctx.reply(`📋 ${data.message}\n\n\`\`\`\n${lines.join("\n") || "(no runs)"}\n\`\`\``, { parseMode: "Markdown" });
    } catch { await ctx.reply("❌ Failed to read history"); }
    return true;
  }

  // /memory
  if (text === "/memory") {
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

  // /nlm
  if (text === "/nlm" || text.startsWith("/nlm ")) {
    const args = text.slice("/nlm".length).trim();
    const result = await handleNLMCommand(args, ctx.nlmConfig as any);
    await ctx.reply(result.text);
    return true;
  }

  // /a2a-reset (Discord-only)
  if (text === "/a2a-reset") {
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

  // /help
  if (text === "/help") {
    const cmds = [
      "/new — Start a new session",
      "/reset — Reset session + switch back to KP",
      "/status — Bot status, transport, heartbeat, mcporter",
      "/stop — Stop current response (Ctrl+C)",
      "/memory — Memory storage statistics",
      "/cron — Scheduled tasks",
      "/cron log <id> — Last 5 runs for a task",
      "/cron trigger <id> — Manually fire a cron task",
      "/facts — Core knowledge (user profile + agent notes)",
      "/coding — Switch to Opus coding agent",
      "/default — Switch back to KP",
      "/nlm — Knowledge base (list/create/sources/query)",
      "/restart — Restart Kiro (tmux only)",
    ];
    if (ctx.platform === "telegram") {
      cmds.push("/full — Raw output, TTS disabled", "/short — Clean responses (default)");
    }
    if (ctx.platform === "discord" && ctx.config.discordA2aEnabled) {
      cmds.push("/a2a-reset — Reset A2A session");
    }
    cmds.push("/help — Show this help");
    await ctx.reply(`📋 Available commands:\n\n${cmds.join("\n")}`);
    return true;
  }

  // Unknown command guard
  if (text.startsWith("/") && /^\/\w+/.test(text) && !text.startsWith("//")) {
    const cmd = text.split(/\s/)[0]!;
    const known = ["/new", "/reset", "/status", "/stop", "/cancel", "/restart", "/memory", "/cron", "/facts", "/coding", "/default", "/nlm", "/full", "/short", "/a2a-reset", "/help"];
    if (!known.includes(cmd)) {
      await ctx.reply(`❓ Unknown command: ${cmd}\nType /help for available commands.`);
      return true;
    }
  }

  return false;
}

function buildStatusLines(ctx: CommandContext): string[] {
  const thisDir = join(homedir(), ".agentbridge");
  let version = "?";
  try {
    const pkgPath = join(thisDir, "..", "workspace", "agentbridge", "package.json");
    version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch { /* */ }
  let model = process.env["AGENT_MODEL"] || "";
  if (!model) {
    try { model = JSON.parse(execSync("kiro-cli settings list --format json 2>/dev/null", { timeout: 3000, encoding: "utf-8" }))["chat.defaultModel"] || "unknown"; } catch { model = "unknown"; }
  }
  const status = ctx.transport.isReady ? "✅ Connected" : "❌ Disconnected";
  const mode = ctx.config.agentTransport.toUpperCase();
  const uptime = formatUptime(Date.now() - ctx.startedAt);
  const ctxPct = ("contextPercent" in ctx.transport && (ctx.transport as TmuxClient).contextPercent >= 0)
    ? `${(ctx.transport as TmuxClient).contextPercent}%`
    : "n/a";
  const cronInfo = ctx.memory?.getCronInfo();
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
  // mcporter status
  try {
    const raw = execSync("mcporter list --json 2>/dev/null", { timeout: 15_000 }).toString();
    const data = JSON.parse(raw);
    const servers = data.servers ?? [];
    const ok = servers.filter((s: Record<string, unknown>) => s.status === "ok").length;
    lines.push(`📦 MCP: ${ok}/${servers.length} servers online`);
  } catch {
    try {
      execSync("mcporter --version 2>/dev/null", { timeout: 5_000 });
      lines.push("📦 MCP: installed, list failed");
    } catch {
      lines.push("📦 MCP: not installed");
    }
  }
  return lines;
}

function formatUptime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
