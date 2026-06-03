/**
 * Runtime manifest: the single source of truth for "what's installed".
 *
 * Location: $HOME/manifest.json (per packagePaths().manifest).
 * Read by: `status`, cross-package compatibility checks, doctor.
 * Written by: `install`, `update`, `rollback`, migrations.
 */

import { readFile, writeFile } from 'node:fs/promises';

export interface Manifest {
  readonly package: 'abtars' | 'abmind';
  /** Currently active release version. */
  readonly version: string;
  /** Git SHA of the source that produced the active release, if known. */
  readonly commit: string | null;
  /** Git branch, if known. */
  readonly branch: string | null;
  /** Hash of package-lock.json at time of last install. */
  readonly packageLockHash: string | null;
  /** ISO timestamp of when the active release became active. */
  readonly activatedAt: string;
  /** Hostname where install lives (informational). */
  readonly host: string;
  /** Source adapter that produced the current release (local | npm | github). */
  readonly source: 'local' | 'npm' | 'github';
  /** Applied migrations (ordered). */
  readonly migrationsApplied: readonly string[];
  /** Previous version (for rollback). Null on first install. */
  readonly previousVersion: string | null;
  /** Previous commit (for rollback reference). */
  readonly previousCommit: string | null;
  /** Install mode: simple (manual), supervised (launchd/systemd user-scope), or supervised-daemon (system-scope). */
  readonly installMode?: 'simple' | 'supervised' | 'supervised-daemon';
}

export async function readManifest(path: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as Manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeManifest(path: string, manifest: Manifest): Promise<void> {
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

export function emptyManifest(pkg: 'abtars' | 'abmind', host: string): Manifest {
  return {
    package: pkg,
    version: '',
    commit: null,
    branch: null,
    packageLockHash: null,
    activatedAt: new Date().toISOString(),
    host,
    source: 'local',
    migrationsApplied: [],
    previousVersion: null,
    previousCommit: null,
  };
}
