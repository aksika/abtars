/**
 * command-registry.ts — Shared bot command definitions for all platforms.
 * Both Telegram (setMyCommands) and Discord (application commands) import from here.
 */

export interface BotCommand {
  readonly name: string;
  readonly description: string;
}

/** All registered bot commands. Discord requires: name ≤32 chars lowercase, description ≤100 chars. */
export const BOT_COMMANDS: readonly BotCommand[] = [
  { name: "reset", description: "Fresh session + exit coding" },
  { name: "session", description: "Session management" },
  { name: "compact", description: "Compact context window" },
  { name: "status", description: "Operational health (PID, platforms, context)" },
  { name: "software", description: "Version, deploy info, rollback" },
  { name: "model", description: "Model configuration & switching" },
  { name: "route", description: "Route selection (pi-ai | acp)" },
  { name: "doctor", description: "Deep healthcheck (probes all subsystems)" },
  { name: "health", description: "Deep healthcheck (alias for /doctor)" },
  { name: "mcp", description: "MCP server status" },
  { name: "hooks", description: "List configured hooks" },
  { name: "stop", description: "Stop current response" },
  { name: "wait", description: "Inject message mid-run (non-interrupting)" },
  { name: "update", description: "Update: git | alpha | stable" },
  { name: "emergency", description: "Select external ACP/tmux emergency route" },
  { name: "heartbeat", description: "Heartbeat diagnostics" },
  { name: "memory", description: "Memory stats" },
  { name: "skills", description: "List active skills" },
  { name: "skill", description: "List skills (reload: /skill reload)" },
  { name: "tasks", description: "Scheduled tasks" },
  { name: "todo", description: "Todo list" },
  { name: "facts", description: "Core knowledge" },
  { name: "nlm", description: "Knowledge base" },
  { name: "restart", description: "Restart bridge" },
  { name: "sleep", description: "Sleep status / resume / now" },
  { name: "whoami", description: "Your user info & clearance" },
  { name: "effort", description: "Reasoning effort (off/low/medium/high/xhigh) + show/hide" },
  { name: "usage", description: "Token usage & cost this session" },
  { name: "continue", description: "Nudge model to continue after failure" },
  { name: "kanban", description: "Kanban board" },
  { name: "help", description: "Show all commands" },
];
