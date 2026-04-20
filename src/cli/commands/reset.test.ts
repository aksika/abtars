import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reset } from './reset.js';

/**
 * Tests exercise reset against a fake $AGENT_BRIDGE_HOME under ~/.cache/.
 * All destructive paths use --dry-run to assert behavior without actually
 * destroying the test's fixture directory. A single apply test runs
 * end-to-end with --yes + scope=config (narrowest) to confirm wiring works.
 */
describe('reset command', () => {
  let fakeHome: string;
  let restoreEnv: string | undefined;

  beforeEach(async () => {
    restoreEnv = process.env['AGENT_BRIDGE_HOME'];
    const base = join(homedir(), '.cache', 'agentbridge-test');
    await mkdir(base, { recursive: true });
    fakeHome = await mkdtemp(join(base, 'reset-'));
    process.env['AGENT_BRIDGE_HOME'] = fakeHome;

    // Seed a minimal layout: config/, memory/, releases/v1/dist/, current symlink.
    await mkdir(join(fakeHome, 'config'), { recursive: true });
    await writeFile(join(fakeHome, 'config', '.env'), 'FOO=bar\n');
    await mkdir(join(fakeHome, 'memory'), { recursive: true });
    await writeFile(join(fakeHome, 'memory', 'data'), 'x');
    await mkdir(join(fakeHome, 'releases', 'v1', 'dist'), { recursive: true });
  });

  afterEach(async () => {
    if (restoreEnv === undefined) delete process.env['AGENT_BRIDGE_HOME'];
    else process.env['AGENT_BRIDGE_HOME'] = restoreEnv;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('requires --scope', async () => {
    expect(
      await reset({ yes: true, dryRun: false, nonInteractive: true, noBackup: true, force: false }),
    ).toBe(2);
  });

  it('dry-run on config scope lists targets without removing', async () => {
    const exitCode = await reset({
      scope: 'config',
      yes: false,
      dryRun: true,
      nonInteractive: true,
      noBackup: true,
      force: false,
    });
    expect(exitCode).toBe(0);
    // config/ still there
    await expect(stat(join(fakeHome, 'config'))).resolves.toBeDefined();
  });

  it('non-interactive without --yes refuses', async () => {
    const code = await reset({
      scope: 'config',
      yes: false,
      dryRun: false,
      nonInteractive: true,
      noBackup: true,
      force: false,
    });
    expect(code).toBe(4);
    await expect(stat(join(fakeHome, 'config'))).resolves.toBeDefined();
  });

  it('config scope with --yes wipes config/ only', async () => {
    const code = await reset({
      scope: 'config',
      yes: true,
      dryRun: false,
      nonInteractive: true,
      noBackup: true,
      force: false,
    });
    expect(code).toBe(0);
    await expect(stat(join(fakeHome, 'config'))).rejects.toThrow();
    // memory/ preserved
    await expect(stat(join(fakeHome, 'memory', 'data'))).resolves.toBeDefined();
    // releases/ preserved
    await expect(stat(join(fakeHome, 'releases', 'v1', 'dist'))).resolves.toBeDefined();
  });

  it('config+data scope wipes memory/ too', async () => {
    const code = await reset({
      scope: 'config+data',
      yes: true,
      dryRun: false,
      nonInteractive: true,
      noBackup: true,
      force: false,
    });
    expect(code).toBe(0);
    await expect(stat(join(fakeHome, 'config'))).rejects.toThrow();
    await expect(stat(join(fakeHome, 'memory'))).rejects.toThrow();
    // releases/ still there
    await expect(stat(join(fakeHome, 'releases', 'v1', 'dist'))).resolves.toBeDefined();
  });

  it('full scope with --no-backup removes everything', async () => {
    const code = await reset({
      scope: 'full',
      yes: true,
      dryRun: false,
      nonInteractive: true,
      noBackup: true,
      force: false,
    });
    expect(code).toBe(0);
    await expect(stat(fakeHome)).rejects.toThrow();
    // Confirm readdir on parent doesn't show the old dir.
    const parent = join(homedir(), '.cache', 'agentbridge-test');
    const entries = await readdir(parent);
    expect(entries.some((e) => e === fakeHome.split('/').pop())).toBe(false);
  });
});
