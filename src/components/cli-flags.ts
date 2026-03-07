/**
 * Parse CLI platform flags from process.argv (or a provided array).
 *
 * --all   → telegram + discord + web
 * --web   → web dashboard only
 * Individual flags can be combined: --telegram --discord --web
 *
 * Also parses --acp / --tmux to override transport (default: tmux).
 */
export function parsePlatformFlags(args?: string[]): { telegram: boolean; discord: boolean; web: boolean; transport?: "tmux" | "acp" } {
  const argv = args ?? process.argv.slice(2);
  const transport = argv.includes("--acp") ? "acp" as const : argv.includes("--tmux") ? "tmux" as const : undefined;
  const web = argv.includes("--web") || argv.includes("--all");
  if (argv.includes("--all")) return { telegram: true, discord: true, web, transport };
  const hasTelegram = argv.includes("--telegram");
  const hasDiscord = argv.includes("--discord");
  if (!hasTelegram && !hasDiscord) return { telegram: true, discord: false, web, transport };
  return { telegram: hasTelegram, discord: hasDiscord, web, transport };
}
