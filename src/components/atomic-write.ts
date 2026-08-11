import { writeFileSync, renameSync, openSync, fchmodSync, fsyncSync, closeSync, unlinkSync, lstatSync } from "node:fs";

import { logWarn } from "./logger.js";

const TAG = "atomic-write";

/**
 * #1632: a live atomic write completes in milliseconds, so its temp file is
 * always fresh. Anything older than this is a temp file orphaned by a killed
 * process. The margin over a millisecond-scale operation is deliberate — a
 * write blocked this long has larger problems than a stale-orphan heuristic.
 */
const ORPHAN_TMP_STALE_MS = 30_000;

/** Atomic write: .tmp → fsync → rename. Crash-safe on POSIX.
 *  Default mode 0600 matches the runtime umask (077) so owner-only files
 *  stay owner-only even when the umask was widened before boot. */
export function atomicWriteSync(path: string, data: string, mode = 0o600): void {
  const tmp = path + ".tmp";
  let fd: number | undefined;
  let created = false;
  try {
    // `wx` is deliberate: an attacker-controlled symlink at the predictable
    // temporary path must never be followed by a secret/config write.
    try {
      fd = openSync(tmp, "wx", mode);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      // #1632: a process killed between openSync and renameSync leaves an
      // orphan temp file, and `wx` then fails EEXIST forever — every later
      // write to this path is bricked until the file is removed by hand. That
      // outage killed bridge.lock creation AND the per-tick heartbeat write.
      //
      // bridge.lock has two writer processes (the bridge and the watchdog), so
      // an unconditional unlink could destroy another process's in-flight temp
      // file. Discriminate by age: only a stale temp file is an orphan.
      //
      // lstatSync, not statSync: never resolve a symlink planted at this path.
      const ageMs = Date.now() - lstatSync(tmp).mtimeMs;
      if (ageMs < ORPHAN_TMP_STALE_MS) throw err; // another writer is mid-write

      logWarn(TAG, `Removing orphan temp file from an interrupted write (age ${Math.round(ageMs / 1000)}s): ${tmp}`);
      // unlinkSync does not follow symlinks, and the retry below still uses
      // `wx`, so an attacker who replants a symlink here gets EEXIST again and
      // we throw. The write can never follow a symlink.
      unlinkSync(tmp);
      fd = openSync(tmp, "wx", mode); // single retry — a racing EEXIST throws
    }
    created = true;
    fchmodSync(fd, mode);
    writeFileSync(fd, data, { encoding: "utf-8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original failure */ }
    }
    if (created) {
      try { unlinkSync(tmp); } catch { /* preserve the original failure */ }
    }
    throw err;
  }
}
