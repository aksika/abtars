/**
 * Atomic release activation (#1262 R7.5).
 *
 * Single source of truth for repointing the canonical release link. Only
 * `~/.abtars-releases/current` is atomically replaced (temp symlink → rename);
 * `~/.abtars/app` is normalized to point at `current` (the canonical link),
 * never directly at a release dir — so deploy and rollback never need a
 * two-link atomic swap.
 *
 * Shared by deploy, rollback, and the boot circuit breaker to avoid drift.
 */
import { symlinkSync, renameSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export function activateRelease(releasesDir: string, home: string, targetDir: string): void {
  const currentLink = join(releasesDir, "current");
  const appLink = join(home, "app");

  // 1. Atomically repoint the canonical `current` link via temp + rename.
  //   rename(2) atomically replaces the existing destination on the same FS.
  const tmpCurrent = `${currentLink}.new.${randomUUID().slice(0, 8)}`;
  symlinkSync(targetDir, tmpCurrent);
  renameSync(tmpCurrent, currentLink);

  // 2. Normalize `app` → `current`. This is a backward-compat link (WD/bridge
  //    resolve app/bundle/...); it is allowed to briefly not exist, only
  //    `current` carries the atomicity guarantee. If a non-symlink (legacy
  //    real dir) occupies the path, remove it first so the rename succeeds.
  try {
    if (lstatSync(appLink).isDirectory() && !lstatSync(appLink).isSymbolicLink()) {
      rmSync(appLink, { recursive: true, force: true });
    }
  } catch { /* absent — fine */ }
  const tmpApp = `${appLink}.new.${randomUUID().slice(0, 8)}`;
  symlinkSync(currentLink, tmpApp);
  renameSync(tmpApp, appLink);
}
