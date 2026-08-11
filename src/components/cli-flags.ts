/**
 * Parse platform flags. Single source of truth: .env *_ENABLED vars.
 * CLI flags (--telegram, --discord, etc.) override for one-off testing only.
 * Transport override: --acp / --tmux.
 */



function envBool(key: string): boolean | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return undefined;
  return v === "true" || v === "1";
}

export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; tui: boolean; web: boolean; agent: boolean; transport?: "tmux" | "acp" | "api" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;

  // CLI flags override env (one-off testing)
  if (argv.includes("--telegram") || argv.includes("--discord") || argv.includes("--tui") || argv.includes("--web") || argv.includes("--agent")) {
    return {
      telegram: argv.includes("--telegram"),
      discord: argv.includes("--discord"),
      tui: argv.includes("--tui"),
      web: argv.includes("--web"),
      agent: argv.includes("--agent"),
      transport,
    };
  }

  // .env is SSoT — *_ENABLED vars, fallback to token/config presence
  const telegram = envBool("TELEGRAM_ENABLED") ?? !!process.env["TELEGRAM_BOT_TOKEN"];
  const discord = envBool("DISCORD_ENABLED") ?? !!process.env["DISCORD_TOKEN"];
  // #1315, #1352: TUI is enabled by default. Set TUI_ENABLED=false to disable.
  const tui = envBool("TUI_ENABLED") ?? true;
  const web = envBool("ENABLE_DASHBOARD") ?? false;
  const agent = envBool("ENABLE_AGENT_API") ?? false;

  return { telegram, discord, tui, web, agent, transport };
}
