/**
 * Parse platform flags. Single source of truth: .env *_ENABLED vars.
 * CLI flags (--telegram, --discord, etc.) override for one-off testing only.
 * Transport override: --acp / --tmux.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function envBool(key: string): boolean | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; irc: boolean; web: boolean; agent: boolean; transport?: "tmux" | "acp" | "api" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;

  // CLI flags override env (one-off testing)
  if (argv.includes("--telegram") || argv.includes("--discord") || argv.includes("--irc") || argv.includes("--web") || argv.includes("--agent")) {
    return {
      telegram: argv.includes("--telegram"),
      discord: argv.includes("--discord"),
      irc: argv.includes("--irc"),
      web: argv.includes("--web"),
      agent: argv.includes("--agent"),
      transport,
    };
  }

  // .env is SSoT — *_ENABLED vars, fallback to token/config presence
  const home = process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars");
  const configDir = join(home, "config");

  const telegram = envBool("TELEGRAM_ENABLED") ?? !!process.env["TELEGRAM_BOT_TOKEN"];
  const discord = envBool("DISCORD_ENABLED") ?? !!process.env["DISCORD_TOKEN"];
  const irc = envBool("IRC_ENABLED") ?? existsSync(join(configDir, "irc.json"));
  const web = envBool("ENABLE_DASHBOARD") ?? false;
  const agent = envBool("ENABLE_AGENT_API") ?? false;

  return { telegram, discord, irc, web, agent, transport };
}
