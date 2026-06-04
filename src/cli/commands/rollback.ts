/**
 * `abtars rollback` — swap app/ ↔ app.prev/, restart, health-verify.
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

export async function rollback(): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);

  if (!existsSync(paths.appPrev)) {
    process.stderr.write(`Nothing to roll back to (no app.prev/ found).\n`);
    return 2;
  }

  if (!manifest?.version) {
    process.stderr.write(`No active release in manifest; nothing to roll back.\n`);
    return 2;
  }

  const release = await acquireLock(paths.lock, 'rollback');
  try {
    // Swap: app/ → app.broken/, app.prev/ → app/
    const brokenDir = join(paths.home, 'app.broken');
    rmSync(brokenDir, { recursive: true, force: true });
    renameSync(paths.app, brokenDir);
    renameSync(paths.appPrev, paths.app);
    rmSync(brokenDir, { recursive: true, force: true });
    process.stdout.write(`✓ rolled back: app.prev/ → app/\n`);

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
    } else {
      process.stderr.write(`⚠️ Bridge may not have started. Check logs.\n`);
    }

    process.stdout.write(`\nRollback complete.\n`);
    return 0;
  } finally {
    await release();
  }
}
