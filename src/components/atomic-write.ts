import { writeFileSync, renameSync, openSync, fchmodSync, fsyncSync, closeSync, unlinkSync } from "node:fs";

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
    fd = openSync(tmp, "wx", mode);
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

/** Clean orphan .tmp files left by crashes. Call on boot. */
export function cleanOrphanTmp(path: string): void {
  try { unlinkSync(path + ".tmp"); } catch { /* no orphan */ }
}
