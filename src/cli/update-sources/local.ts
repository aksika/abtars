/**
 * LocalBuildSource: the Phase 1 adapter. Builds the current working-tree
 * checkout and stages the output into releases/<version>/dist/.
 *
 * Staleness guard: runs `git fetch` and refuses to proceed if HEAD is behind
 * origin/<branch>, unless allowStale (--from-local) is passed. Handles the
 * detached-HEAD / no-upstream / unpushed edge cases with a friendly message.
 *
 * Version string: `<package-version>-<short-sha>`, e.g. `0.1.0-28f71ef`.
 * Uniqueness: if the same version is staged twice, the second stage
 * overwrites (rsync --delete semantics via rm + cp). Rare; only happens when
 * operator runs update twice without changing a commit or bumping version.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashFile } from '../deploy-lib-import.js';
import type { PrepareContext, StagedRelease, UpdateSource } from './types.js';

export class LocalBuildError extends Error {
  constructor(
    message: string,
    public readonly hint?: string,
  ) {
    super(hint ? `${message}\n\n${hint}` : message);
    this.name = 'LocalBuildError';
  }
}

export interface LocalBuildOptions {
  /** Repository root for the build (defaults to process.cwd()). */
  readonly repoRoot?: string;
  /** If true, skip the behind-origin guard. Operator opt-in. */
  readonly allowStale?: boolean;
  /** If true, skip `npm install` (assume node_modules is already current). */
  readonly skipInstall?: boolean;
}

