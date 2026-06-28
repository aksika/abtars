/**
 * Runtime directory resolution for deploy-lib consumers.
 *
 * Rules:
 *   - abtars runtime root: $ABTARS_HOME ?? ~/.abtars
 *   - abmind runtime root:      $ABMIND_HOME ?? ~/.abmind
 *   - releases dir:            $ABTARS_RELEASES ?? ~/.abtars-releases
 *   - user bin dir:            $ABTARS_BIN ?? ~/.local/bin
 *
 * All callers use these resolvers — never hardcode paths. Required by
 * plan #158 v7 (Ag2 round-2 nit): cross-repo manifest reads must respect
 * env-var overrides, not assume default locations.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type PackageName = 'abtars' | 'abmind';

export function resolveAbtarsHome(): string {
  return process.env['ABTARS_HOME'] ?? join(homedir(), '.abtars');
}

export function resolveAbmindHome(): string {
  return process.env['ABMIND_HOME'] ?? join(homedir(), '.abmind');
}

export function resolvePackageHome(pkg: PackageName): string {
  return pkg === 'abtars' ? resolveAbtarsHome() : resolveAbmindHome();
}

export function resolveReleasesDir(): string {
  return process.env['ABTARS_RELEASES'] ?? join(homedir(), '.abtars-releases');
}

export function resolveUserBinDir(): string {
  return process.env['ABTARS_BIN'] ?? join(homedir(), '.local', 'bin');
}

export interface PackagePaths {
  readonly home: string;
  readonly config: string;
  readonly app: string;
  readonly appPrev: string;
  readonly appPrev1: string;
  readonly appPrev2: string;
  readonly appPrev3: string;
  readonly appStaging: string;
  readonly bin: string;
  readonly manifest: string;
  readonly lock: string;
  // #1089: releases dir layout
  readonly releasesDir: string;
  readonly releasesCurrentLink: string;
  readonly releasesHistory: string;
  readonly releasesSrc: string;
  // Legacy — kept for migration detection only. Remove after all hosts migrated.
  readonly releases: string;
  readonly current: string;
}

export function packagePaths(pkg: PackageName): PackagePaths {
  const home = resolvePackageHome(pkg);
  const releasesDir = resolveReleasesDir();
  return {
    home,
    config: join(home, 'config'),
    app: join(home, 'app'),
    appPrev: join(home, 'app.prev'),
    appPrev1: join(home, 'app.prev.1'),
    appPrev2: join(home, 'app.prev.2'),
    appPrev3: join(home, 'app.prev.3'),
    appStaging: join(home, 'app.staging'),
    bin: resolveUserBinDir(),
    manifest: join(home, 'manifest.json'),
    lock: join(home, '.update.lock'),
    // #1089
    releasesDir,
    releasesCurrentLink: join(releasesDir, 'current'),
    releasesHistory: join(releasesDir, 'history.json'),
    releasesSrc: join(releasesDir, 'src'),
    // Legacy
    releases: join(home, 'releases'),
    current: join(home, 'current'),
  };
}
