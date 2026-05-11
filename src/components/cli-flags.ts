/**
 * Parse CLI platform flags from process.argv (or a provided array).
 *
 * --all   → telegram + discord + web (NOT irc)
 * --irc   → IRC adapter (always opt-in, never in --all)
 * --web   → web dashboard only
 * --agent → agent API for external agents (e.g. Molty)
 * Individual flags can be combined: --telegram --discord --irc --web --agent
 *
 * Also parses --acp / --tmux to override transport (default: acp).
 *
 * When NO flags are provided, auto-detects from config presence:
 * - TELEGRAM_BOT_TOKEN in env → Telegram
 * - DISCORD_TOKEN in env → Discord
 * - irc.json exists → IRC
 * - ENABLE_DASHBOARD=true → Dashboard
 * - ENABLE_AGENT_API=true → Agent API
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; irc: boolean; web: boolean; agent: boolean; transport?: "tmux" | "acp" | "api" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;

  // Legacy CLI flags still work (backward compat during transition)
  if (argv.includes("--all") || argv.includes("--telegram") || argv.includes("--discord") || argv.includes("--irc") || argv.includes("--web") || argv.includes("--agent")) {
    const web = argv.includes("--web") || argv.includes("--all");
    const agent = argv.includes("--agent");
    const irc = argv.includes("--irc");
    if (argv.includes("--all")) return { telegram: true, discord: true, irc, web, agent, transport };
    const hasTelegram = argv.includes("--telegram");
    const hasDiscord = argv.includes("--discord");
    if (!hasTelegram && !hasDiscord) return { telegram: true, discord: false, irc, web, agent, transport };
    return { telegram: hasTelegram, discord: hasDiscord, irc, web, agent, transport };
  }

  // Auto-detect from config presence
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
  const configDir = join(home, "config");

  const telegram = !!process.env["TELEGRAM_BOT_TOKEN"];
  const discord = !!process.env["DISCORD_TOKEN"];
  const irc = existsSync(join(configDir, "irc.json"));
  const web = process.env["ENABLE_DASHBOARD"] === "true";
  const agent = process.env["ENABLE_AGENT_API"] === "true";

  return { telegram, discord, irc, web, agent, transport };
}
