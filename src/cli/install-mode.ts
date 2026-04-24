/**
 * install-mode.ts — Read/write/infer deployment mode (simple vs supervised).
 * Mode is an install-time property stored in ~/.agentbridge/install-mode.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type InstallMode = "simple" | "supervised";

/** Read mode from file. Returns null if file doesn't exist. */
export function readInstallMode(abHome: string): InstallMode | null {
  const p = join(abHome, "install-mode");
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf-8").trim();
  if (raw === "simple" || raw === "supervised") return raw;
  return null;
}

/** Write mode to file. */
export function writeInstallMode(abHome: string, mode: InstallMode): void {
  writeFileSync(join(abHome, "install-mode"), mode + "\n");
}

/** Infer mode from existing artifacts. Presence of plist or systemd service → supervised. */
export function inferInstallMode(): InstallMode {
  const home = process.env["HOME"] ?? "";
  if (!home) return "simple";
  const hasPlist = existsSync(join(home, "Library", "LaunchAgents", "com.agentbridge.watchdog.plist"));
  const hasSystemd = existsSync(join(home, ".config", "systemd", "user", "agentbridge-watchdog.service"));
  return (hasPlist || hasSystemd) ? "supervised" : "simple";
}

/** Read mode, infer + write if missing. */
export function resolveInstallMode(abHome: string): InstallMode {
  const existing = readInstallMode(abHome);
  if (existing) return existing;
  const inferred = inferInstallMode();
  writeInstallMode(abHome, inferred);
  return inferred;
}
