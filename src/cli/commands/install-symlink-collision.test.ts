/**
 * Regression tests for the PATH symlink collision policy (bug discovered
 * during Phase 1 smoke on KP, 2026-04-20).
 *
 * Two bugs fixed here:
 *   1. Fuzzy ownership match: code was checking target.endsWith('/.abtars/bin/<name>')
 *      which treated symlinks pointing at the REAL ~/.abtars as "ours to
 *      overwrite" even when ABTARS_HOME pointed at a throwaway dir.
 *      Fix: require exact targetPath match.
 *   2. Dangling symlink as "not existing": exists() used stat() which follows
 *      symlinks and returns false on dangling targets, then symlink() fails
 *      EEXIST. Fix: existsAny() uses lstat() for collision detection.
 *
 * We test via the install command's reconcilePathLink indirectly — by setting
 * up a dangling symlink pointing at a different install's bin dir and
 * confirming install refuses rather than clobbers.
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from './install.js';

vi.mock('../install-manifest.js', () => ({
  loadManifest: () => ({
    manifestVersion: 2,
    directories: [],
    lazyRoots: [],
    configSeeds: [],
    requiredConfigs: [],
    scripts: { include: [], executable: "*.sh" },
    services: { supervised: {} },
    cliWrappers: ["abtars"],
    postInstall: [],
  }),
  _resetManifestCache: () => {},
  isLazyRootAllowed: () => true,
  reconcileManifest: () => ({ ok: [], warnings: [], fixed: [] }),
}));

describe('install: PATH symlink collision policy (regression #158 smoke)', () => {
  let fakeHome: string;
  let fakeUserBin: string;
  let otherInstallBin: string;
  let restoreEnvHome: string | undefined;
  let restoreEnvHomeVar: string | undefined;

  beforeEach(async () => {
    restoreEnvHome = process.env['ABTARS_HOME'];
    restoreEnvHomeVar = process.env['HOME'];

    // Set up a fake home and fake user bin directory. $HOME override so
    // resolveUserBinDir() points at our test dir, not the real ~/.local/bin.
    const base = join(homedir(), '.cache', 'abtars-test');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'pathcollision-'));
    fakeHome = join(root, '.abtars');
    fakeUserBin = join(root, '.local', 'bin');
    otherInstallBin = join(root, 'other-install', '.abtars', 'bin');
    await mkdir(fakeUserBin, { recursive: true });
    await mkdir(otherInstallBin, { recursive: true });
    await mkdir(join(fakeHome, 'state'), { recursive: true });
    await mkdir(join(fakeHome, 'config'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(fakeHome, 'tasks', 'tasks.json'), '[]');
    writeFileSync(join(fakeHome, 'config', 'identity.key'), 'test-key');

    process.env['ABTARS_HOME'] = fakeHome;
    process.env['HOME'] = root;
  });

  afterEach(async () => {
    if (restoreEnvHome === undefined) delete process.env['ABTARS_HOME'];
    else process.env['ABTARS_HOME'] = restoreEnvHome;
    if (restoreEnvHomeVar !== undefined) process.env['HOME'] = restoreEnvHomeVar;
    // Tear down the whole test root.
    await rm(join(fakeHome, '..'), { recursive: true, force: true });
  });

  it('refuses to overwrite a PATH symlink owned by a different install', async () => {
    // Pre-seed: ~/.local/bin/abtars points at the OTHER install's
    // ~/.abtars/bin/abtars (not ours).
    await symlink(join(otherInstallBin, 'abtars'), join(fakeUserBin, 'abtars'));

    const code = await install({ upgrade: false, force: false, dryRun: false });

    expect(code).toBe(4); // refusal exit
    // Symlink was not touched.
    const { readlink } = await import('node:fs/promises');
    const target = await readlink(join(fakeUserBin, 'abtars'));
    expect(target).toBe(join(otherInstallBin, 'abtars'));
  });

  it('refuses even when the other install symlink is DANGLING', async () => {
    // Regression for the exists() bug: a dangling symlink was reported as
    // "not exists" and then symlink() threw EEXIST mid-install.
    const danglingTarget = join(otherInstallBin, 'abtars');
    // Do NOT create the target — so the symlink is dangling.
    await symlink(danglingTarget, join(fakeUserBin, 'abtars'));

    const code = await install({ upgrade: false, force: false, dryRun: false });

    expect(code).toBe(4);
    // Still dangling, still there.
    const { readlink } = await import('node:fs/promises');
    const target = await readlink(join(fakeUserBin, 'abtars'));
    expect(target).toBe(danglingTarget);
  });

  it('--force overwrites a symlink pointing at a different install', async () => {
    await symlink(join(otherInstallBin, 'abtars'), join(fakeUserBin, 'abtars'));

    const code = await install({ upgrade: false, force: true, dryRun: false });

    expect(code).toBe(0);
    const { readlink } = await import('node:fs/promises');
    const target = await readlink(join(fakeUserBin, 'abtars'));
    expect(target).toBe(join(fakeHome, 'bin', 'abtars'));
  });
});
