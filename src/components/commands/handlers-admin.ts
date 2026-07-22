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
  // #1141: /skill run <name>, /skill stop, /skill list (runnable)
  const args = text.replace(/^\/skills?\s*/, "").trim();
  if (args.startsWith("run ")) {
    const skillName = args.slice(4).trim();
    if (!skillName) { await ctx.reply("Usage: /skill run <name>"); return true; }
    const { launchSkill } = await import("../skill-session.js");
    const err = await launchSkill(skillName, ctx.userId, String(ctx.chatId));
    await ctx.reply(err ?? `* Skill "${skillName}" started.`);
    return true;
  }
  if (args === "stop") {
    const { endSkillSession } = await import("../skill-session.js");
    const ended = await endSkillSession(String(ctx.chatId));
    await ctx.reply(ended ? "* Skill session ended." : "No active skill session.");
    return true;
  }
  if (args === "list") {
    const { listRunnableSkills } = await import("../skill-session.js");
    const skills = listRunnableSkills();
    if (skills.length === 0) { await ctx.reply("No runnable skills (no skill.json found)."); return true; }
    const lines = skills.map(s => `  ${s.interactive ? "~" : "*"} ${s.name}${s.description ? ` — ${s.description}` : ""}`);
    await ctx.reply(`Runnable skills:\n${lines.join("\n")}\n\nUse: /skill run <name>`);
    return true;
  }

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
    "/software rollback <version|slot> — Roll back to previous version or slot (1-3)",
    "/update — Alias for /software update pull",
    "/update abmind — Update abmind from dev (pull + build + install)",
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
    "/emergency — Emergency execution unavailable until #1468 (global ACP hailMary config)",
    "/tasks — Scheduled tasks",
    "/tasks log <id> — Last 5 runs for a task",
    "/task run <id> — Manually fire a task",
    "/task pause <id> — Pause / /task resume <id> — Resume",
    "/todo — Todo list",
    "/facts — Core knowledge (user profile + agent notes)",
    "/skills — List active/skipped skills",
    "/session — List sessions",
    "/session new [browse|code|task] — New session",
    "/session <#> — Switch / /session end [#] — End / /session kill <#> — Kill",
    "/nlm — Knowledge base (list/create/sources/query)",
    "/restart — Restart bridge",
    "/sleep — Sleep status / /sleep resume / /sleep now",
    "/whoami — Your user info & clearance",
    "/effort (alias /thinking) — Reasoning effort (off/low/medium/high/xhigh) + show/hide thinking",
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
  const { loadPeerConfig } = await import("../peer-config.js");
  const config = loadPeerConfig();
  const peerNames = Object.keys(config.peers);
  if (peerNames.length === 0) {
    await ctx.reply("No peers configured.");
    return true;
  }
  const { getPeerWsBroker } = await import("../peer-transport/peer-ws-broker.js");
  const broker = getPeerWsBroker();
  const connected = broker.getConnectedPeers();
  const lines = peerNames.map(n => {
    const entry = config.peers[n];
    const isConnected = connected.includes(n);
    const icon = isConnected ? "🟢" : "🔴";
    const host = entry?.host ?? "?";
    const port = entry?.port ?? 0;
    return `${icon} **${n}** — ${host}:${port}${isConnected ? "" : " (disconnected)"}`;
  });
  const alive = connected.length;
  lines.push(`\n${peerNames.length} peer(s) (${alive} connected, ${peerNames.length - alive} disconnected)`);
  await ctx.reply(lines.join("\n"));
  return true;
}
