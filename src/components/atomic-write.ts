import { writeFileSync, renameSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";

/** Atomic write: .tmp → fsync → rename. Crash-safe on POSIX.
 *  Default mode 0600 matches the runtime umask (077) so owner-only files
 *  stay owner-only even when the umask was widened before boot. */
export function atomicWriteSync(path: string, data: string, mode = 0o600): void {
  const tmp = path + ".tmp";
  writeFileSync(tmp, data, { encoding: "utf-8", mode });
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, path);
}

/** Clean orphan .tmp files left by crashes. Call on boot. */
export function cleanOrphanTmp(path: string): void {
  try { unlinkSync(path + ".tmp"); } catch { /* no orphan */ }
}
