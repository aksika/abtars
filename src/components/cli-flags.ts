/**
 * Parse CLI platform flags from process.argv (or a provided array).
 *
 * --all   → telegram + discord + web
 * --web   → web dashboard only
 * --agent → agent API for external agents (e.g. Molty)
 * Individual flags can be combined: --telegram --discord --web --agent
 *
 * Also parses --acp / --tmux to override transport (default: acp).
 */
export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; web: boolean; agent: boolean; transport?: "tmux" | "acp" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;
  const web = argv.includes("--web") || argv.includes("--all");
  const agent = argv.includes("--agent");
  if (argv.includes("--all")) return { telegram: true, discord: true, web, agent, transport };
  const hasTelegram = argv.includes("--telegram");
  const hasDiscord = argv.includes("--discord");
  if (!hasTelegram && !hasDiscord) return { telegram: true, discord: false, web, agent, transport };
  return { telegram: hasTelegram, discord: hasDiscord, web, agent, transport };
}
