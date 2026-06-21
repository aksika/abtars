/**
 * migrate-layout.ts — One-time migration from #1085 layout to #1089 releases dir.
 * Detects old layout (app/ is a real dir, not a symlink) and moves to releases.
 */

import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export function migrateIfNeeded(home: string): boolean {
  const appDir = join(home, "app");
  const releasesDir = resolve(homedir(), ".abtars-releases");

  // Already migrated: app/ is a symlink OR releases/current exists
  if (!existsSync(appDir)) return false;
  try {
    if (lstatSync(appDir).isSymbolicLink()) return false;
  } catch { return false; }

  // Old layout detected — migrate
  process.stdout.write("[migrate] Converting from #1085 layout to #1089 releases dir...\n");
  mkdirSync(releasesDir, { recursive: true });

  // Determine version from manifest
  let version = "migrated";
  try {
    const manifest = JSON.parse(readFileSync(join(home, "manifest.json"), "utf-8"));
    version = manifest.commit ?? manifest.version ?? "migrated";
  } catch {}

  const targetDir = join(releasesDir, version);

  // Move app/ to releases/<version>/
  if (!existsSync(targetDir)) {
    renameSync(appDir, targetDir);
  } else {
    rmSync(appDir, { recursive: true, force: true });
  }
  process.stdout.write(`  ✓ app/ → releases/${version}\n`);

  // Move app.prev/ if exists
  const prevDir = join(home, "app.prev");
  if (existsSync(prevDir) && !lstatSync(prevDir).isSymbolicLink()) {
    let prevVersion = "prev";
    try {
      const pkg = JSON.parse(readFileSync(join(prevDir, "package.json"), "utf-8"));
      prevVersion = pkg.version ?? "prev";
    } catch {}
    const prevTarget = join(releasesDir, prevVersion);
    if (!existsSync(prevTarget)) renameSync(prevDir, prevTarget);
    else rmSync(prevDir, { recursive: true, force: true });
    process.stdout.write(`  ✓ app.prev/ → releases/${prevVersion}\n`);
  }

  // Move src/ if exists
  const srcDir = join(home, "src");
  const releasesSrc = join(releasesDir, "src");
  if (existsSync(srcDir)) {
    if (!existsSync(releasesSrc)) {
      renameSync(srcDir, releasesSrc);
      process.stdout.write("  ✓ src/ → releases/src/\n");
    } else {
      rmSync(srcDir, { recursive: true, force: true });
      process.stdout.write("  ✓ src/ removed (already in releases/src/)\n");
    }
  }

  // Create symlinks
  const currentLink = join(releasesDir, "current");
  try { symlinkSync(targetDir, currentLink); } catch {}
  try { symlinkSync(targetDir, appDir); } catch {}

  // Write history.json
  const history = [version];
  if (existsSync(join(releasesDir, "prev"))) history.push("prev");
  writeFileSync(join(releasesDir, "history.json"), JSON.stringify(history) + "\n");

  // Remove old dirs that are now dead
  for (const old of ["app.prev.1", "app.prev.2", "app.prev.3", "app.staging", "core"]) {
    rmSync(join(home, old), { recursive: true, force: true });
  }

  process.stdout.write("[migrate] Done. Layout upgraded to #1089.\n");
  return true;
}
