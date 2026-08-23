/**
 * command-registry.ts — Canonical built-in slash command registry.
 *
 * Single ordered source of truth for every built-in command: match pattern,
 * handler, description, access policy, platform visibility, and help text.
 * Dispatch (commands/index.ts), authorization (commands/registry.ts), the
 * platform menus, and /help are all projections of COMMAND_DEFINITIONS.
 *
 * Ordering: definitions follow the /help output order; prefix routes do not
 * shadow each other (verified — no match string is a prefix of a later one),
 * so the same order is safe for the first-match-wins router.
 *
 * This module must stay free of platform API calls, timers, filesystem reads,
 * and config access so it can be imported by any surface without side effects.
 */

import type { CommandHandler } from "./commands/types.js";
import {
  handleNewReset, handleCompact,
  handleStatus, handleDoctor, handleStop, handleWait, handleRestart,
  handleFull, handleShort, handleHealing, handleFacts,
  handleTasksList, handleTasksTrigger, handleTasksLog, handleTaskPause, handleTasksValidate, handleKanban,
  handleChannel, handleTodo, handleProjectUnquarantine,
  handleEmergencyAlias, handleModels, handleHeartbeat, handleEffort, handleThinking, handleContinue, handleRoute,
  handleMemory, handleNlm,
  handleSleep, handleSleepSub, handleHelp, handleSkills,
  handleHooks, handleMcp, handleUsers, handleUsage, handleOpenRouter, handleWhoami,
  handleSoftware, handleTribe, handleMetrics, handleOrc,
} from "./commands/handlers.js";
import { handleSession } from "./commands/session-handler.js";
import { handleCoding } from "./commands/handlers-coding.js";
import {
  handlePiRun, handlePiStatus, handlePiList, handlePiReply,
  handlePiSteer, handlePiCancel, handlePiResume, handlePiCompact,
} from "./commands/handlers-pi.js";

export type CommandPlatform = "telegram" | "discord";
export type CommandKind = "exact" | "prefix";
export type CommandVisibility = "public" | "alias" | "help-only" | "internal";
export type CommandAccess = "all" | "master";

export interface CommandDefinition {
  readonly name: string;                    // root, without `/`
  readonly match: string;                   // `/tasks` or `/tasks run `
  readonly description: string;             // platform-menu description
  readonly handler: CommandHandler;
  readonly kind: CommandKind;
  readonly visibility: CommandVisibility;
  readonly access: CommandAccess;
  readonly platforms?: readonly CommandPlatform[];
  readonly help?: readonly string[];        // detailed `/help` lines
}

export interface BotCommand {
  readonly name: string;
  readonly description: string;
}

/**
 * Visibility semantics:
 * - public:    platform menu plus a help line (explicit help or `/${name} — ${description}`)
 * - alias:     platform menu, help only when explicit help lines are supplied
 * - help-only: help only (routed subcommands / documented roots with no bare platform command)
 * - internal:  dispatch only, never surfaced in menus or help
 */
