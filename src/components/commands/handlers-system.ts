import { execAsync } from "./exec-async.js";
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

  const { getDoctorReport, renderDoctorText } = await import("../doctor/index.js");
  const force = arg === "force";
  const svcStates = ctx.registry?.getStates() ?? {};
  await ctx.reply("🩺 Running diagnostics...");
  const report = await getDoctorReport({
    memory: ctx.memory,
    transport: ctx.transport,
    telegramRunning: svcStates.telegram?.running ?? false,
    discordRunning: svcStates.discord?.running ?? false,
    ircRunning: svcStates.irc?.running ?? false,
    phaseHealth: ctx.phaseHealth,
  }, { force });
  await ctx.reply(renderDoctorText(report));
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
  ctx.sessions.getOrCreate(ctx.sessionKey).busy = false;
  await ctx.reply("🛑 Ctrl+C sent.");
  logInfo(TAG, "Ctrl+C interrupt sent");
  return true;
}

export async function handleRestart(_text: string, ctx: CommandContext): Promise<boolean> {
  const arg = _text.replace(/^\/restart\s*/i, "").trim().toLowerCase();
  if (arg === "cold") {
    await ctx.reply("🧊 Cold restart (process exit → supervisor respawn)...");
    setTimeout(() => process.exit(0), 500);
    return true;
  }
  await ctx.reply("♻️ Restarting bridge...");
  setTimeout(() => ctx.requestShutdown?.(0), 500);
  return true;
}

export async function handleHeartbeat(_text: string, ctx: CommandContext): Promise<boolean> {
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
  ctx.sessions.getOrCreate(ctx.sessionKey).fullMode = true;
  await ctx.reply("📺 Full mode — sending raw output, TTS disabled.");
  return true;
}

