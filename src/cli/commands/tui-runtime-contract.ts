/** Runtime values consumed by the interactive `abtars tui` client. */
export const REQUIRED_PI_TUI_EXPORTS = [
  "ProcessTerminal", "TUI", "Container", "Editor", "Text", "Markdown", "Loader", "matchesKey",
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
