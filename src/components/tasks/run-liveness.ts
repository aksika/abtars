/**
 * run-liveness.ts — #1601: run ownership liveness.
 *
 * A run's owner is live only if the pid exists AND its start time matches what
 * we recorded. pid alone is unsafe under pid reuse. When liveness cannot be
 * determined, report live — inability to prove death must never rewrite
 * durable state.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** True when a process with this pid exists (kill(pid, 0) probe). */
export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Process start time as a comparison token. Linux: /proc/<pid>/stat field 22
 * (starttime in clock ticks since boot — stable per process, different after
 * pid reuse). macOS: `ps -o lstart` parsed to epoch seconds. Returns null
 * when the platform cannot be probed — the caller must treat null as
 * unprovable, never as dead.
 */
export function processStartTime(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // After the closing paren of comm, rest[0] is field 3 (state); field 22
    // (starttime, in clock ticks since boot) is rest[19].
    const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const field22 = rest[19];
    if (field22 !== undefined) {
      const ticks = Number(field22);
      if (Number.isFinite(ticks)) return ticks;
    }
  } catch {
    /* not Linux — fall through to ps */
  }
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 3000 }).trim();
    const epoch = Date.parse(out);
    if (Number.isFinite(epoch)) return Math.floor(epoch / 1000);
  } catch {
    /* unprovable */
  }
  return null;
}

/** The current process's own start-time token, recorded at reservation. */
export function currentProcessStartTime(): number | null {
  return processStartTime(process.pid);
}

/**
 * #1601: a run's owner is live only if the pid exists AND its start time
 * matches what we recorded. Unprovable (null startedAt, or a platform that
 * cannot report start times) reports LIVE — fail safe.
 */
export function ownerIsLive(pid: number, startedAt: number | null): boolean {
  if (!pidExists(pid)) return false;
  if (startedAt === null) return true;
  const current = processStartTime(pid);
  if (current === null) return true;
  return current === startedAt;
}
