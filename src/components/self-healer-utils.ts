/**
 * Shared healing utilities — called by service-registry during background retry.
 */
import { execFileSync } from "node:child_process";
import { logInfo } from "./logger.js";

const TAG = "self-healer";

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
      try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
    }
    logInfo(TAG, `healPort(${port}): killed PID ${pids.join(", ")}`);
    return true;
  } catch {
    return false;
  }
}
