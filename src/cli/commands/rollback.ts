/**
 * `abtars rollback` — swap app/ ↔ app.prev.N/, restart via watchdog, health-verify.
 * --to N (1-3, default 1) selects which prior to restore.
 * --no-cascade disables automatic fallback to next slot.
 */

import { existsSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireLock,
  healthProbe,
  packagePaths,
  readManifest,
  writeManifest,
} from '../deploy-lib-import.js';

function readJsonField(path: string, field: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf-8'))[field]; } catch { return undefined; }
}

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

    // Restart — same pattern as abtars update: clear .stopped, USR1, fallback cold
    try { unlinkSync(join(paths.home, '.stopped')); } catch {}
    try { unlinkSync(join(paths.home, 'watchdog.state')); } catch {}

    const restartTs = Date.now();
    const wdPid = readJsonField(join(paths.home, 'bridge.lock'), 'watchdogPid') as number | undefined;
    if (wdPid && wdPid > 0) {
      try {
        process.kill(wdPid, 'SIGUSR1');
        process.stdout.write(`♻️ USR1 sent to watchdog (PID ${wdPid})\n`);
      } catch {
        process.stdout.write(`♻️ Watchdog gone — cold restart...\n`);
        const { restart } = await import('./restart.js');
        await restart({ cold: true }).catch(() => {});
      }
    } else {
      process.stdout.write(`♻️ No watchdog — cold restart...\n`);
      const { restart } = await import('./restart.js');
      await restart({ cold: true }).catch(() => {});
    }

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
