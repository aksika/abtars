import { printBanner } from './banner.js';
/**
 * `abtars rollback` — repoint current symlink to a previous release from history.json.
 * --to N (1-3, default 1) selects which prior to restore.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireLock, packagePaths, readManifest, writeManifest, emptyManifest } from '../deploy-lib-import.js';

/**
 * Derive {version, commit} for a history entry. History entries are either a
 * git short SHA (dev builds, e.g. "3aebb9d") or a version string (npm builds,
 * e.g. "0.3.4-alpha.8"). The release dir's package.json holds the full version.
 */
function resolveReleaseIdentity(releaseDir: string, target: string): { version: string; commit: string | null } {
  let version = target;
  try {
    const pkg = JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf-8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch { /* fall back to target as version */ }
  // Git short SHA: 7-40 hex chars. npm versions contain dots/dashes.
  const commit = /^[0-9a-f]{7,40}$/.test(target) ? target : null;
  return { version, commit };
}

export async function rollback(opts?: { to?: number }): Promise<number> {
  await printBanner("rollback");
  const paths = packagePaths('abtars');
  const releasesDir = paths.releasesDir;
  const historyFile = join(releasesDir, 'history.json');
  const currentLink = join(releasesDir, 'current');
  const slot = opts?.to ?? 1;

  if (slot < 1 || slot > 3) {
    process.stderr.write(`Invalid --to value: ${slot}. Must be 1-3.\n`);
    return 2;
  }

  let history: string[] = [];
  try { history = JSON.parse(readFileSync(historyFile, "utf-8")); } catch {}

  if (history.length <= slot) {
    process.stderr.write(`Nothing at slot ${slot} (history has ${history.length} entries).\n`);
    return 2;
  }

  const target = history[slot]!;
  const targetDir = join(releasesDir, target);
  if (!existsSync(targetDir)) {
    process.stderr.write(`Release dir ${target} not found on disk.\n`);
    return 2;
  }

  const release = await acquireLock(paths.lock, 'rollback');
  try {
    // Repoint current symlink
    try { unlinkSync(currentLink); } catch {}
    symlinkSync(targetDir, currentLink);

    // Also repoint legacy app/ symlink
    try { unlinkSync(paths.app); } catch {}
    try { symlinkSync(targetDir, paths.app); } catch {}

    // #1291: update manifest.json + deploy.state so the respawned bridge (which
    // reads its version from manifest via getDeployedVersion()) reports the
    // rolled-back release, not the stale pre-rollback one. Without this,
    // /software and bridge.lock keep showing the old version even though the
    // symlink + code were swapped correctly.
    const priorManifest = await readManifest(paths.manifest);
    const { version: targetVersion, commit: targetCommit } = resolveReleaseIdentity(targetDir, target);
    await writeManifest(paths.manifest, {
      ...(priorManifest ?? emptyManifest('abtars', hostname())),
      version: targetVersion,
      commit: targetCommit,
      activatedAt: new Date().toISOString(),
      previousVersion: priorManifest?.version ?? null,
      previousCommit: priorManifest?.commit ?? null,
      // source intentionally preserved from prior manifest — rollback does not
      // change release provenance, and Manifest.source has no 'rollback' variant.
    });

    process.stdout.write(`✓ rolled back to ${target} (slot ${slot}) — manifest updated to ${targetVersion}\n`);

    // Reset circuit breaker counter + mark deploy.state so /software deploy-state line is accurate
    try {
      const statePath = join(paths.home, 'deploy.state');
      const state: Record<string, unknown> = JSON.parse(readFileSync(statePath, 'utf-8') || '{}');
      state.status = 'rollback';
      state.version = targetVersion;
      state.completedAt = new Date().toISOString();
      state.restartCount = 0;
      writeFileSync(statePath, JSON.stringify(state) + '\n');
    } catch {}

    // Write start reason + restart
    writeFileSync(join(paths.home, '.start-reason'), `rollback:${target}`);

    // Kill bridge so WD respawns from rolled-back code
    try {
      const bridgePid = JSON.parse(readFileSync(join(paths.home, 'bridge.lock'), 'utf-8')).pid;
      if (bridgePid > 0) process.kill(bridgePid, 'SIGTERM');
    } catch {}

    process.stdout.write(`♻️ Bridge killed — WD will respawn from ${target}\n`);
    return 0;
  } finally {
    await release();
  }
}
