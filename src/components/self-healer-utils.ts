/**
 * Shared healing utilities — called by service-registry during background retry.
 */
import { execFileSync } from "node:child_process";
import { logInfo } from "./logger.js";
import { logAndSwallow } from "./log-and-swallow.js";

const TAG = "self-healer";

/**
 * #1589: bounded quiet window after boot for unknown-fault SHA dispatch.
 * Replaces the former `bridge.lock.bootType === "darkwake"` gate, which was
 * written once per process and therefore never expired.
 */
export const BOOT_QUIET_MS = 5 * 60 * 1000;

/** True while `now` is inside the post-boot quiet window. Fails open on bad input. */
export function isWithinBootQuietWindow(startedAt: unknown, now: number): boolean {
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return false;
  if (startedAt > now) return false;   // clock skew: never suppress on a future boot
  return now - startedAt < BOOT_QUIET_MS;
}

/** Kill the process holding a port. Returns true if killed, false if nothing found. */
export function healPort(port: number): boolean {
  try {
    const cmd = process.platform === "darwin" ? "lsof" : "fuser";
    const args = process.platform === "darwin" ? ["-ti", `:${port}`] : [`${port}/tcp`];
    const out = execFileSync(cmd, args, { encoding: "utf-8", timeout: 5000 }).trim();
    if (!out) return false;
    const pids = out.split(/\s+/).map(Number).filter(p => p > 0 && p !== process.pid);
    if (pids.length === 0) return false;
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch (err) { logAndSwallow(TAG, "kill pid", err); }
    }
    logInfo(TAG, `healPort(${port}): killed PID ${pids.join(", ")}`);
    return true;
  } catch (err) {
    logAndSwallow(TAG, "healPort", err);
    return false;
  }
}
