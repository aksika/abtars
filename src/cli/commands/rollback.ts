import { printBanner } from './banner.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireLock, packagePaths, readManifest, writeManifest, emptyManifest } from '../deploy-lib-import.js';
import { publishCommand, resetRestartCount } from '../../supervisor/state.js';

function resolveReleaseIdentity(releaseDir: string, target: string): { version: string; commit: string | null } {
  let version = target;
  try {
    const pkg = JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf-8')) as { version?: string };
    if (typeof pkg.version === 'string' && pkg.version) version = pkg.version;
  } catch { }
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
    try { unlinkSync(currentLink); } catch {}
    symlinkSync(targetDir, currentLink);

    try { unlinkSync(paths.app); } catch {}
    try { symlinkSync(targetDir, paths.app); } catch {}

    const priorManifest = await readManifest(paths.manifest);
    const { version: targetVersion, commit: targetCommit } = resolveReleaseIdentity(targetDir, target);
    await writeManifest(paths.manifest, {
      ...(priorManifest ?? emptyManifest('abtars', hostname())),
      version: targetVersion,
      commit: targetCommit,
      activatedAt: new Date().toISOString(),
      previousVersion: priorManifest?.version ?? null,
      previousCommit: priorManifest?.commit ?? null,
    });

    process.stdout.write(`+ rolled back to ${target} (slot ${slot}) — manifest updated to ${targetVersion}\n`);

    try {
      const statePath = join(paths.home, 'deploy.state');
      const state: Record<string, unknown> = JSON.parse(readFileSync(statePath, 'utf-8') || '{}');
      state.status = 'rollback';
      state.version = targetVersion;
      state.completedAt = new Date().toISOString();
      writeFileSync(statePath, JSON.stringify(state) + '\n');
    } catch {}

    publishCommand(paths.home, "rollback", `rollback:${target}`);
    resetRestartCount(paths.home, "rollback");

    try {
      const bridgePid = JSON.parse(readFileSync(join(paths.home, 'bridge.lock'), 'utf-8')).pid;
      if (bridgePid > 0) process.kill(bridgePid, 'SIGTERM');
    } catch {}

    process.stdout.write(`+ Bridge killed — WD will respawn from ${target}\n`);
    return 0;
  } finally {
    await release();
  }
}
