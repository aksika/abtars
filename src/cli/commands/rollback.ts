import { printBanner } from './banner.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { acquireLock, packagePaths, readManifest, writeManifest, emptyManifest } from '../deploy-lib-import.js';
import { activateRelease } from '../deploy-lib/activate.js';
import { publishCommand, resetRestartCount } from '../../supervisor/state.js';
import { validateBridgePid } from '../../supervisor/identity.js';

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
    // Atomically activate: current → target (atomic rename), app → current (#1262 R7.5)
    activateRelease(releasesDir, paths.home, targetDir);

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

    const command = publishCommand(paths.home, "rollback", `rollback:${target}`);
    if (command.result === "busy") {
      process.stderr.write("Rollback activated, but another supervisor command is pending; bridge restart was not requested.\n");
      return 1;
    }
    resetRestartCount(paths.home, "rollback");

    try {
      const lock = JSON.parse(readFileSync(join(paths.home, 'bridge.lock'), 'utf-8'));
      const bridgePid = typeof lock.pid === "number" ? lock.pid : 0;
      const bridgeIdentity = typeof lock.startIdentity === "string" ? lock.startIdentity : null;
      const wdPid = typeof lock.watchdogPid === "number" ? lock.watchdogPid : null;
      const wdIdentity = typeof lock.watchdogStartIdentity === "string" ? lock.watchdogStartIdentity : null;
      if (bridgePid > 0 && bridgeIdentity && validateBridgePid(bridgePid, bridgeIdentity, ['abtars.js', 'bundle']).safeToSignal) {
        process.kill(bridgePid, 'SIGTERM');
      }
      if (wdPid && wdPid > 0 && wdIdentity && validateBridgePid(wdPid, wdIdentity, ['abtars-watchdog.sh']).safeToSignal) {
        process.kill(wdPid, 'SIGUSR1');
      }
    } catch {}

    process.stdout.write(`+ Bridge killed — WD will respawn from ${target}\n`);
    return 0;
  } finally {
    await release();
  }
}
