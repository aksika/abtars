/**
 * Format a reaction signal string for forwarding to the agent transport.
 * @param senderName - Display name of the user who reacted
 * @param emojis - Array of emoji characters that were added
 * @returns Formatted reaction signal string
 */
export function formatReactionSignal(senderName: string, emojis: string[]): string {
  return `[${senderName} reaction: ${emojis.join(" ")}]`;
}
