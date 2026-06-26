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
  "rm -rf /",
];

const AUTH_REQUIRED_PATTERNS = [
  /\brm\s+(-[a-z]*f[a-z]*r|-[a-z]*r[a-z]*f)\b/i,
  /\bgit\s+(reset\s+--hard|push\s+--force|clean\s+-f|branch\s+-D)/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\bTRUNCATE\s/i,
  /\bkill\s+(-9|--signal\s+(KILL|9))/i,
  /\bsudo\b/,
  /\bchmod\s+777\b/,
  /\bDELETE\s+FROM\s+\w+\s*;/i,
];

export type CommandTier = "block" | "auth-required" | "allow";

/** Classify a command into block / auth-required / allow. */
export function classifyCommand(cmd: string): CommandTier {
  const trimmed = cmd.trim();
  for (const prefix of BLOCKED_COMMAND_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return "block";
  }
  for (const re of AUTH_REQUIRED_PATTERNS) {
    if (re.test(trimmed)) return "auth-required";
  }
  return "allow";
}

export type SecurityMode = "off" | "guardrails" | "seatbelt" | "docker";

export function getSecurityMode(): SecurityMode {
  const mode = getEnv().securityMode as SecurityMode;
  return mode || "off";
}

export function isGuardrailsActive(): boolean {
  return getSecurityMode() !== "off";
}

export function isSeatbeltActive(): boolean {
  const m = getSecurityMode();
  return m === "seatbelt" || m === "docker";
}

export function isDockerActive(): boolean {
  return getSecurityMode() === "docker";
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

  const tier = classifyCommand(cmd);
  if (tier === "block") {
    logWarn(TAG, `Blocked command: ${cmd.slice(0, 100)}`);
    return `Command blocked by guardrails: ${cmd.slice(0, 60)}`;
  }
  // "auth-required" is handled by action-gate at a higher level — not blocked here
  return null;
}
