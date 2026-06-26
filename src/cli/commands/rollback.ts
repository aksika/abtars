import { printBanner } from './banner.js';
/**
 * `abtars rollback` — repoint current symlink to a previous release from history.json.
 * --to N (1-3, default 1) selects which prior to restore.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { acquireLock, packagePaths } from '../deploy-lib-import.js';

export async function rollback(opts?: { to?: number }): Promise<number> {
  await printBanner("rollback");
  const paths = packagePaths('abtars');
  const releasesDir = resolve(homedir(), '.abtars-releases');
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

    process.stdout.write(`✓ rolled back to ${target} (slot ${slot})\n`);

    // Reset circuit breaker counter
    try {
      const state = JSON.parse(readFileSync(join(paths.home, 'deploy.state'), 'utf-8'));
      state.restartCount = 0;
      writeFileSync(join(paths.home, 'deploy.state'), JSON.stringify(state) + '\n');
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
