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
 */
export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; irc: boolean; web: boolean; agent: boolean; transport?: "tmux" | "acp" | "api" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;
  const web = argv.includes("--web") || argv.includes("--all");
  const agent = argv.includes("--agent");
  const irc = argv.includes("--irc"); // Never in --all, always opt-in
  if (argv.includes("--all")) return { telegram: true, discord: true, irc, web, agent, transport };
  const hasTelegram = argv.includes("--telegram");
  const hasDiscord = argv.includes("--discord");
  if (!hasTelegram && !hasDiscord) return { telegram: true, discord: false, irc, web, agent, transport };
  return { telegram: hasTelegram, discord: hasDiscord, irc, web, agent, transport };
}
