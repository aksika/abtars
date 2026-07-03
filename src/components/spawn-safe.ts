/**
 * spawn-safe.ts — fire-and-forget detached spawn with mandatory error handler (#1281).
 *
 * A spawn("binary") call with no .on("error") handler will emit an unhandled error event
 * when the binary is not found (ENOENT), which bubbles to uncaughtException and kills the
 * bridge. This helper makes the correct pattern the only pattern.
 */

import { spawn } from "node:child_process";
import { logWarn } from "./logger.js";

/**
 * Spawn a detached child process that the bridge does not need to track.
 * If the binary is not found (ENOENT) or spawn fails for any reason, logs a warning
 * and continues — never crashes the bridge.
 */
export function spawnDetached(cmd: string, args: string[], tag: string): void {
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", (err) => logWarn(tag, `spawn ${cmd} failed (non-fatal): ${err.message}`));
  child.unref();
}
