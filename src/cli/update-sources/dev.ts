/**
 * LocalBuildSource: the Phase 1 adapter. Builds the current working-tree
 * checkout and stages the output into releases/<version>/dist/.
 *
 * Staleness guard: runs `git fetch` and refuses to proceed if HEAD is behind
 * origin/<branch>, unless allowStale (--local) is passed. Handles the
 * detached-HEAD / no-upstream / unpushed edge cases with a friendly message.
 *
 * Version string: `<package-version>-<short-sha>`, e.g. `0.1.0-28f71ef`.
 * Uniqueness: if the same version is staged twice, the second stage
 * overwrites (rsync --delete semantics via rm + cp). Rare; only happens when
 * operator runs update twice without changing a commit or bumping version.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, cpSync } from 'node:fs';
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
      'Cannot check for staleness. Pass --local to proceed with the current tree.',
    );
  }

  // Fetch to refresh origin refs. Not --unshallow; caller may have a shallow clone intentionally.
  runCmd('git', ['fetch', '--quiet'], repoRoot);

  // Does the branch have an upstream?
  const upstream = tryCmd('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], repoRoot);
  if (upstream === null) {
    throw new LocalBuildError(
      `Branch '${branch}' has no upstream configured.`,
      'Cannot check for staleness. Push the branch, or pass --local to proceed with the current tree.',
    );
  }

  // How many commits is HEAD behind upstream?
  const behindStr = tryCmd('git', ['rev-list', '--count', `HEAD..${upstream}`], repoRoot);
  const behind = behindStr === null ? null : Number(behindStr);
  if (behind === null || !Number.isFinite(behind)) {
    throw new LocalBuildError(
      `Could not determine how far HEAD is behind ${upstream}.`,
      'Pass --local to proceed anyway.',
    );
  }
  if (behind > 0) {
    throw new LocalBuildError(
      `Current branch: ${branch} (${commit})\n${upstream} is ahead by ${behind} commit${behind === 1 ? '' : 's'}.`,
      `Run 'git pull' first, or pass --local to build from the current tree.`,
    );
  }

  // Enforce dev branch for deployments
  if (branch !== 'dev') {
    throw new LocalBuildError(
      `Current branch is '${branch}', but deployments must come from 'dev'.`,
      `Run 'git checkout dev && git pull', or pass --local to override.`,
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
  const isNpmPackage = !existsSync(join(repoRoot, '.git'));

  return {
    name: 'dev',
    async prepare(ctx: PrepareContext): Promise<StagedRelease> {
      // npm package mode: no git, no build — just copy the pre-built bundle
      if (isNpmPackage) {
        const bundleDir = join(repoRoot, 'bundle');
        if (!existsSync(bundleDir)) {
          throw new Error(`No bundle/ found at ${repoRoot}. Run from the abtars npm package or a git checkout.`);
        }
        const pkgVersion = await readPackageVersion(repoRoot);
        const version = pkgVersion;
        const stagedPath = ctx.stagingDir;
        await rm(stagedPath, { recursive: true, force: true });
        await mkdir(stagedPath, { recursive: true });
        await cp(bundleDir, join(stagedPath, 'bundle'), { recursive: true });
        const templatesDir = join(repoRoot, 'templates');
        if (existsSync(templatesDir)) await cp(templatesDir, join(stagedPath, 'templates'), { recursive: true });
        const configSrc = join(repoRoot, 'config');
        if (existsSync(configSrc)) await cp(configSrc, join(stagedPath, 'config'), { recursive: true });
        const manifestSrc = join(repoRoot, 'install-manifest.json');
        if (existsSync(manifestSrc)) await copyFile(manifestSrc, join(stagedPath, 'install-manifest.json'));
        await writeFile(join(stagedPath, 'package.json'), JSON.stringify({ type: "module", name: "abtars", version }, null, 2) + "\n");
        process.stdout.write(`✓ staged ${version} (from npm package)\n`);
        return { version, stagedPath, commit: null, branch: null, packageLockHash: null, source: 'dev' };
      }

      // Git checkout mode: build from source
      const { commit, branch } = checkStaleness(repoRoot, opts.allowStale === true || ctx.allowStale);
      const pkgVersion = await readPackageVersion(repoRoot);
      const version = `${pkgVersion}-${commit}`;

      // Install deps into the repo (if not skipped). npm ci wipes node_modules
      // and installs from package-lock.json — also clears any stale pnpm store
      // (the .pnpm workspace: links that npm cannot parse). (#1234)
      if (opts.skipInstall !== true) {
        runCmd('npm', ['ci'], repoRoot);
      }

      // Bundle mode (esbuild) — build directly, skip npm run bundle (it requires ../abmind)
      runCmd('node', ['esbuild.config.js'], repoRoot);
      const publicSrc = join(repoRoot, 'src', 'components', 'dashboard', 'public');
      if (existsSync(publicSrc)) cpSync(publicSrc, join(repoRoot, 'bundle', 'public'), { recursive: true });
      const agentsSrc = join(repoRoot, 'agents');
      if (existsSync(agentsSrc)) cpSync(agentsSrc, join(repoRoot, 'bundle', 'agents'), { recursive: true });

      const stagedPath = ctx.stagingDir;
      await rm(stagedPath, { recursive: true, force: true });
      await mkdir(stagedPath, { recursive: true });
      await cp(join(repoRoot, 'bundle'), join(stagedPath, 'bundle'), { recursive: true });

      // Copy templates/ for reconcile (skills, prompts, config seeds, tasks)
      const templatesSrc = join(repoRoot, 'templates');
      if (existsSync(templatesSrc)) {
        await cp(templatesSrc, join(stagedPath, 'templates'), { recursive: true });
      }

      // Ensure ESM works
      await writeFile(join(stagedPath, 'package.json'), JSON.stringify({ type: "module", name: "abtars", version }, null, 2) + "\n");

      // Copy install-manifest.json for doctor reconciliation
      await copyFile(join(repoRoot, 'install-manifest.json'), join(stagedPath, 'install-manifest.json'));

      const packageLockHash = await hashFile(join(repoRoot, 'package-lock.json'));
      return { version, stagedPath, commit, branch, packageLockHash, source: 'dev' };
    },
  };
}
