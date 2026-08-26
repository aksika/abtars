/**
 * Runtime values consumed by the interactive `abtars tui` client.
 *
 * Pi 0.84 removed the runtime `TUI` constructor; `TUI` survives only as a
 * TypeScript interface. The concrete main-screen renderer is `TuiMainScreen`
 * and is required here so a pre-0.84 installation fails before `TUI.start()`.
 */
export const REQUIRED_PI_TUI_EXPORTS = [
  "ProcessTerminal", "TuiMainScreen", "Container", "Editor", "Text", "Markdown", "Loader", "matchesKey",
] as const;

export const REQUIRED_PI_CODING_AGENT_EXPORTS = [
  "initTheme", "getMarkdownTheme", "getSelectListTheme",
  "UserMessageComponent", "AssistantMessageComponent", "DynamicBorder",
] as const;

export function missingRuntimeExports(
  module: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter(name => typeof module[name] !== "function");
}
