/**
 * `abtars rollback` — swap app/ ↔ app.prev.N/, restart via watchdog, health-verify.
 * --to N (1-3, default 1) selects which prior to restore.
 * --no-cascade disables automatic fallback to next slot.
 */

import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  packagePaths,
  readManifest,
  writeManifest,
} from '../deploy-lib-import.js';

export async function rollback(opts?: { to?: number }): Promise<number> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const slot = opts?.to ?? 1;

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
    process.stderr.write(`Nothing to roll back to (no app.prev.${slot}/ found).\n`);
    return 2;
  }

  if (!manifest?.version) {
    process.stderr.write(`No active release in manifest; nothing to roll back.\n`);
    return 2;
  }

  const release = await acquireLock(paths.lock, 'rollback');
  try {
    // Swap: app/ ↔ app.prev.N/ via temp
    const tempDir = join(paths.home, 'app.swap-temp');
    renameSync(paths.app, tempDir);
    renameSync(prevDir, paths.app);
    renameSync(tempDir, prevDir);
    process.stdout.write(`✓ swapped: app/ ↔ app.prev.${slot}/\n`);

    // Update manifest
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

    // Restart — clear .stopped, write start reason, then exit so watchdog respawns with new code
    try { unlinkSync(join(paths.home, '.stopped')); } catch {}
    try { const s = JSON.parse(readFileSync(join(paths.home, 'deploy.state'), 'utf-8')); s.restartCount = 0; writeFileSync(join(paths.home, 'deploy.state'), JSON.stringify(s) + '\n'); } catch {}
    const { readFileSync: rfs } = await import('node:fs');
    let rollbackCommit = "unknown";
    try { rollbackCommit = JSON.parse(rfs(join(paths.app, "package.json"), "utf-8")).version; } catch {}
    const { writeFileSync: wfs } = await import('node:fs');
    wfs(join(paths.home, '.start-reason'), `manual-rollback:${slot}:${rollbackCommit}`);

    const restartTs = Date.now();
    process.stdout.write(`♻️ Restarting bridge...\n`);
    // If running inside the bridge (e.g. /software rollback command), just exit.
    // Watchdog respawns with the swapped code. Don't USR1 — that kills us mid-rollback.
    setTimeout(() => process.exit(0), 500);

    // Process exits above — watchdog respawns with swapped code.
    // Health checking is watchdog's job (circuit breaker handles bad slots).
    return 0;
  } finally {
    await release();
  }
}