export const COMMAND_DEFINITIONS: readonly CommandDefinition[] = [
  // ── Core session / transport ──────────────────────────────────────────────
  {
    name: "reset", match: "/reset", description: "Fresh session + exit coding",
    handler: handleNewReset, kind: "exact", visibility: "public", access: "all",
    help: [
      "/reset — Reload transport + fresh session",
      "/reset default — Restore transport.default.json + fresh session",
    ],
  },
  {
    name: "compact", match: "/compact", description: "Compact context window",
    handler: handleCompact, kind: "exact", visibility: "public", access: "master",
    help: ["/compact — Compact context window (summarize + fresh session)"],
  },
  {
    name: "status", match: "/status", description: "Operational health (PID, platforms, context)",
    handler: handleStatus, kind: "exact", visibility: "public", access: "all",
    help: ["/status — Operational health (PID, uptime, platforms, context)"],
  },

  // ── Software / update ─────────────────────────────────────────────────────
  {
    name: "software", match: "/software", description: "Version, deploy info, rollback",
    handler: handleSoftware, kind: "exact", visibility: "public", access: "all",
    help: [
      "/software — Version info, deploy date, npm check, rollback",
      "/software update [pull|deploy] — Pull & build from git",
      "/software update npm — Update from npm registry",
      "/software rollback <version|slot> — Roll back to previous version or slot (1-3)",
    ],
  },
  {
    name: "update", match: "/update", description: "Update: git | alpha | stable",
    handler: handleSoftware, kind: "exact", visibility: "public", access: "all",
    help: [
      "/update — Alias for /software update pull",
      "/update abmind — Update abmind from dev (pull + build + install)",
    ],
  },

  // ── Model / routing ───────────────────────────────────────────────────────
  {
    name: "model", match: "/model", description: "Model configuration & switching",
    handler: handleModels, kind: "exact", visibility: "public", access: "all",
    help: [
      "/model — Model configuration (provider, context, fallbacks)",
      "/model set <name> — Switch model",
    ],
  },

  // ── Diagnostics / admin ───────────────────────────────────────────────────
  {
    name: "doctor", match: "/doctor", description: "Deep healthcheck (probes all subsystems)",
    handler: handleDoctor, kind: "exact", visibility: "public", access: "all",
    help: [
      "/doctor — Deep probe all subsystems",
      "/doctor fix — Run safe auto-repairs",
      "/doctor fix-full — Full repair (+ FTS rebuild, WAL checkpoint)",
    ],
  },
  {
    name: "health", match: "/health", description: "Deep healthcheck (alias for /doctor)",
    handler: handleDoctor, kind: "exact", visibility: "alias", access: "master",
  },
  {
    name: "mcp", match: "/mcp", description: "MCP server status",
    handler: handleMcp, kind: "exact", visibility: "public", access: "master",
    help: ["/mcp — MCP server status"],
  },
  {
    name: "hooks", match: "/hooks", description: "List configured hooks",
    handler: handleHooks, kind: "exact", visibility: "public", access: "all",
    help: ["/hooks — List configured hooks"],
  },

  // ── Stop / wait / continue ────────────────────────────────────────────────
  {
    name: "stop", match: "/stop", description: "Stop current response",
    handler: handleStop, kind: "exact", visibility: "public", access: "all",
    help: ["/stop, /ctrlc — Stop current response"],
  },
  {
    name: "ctrlc", match: "/ctrlc", description: "Stop current response (alias for /stop)",
    handler: handleStop, kind: "exact", visibility: "help-only", access: "all",
  },
  {
    name: "wait", match: "/wait", description: "Inject message mid-run (non-interrupting)",
    handler: handleWait, kind: "exact", visibility: "public", access: "master",
    help: ["/wait [msg] — Inject message mid-run (non-interrupting)"],
  },
  {
    name: "steer", match: "/steer", description: "Inject message mid-run (alias for /wait)",
    handler: handleWait, kind: "exact", visibility: "help-only", access: "master",
  },
  {
    name: "continue", match: "/continue", description: "Nudge model to continue after failure",
    handler: handleContinue, kind: "exact", visibility: "public", access: "master",
    help: ["/continue — Nudge model to continue after failure"],
  },

  // ── Usage / memory / heartbeat / emergency ────────────────────────────────
  {
    name: "usage", match: "/usage", description: "Token usage & cost this session",
    handler: handleUsage, kind: "exact", visibility: "public", access: "all",
    help: ["/usage — Token usage & cost this session"],
  },
  {
    name: "usage", match: "/usage ", description: "Token usage for a run",
    handler: handleUsage, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "memory", match: "/memory", description: "Memory stats",
    handler: handleMemory, kind: "exact", visibility: "public", access: "all",
    help: ["/memory — Memory storage statistics"],
  },
  {
    name: "heartbeat", match: "/heartbeat", description: "Heartbeat diagnostics",
    handler: handleHeartbeat, kind: "exact", visibility: "public", access: "all",
    help: ["/heartbeat — Heartbeat diagnostics (tasks, last tick)"],
  },

  // ── Model aliases / routing (help-only and alias surfaces) ────────────────
  {
    name: "models", match: "/models", description: "Model, transport & agent status",
    handler: handleModels, kind: "exact", visibility: "help-only", access: "all",
    help: [
      "/models — Model, transport & agent status (legacy)",
      "/models change — Switch model/provider (any agent)",
      "/models quick <model> — Instant switch on same provider",
    ],
  },
  {
    name: "change", match: "/change", description: "Switch model",
    handler: (_, ctx) => handleModels("/model change", ctx), kind: "exact",
    visibility: "internal", access: "master",
  },
  {
    name: "route", match: "/route", description: "Route selection (pi-ai | acp)",
    handler: handleRoute, kind: "exact", visibility: "alias", access: "master",
  },
  {
    name: "emergency", match: "/emergency", description: "Emergency fast path (ACP hailMary)",
    handler: handleEmergencyAlias, kind: "exact", visibility: "public", access: "master",
    help: ["/emergency — Activate emergency fast path (ACP hailMary); /model restore to exit"],
  },

  // ── Tasks / todo / facts / skills ─────────────────────────────────────────
  {
    name: "tasks", match: "/tasks", description: "Scheduled tasks",
    handler: handleTasksList, kind: "exact", visibility: "public", access: "all",
    help: ["/tasks — Scheduled tasks"],
  },
  {
    name: "tasks", match: "/tasks log ", description: "Last 5 runs for a task",
    handler: handleTasksLog, kind: "prefix", visibility: "help-only", access: "all",
    help: ["/tasks log <id> — Last 5 runs for a task"],
  },
  {
    name: "tasks", match: "/tasks run ", description: "Run a scheduled task",
    handler: handleTasksTrigger, kind: "prefix", visibility: "help-only", access: "all",
    help: ["/task run <id> — Manually fire a task"],
  },
  {
    name: "task", match: "/task run ", description: "Run a scheduled task",
    handler: handleTasksTrigger, kind: "prefix", visibility: "help-only", access: "all",
  },
  {
    name: "task", match: "/task pause ", description: "Pause a task",
    handler: handleTaskPause, kind: "prefix", visibility: "help-only", access: "all",
    help: ["/task pause <id> — Pause / /task resume <id> — Resume"],
  },
  {
    name: "task", match: "/task resume ", description: "Resume a task",
    handler: handleTaskPause, kind: "prefix", visibility: "help-only", access: "all",
    help: ["/task pause <id> — Pause / /task resume <id> — Resume"],
  },
  {
    name: "task", match: "/task log ", description: "Task run log",
    handler: handleTasksLog, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "tasks", match: "/tasks pause ", description: "Pause a task",
    handler: handleTaskPause, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "tasks", match: "/tasks resume ", description: "Resume a task",
    handler: handleTaskPause, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "task", match: "/task validate", description: "Dry-run validation of the live task registry",
    handler: handleTasksValidate, kind: "prefix", visibility: "help-only", access: "all",
    help: ["/task validate — Dry-run validation of the live task registry"],
  },
  {
    name: "tasks", match: "/tasks validate", description: "Dry-run validation of the live task registry",
    handler: handleTasksValidate, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "task", match: "/task", description: "Scheduled tasks (alias for /tasks)",
    handler: handleTasksList, kind: "exact", visibility: "help-only", access: "all",
  },
  {
    name: "todo", match: "/todo", description: "Todo list",
    handler: handleTodo, kind: "exact", visibility: "public", access: "master",
    help: ["/todo — Todo list"],
  },
  {
    name: "facts", match: "/facts", description: "Core knowledge",
    handler: handleFacts, kind: "exact", visibility: "public", access: "all",
    help: ["/facts — Core knowledge (user profile + agent notes)"],
  },
  {
    name: "skills", match: "/skills", description: "List active skills",
    handler: handleSkills, kind: "exact", visibility: "public", access: "all",
    help: ["/skills — List active/skipped skills"],
  },
  {
    name: "skill", match: "/skill", description: "List skills (reload: /skill reload)",
    handler: handleSkills, kind: "exact", visibility: "alias", access: "all",
  },

  // ── Sessions / knowledge / sleep ──────────────────────────────────────────
  {
    name: "session", match: "/session", description: "Session management",
    handler: handleSession, kind: "exact", visibility: "public", access: "all",
    help: [
      "/session — List sessions",
      "/session new [browse|code|task] — New session",
      "/session <#> — Switch / /session end [#] — End / /session kill <#> — Kill",
    ],
  },
  {
    name: "session", match: "/session ", description: "Session subcommands",
    handler: handleSession, kind: "prefix", visibility: "help-only", access: "all",
  },
  {
    name: "nlm", match: "/nlm", description: "Knowledge base",
    handler: handleNlm, kind: "exact", visibility: "public", access: "master",
    help: ["/nlm — Knowledge base (list/create/sources/query)"],
  },
  {
    name: "nlm", match: "/nlm", description: "Knowledge base query",
    handler: handleNlm, kind: "prefix", visibility: "internal", access: "master",
  },
  {
    name: "restart", match: "/restart", description: "Restart bridge",
    handler: handleRestart, kind: "exact", visibility: "public", access: "master",
    help: ["/restart — Restart bridge"],
  },
  {
    name: "sleep", match: "/sleep", description: "Sleep status / resume / now",
    handler: handleSleep, kind: "exact", visibility: "public", access: "master",
    help: ["/sleep — Sleep status / /sleep resume / /sleep now"],
  },
  {
    name: "sleep", match: "/sleep ", description: "Sleep subcommands",
    handler: handleSleepSub, kind: "prefix", visibility: "internal", access: "master",
  },

  // ── User-facing controls ──────────────────────────────────────────────────
  {
    name: "whoami", match: "/whoami", description: "Your user info & clearance",
    handler: handleWhoami, kind: "exact", visibility: "public", access: "all",
    help: ["/whoami — Your user info & clearance"],
  },
  {
    name: "effort", match: "/effort", description: "Reasoning effort (off/low/medium/high/xhigh)",
    handler: handleEffort, kind: "exact", visibility: "public", access: "master",
    help: ["/effort — Reasoning effort (off/low/medium/high/xhigh)"],
  },
  {
    name: "thinking", match: "/thinking", description: "Show/hide model reasoning (show/hide)",
    handler: handleThinking, kind: "exact", visibility: "public", access: "master",
    help: ["/thinking show|hide — Show or hide model reasoning in chat"],
  },
  {
    name: "kanban", match: "/kanban", description: "Kanban board",
    handler: handleKanban, kind: "exact", visibility: "public", access: "all",
    help: [
      "/kanban — Kanban board",
      "/kanban nuke — Reset the Kanban database on next bridge start (owner-only)",
    ],
  },
  {
    name: "kanban", match: "/kanban ", description: "Kanban subcommands",
    handler: handleKanban, kind: "prefix", visibility: "internal", access: "all",
  },
  {
    name: "project", match: "/project", description: "Project operations (unquarantine)",
    handler: handleProjectUnquarantine, kind: "exact", visibility: "public", access: "master",
    help: ["/project unquarantine <id> — Clear reconcile quarantine for a project"],
  },
  {
    name: "project", match: "/project unquarantine ", description: "Clear reconcile quarantine",
    handler: handleProjectUnquarantine, kind: "prefix", visibility: "help-only", access: "master",
  },
  {
    name: "tribe", match: "/tribe", description: "Peer status (Orc + enrolled peers)",
    handler: handleTribe, kind: "exact", visibility: "public", access: "master",
    help: ["/tribe — Peer status (Orc + enrolled peers)"],
  },
  {
    name: "orc", match: "/orc", description: "Orc fuse status and reset",
    handler: handleOrc, kind: "exact", visibility: "public", access: "master",
    help: [
      "/orc — Orc circuit-breaker status (fuses, limits, window counts)",
      "/orc limits — Configured fuse limits",
      "/orc reset project <card-id> — Clear one card's fuse/counters",
      "/orc reset bridge — Clear the bridge-wide emergency fuse",
      "/orc alerts status | test | mute <minutes>",
    ],
  },
  {
    name: "orc", match: "/orc ", description: "Orc subcommands",
    handler: handleOrc, kind: "prefix", visibility: "internal", access: "master",
  },

  // ── Pi coding runs ────────────────────────────────────────────────────────
  {
    name: "pi", match: "/pi run ", description: "Start a Pi coding run",
    handler: handlePiRun, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi run --workspace <alias> <goal> — Start a Pi coding run"],
  },
  {
    name: "pi", match: "/pi status ", description: "Pi run status",
    handler: handlePiStatus, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi status <runId> — Pi run status"],
  },
  {
    name: "pi", match: "/pi steer ", description: "Steer a Pi run",
    handler: handlePiSteer, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi steer <runId> <text> — Steer a Pi run"],
  },
  {
    name: "pi", match: "/pi compact ", description: "Native Pi compaction of a coding run",
    handler: handlePiCompact, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi compact <runId> [instructions] — Native Pi compaction of a coding run"],
  },
  {
    name: "pi", match: "/pi cancel ", description: "Cancel a Pi run",
    handler: handlePiCancel, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi cancel <runId> — Cancel a Pi run"],
  },
  {
    name: "pi", match: "/pi resume ", description: "Resume a Pi run",
    handler: handlePiResume, kind: "prefix", visibility: "help-only", access: "master",
    help: ["/pi resume <runId> — Resume a Pi run"],
  },
  {
    name: "pi", match: "/pi get ", description: "Pi run status (alias)",
    handler: handlePiStatus, kind: "prefix", visibility: "internal", access: "master",
  },
  {
    name: "pi", match: "/pi list", description: "List Pi runs",
    handler: handlePiList, kind: "prefix", visibility: "internal", access: "master",
  },
  {
    name: "pi", match: "/pi reply ", description: "Reply to a Pi run",
    handler: handlePiReply, kind: "prefix", visibility: "internal", access: "master",
  },

  // ── Interactive coding ────────────────────────────────────────────────────
  {
    name: "coding", match: "/coding", description: "Interactive Pi coding session",
    handler: handleCoding, kind: "exact", visibility: "public", access: "all",
    help: [
      "/coding — Interactive Pi coding session (resume most recent)",
      "/coding new <alias> — New interactive coding session",
      "/coding status — List coding sessions",
      "/coding off — Leave coding mode",
      "/coding end — End coding session (transcript preserved)",
    ],
  },
  {
    name: "coding", match: "/coding ", description: "Coding subcommands",
    handler: handleCoding, kind: "prefix", visibility: "help-only", access: "all",
  },

  // ── Internal-only routes (dispatch, no menu/help surface) ─────────────────
  {
    name: "channel", match: "/channel", description: "Channel routing",
    handler: handleChannel, kind: "exact", visibility: "internal", access: "master",
  },
  {
    name: "channel", match: "/channel ", description: "Channel subcommands",
    handler: handleChannel, kind: "prefix", visibility: "internal", access: "master",
  },
  {
    name: "users", match: "/users", description: "User management",
    handler: handleUsers, kind: "exact", visibility: "internal", access: "master",
  },
  {
    name: "metrics", match: "/metrics", description: "Metrics",
    handler: handleMetrics, kind: "exact", visibility: "internal", access: "master",
  },
  {
    name: "openrouter", match: "/openrouter", description: "OpenRouter provider status",
    handler: handleOpenRouter, kind: "exact", visibility: "internal", access: "all",
  },

  // ── Telegram-only surfaces ────────────────────────────────────────────────
  {
    name: "full", match: "/full", description: "Raw output, TTS disabled",
    handler: handleFull, kind: "exact", visibility: "public", access: "master",
    platforms: ["telegram"],
    help: ["/full — Raw output, TTS disabled"],
  },
  {
    name: "short", match: "/short", description: "Clean responses (default)",
    handler: handleShort, kind: "exact", visibility: "public", access: "master",
    platforms: ["telegram"],
    help: ["/short — Clean responses (default)"],
  },
  {
    name: "healing", match: "/healing", description: "Self-healing status (read-only)",
    handler: handleHealing, kind: "exact", visibility: "public", access: "master",
    platforms: ["telegram"],
    help: ["/healing — Self-healing mode, policy and active incidents (read-only)"],
  },
  {
    name: "healing", match: "/healing ", description: "Healing subcommands (list|reset|approve|disable)",
    handler: handleHealing, kind: "prefix", visibility: "internal", access: "master",
    platforms: ["telegram"],
  },

  // ── Help ──────────────────────────────────────────────────────────────────
  {
    name: "help", match: "/help", description: "Show all commands",
    handler: handleHelp, kind: "exact", visibility: "public", access: "all",
    help: ["/help — Show this help"],
  },
];

function platformAllowed(def: CommandDefinition, platform: string): boolean {
  return !def.platforms || def.platforms.includes(platform as CommandPlatform);
}

/** Visible platform-menu commands: first bare-root entry per name, in definition order. */
export function getPlatformCommands(platform: string): BotCommand[] {
  const seen = new Set<string>();
  const out: BotCommand[] = [];
  for (const def of COMMAND_DEFINITIONS) {
    if (def.visibility !== "public" && def.visibility !== "alias") continue;
    if (!platformAllowed(def, platform)) continue;
    if (def.kind !== "exact" || def.match !== `/${def.name}`) continue;
    if (seen.has(def.name)) continue;
    seen.add(def.name);
    out.push({ name: def.name, description: def.description });
  }
  return out;
}

/** Derived `/help` lines for a platform, in definition order, deduplicated. */
export function getHelpEntries(platform: string): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const def of COMMAND_DEFINITIONS) {
    if (def.visibility === "internal") continue;
    if (!platformAllowed(def, platform)) continue;
    if (def.visibility === "alias" && !def.help) continue;
    const candidates = def.help ?? (def.visibility === "public" ? [`/${def.name} — ${def.description}`] : []);
    for (const line of candidates) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines;
}
