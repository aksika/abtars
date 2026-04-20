import { mkdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration003 } from './003-flat-to-releases.js';

/**
 * Uses a throwaway dir under $HOME (not /tmp — cleanup.isUnsafeRemovalTarget
 * rejects /tmp paths). AGENT_BRIDGE_HOME is monkey-patched for the test.
 */
describe('migration 003-flat-to-releases', () => {
  let fakeHome: string;
  let restoreEnv: string | undefined;
  beforeEach(async () => {
    restoreEnv = process.env['AGENT_BRIDGE_HOME'];
    const base = join(homedir(), '.cache', 'agentbridge-test');
    await mkdir(base, { recursive: true });
    // Unique per test
    const { mkdtemp } = await import('node:fs/promises');
    fakeHome = await mkdtemp(join(base, 'mig003-'));
    process.env['AGENT_BRIDGE_HOME'] = fakeHome;
  });
  afterEach(async () => {
    if (restoreEnv === undefined) delete process.env['AGENT_BRIDGE_HOME'];
    else process.env['AGENT_BRIDGE_HOME'] = restoreEnv;
    await rm(fakeHome, { recursive: true, force: true });
    await rm(`${fakeHome}.pre-158.bak`, { recursive: true, force: true });
  });

  it('skips if flat layout not detected', async () => {
    const result = await migration003.run({ home: fakeHome, dryRun: false });
    expect(result.applied).toBe(false);
    expect(result.message).toMatch(/not applicable/);
  });

  it('migrates a fake flat layout to releases/<version>/dist + manifest', async () => {
    // Seed a flat layout
    await mkdir(join(fakeHome, 'dist'), { recursive: true });
    await writeFile(join(fakeHome, 'dist', 'main.js'), 'console.log("hi");');
    await mkdir(join(fakeHome, 'bin'), { recursive: true });
    await writeFile(join(fakeHome, 'bin', 'custom-operator-tool'), '#!/bin/sh\necho custom\n', { mode: 0o755 });

    const result = await migration003.run({ home: fakeHome, dryRun: false });

    expect(result.applied).toBe(true);
    expect(result.message).toMatch(/migrated flat/);
    // dist/ moved into releases/<version>/
    await expect(stat(join(fakeHome, 'dist'))).rejects.toThrow();
    const { readdir } = await import('node:fs/promises');
    const releases = await readdir(join(fakeHome, 'releases'));
    expect(releases.length).toBe(1);
    const version = releases[0]!;
    await expect(stat(join(fakeHome, 'releases', version, 'dist', 'main.js'))).resolves.toBeDefined();

    // current symlink
    const target = await readlink(join(fakeHome, 'current'));
    expect(target).toBe(join('releases', version));

    // backup exists and includes bin/custom-operator-tool
    await expect(stat(`${fakeHome}.pre-158.bak/bin.pre-158.bak/custom-operator-tool`)).resolves.toBeDefined();
    expect(result.message).toMatch(/custom-operator-tool/);

    // manifest is written
    const manifest = JSON.parse(await readFile(join(fakeHome, 'manifest.json'), 'utf-8'));
    expect(manifest.version).toBe(version);
    expect(manifest.package).toBe('agentbridge');
    expect(manifest.migrationsApplied).toContain('003-flat-to-releases');
    expect(manifest.preMigrationBackup).toBe(`${fakeHome}.pre-158.bak`);

    // bin/ regenerated with owned wrappers
    await expect(stat(join(fakeHome, 'bin', 'agentbridge'))).resolves.toBeDefined();
  });

  it('refuses if backup destination already exists', async () => {
    await mkdir(join(fakeHome, 'dist'));
    await mkdir(`${fakeHome}.pre-158.bak`);
    await expect(migration003.run({ home: fakeHome, dryRun: false })).rejects.toThrow(/already exists/);
  });
});
