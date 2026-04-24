/**
 * `agentbridge update` — build current checkout, stage new release, flip symlink.
 *
 * Phase 1 implements --source local only. Other sources error with a
 * "not yet supported" stub (Phase 5 will add NpmSource).
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import { copyFile, mkdir, chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { makeLocalBuildSource } from '../update-sources/local.js';
import type { SourceName } from '../update-sources/types.js';
import { acquireLock, activate, emptyManifest, hashFile, packagePaths, pruneReleases, readManifest, writeManifest, RETENTION } from '../deploy-lib-import.js';
import { runMigrations } from '../migrations/index.js';

export interface UpdateOptions {
  readonly source: SourceName;
  readonly fromLocal: boolean;
  readonly allowAbmindMismatch: boolean;
}

export async function update(opts: UpdateOptions): Promise<number> {
  if (opts.source !== 'local') {
    process.stderr.write(
      `--source ${opts.source} is not yet supported (reserved for post-#155 npm publish).\nUse --source local (the default) for now.\n`,
    );
    return 2;
  }

  const paths = packagePaths('agentbridge');
  const release = await acquireLock(paths.lock, `update --source ${opts.source}`);

  try {
    const source = makeLocalBuildSource({ repoRoot: process.cwd(), allowStale: opts.fromLocal });
    process.stdout.write(`Building from local checkout (${process.cwd()})...\n`);
    const staged = await source.prepare({
      releasesDir: paths.releases,
      nodeModulesDir: paths.nodeModules,
      home: paths.home,
      allowStale: opts.fromLocal,
    });
    process.stdout.write(`✓ staged ${staged.version} at ${staged.stagedPath}\n`);

    // Flip current → releases/<version>
    await activate(paths.current, staged.version);
    process.stdout.write(`✓ current -> releases/${staged.version}\n`);

    // Update manifest
    const prior = await readManifest(paths.manifest);
    const now = new Date().toISOString();
    const newPriorReleases = prior?.version
      ? [
          {
            version: prior.version,
            commit: prior.commit,
            activatedAt: prior.activatedAt,
            packageLockHash: prior.packageLockHash,
          },
          ...(prior.priorReleases ?? []),
        ].slice(0, RETENTION - 1)
      : prior?.priorReleases ?? [];

    await writeManifest(paths.manifest, {
      ...(prior ?? emptyManifest('agentbridge', hostname())),
      version: staged.version,
      commit: staged.commit,
      branch: staged.branch,
      packageLockHash: staged.packageLockHash,
      activatedAt: now,
      source: 'local',
      priorReleases: newPriorReleases,
    });
    process.stdout.write(`✓ manifest updated\n`);

    // Prune old releases
    const pruned = await pruneReleases(
      paths.releases,
      [staged.version, ...newPriorReleases.map((r) => r.version)],
      staged.version,
      RETENTION,
    );
    if (pruned.length > 0) {
      process.stdout.write(`✓ pruned ${pruned.length} old release${pruned.length === 1 ? '' : 's'}: ${pruned.join(', ')}\n`);
    }

    process.stdout.write(`\nUpdate complete: ${staged.version}\n`);

    // Refresh all scripts from repo scripts/ directory
    const repoScripts = join(process.cwd(), 'scripts');
    const destScripts = join(paths.home, 'scripts');
    await mkdir(destScripts, { recursive: true });
    const scriptFiles = await readdir(repoScripts).catch(() => [] as string[]);
    const home = process.env['HOME'] ?? '';
    let serviceChanged = false;

    // Resolve install mode — skip supervisor artifacts in simple mode
    const { resolveInstallMode } = await import('../install-mode.js');
    const installMode = resolveInstallMode(paths.home);

    for (const name of scriptFiles) {
      await copyFile(join(repoScripts, name), join(destScripts, name));
      if (name.endsWith('.sh')) await chmod(join(destScripts, name), 0o755);
      // Root-level copies for launcher scripts watchdog/launchd reference directly
      if (name.endsWith('.sh')) {
        await copyFile(join(repoScripts, name), join(paths.home, name));
        await chmod(join(paths.home, name), 0o755);
      }
      // macOS: template + install LaunchAgent plist (supervised only)
      if (name.endsWith('.plist') && process.platform === 'darwin' && home && installMode === 'supervised') {
        const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
        await mkdir(launchAgentsDir, { recursive: true });
        const dst = join(launchAgentsDir, name);
        const oldContent = await readFile(dst, 'utf-8').catch(() => '');
        const templated = (await readFile(join(repoScripts, name), 'utf-8')).replace(/\{\{HOME\}\}/g, home);
        await writeFile(dst, templated);
        if (oldContent !== templated) serviceChanged = true;
      }
      // Linux: install systemd user service (supervised only)
      if (name.endsWith('.service') && process.platform === 'linux' && home && installMode === 'supervised') {
        const systemdDir = join(home, '.config', 'systemd', 'user');
        await mkdir(systemdDir, { recursive: true });
        const dst = join(systemdDir, name);
        const oldContent = await readFile(dst, 'utf-8').catch(() => '');
        await copyFile(join(repoScripts, name), dst);
        const newContent = await readFile(dst, 'utf-8').catch(() => '');
        if (oldContent !== newContent) serviceChanged = true;
      }
    }
    process.stdout.write(`✓ scripts refreshed (${scriptFiles.length} files)\n`);
    if (serviceChanged) {
      if (process.platform === 'darwin') {
        process.stdout.write(`⚠️  LaunchAgent plist updated — reload with: launchctl bootout gui/$(id -u)/com.agentbridge.watchdog && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentbridge.watchdog.plist\n`);
      } else {
        process.stdout.write(`⚠️  systemd service updated — reload with: systemctl --user daemon-reload && systemctl --user restart agentbridge-watchdog\n`);
      }
    }

    // Run any pending migrations (excluding 003-flat-to-releases, which is
    // gated behind `install --upgrade`). 001/002 are safe to run here.
    const migrationResults = await runMigrations({
      home: paths.home,
      dryRun: false,
      only: ['001-env-memory-to-config', '002-env-skills-to-config'],
    });
    const applied = migrationResults.filter((r) => r.applied);
    if (applied.length > 0) {
      process.stdout.write(`\nMigrations applied:\n`);
      for (const r of applied) process.stdout.write(`  ✓ ${r.name}: ${r.message}\n`);
    }

    // hashFile is unused here but imported to validate the re-export surface;
    // leaving this no-op call removed — the re-export is exercised by tests.
    void hashFile;
    return 0;
  } finally {
    await release();
  }
}
