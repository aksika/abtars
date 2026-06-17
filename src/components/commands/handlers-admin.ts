import { execAsync } from "./exec-async.js";
import { logAndSwallow } from "../log-and-swallow.js";
import type { CommandContext } from "./types.js";

const TAG = "cmd_admin";


export async function handleUsers(text: string, ctx: CommandContext): Promise<boolean> {
  const { loadUsers } = await import("../user-registry.js");
  const parts = text.trim().split(/\s+/);
  const sub = parts[1];

  if (sub === "approve" && parts[2]) {
    const platformId = parts[2];
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { abtarsHome } = await import("../../paths.js");
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
      await ctx.reply(`✓ Approved guest: ${guestId} (platform ID: ${platformId})`);
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

  if (sub === "revoke" && parts[2]) {
    const targetUserId = parts[2];
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { abtarsHome } = await import("../../paths.js");
    const configPath = join(abtarsHome(), "config", "users.json");
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      const users = (Array.isArray(raw.users) ? raw.users : []).filter((u: { userId: string }) => u.userId !== targetUserId);
      writeFileSync(configPath, JSON.stringify({ users }, null, 2), "utf-8");
      await ctx.reply(`✓ Revoked: ${targetUserId}`);
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

export async function handleSkills(text: string, ctx: CommandContext): Promise<boolean> {
  if (text.includes("reload")) {
    const { reloadCatalog } = await import("../../capabilities/hotskills/index.js");
    const count = reloadCatalog();
    await ctx.reply(`Reloaded — ${count} skills available.`);
    return true;
  }
  const { getSkillCache } = await import("../../capabilities/hotskills/index.js");
  const skills = getSkillCache();
  if (skills.length === 0) { await ctx.reply("📚 No skills loaded."); return true; }

  const active = skills.filter(s => !s.skipped);
  const skipped = skills.filter(s => s.skipped);
  const groups = new Map<string, Array<typeof skills[number]>>();
  for (const s of skills) {
    const list = groups.get(s.group) ?? [];
    list.push(s);
    groups.set(s.group, list);
  }

  const header = `📚 Skills: ${active.length} active${skipped.length ? `, ${skipped.length} skipped` : ""}`;
  const sections: string[] = [];
  for (const [group, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const lines = items.map(s => s.skipped ? `  ✗ ${s.name} (${s.skipped})` : `  ✓ ${s.name}`);
    sections.push(`${group} (${items.length}):\n${lines.join("\n")}`);
  }

  await ctx.reply(`${header}\n\n${sections.join("\n\n")}`);
  return true;
}

export async function handleHooks(_text: string, ctx: CommandContext): Promise<boolean> {
  const { getHookSummary } = await import("../hooks/hook-system.js");
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

export async function handleMcp(_text: string, ctx: CommandContext): Promise<boolean> {
  const arg = _text.replace(/^\/mcp\s*/i, "").trim().toLowerCase();

  // /mcp start — master only, start daemon manually
  if (arg === "start") {
    const { loadUsers } = await import("../user-registry.js");
    const registry = loadUsers();
    const user = registry.byUserId.get(ctx.userId);
    if (user?.role !== "master") { await ctx.reply("❌ /mcp start is master-only."); return true; }
    const result = await execAsync("mcporter", ["daemon", "start"], 10_000);
    await ctx.reply(result ? `📦 mcporter daemon started.\n${result}` : "📦 mcporter daemon start failed.");
    return true;
  }

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
      const data = JSON.parse(raw) as { servers?: Array<{ name?: string; status?: string; tools?: unknown; prompts?: number; error?: string }> };
      const servers = data.servers ?? [];
      const ok = servers.filter(s => s.status === "ok").length;
      const lines = [
        "📦 MCP status",
        `  mcporter: installed (${version.split("\n")[0]})`,
        `  Servers: ${ok}/${servers.length} online`,
      ];
      for (const s of servers) {
        const mark = s.status === "ok" ? "✓" : "✗";
        const toolCount = Array.isArray(s.tools) ? s.tools.length : (s.tools ?? 0);
        const detail = s.status === "ok"
          ? `tools: ${toolCount}${s.prompts ? `, prompts: ${s.prompts}` : ""}`
          : (s.error ?? s.status ?? "error");
        lines.push(`    ${mark} ${s.name ?? "?"} (${detail})`);
      }
      body = lines.join("\n");
    } catch (err) {
      logAndSwallow(TAG, "JSON.parse mcp list", err);
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

// ── Local helpers (not exported) ────────────────────────────────────────────


export async function handleHelp(_text: string, ctx: CommandContext): Promise<boolean> {
  const cmds = [
    "/reset — Reload transport + fresh session",
    "/reset default — Restore transport.default.json + fresh session",
    "/compact — Compact context window (summarize + fresh session)",
    "/status — Operational health (PID, uptime, platforms, context)",
    "/software — Version info, deploy date, npm check, rollback",
    "/software update [pull|deploy] — Pull & build from git",
    "/software update npm — Update from npm registry",
    "/software rollback <version> — Roll back to previous version",
    "/update — Alias for /software update pull",
    "/model — Model configuration (provider, context, fallbacks)",
    "/model set <name> — Switch model",
    "/doctor — Deep probe all subsystems",
    "/doctor fix — Run safe auto-repairs",
    "/doctor fix-full — Full repair (+ FTS rebuild, WAL checkpoint)",
    "/mcp — MCP server status",
    "/hooks — List configured hooks",
    "/stop, /ctrlc — Stop current response",
    "/wait [msg] — Inject message mid-run (non-interrupting)",
    "/continue — Nudge model to continue after failure",
    "/usage — Token usage & cost this session",
    "/memory — Memory storage statistics",
    "/heartbeat — Heartbeat diagnostics (tasks, last tick)",
    "/models — Model, transport & agent status (legacy)",
    "/models change — Switch model/provider (any agent)",
    "/models quick <model> — Instant switch on same provider",
    "/emergency — 🚨 Activate paid hailMary model",
    "/tasks — Scheduled tasks",
    "/tasks log <id> — Last 5 runs for a task",
    "/task run <id> — Manually fire a task",
    "/task pause <id> — Pause / /task resume <id> — Resume",
    "/facts — Core knowledge (user profile + agent notes)",
    "/skills — List active/skipped skills",
    "/session — List sessions",
    "/session new [browse|code|task] — New session",
    "/session <#> — Switch / /session end [#] — End / /session kill <#> — Kill",
    "/nlm — Knowledge base (list/create/sources/query)",
    "/restart — Restart bridge",
    "/wakeup — Wake Mac from sleep",
    "/sleep — Sleep status / /sleep resume / /sleep now",
    "/whoami — Your user info & clearance",
    "/reasoning — Reasoning effort (low/medium/high/none) + show/hide thinking",
    "/kanban — Kanban board",
  ];
  if (ctx.platform === "telegram") {
    cmds.push("/full — Raw output, TTS disabled", "/short — Clean responses (default)", "/healing — Toggle self-healer on/off");
  }
  cmds.push("/help — Show this help");
  await ctx.reply(`📋 Available commands:\n\n${cmds.join("\n")}`);
  return true;
}

export async function handlePeers(_text: string, ctx: CommandContext): Promise<boolean> {
  const { getPeerTable } = await import("../peer-transport/gossip.js");
  const peers = getPeerTable(true);
  if (peers.length === 0) {
    await ctx.reply("No peers configured or gossip not started.");
    return true;
  }
  const now = Date.now();
  const lines = peers
    .sort((a, b) => (a.alive === b.alive ? a.name.localeCompare(b.name) : a.alive ? -1 : 1))
    .map(p => {
      const age = Math.round((now - p.lastSeen) / 1000);
      const ageStr = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}min ago`;
      const icon = p.alive ? "🟢" : "🔴";
      const caps = p.capabilities.length ? ` [${p.capabilities.join(", ")}]` : "";
      return `${icon} **${p.name}** (${ageStr}) — load ${p.load}${caps}`;
    });
  const alive = peers.filter(p => p.alive).length;
  lines.push(`\n${peers.length} peer(s) (${alive} alive, ${peers.length - alive} dead)`);
  await ctx.reply(lines.join("\n"));
  return true;
}
