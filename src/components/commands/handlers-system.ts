import { readFileSync, readdirSync} from "node:fs";
import { join } from "node:path";
import { homedir} from "node:os";
import { logInfo} from "../logger.js";
import { logAndSwallow } from "../log-and-swallow.js";
import { readEntries as cronReadEntries } from "../tasks/task-store.js";
import { abtarsHome } from "../../paths.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd";

export async function handleDoctor(_text: string, ctx: CommandContext): Promise<boolean> {
  const arg = _text.replace(/^\/(doctor|health)\s*/i, "").trim().toLowerCase();

  // /doctor fix → run fixes
  if (arg === "fix" || arg === "fix-full") {
    try {
      const { runFixes, runAllProbes, renderHuman } = await import("../../cli/commands/doctor-probes.js");
      const fixes = await runFixes();
      const fixLines = fixes.map(f => `  ${f.success ? "+" : "x"} ${f.action}`).join("\n");
      const output = await runAllProbes();
      await ctx.reply(`🩺 Fix:\n${fixLines || "(nothing to fix)"}\n\n${renderHuman(output)}`);
    } catch (err) {
      await ctx.reply(`x doctor fix failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  await ctx.reply("🩺 Running diagnostics...");
  const { runAllProbes, renderHuman } = await import("../../cli/commands/doctor-probes.js");
  const output = await runAllProbes();
  await ctx.reply(renderHuman(output));
  return true;
}

export async function handleStatus(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.phaseHealth && ctx.registry) {
    const { getSystemStatus, renderStatusText } = await import("../system-status.js");
    const status = await getSystemStatus({
      phaseHealth: ctx.phaseHealth,
      registry: ctx.registry,
      transport: ctx.transport,
      startedAt: ctx.startedAt,
      bridgeLockPath: ctx.bridgeLockPath ?? "",
      heartbeat: { intervalMs: Math.max(60, parseInt(process.env["HEARTBEAT_INTERVAL_SEC"] ?? "60", 10)) * 1000 },
    });
    let text = renderStatusText(status);
    // #255: append sanitized env dump on /status full
    if (_text.trim().toLowerCase() === "full") {
      const { envDump } = await import("../env-schema.js");
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

export async function handleWait(text: string, ctx: CommandContext): Promise<boolean> {
  // When idle, /wait is a no-op (nothing running to steer). Inform user.
  const body = text.replace(/^\/(wait|steer)\s*/i, "").trim();
  if (!body) { await ctx.reply("Nothing running. Send a message to start."); return true; }
  // Has a message body but idle — just pass it as a normal prompt (return false = not handled)
  return false;
}

export async function handleStop(_text: string, ctx: CommandContext): Promise<boolean> {
  await ctx.transport.sendInterrupt();
  const { spin } = await import("../spin.js");
  const s = spin.getSessionById(ctx.sessionKey);
  if (s) s.busy = false;
  await ctx.reply("🛑 Ctrl+C sent.");
  logInfo(TAG, "Ctrl+C interrupt sent");
  return true;
}

export async function handleRestart(_text: string, ctx: CommandContext): Promise<boolean> {
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const home = process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars");
  writeFileSync(join(home, ".start-reason"), "user-restart");

  const arg = _text.replace(/^\/restart\s*/i, "").trim().toLowerCase();
  if (arg === "cold") {
    await ctx.reply("+ Cold restart...");
    setTimeout(() => process.exit(0), 500);
    return true;
  }
  await ctx.reply("+ Restarting bridge...");
  setTimeout(() => ctx.requestShutdown?.(0), 500);
  return true;
}

export async function handleHeartbeat(_text: string, ctx: CommandContext): Promise<boolean> {
  const { getHeartbeatInstance } = await import("../heartbeat-system.js");
  const hb = getHeartbeatInstance();
  if (!hb) { await ctx.reply("💓 Heartbeat not available."); return true; }

  const mins = Math.round(hb.intervalMs / 60000);
  const lines = [
    `💓 Heartbeat: ${hb.isRunning ? "running" : "stopped"} (${mins}min interval)`,
    "",
  ];

  // Task statuses
  const statuses = hb.getTaskStatuses();
  if (statuses.size > 0) {
    lines.push("Tasks (last tick):");
    for (const [name, status] of statuses) {
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

export async function handleHealing(text: string, ctx: CommandContext): Promise<boolean> {
  const arg = text.replace(/^\/healing\s*/, "").trim();
  const cmd = arg.toLowerCase().split(/\s+/)[0] ?? "";

  if (cmd === "on") {
    if (ctx.selfHealerTask) ctx.selfHealerTask.enabled = true;
    await ctx.reply("🩺 Self-healing: ON");
    logInfo(TAG, "Self-healer ON by user");
    return true;
  }
  if (cmd === "off") {
    if (ctx.selfHealerTask) ctx.selfHealerTask.enabled = false;
    await ctx.reply("🩺 Self-healing: OFF");
    logInfo(TAG, "Self-healer OFF by user");
    return true;
  }
  if (cmd === "reset") {
    const { resetAutofixState } = await import("../sha-tracker.js");
    resetAutofixState();
    await ctx.reply("🩺 Autofix state reset — all suppressed faults re-enabled.");
    return true;
  }
  if (cmd === "list") {
    const { loadFixes } = await import("../sha-tracker.js");
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const fixes = loadFixes();
    if (fixes.length === 0) { await ctx.reply("🩺 No fix rules configured."); return true; }
    let state: Record<string, { totalRuns?: number }> = {};
    try { state = JSON.parse(readFileSync(join(process.env["ABTARS_HOME"] || join(process.env["HOME"] || "~", ".abtars"), "state", "sha-state.json"), "utf-8")); } catch {}
    const lines = fixes.map(f => {
      const v = f.verified === false ? " ⚠️" : "";
      const src = f.createdAt ? "(self)" : "(core)";
      const runs = state[`autofix-known:${f.pattern}`]?.totalRuns ?? 0;
      const runsText = runs > 0 ? ` [${runs}x]` : "";
      return `• "${f.pattern.slice(0, 20)}" → ${f.command?.[0] ?? "?"} ${src}${v}${runsText}`;
    });
    await ctx.reply(`🩺 Fix rules (${fixes.length}):\n${lines.join("\n")}`);
    return true;
  }
  if (cmd === "approve") {
    const pattern = arg.slice(8).trim();
    if (!pattern) { await ctx.reply("Usage: /healing approve <pattern>"); return true; }
    const { approveFix } = await import("../sha-tracker.js");
    const ok = approveFix(pattern);
    await ctx.reply(ok ? `✓ Approved: "${pattern}"` : `❌ Pattern not found in self-rules.`);
    return true;
  }
  if (cmd === "disable") {
    const pattern = arg.slice(8).trim();
    if (!pattern) { await ctx.reply("Usage: /healing disable <pattern>"); return true; }
    const { disableFix } = await import("../sha-tracker.js");
    const ok = disableFix(pattern);
    await ctx.reply(ok ? `✓ Disabled: "${pattern}"` : `❌ Pattern not found in self-rules.`);
    return true;
  }

  // Default: show status
  const status = ctx.selfHealerTask?.enabled ? "ON" : "OFF";
  await ctx.reply(`🩺 Self-healing: ${status}\nCommands: /healing [on|off|list|reset|approve|disable]`);
  return true;
}

export async function handleFull(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") { await ctx.reply("📺 Full mode is only available on Telegram."); return true; }
  const { spin } = await import("../spin.js");
  const s = spin.getSessionById(ctx.sessionKey);
  if (s) s.fullMode = true;
  await ctx.reply("📺 Full mode — sending raw output, TTS disabled.");
  return true;
}

export async function handleShort(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") { await ctx.reply("✂️ Short mode is only available on Telegram."); return true; }
  const { spin } = await import("../spin.js");
  const s = spin.getSessionById(ctx.sessionKey);
  if (s) s.fullMode = false;
  await ctx.reply("✂️ Short mode — clean responses, TTS enabled.");
  return true;
}

async function buildStatusLines(ctx: CommandContext): Promise<string[]> {
  let version = "?";
  let buildInfo = "";
  try {
    const pkgPath = join(import.meta.dirname, "..", "..", "..", "package.json");
    version = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
  } catch (err) { logAndSwallow("command_handlers", "op", err); }
  try {
    const biPath = join(import.meta.dirname, "..", "..", "build-info.json");
    const bi = JSON.parse(readFileSync(biPath, "utf-8")) as { hash: string; date: string };
    buildInfo = ` (${bi.hash} ${bi.date.slice(0, 10)})`;
  } catch (err) { logAndSwallow("command_handlers", "op", err); }

  let model = "unknown";
  if ("currentModel" in ctx.transport) {
    model = (ctx.transport as unknown as { currentModel: string }).currentModel;
  } else {
    const { loadTransport, resolveAgent } = await import("../transport-config.js");
    const tc = loadTransport();
    const prof = tc ? resolveAgent("professor", tc) : null;
    model = prof?.model ?? "unknown";
  }

  const transportStatus = ctx.transport.isReady ? "✓ Connected" : "❌ Disconnected";
  const uptime = formatUptime(Date.now() - ctx.startedAt);
  const ctxPct = ctx.transport.contextPercent >= 0
    ? `${ctx.transport.contextPercent}%`
    : "n/a";
  const { getHeartbeatInstance } = await import("../heartbeat-system.js");
  const hb = getHeartbeatInstance();

  // Transport details from transport.json
  const { loadTransport: lt, resolveAgent: ra } = await import("../transport-config.js");
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
  if (hb) {
    const mins = Math.round(hb.intervalMs / 60000);
    lines.push(
      `💓 Heartbeat: ${hb.isRunning ? "running" : "stopped"} (${mins}min)`,
    );
    if (ctx.loadedCapabilities?.length) {
      lines.push(`🔌 Capabilities: ${ctx.loadedCapabilities.join(", ")}`);
    }
    // Last sleep audit from filesystem
    try {
      const { readdirSync } = await import("node:fs");
      const sleepDir = join(homedir(), ".abmind", "memory", "sleep");
      const files = readdirSync(sleepDir).filter((f: string) => f.startsWith("sleep_")).sort();
      lines.push(`😴 Last sleep: ${files.length > 0 ? files[files.length - 1] : "(never)"}`);
    } catch { lines.push("😴 Last sleep: (unknown)"); }    const sp = ctx.sleepProgress?.();
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

// ── /usage command ──────────────────────────────────────────────────────────

export async function handleUsage(_text: string, ctx: CommandContext): Promise<boolean> {
  const { readUsage, resetUsage } = await import("../usage-tracker.js");
  const { loadModels } = await import("../transport-config.js");

  const arg = _text.replace("/usage", "").trim();

  if (arg === "reset") {
    resetUsage();
    await ctx.reply("✓ Usage stats reset.");
    return true;
  }

  const models = loadModels();
  const costTable = new Map<string, { input: number; output: number }>();
  for (const [id, entry] of Object.entries(models)) {
    costTable.set(id, entry.cost);
  }

  const now = Date.now();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfDayBefore = startOfYesterday - 86_400_000;

  const today = readUsage(startOfToday, costTable);
  const yesterday = readUsage(startOfYesterday, costTable);
  const dayBefore = readUsage(startOfDayBefore, costTable);
  const week = readUsage(now - 7 * 86_400_000, costTable);
  const month = readUsage(now - 30 * 86_400_000, costTable);

  // Subtract to get single-day values
  const yIn = yesterday.inputTokens - today.inputTokens;
  const yOut = yesterday.outputTokens - today.outputTokens;
  const yCost = yesterday.cost - today.cost;
  const dbIn = dayBefore.inputTokens - yesterday.inputTokens;
  const dbOut = dayBefore.outputTokens - yesterday.outputTokens;
  const dbCost = dayBefore.cost - yesterday.cost;

  const fmt = (n: number): string => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const fmtCost = (c: number): string => c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`;

  let msg = `📊 Token usage\n\n`;
  msg += `Today:      ${fmt(today.inputTokens)} / ${fmt(today.outputTokens)} — ${fmtCost(today.cost)}\n`;
  msg += `Yesterday:  ${fmt(yIn)} / ${fmt(yOut)} — ${fmtCost(yCost)}\n`;
  msg += `Day before: ${fmt(dbIn)} / ${fmt(dbOut)} — ${fmtCost(dbCost)}\n`;
  msg += `Last 7d:    ${fmt(week.inputTokens)} / ${fmt(week.outputTokens)} — ${fmtCost(week.cost)}\n`;
  msg += `Last 30d:   ${fmt(month.inputTokens)} / ${fmt(month.outputTokens)} — ${fmtCost(month.cost)}\n`;

  if (arg === "detail") {
    msg += `\n📋 Today by model:\n`;
    for (const [model, stats] of today.byModel) {
      msg += `  ${model}: ${fmt(stats.in)}/${fmt(stats.out)} — ${fmtCost(stats.cost)}\n`;
    }
  }

  // OpenRouter credits
  const { fetchOpenRouterCredits } = await import("../openrouter-credits.js");
  const credits = await fetchOpenRouterCredits();
  if (credits) {
    msg += `\n💳 OpenRouter: $${credits.remaining.toFixed(2)} remaining ($${credits.purchased.toFixed(2)} purchased, $${credits.used.toFixed(2)} used)`;
  }

  // Budget status
  const { getBudgetStatus } = await import("../budget.js");
  const budgetItems = getBudgetStatus();
  if (budgetItems.length > 0) {
    msg += `\n\n📋 Budget (today):`;
    for (const { agent, used, limit } of budgetItems) {
      const tokStr = limit.tokens ? `${Math.round(used.tokens / 1000)}K/${limit.tokens}K` : "unlimited";
      const callStr = limit.calls ? `${used.calls}/${limit.calls}` : "unlimited";
      msg += `\n  ${agent}: ${tokStr} tokens, ${callStr} calls`;
    }
  }

  await ctx.reply(msg.trim());
  return true;
}

// ── /openrouter command ─────────────────────────────────────────────────────

export async function handleOpenRouter(_text: string, ctx: CommandContext): Promise<boolean> {
  const { fetchOpenRouterCredits } = await import("../openrouter-credits.js");
  const credits = await fetchOpenRouterCredits();
  if (!credits) {
    await ctx.reply("❌ OpenRouter API key not set or request failed.");
    return true;
  }
  await ctx.reply(
    `💳 OpenRouter credits\n\nPurchased: $${credits.purchased.toFixed(2)}\nUsed:      $${credits.used.toFixed(2)}\nRemaining: $${credits.remaining.toFixed(2)}`,
  );
  return true;
}

// ── /whoami command ─────────────────────────────────────────────────────────

export async function handleWhoami(_text: string, ctx: CommandContext): Promise<boolean> {
  const { loadUsers } = await import("../user-registry.js");
  const reg = loadUsers();
  const CLASS_NAMES = ["UNCLASSIFIED", "RESTRICTED", "CONFIDENTIAL", "SECRET"];
  const user = ctx.userId ? reg.byUserId.get(ctx.userId) : undefined;
  if (user) {
    const clearance = CLASS_NAMES[user.maxClass] ?? `class ${user.maxClass}`;
    await ctx.reply(`${user.displayName ?? user.userId} (${user.role})\nClearance: ${clearance}\nchatId: ${ctx.chatId}`);
  } else {
    await ctx.reply(`${ctx.userId ?? "unknown"} (unregistered)\nchatId: ${ctx.chatId}`);
  }
  return true;
}

export async function handleSoftware(_text: string, ctx: CommandContext): Promise<boolean> {
  const { existsSync } = await import("node:fs");
  const { abtarsHome } = await import("../../paths.js");
  const home = abtarsHome();
  const arg = _text.replace(/^\/(software|update)\s*/i, "").trim();

  // Master-only gate for destructive subcommands
  const { loadUsers } = await import("../user-registry.js");
  const user = loadUsers().byUserId.get(ctx.userId);
  const isMaster = user?.role === "master";

  // /software rollback <version|slot>
  if (arg.startsWith("rollback")) {
    if (!isMaster) { await ctx.reply("❌ Requires master role."); return true; }
    const targetVersion = arg.replace(/^rollback\s*/, "").trim();
    if (!targetVersion) {
      await ctx.reply("Usage: /software rollback <slot 1-3>\nUse /software to see available versions.");
      return true;
    }

    const asSlot = parseInt(targetVersion);
    if (!(asSlot >= 1 && asSlot <= 3) || String(asSlot) !== targetVersion) {
      await ctx.reply(`❌ Invalid slot: ${targetVersion}. Use 1, 2, or 3.`);
      return true;
    }

    await ctx.reply(`⚠️ Rolling back to slot ${asSlot}...`);
    try {
      const { rollback } = await import("../../cli/commands/rollback.js");
      const code = await rollback({ to: asSlot });
      if (code !== 0) {
        await ctx.reply(`❌ Rollback failed (exit ${code}).`);
      }
    } catch (err) {
      await ctx.reply(`❌ Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // /update dev | alpha | stable
  if (arg === "update" || arg === "update dev" || arg === "dev" ||
      arg === "update git" || arg === "git" ||
      arg === "update alpha" || arg === "alpha" ||
      arg === "update stable" || arg === "stable" ||
      arg === "update deploy" || arg === "deploy" || arg === "update pull" || arg === "pull" || arg === "update build" || arg === "build") {
    // /update with no args → show usage
    if (arg === "update") {
      await ctx.reply("Usage: /update dev | alpha | stable");
      return true;
    }
    // dev + hidden aliases (git, pull, deploy, build)
    const channel = (arg === "dev" || arg === "update dev" || arg === "git" || arg === "update git" || arg === "update pull" || arg === "pull" || arg === "update deploy" || arg === "deploy" || arg === "update build" || arg === "build")
      ? "dev"
      : (arg === "alpha" || arg === "update alpha") ? "alpha" : "stable";

    if (!isMaster) { await ctx.reply("Requires master role."); return true; }

    if (channel === "dev") {
      const { spawn } = await import("node:child_process");
      const releasesRoot = join(process.env["HOME"] ?? "", ".abtars-releases", "src");
      const abtarsDir = join(releasesRoot, "abtars");
      const abmindDir = join(releasesRoot, "abmind");

      // Async helper — never blocks the event loop
      const execP = (cmd: string, args: string[], opts: { cwd?: string; timeout: number }): Promise<{ stdout: string; ok: boolean }> =>
        new Promise((resolve) => {
          const { spawn: sp } = require("node:child_process") as typeof import("node:child_process");
          let stdout = "";
          const proc = sp(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
          proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
          const timer = setTimeout(() => { proc.kill("SIGKILL"); resolve({ stdout, ok: false }); }, opts.timeout);
          proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout, ok: code === 0 }); });
          proc.on("error", () => { clearTimeout(timer); resolve({ stdout, ok: false }); });
        });

      const emergencyScript = join(abtarsDir, "scripts", "emergency-update.sh");

      // Show incoming commits (async, non-blocking)
      await ctx.reply("Checking for updates...");
      const fetchResult = await execP("git", ["-C", abtarsDir, "fetch", "origin", "dev"], { timeout: 30_000 });
      if (!fetchResult.ok) {
        await ctx.reply("git fetch timed out — running emergency update.");
        spawn("bash", [emergencyScript], { detached: true, stdio: "ignore" }).unref();
        return true;
      }

      const logResult = await execP("git", ["-C", abtarsDir, "log", "--oneline", "HEAD..origin/dev"], { timeout: 5_000 });
      const commits = logResult.stdout.trim();
      if (!commits) {
        await ctx.reply("Already up to date.");
        return true;
      }
      const lines = commits.split("\n");
      await ctx.reply(`${lines.length} new commit(s):\n${commits.slice(0, 300)}\n\nDeploying...`);
      logInfo("update", "git update requested");

      // Checkout + build (async, with timeout fallback)
      try {
        const co = await execP("git", ["-C", abtarsDir, "checkout", "origin/dev"], { timeout: 10_000 });
        if (!co.ok) throw new Error("checkout failed");

        if (existsSync(join(abmindDir, ".git"))) {
          await execP("git", ["-C", abmindDir, "fetch", "origin", "dev"], { timeout: 30_000 });
          await execP("git", ["-C", abmindDir, "checkout", "origin/dev"], { timeout: 10_000 });
        }

        const build = await execP("node", ["esbuild.config.js"], { cwd: abtarsDir, timeout: 60_000 });
        if (!build.ok) throw new Error("build failed");
      } catch {
        await ctx.reply("Build/checkout failed — running emergency update.");
        spawn("bash", [emergencyScript], { detached: true, stdio: "ignore" }).unref();
        return true;
      }

      // Deploy from fresh bundle (detached — survives bridge restart)
      const bundleCli = join(abtarsDir, "bundle", "abtars-cli.js");
      spawn("node", [bundleCli, "update", "--dev", abtarsDir], { detached: true, stdio: "ignore" }).unref();
    } else if (channel === "alpha") {
      await ctx.reply("Updating from npm (alpha)...");
      logInfo("update", "npm alpha update requested");
      const { spawn } = await import("node:child_process");
      const child = spawn("abtars", ["update", "--source", "npm", "--tag", "alpha"], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => { if (code !== 0 && code !== null) ctx.reply(`x Update failed (exit ${code}):\n${stderr.slice(-300)}`).catch(() => {}); });
    } else {
      await ctx.reply("Updating from npm (stable)...");
      logInfo("update", "npm stable update requested");
      const { spawn } = await import("node:child_process");
      const child = spawn("abtars", ["update", "--source", "npm"], { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("close", (code) => { if (code !== 0 && code !== null) ctx.reply(`x Update failed (exit ${code}):\n${stderr.slice(-300)}`).catch(() => {}); });
    }
    return true;
  }

  if ((arg as string) === "npm" || (arg as string) === "update npm") {
    // Legacy: /update npm → alpha
    if (!isMaster) { await ctx.reply("Requires master role."); return true; }
    logInfo("update", "npm alpha update (legacy /update npm)");
    await ctx.reply("Updating from npm (alpha)...");
    const { spawn } = await import("node:child_process");
    spawn("abtars", ["update", "--source", "npm", "--tag", "alpha"], { detached: true, stdio: "ignore" }).unref();
    return true;
  }

  // /software check — force-refresh npm registry
  if (arg === "check") {
    await ctx.reply("🔍 Checking npm registry...");
    try {
      const { spawnSync } = await import("node:child_process");
      const abtarsLatest = spawnSync("npm", ["view", "abtars", "dist-tags", "--json"], { encoding: "utf-8", timeout: 10_000 });
      const abmindLatest = spawnSync("npm", ["view", "abmind", "dist-tags", "--json"], { encoding: "utf-8", timeout: 10_000 });
      const abt = abtarsLatest.status === 0 ? JSON.parse(abtarsLatest.stdout) : null;
      const abm = abmindLatest.status === 0 ? JSON.parse(abmindLatest.stdout) : null;
      const lines = ["📦 npm registry (fresh):"];
      if (abt) lines.push(`  abtars: latest=${abt.latest ?? "?"} alpha=${abt.alpha ?? "?"}`);
      if (abm) lines.push(`  abmind: latest=${abm.latest ?? "?"} alpha=${abm.alpha ?? "?"}`);
      if (!abt && !abm) lines.push("  ⚠️ npm unreachable");
      await ctx.reply(lines.join("\n"));
    } catch {
      await ctx.reply("❌ npm check failed (timeout or network error)");
    }
    return true;
  }

  // /software — show deployment info (default)
  const lines: string[] = ["🔧 Software"];

  // abtars block
  try {
    const { getDeployedVersion } = await import("../../paths.js");
    const ver = getDeployedVersion();
    const manifest = existsSync(join(home, "manifest.json"))
      ? JSON.parse(readFileSync(join(home, "manifest.json"), "utf-8"))
      : null;
    const deployed = manifest?.activatedAt ? new Date(manifest.activatedAt).toLocaleString() : "unknown";
    lines.push(`  abtars: ${ver.version}${ver.commit && !ver.version.includes(ver.commit) ? "-" + ver.commit : ""} (deployed ${deployed})`);
    if (manifest?.source) lines.push(`  source: ${manifest.source === "local" ? "local" : "npm"}`);
    try {
      const { execFileSync } = await import("node:child_process");
      const raw = execFileSync("npm", ["view", "abtars", "dist-tags", "--json"], { encoding: "utf-8", timeout: 5000 });
      const latest = JSON.parse(raw).alpha ?? JSON.parse(raw).latest;
      if (latest) lines.push(`  npm latest: abtars@${latest} ${latest === ver.version || ver.version.startsWith(latest) ? "✓" : "⚠️"}`);
    } catch { /* timeout or offline — skip */ }
  } catch {
    lines.push("  abtars: unknown");
  }

  // abmind block
  lines.push("");
  // Only show abmind if configured as memory provider (#1162)
  const { getEnv } = await import("../env-schema.js");
  const memoryProvider = getEnv().memory;
  if (memoryProvider === "abmind" || memoryProvider === "auto") {
  // Try deployed copy first (always up to date), fall back to ~/.abmind/manifest.json
  const abmindBundlePkg = join(home, "app", "bundle", "node_modules", "abmind", "package.json");
  const abmindAppPkg = join(home, "app", "node_modules", "abmind", "package.json");
  const { abmindHome: resolveAbmind } = await import("../../paths.js");
  const abmHome = resolveAbmind();
  const abmindManifest = join(abmHome, "manifest.json");
  const abmindPkgPath = existsSync(abmindBundlePkg) ? abmindBundlePkg : existsSync(abmindAppPkg) ? abmindAppPkg : null;
  if (abmindPkgPath) {
    try {
      const pkg = JSON.parse(readFileSync(abmindPkgPath, "utf-8"));
      const manifest = existsSync(abmindManifest) ? JSON.parse(readFileSync(abmindManifest, "utf-8")) : null;
      const deployed = manifest?.activatedAt ? new Date(manifest.activatedAt).toLocaleString() : "unknown";
      lines.push(`  abmind: ${pkg.version ?? "?"} (deployed ${deployed})`);
      lines.push(`  source: local`);
      try {
        const { execFileSync } = await import("node:child_process");
        const raw = execFileSync("npm", ["view", "abmind", "dist-tags", "--json"], { encoding: "utf-8", timeout: 5000 });
        const latest = JSON.parse(raw).alpha ?? JSON.parse(raw).latest;
        if (latest) lines.push(`  npm latest: abmind@${latest} ${latest === pkg.version || pkg.version.startsWith(latest) ? "✓" : "⚠️"}`);
      } catch { /* timeout or offline — skip */ }
    } catch { lines.push("  abmind: installed (version unknown)"); }
  } else if (existsSync(abmindManifest)) {
    try {
      const m = JSON.parse(readFileSync(abmindManifest, "utf-8"));
      const deployed = m.activatedAt ? new Date(m.activatedAt).toLocaleString() : "unknown";
      lines.push(`  abmind: ${m.version ?? "?"} (deployed ${deployed})`);
      lines.push(`  source: npm`);
      try {
        const { execFileSync } = await import("node:child_process");
        const raw = execFileSync("npm", ["view", "abmind", "dist-tags", "--json"], { encoding: "utf-8", timeout: 5000 });
        const latest = JSON.parse(raw).alpha ?? JSON.parse(raw).latest;
        if (latest) lines.push(`  npm latest: abmind@${latest} ${latest === m.version || m.version.startsWith(latest) ? "✓" : "⚠️"}`);
      } catch { /* timeout or offline — skip */ }
    } catch { lines.push("  abmind: installed (version unknown)"); }
  } else {
    lines.push("  abmind: not installed");
  }
  } // end memoryProvider gate

  // Rollback slots
  lines.push("");
  lines.push("  Rollback:");
  try {
    const { resolve } = await import("node:path");
    const { homedir } = await import("node:os");
    const historyPath = resolve(homedir(), ".abtars-releases", "history.json");
    const history: string[] = JSON.parse(readFileSync(historyPath, "utf-8"));
    const prev = history.slice(1, 4); // skip current (index 0)
    for (let i = 0; i < 3; i++) {
      lines.push(`    ${i + 1}: ${prev[i] ?? "(empty)"}`);
    }
  } catch {
    for (let i = 1; i <= 3; i++) {
      const pkgPath = join(home, `app.prev.${i}`, "package.json");
      try {
        const ver = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
        lines.push(`    ${i}: ${ver}`);
      } catch {
        lines.push(`    ${i}: (empty)`);
      }
    }
  }

  // Deploy state (#878)
  try {
    const stateRaw = readFileSync(join(home, "deploy.state"), "utf-8");
    const ds = JSON.parse(stateRaw);
    if (ds.status === "running") {
      const ago = Math.round((Date.now() - new Date(ds.startedAt).getTime()) / 60_000);
      lines.push(`\n  🔄 Deploy in progress (${ago}min ago)`);
    } else if (ds.status === "failed") {
      lines.push(`\n  ❌ Last deploy failed: ${ds.error}\n     Log: ~/.abtars/logs/${ds.logFile}`);
    } else if (ds.status === "partial") {
      lines.push(`\n  ⚠️ Last deploy incomplete: missing ${ds.missing?.join(", ")}`);
    }
  } catch { /* no state file = normal */ }

  lines.push("");
  lines.push("  /update [dev|alpha|stable] | /software rollback <version>");
  await ctx.reply(lines.join("\n"));
  return true;
}

export async function handleRollback(text: string, ctx: CommandContext): Promise<boolean> {
  const arg = text.replace(/^\/rollback\s*/i, "").trim();
  const slot = parseInt(arg) || 1;
  if (slot < 1 || slot > 3) {
    await ctx.reply("Slot must be 1-3. Usage: /rollback 1");
    return true;
  }
  await ctx.reply(`Rolling back to slot ${slot}...`);
  const { rollback } = await import("../../cli/commands/rollback.js");
  const code = await rollback({ to: slot });
  await ctx.reply(code === 0 ? `+ Rolled back to slot ${slot}` : `x Rollback failed (code ${code})`);
  return true;
}

/** #832: /metrics — structured observability summary. */
export async function handleMetrics(_text: string, ctx: CommandContext): Promise<boolean> {
  const { getMetricsSummary } = await import("../metrics-collector.js");
  const s = getMetricsSummary();

  const lines: string[] = ["Metrics (recent window):"];

  // LLM
  const models = Object.entries(s.llm);
  if (models.length > 0) {
    lines.push("\nLLM latency:");
    for (const [model, m] of models) {
      lines.push(`  ${model}: p50=${m.p50}ms p95=${m.p95}ms max=${m.max}ms | ${m.calls} calls, ${m.failures} fails`);
    }
  } else { lines.push("\nLLM: no data yet"); }

  // Recall
  if (s.recall) {
    lines.push(`\nRecall: p50=${s.recall.p50}ms p95=${s.recall.p95}ms (${s.recall.calls} calls)`);
  }

  // Sleep
  if (s.sleep) {
    const rate = s.sleep.calls > 0 ? Math.round((1 - s.sleep.failures / s.sleep.calls) * 100) : 100;
    lines.push(`\nSleep: ${s.sleep.calls} runs, ${rate}% success`);
  }

  // Cron
  lines.push(`\nCron depth: avg=${s.cronDepth.avg} max=${s.cronDepth.max}`);

  await ctx.reply(lines.join("\n"));
  return true;
}
