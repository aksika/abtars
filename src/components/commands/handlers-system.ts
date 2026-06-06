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
  if (!ctx.selfHealerTask) { await ctx.reply("🩺 Self-healer not available."); return true; }
  const arg = text.replace(/^\/healing\s*/, "").trim().toLowerCase();
  if (arg === "on") {
    ctx.selfHealerTask.enabled = true;
  } else if (arg === "off") {
    ctx.selfHealerTask.enabled = false;
  } else if (arg === "reset") {
    ctx.selfHealerTask.resetCircuitBreaker?.();
    await ctx.reply("🩺 Circuit breaker reset — all paused rules re-enabled.");
    return true;
  }
  const status = ctx.selfHealerTask.enabled ? "ON" : "OFF";
  const paused = ctx.selfHealerTask.pausedRules?.() ?? 0;
  const pausedText = paused > 0 ? ` (${paused} rule${paused > 1 ? "s" : ""} paused)` : "";
  await ctx.reply(`🩺 Self-healing: ${status}${pausedText}`);
  if (arg === "on" || arg === "off") logInfo(TAG, `Self-healer ${status} by user`);
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
    await ctx.reply(`${user.displayName ?? user.userId} (${user.role}, ${clearance} clearance)`);
  } else {
    await ctx.reply(`${ctx.userId ?? "unknown"} (unregistered)`);
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
        const { mkdirSync } = await import("node:fs");
        const srcDir = join(home, "src", "abtars");
        const abmindDir = join(home, "src", "abmind");
        logInfo("update", "Pull requested");
        if (!existsSync(join(srcDir, ".git"))) {
          await ctx.reply("Cloning abtars repo...");
          mkdirSync(join(home, "src"), { recursive: true });
          const cl = spawnSync("git", ["clone", "git@github.com:aksika/abtars.git", srcDir], { encoding: "utf-8", timeout: 60_000 });
          if (cl.status !== 0) { logInfo("update", "Clone failed"); await ctx.reply(`Clone failed:\n${(cl.stderr || "").trim().slice(0, 300)}`); return true; }
        }
        const r = spawnSync("git", ["-C", srcDir, "pull", "--ff-only", "origin", "dev"], { encoding: "utf-8", timeout: 30_000 });
        if (r.status !== 0) { logInfo("update", `Pull failed (abtars): ${(r.stderr || "").slice(0, 100)}`); await ctx.reply(`Pull failed (abtars):\n${(r.stderr || "").trim().slice(0, 300)}`); return true; }
        let pulled = (r.stdout || "").trim().slice(0, 300);
        // Pull + build abmind
        if (existsSync(join(abmindDir, ".git"))) {
          const ab = spawnSync("git", ["-C", abmindDir, "pull", "--ff-only", "origin", "dev"], { encoding: "utf-8", timeout: 30_000 });
          if (ab.status !== 0) { logInfo("update", `Pull failed (abmind): ${(ab.stderr || "").slice(0, 100)}`); await ctx.reply(`Pull failed (abmind):\n${(ab.stderr || "").trim().slice(0, 300)}`); return true; }
          const abBuild = spawnSync("npm", ["run", "build"], { cwd: abmindDir, encoding: "utf-8", timeout: 60_000 });
          if (abBuild.status !== 0) { logInfo("update", `abmind build failed`); await ctx.reply(`abmind build failed:\n${(abBuild.stderr || abBuild.stdout || "").slice(0, 300)}`); return true; }
          pulled += `\nabmind: ${(ab.stdout || "").trim().slice(0, 200)}`;
        }
        logInfo("update", `Pull complete: ${pulled.slice(0, 100)}`);
        await ctx.reply(`Pulled:\n${pulled}`);
      } catch (err) {
        await ctx.reply(`Pull failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    } else if (arg === "update" || arg === "update deploy" || arg === "deploy" || arg === "update build" || arg === "build") {
      if (!isMaster) { await ctx.reply("Requires master role."); return true; }
      try {
        const { spawnSync } = await import("node:child_process");
        const { readFileSync } = await import("node:fs");
        const srcDir = join(home, "src", "abtars");
        // Guard: reject if source matches deployed commit
        const head = spawnSync("git", ["-C", srcDir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout.trim();
        const manifestPath = join(home, "install-manifest.json");
        const deployed = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf-8")).commit : "";
        if (head && head === deployed) {
          logInfo("update", `Build rejected — already running ${head}`);
          await ctx.reply("Already running this version. Run /update pull first.");
          return true;
        }
        logInfo("update", `Build starting: ${deployed} → ${head}`);
        await ctx.reply("Building...");
        const script = join(srcDir, "scripts", "build-and-deploy.sh");
        spawnSync("bash", [script], { encoding: "utf-8", timeout: 120_000 });
        // Bridge restarts as part of the script — this line likely never reached
      } catch (err) {
        await ctx.reply(`Build failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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

  // abtars version
  try {
    const pkg = JSON.parse(readFileSync(join(home, "app", "package.json"), "utf-8"));
    const manifest = existsSync(join(home, "manifest.json"))
      ? JSON.parse(readFileSync(join(home, "manifest.json"), "utf-8"))
      : null;
    const deployed = manifest?.activatedAt ? new Date(manifest.activatedAt).toLocaleString() : "unknown";
    lines.push(`  abtars: ${pkg.version} (deployed ${deployed})`);
    if (manifest?.repoRoot) lines.push(`  source: local (${manifest.repoRoot})`);
    else lines.push(`  source: npm`);
  } catch {
    lines.push("  abtars: unknown");
  }

  // abmind version
  const abmindHome = process.env["ABMIND_HOME"] ?? join(home, "..", ".abmind");
  const abmindManifest = join(abmindHome, "manifest.json");
  if (existsSync(abmindManifest)) {
    try {
      const m = JSON.parse(readFileSync(abmindManifest, "utf-8"));
      const deployed = m.activatedAt ? new Date(m.activatedAt).toLocaleString() : "unknown";
      lines.push(`  abmind: ${m.version ?? "?"} (deployed ${deployed})`);
    } catch { lines.push("  abmind: installed (version unknown)"); }
  }

  // npm latest (cached from update-check)
  try {
    const { checkForUpdate } = await import("../update-check.js");
    const abtResult = checkForUpdate("abtars", "0.0.0"); // force return latest
    if (abtResult?.latest) lines.push(`  npm latest: abtars@${abtResult.latest}`);
  } catch { /* no cached data */ }

  // Rollback slots
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

  lines.push("");
  lines.push("  /software update [pull] [deploy] | rollback");
  await ctx.reply(lines.join("\n"));
  return true;
}