function runCmd(cmd: string, args: readonly string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (r.error) throw new LocalBuildError(`${cmd} ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new LocalBuildError(
      `${cmd} ${args.join(' ')} exited with status ${r.status}`,
      r.stderr?.trim() || undefined,
    );
  }
  return r.stdout.trim();
}

function tryCmd(cmd: string, args: readonly string[], cwd: string): string | null {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function checkStaleness(repoRoot: string, allowStale: boolean): { commit: string; branch: string | null } {
  const commit = runCmd('git', ['rev-parse', '--short', 'HEAD'], repoRoot);
  const branch = tryCmd('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
  if (allowStale) return { commit, branch: branch === 'HEAD' ? null : branch };

  // Detached HEAD / no-branch case
  if (branch === 'HEAD' || branch === null) {
    throw new LocalBuildError(
      'Working tree is in detached HEAD (no current branch).',
      'Cannot check for staleness. Pass --from-local to proceed with the current tree.',
    );
  }

  // Fetch to refresh origin refs. Not --unshallow; caller may have a shallow clone intentionally.
  runCmd('git', ['fetch', '--quiet'], repoRoot);

  // Does the branch have an upstream?
  const upstream = tryCmd('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], repoRoot);
  if (upstream === null) {
    throw new LocalBuildError(
      `Branch '${branch}' has no upstream configured.`,
      'Cannot check for staleness. Push the branch, or pass --from-local to proceed with the current tree.',
    );
  }

  // How many commits is HEAD behind upstream?
  const behindStr = tryCmd('git', ['rev-list', '--count', `HEAD..${upstream}`], repoRoot);
  const behind = behindStr === null ? null : Number(behindStr);
  if (behind === null || !Number.isFinite(behind)) {
    throw new LocalBuildError(
      `Could not determine how far HEAD is behind ${upstream}.`,
      'Pass --from-local to proceed anyway.',
    );
  }
  if (behind > 0) {
    throw new LocalBuildError(
      `Current branch: ${branch} (${commit})\n${upstream} is ahead by ${behind} commit${behind === 1 ? '' : 's'}.`,
      `Run 'git pull' first, or pass --from-local to build from the current tree.`,
    );
  }

  return { commit, branch };
}

async function readPackageVersion(repoRoot: string): Promise<string> {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf-8')) as { version?: string };
  if (typeof pkg.version !== 'string') {
    throw new LocalBuildError('package.json has no version field.');
  }
  return pkg.version;
}

export function makeLocalBuildSource(opts: LocalBuildOptions = {}): UpdateSource {
  const repoRoot = opts.repoRoot ?? process.cwd();
  return {
    name: 'local',
    async prepare(ctx: PrepareContext): Promise<StagedRelease> {
      const { commit, branch } = checkStaleness(repoRoot, opts.allowStale === true || ctx.allowStale);
      const pkgVersion = await readPackageVersion(repoRoot);
      const version = `${pkgVersion}-${commit}`;

      // Install deps into the shared node_modules/ (if not skipped).
      if (opts.skipInstall !== true) {
        runCmd('npm', ['install', '--no-audit', '--no-fund'], repoRoot);
      }

      // Build: bundle mode (esbuild) or legacy mode (tsc)
      const useBundle = process.env['AGENTBRIDGE_BUILD_MODE'] !== 'tsc';

      if (useBundle) {
        // Bundle mode: esbuild → bundle/ + pruned native deps
        runCmd('npm', ['run', 'bundle'], repoRoot);

        const stagedPath = join(ctx.releasesDir, version);
        await rm(stagedPath, { recursive: true, force: true });
        await mkdir(stagedPath, { recursive: true });
        await cp(join(repoRoot, 'bundle'), join(stagedPath, 'bundle'), { recursive: true });

        // Copy core skills for runtime sync (#438)
        const coreSkillsSrc = join(repoRoot, 'core', 'skills');
        if (existsSync(coreSkillsSrc)) {
          await cp(coreSkillsSrc, join(stagedPath, 'core', 'skills'), { recursive: true });
        }

        // Ensure ESM works without warnings (MODULE_TYPELESS_PACKAGE_JSON)
        await writeFile(join(stagedPath, 'package.json'), JSON.stringify({ type: "module", name: "abtars", version }, null, 2) + "\n");

        // Copy install-manifest.json for doctor reconciliation
        await copyFile(join(repoRoot, 'install-manifest.json'), join(stagedPath, 'install-manifest.json'));

        // Native addons (better-sqlite3, sqlite-vec) live at ~/.abmind/lib/node_modules/
        // and are loaded via native-loader.ts from there. No need to copy into release.
        // See #431 (persistent install) + native-loader.ts.

        const packageLockHash = await hashFile(join(repoRoot, 'package-lock.json'));
        return { version, stagedPath, commit, branch, packageLockHash, source: 'local' };
      }

      // Legacy tsc mode (AGENTBRIDGE_BUILD_MODE=tsc)
      runCmd('npm', ['run', 'build'], repoRoot);

      // Stage releases/<version>/dist/
      const stagedPath = join(ctx.releasesDir, version);
      await rm(stagedPath, { recursive: true, force: true });
      await mkdir(stagedPath, { recursive: true });
      await cp(join(repoRoot, 'dist'), join(stagedPath, 'dist'), { recursive: true });

      // Copy install-manifest.json for doctor reconciliation
      await copyFile(join(repoRoot, 'install-manifest.json'), join(stagedPath, 'install-manifest.json'));

      // Sync node_modules/ to the shared location.
      //
      // Use `rsync -aL` to DEREFERENCE symlinks — critical because
      // package.json `"abmind": "file:../abmind"` creates a symlink at
      // node_modules/abmind pointing into the dev workspace. Plain cp
      // preserves the symlink, so the runtime ends up with abmind code
      // served from the developer's working tree (active live edits +
      // test-suite contention on memory.db). We want a materialized copy.
      //
      // Delete destination first so rsync's --delete is unnecessary (and
      // safer — we don't want to rsync-delete anything outside).
      await rm(ctx.nodeModulesDir, { recursive: true, force: true });
      await mkdir(ctx.nodeModulesDir, { recursive: true });
      const rsyncResult = spawnSync(
        'rsync',
        ['-aL', '--quiet', `${join(repoRoot, 'node_modules')}/`, `${ctx.nodeModulesDir}/`],
        { stdio: 'inherit' },
      );
      if (rsyncResult.status !== 0) {
        throw new LocalBuildError(
          `rsync of node_modules failed (status ${rsyncResult.status ?? -1})`,
          `Ensure rsync is installed. Falling back to node cp would re-create symlinks.`,
        );
      }

      // Note: abmind's nested node_modules/ (rsync'd from its dev workspace)
      // stays in place. Previously deleted to avoid duplicate better-sqlite3
      // native-addon conflict (#230-related), but since f24b33f removed
      // better-sqlite3 from abtars's deps, abmind's nested copy is the
      // only one and must remain — deleting it breaks module resolution for
      // abmind at runtime ('Cannot find package better-sqlite3').

      const packageLockHash = await hashFile(join(repoRoot, 'package-lock.json'));

      return { version, stagedPath, commit, branch, packageLockHash, source: 'local' };
    },
  };
}
