/**
 * Unified command handlers for all platforms (Telegram, Discord).
 * Split from the original monolithic command-handlers.ts.
 *
 * Built-in routes are installed from the canonical COMMAND_DEFINITIONS list —
 * no hand-written registrations, so dispatch, authorization, menus, and /help
 * cannot drift apart.
 */

export type { Reply, CommandContext, CommandHandler, Platform } from "./types.js";
export { registerCommand, handleCommand, triggerNewSession, triggerResetSession } from "./registry.js";
import { registerExact, registerPrefix } from "./registry.js";
import { COMMAND_DEFINITIONS } from "../command-registry.js";

for (const def of COMMAND_DEFINITIONS) {
  const options = { allowNonMaster: def.access === "all" };
  if (def.kind === "exact") {
    registerExact(def.match, def.handler, options);
  } else {
    registerPrefix(def.match, def.handler, options);
  }
}
