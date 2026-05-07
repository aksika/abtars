/**
 * guardrails.ts — path + command restrictions for SECURITY_MODE=guardrails.
 * Defense-in-depth: catches accidental/confused model behavior, NOT adversarial bypass.
 */

import { resolve, sep } from "node:path";
import { homedir } from "node:os";
import { getEnv } from "./env-schema.js";
import { logWarn } from "./logger.js";

const TAG = "guardrails";
const HOME = homedir();

const BLOCKED_PATHS = [
  `${HOME}/.ssh${sep}`,
  `${HOME}/.abtars/secret${sep}`,
  `/etc${sep}`,
  `/proc${sep}`,
  `/sys${sep}`,
  `/dev${sep}`,
  `/root${sep}`,
  `/run${sep}`,
];

const WRITE_BLOCKED = [
  `${HOME}/.abtars/config/peers.json`,
  `${HOME}/.kiro${sep}`,
];

const BLOCKED_COMMAND_PREFIXES = [
  "sudo ",
  "npm publish",
  "git push ",
  "chmod 777",
  "rm -rf /",
];

export type SecurityMode = "off" | "guardrails" | "sandbox";

export function getSecurityMode(): SecurityMode {
  const mode = getEnv().securityMode as SecurityMode;
  return mode || "off";
}

export function isGuardrailsActive(): boolean {
  return getSecurityMode() !== "off";
}

/** Check if a file path is allowed. Returns error message or null if OK. */
export function checkPath(path: string, mode: "read" | "write"): string | null {
  if (!isGuardrailsActive()) return null;

  const resolved = resolve(path) + (path.endsWith("/") ? sep : "");

  for (const blocked of BLOCKED_PATHS) {
    if (resolved.startsWith(blocked) || resolved === blocked.slice(0, -1)) {
      return `Path blocked by guardrails: ${path}`;
    }
  }

  if (mode === "write") {
    for (const wb of WRITE_BLOCKED) {
      if (resolved.startsWith(wb) || resolved === wb) {
        return `Write blocked by guardrails: ${path}`;
      }
    }
  }

  return null;
}

/** Check if a bash command is allowed. Returns error message or null if OK. */
export function checkCommand(cmd: string): string | null {
  if (!isGuardrailsActive()) return null;

  const trimmed = cmd.trim().toLowerCase();

  for (const prefix of BLOCKED_COMMAND_PREFIXES) {
    if (trimmed.startsWith(prefix.toLowerCase())) {
      logWarn(TAG, `Blocked command: ${cmd.slice(0, 100)}`);
      return `Command blocked by guardrails: matches '${prefix.trim()}'`;
    }
  }

  return null;
}
