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
  { name: "status", description: "Bridge status" },
  { name: "doctor", description: "Deep healthcheck (probes all subsystems)" },
  { name: "mcp", description: "MCP server status" },
  { name: "hooks", description: "List configured hooks" },
  { name: "stop", description: "Stop current response" },
  { name: "wait", description: "Inject message mid-run (non-interrupting)" },
  { name: "models", description: "Model, transport & agents" },
  { name: "change", description: "Switch model/provider" },
  { name: "emergency", description: "Activate paid hailMary model" },
  { name: "heartbeat", description: "Heartbeat diagnostics" },
  { name: "memory", description: "Memory stats" },
  { name: "skills", description: "List skills" },
  { name: "skill", description: "Reload skills catalog" },
  { name: "tasks", description: "Scheduled tasks" },
  { name: "facts", description: "Core knowledge" },
  { name: "nlm", description: "Knowledge base" },
  { name: "restart", description: "Restart bridge" },
  { name: "wakeup", description: "Wake Mac from sleep" },
  { name: "sleep", description: "Sleep status / resume / now" },
  { name: "help", description: "Show all commands" },
];
