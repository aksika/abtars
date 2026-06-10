/**
 * seatbelt/command-safety.ts — Determine if a command needs sandboxing.
 */

import { basename } from "node:path";

/** Commands that are safe ONLY when called with no arguments. */
const SAFE_NO_ARGS = new Set(["date", "pwd", "whoami", "hostname", "uname"]);

/** Shell operators that indicate piping, redirection, or chaining. */
const SHELL_OPERATORS = /[|;&><`$]/;

/** Destructive patterns that ALWAYS require ActionGate, even with seatbelt active. */
export const ALWAYS_GATE = /rm\s+-rf|git\s+push\s+--force|DROP\s+TABLE|TRUNCATE|chmod\s+777|mkfs|dd\s+if=/i;

/**
 * Returns true if the command should be wrapped in OS sandbox.
 * Only bare safe commands with no arguments bypass.
 */
export function shouldSandbox(command: string): boolean {
  if (SHELL_OPERATORS.test(command)) return true;
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return false;
  const name = basename(parts[0]!);
  if (!SAFE_NO_ARGS.has(name)) return true;
  return parts.length > 1; // has arguments → sandbox
}