export async function handleShort(_text: string, ctx: CommandContext): Promise<boolean> {
  if (ctx.platform !== "telegram") { await ctx.reply("✂️ Short mode is only available on Telegram."); return true; }
  ctx.sessions.getOrCreate(ctx.sessionKey).fullMode = false;
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
  const cronInfo = ctx.memory?.getCronInfo();

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

  // /software rollback <version>
  if (arg.startsWith("rollback")) {
    if (!isMaster) { await ctx.reply("❌ Requires master role."); return true; }
    const targetVersion = arg.replace(/^rollback\s*/, "").trim();
    if (!targetVersion) {
      await ctx.reply("Usage: /software rollback <version>\nUse /software to see available versions.");
      return true;
    }

    let targetSlot: number | null = null;
    for (let i = 1; i <= 3; i++) {
      const pkgPath = join(home, `app.prev.${i}`, "package.json");
      try {
        const ver = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
        if (ver === targetVersion) { targetSlot = i; break; }
      } catch { /* slot empty */ }
    }

    if (!targetSlot) {
      await ctx.reply(`❌ Version ${targetVersion} not found in rollback slots.`);
      return true;
    }

    await ctx.reply(`⚠️ Rolling back to ${targetVersion}...`);
    try {
      const { rollback } = await import("../../cli/commands/rollback.js");
      await rollback({ to: targetSlot });
    } catch (err) {
      await ctx.reply(`❌ Rollback failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  // /software update [deploy|pull]
  if (arg === "update" || arg === "update deploy" || arg === "deploy" || arg === "update build" || arg === "build" ||
      arg === "update pull" || arg === "pull" || arg === "") {
    // /update with no args → treat as /software (show info)
    if (arg === "" && _text.match(/^\/software\s*$/i)) {
      // Fall through to info display below
    } else if (arg === "update pull" || arg === "pull") {
      if (!isMaster) { await ctx.reply("Requires master role."); return true; }
      try {
        const { spawnSync } = await import("node:child_process");
        const { mkdirSync, rmSync: rms } = await import("node:fs");
        const srcDir = join(home, "src", "abtars");
        const abmindDir = join(home, "src", "abmind");
        logInfo("update", "Pull requested");

        const pullOrReclone = (dir: string, repo: string): { ok: boolean; msg: string } => {
          mkdirSync(join(home, "src"), { recursive: true });
          // Try fetch+reset if .git exists
          if (existsSync(join(dir, ".git"))) {
            spawnSync("git", ["-C", dir, "fetch", "origin", "dev"], { encoding: "utf-8", timeout: 30_000 });
            const r = spawnSync("git", ["-C", dir, "reset", "--hard", "origin/dev"], { encoding: "utf-8" });
            const hasConflicts = spawnSync("git", ["-C", dir, "grep", "-q", "^<<<<<<<"], { encoding: "utf-8" }).status === 0;
            if (r.status === 0 && !hasConflicts) {
              return { ok: true, msg: (r.stdout || "").trim().slice(0, 300) };
            }
            // Failed or conflicts — nuke and reclone
            logInfo("update", `${dir}: reset failed or conflicts — recloning`);
            rms(dir, { recursive: true, force: true });
          }
          // Clone fresh
          const cl = spawnSync("git", ["clone", "-b", "dev", repo, dir], { encoding: "utf-8", timeout: 60_000 });
          if (cl.status === 0) return { ok: true, msg: "cloned fresh" };
          return { ok: false, msg: (cl.stderr || "").trim().slice(0, 300) };
        };

        const abtarsResult = pullOrReclone(srcDir, "git@github.com:aksika/abtars.git");
        if (!abtarsResult.ok) { await ctx.reply(`Pull failed (abtars):\n${abtarsResult.msg}`); return true; }
        let pulled = `Pulled:\n${abtarsResult.msg}`;

        const abmindResult = pullOrReclone(abmindDir, "git@github.com:aksika/abmind.git");
        pulled += `\nabmind: ${abmindResult.msg}`;

        logInfo("update", `Pull complete`);
        await ctx.reply(`${pulled}\n\nReady to deploy: /update deploy`);
      } catch (err) {
        await ctx.reply(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    } else if (arg === "update deploy" || arg === "deploy" || arg === "update build" || arg === "build") {
      if (!isMaster) { await ctx.reply("Requires master role."); return true; }
      try {
        const { spawnSync, spawn } = await import("node:child_process");
        const srcDir = join(home, "src", "abtars");
        const abmindDir = join(home, "src", "abmind");
        if (!existsSync(join(srcDir, ".git"))) {
          await ctx.reply("No source repo. Run /update pull first.");
          return true;
        }
        // Guard: skip if already running this commit
        const { getDeployedVersion } = await import("../../paths.js");
        const head = spawnSync("git", ["-C", srcDir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout.trim();
        const running = getDeployedVersion();
        if (head && (running.version.includes(head) || running.commit === head)) {
          await ctx.reply(`Already running ${head}. Nothing to deploy.`);
          return true;
        }
        logInfo("update", `Deploy starting (non-blocking)`);
        // Pre-flight: check for merge conflict markers in source
        const markers = spawnSync("git", ["-C", srcDir, "grep", "-l", "^<<<<<<<"], { encoding: "utf-8", timeout: 10_000 });
        if (markers.stdout.trim()) {
          const files = markers.stdout.trim().split("\n").join(", ");
          await ctx.reply(`⚠️ Conflict markers found in source — refusing to deploy.\nFiles: ${files}\nRepo has a broken commit. Notify dev team.`);
          return true;
        }
        await ctx.reply("⚙️ Deploying (building in background)...");

        // Write deploy state (#878)
        const logFile = `deploy-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.log`;
        const { writeFileSync: wfs } = await import("node:fs");
        wfs(join(home, "deploy.state"), JSON.stringify({ status: "running", startedAt: new Date().toISOString(), logFile }) + "\n");

        // Spawn build-and-deploy.sh detached — bridge stays responsive (#871)
        const script = join(srcDir, "scripts", "build-and-deploy.sh");
        spawn("bash", [script, srcDir, abmindDir], {
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch (err) {
        await ctx.reply(`Deploy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    } else if ((arg as string) === "npm" || (arg as string) === "update npm") {
      if (!isMaster) { await ctx.reply("Requires master role."); return true; }
      logInfo("update", "npm update starting");
      await ctx.reply("Updating from npm...");
      const { spawn } = await import("node:child_process");
      spawn("abtars", ["update", "--source", "npm"], { detached: true, stdio: "ignore" }).unref();
      return true;
    }
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

  // Rollback slots
  lines.push("");
  lines.push("  Rollback:");
  for (let i = 1; i <= 3; i++) {
    const pkgPath = join(home, `app.prev.${i}`, "package.json");
    try {
      const ver = JSON.parse(readFileSync(pkgPath, "utf-8")).version;
      lines.push(`    ${i}: ${ver}`);
    } catch {
      lines.push(`    ${i}: (empty)`);
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
  lines.push("  /update [pull|deploy|npm] | /software rollback <version>");
  await ctx.reply(lines.join("\n"));
  return true;
}
