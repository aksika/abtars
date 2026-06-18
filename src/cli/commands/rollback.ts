/**
 * `abtars rollback` — swap app/ with a prior version, restart, health-verify.
 * --to N (1-3, default 1) selects which prior to restore.
 */

import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  healthProbe,
  packagePaths,
  readManifest,
  writeManifest,
} from '../deploy-lib-import.js';

export async function rollback(opts?: { to?: number; cascade?: boolean }): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const slot = opts?.to ?? 1;
  const cascade = opts?.cascade ?? true;

  if (slot < 1 || slot > 3) {
    process.stderr.write(`Invalid --to value: ${slot}. Must be 1-3.\n`);
    return 2;
  }

  const prevDir = join(paths.home, `app.prev.${slot}`);

  // Backward compat: check old app.prev/ if slot 1 and new format doesn't exist
  const legacyPrev = paths.appPrev;
  if (slot === 1 && !existsSync(prevDir) && existsSync(legacyPrev)) {
    renameSync(legacyPrev, prevDir);
  }

  if (!existsSync(prevDir)) {
    if (cascade && slot < 3) {
      process.stdout.write(`x slot ${slot} not available — trying slot ${slot + 1}...\n`);
      return rollback({ to: slot + 1, cascade });
    }
    process.stderr.write(`Nothing to roll back to (no app.prev.${slot}/ found).\n`);
    return 2;
  }

  if (!manifest?.version) {
    process.stderr.write(`No active release in manifest; nothing to roll back.\n`);
    return 2;
  }

  const release = await acquireLock(paths.lock, 'rollback');
  try {
    // Swap: app/ → app.broken/, app.prev.N/ → app/
    const brokenDir = join(paths.home, 'app.broken');
    rmSync(brokenDir, { recursive: true, force: true });
    renameSync(paths.app, brokenDir);
    renameSync(prevDir, paths.app);
    rmSync(brokenDir, { recursive: true, force: true });
    process.stdout.write(`✓ rolled back: app.prev.${slot}/ → app/\n`);

    // Update manifest (swap version ↔ previousVersion)
    if (manifest.previousVersion) {
      await writeManifest(paths.manifest, {
        ...manifest,
        version: manifest.previousVersion,
        commit: manifest.previousCommit,
        activatedAt: new Date().toISOString(),
        previousVersion: manifest.version,
        previousCommit: manifest.commit,
      });
      process.stdout.write(`✓ manifest: ${manifest.version} → ${manifest.previousVersion}\n`);
    }

    // Restart bridge
    const restartTs = Date.now();
    const { restart } = await import('./restart.js');
    process.stdout.write(`♻️ Restarting bridge...\n`);
    await restart({ cold: true }).catch(() => {});

    // Health probe
    const health = await healthProbe(paths.home, restartTs, 60_000);
    if (health.healthy) {
      process.stdout.write(`✓ Bridge healthy (PID ${health.pid})\n`);
      process.stdout.write(`\nRollback complete.\n`);
      return 0;
    }

    // Unhealthy — cascade to next slot
    if (cascade && slot < 3) {
      process.stdout.write(`x slot ${slot} unhealthy — trying slot ${slot + 1}...\n`);
      return rollback({ to: slot + 1, cascade });
    }

    // All exhausted — full shutdown
    process.stderr.write(`x all slots exhausted — shutting down.\n`);
    const { stop } = await import('./stop.js');
    await stop();
    return 2;
  } finally {
    await release();
  }
}
