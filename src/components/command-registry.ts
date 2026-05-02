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
  { name: "new", description: "Fresh session (keeps mode)" },
  { name: "reset", description: "Fresh session + exit coding" },
  { name: "compact", description: "Compact context window" },
  { name: "status", description: "Bridge status" },
  { name: "doctor", description: "Deep healthcheck (probes all subsystems)" },
  { name: "mcp", description: "MCP server status" },
  { name: "hooks", description: "List configured hooks" },
  { name: "stop", description: "Stop current response" },
  { name: "models", description: "Model, transport & agents" },
  { name: "emergency", description: "Activate paid hailMary model" },
  { name: "heartbeat", description: "Heartbeat diagnostics" },
  { name: "memory", description: "Memory stats" },
  { name: "skills", description: "List skills" },
  { name: "tasks", description: "Scheduled tasks" },
  { name: "facts", description: "Core knowledge" },
  { name: "coding", description: "Switch to coding agent" },
  { name: "default", description: "Switch to default agent" },
  { name: "nlm", description: "Knowledge base" },
  { name: "restart", description: "Restart bridge" },
  { name: "wakeup", description: "Wake Mac from sleep" },
  { name: "sleep", description: "Sleep status / resume / now" },
  { name: "help", description: "Show all commands" },
];
