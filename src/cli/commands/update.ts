/**
 * `agentbridge update` — build current checkout, stage new release, flip symlink.
 *
 * Phase 1 implements --source local only. Other sources error with a
 * "not yet supported" stub (Phase 5 will add NpmSource).
 */

import { hostname } from 'node:os';
import { makeLocalBuildSource } from '../update-sources/local.js';
import type { SourceName } from '../update-sources/types.js';
import { acquireLock, activate, emptyManifest, hashFile, packagePaths, pruneReleases, readManifest, writeManifest, RETENTION } from '../deploy-lib-import.js';

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
    // hashFile is unused here but imported to validate the re-export surface;
    // leaving this no-op call removed — the re-export is exercised by tests.
    void hashFile;
    return 0;
  } finally {
    await release();
  }
}
