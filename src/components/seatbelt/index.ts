/**
 * seatbelt/index.ts — Main entry point for OS-level per-command sandboxing.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildBwrapArgs } from "./bwrap-builder.js";
import { buildSeatbeltProfile } from "./seatbelt-builder.js";
import type { SeatbeltPolicy } from "./policy.js";

const platform = process.platform;

/** Check if OS sandbox tooling is available. */
export function isAvailable(): boolean {
  if (platform === "darwin") {
    return spawnSync("which", ["sandbox-exec"], { stdio: "pipe" }).status === 0;
  }
  return spawnSync("which", ["bwrap"], { stdio: "pipe" }).status === 0;
}

/** Returns the platform name for logging. */
export function mechanismName(): string {
  return platform === "darwin" ? "sandbox-exec" : "bwrap";
}

/**
 * Wrap a bash command with OS-level sandboxing.
 * Returns { command, args } ready for spawnSync.
 */
export function wrapCommand(command: string, policy: SeatbeltPolicy): { bin: string; args: string[] } {
  if (platform === "darwin") {
    // Write profile to temp file (sandbox-exec needs a file path)
    const profileDir = join(tmpdir(), "abtars-seatbelt");
    mkdirSync(profileDir, { recursive: true });
    const profilePath = join(profileDir, `profile-${process.pid}-${Date.now()}.sb`);
    const profile = buildSeatbeltProfile(policy);
    writeFileSync(profilePath, profile, "utf-8");

    return {
      bin: "sandbox-exec",
      args: ["-f", profilePath, "bash", "-c", command],
    };
  }

  // Linux: bwrap
  const args = buildBwrapArgs(command, policy);
  return { bin: "bwrap", args };
}

/** Clean up temp profile files (call periodically or on shutdown). */
export function cleanupProfiles(): void {
  if (platform !== "darwin") return;
  const profileDir = join(tmpdir(), "abtars-seatbelt");
  try { unlinkSync(profileDir); } catch { /* may not exist or not empty */ }
}

export { shouldSandbox, ALWAYS_GATE } from "./command-safety.js";
export { getPolicy } from "./policy.js";
export type { SeatbeltPolicy } from "./policy.js";
