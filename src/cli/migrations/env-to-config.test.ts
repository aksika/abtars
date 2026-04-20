import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migration001 } from './001-env-memory-to-config.js';
import { migration002 } from './002-env-skills-to-config.js';

describe('env-to-config migrations (001, 002)', () => {
  let fakeHome: string;
  beforeEach(async () => {
    const base = join(homedir(), '.cache', 'agentbridge-test');
    await mkdir(base, { recursive: true });
    fakeHome = await mkdtemp(join(base, 'envmig-'));
    await mkdir(join(fakeHome, 'config'), { recursive: true });
  });
  afterEach(async () => {
    await rm(fakeHome, { recursive: true, force: true });
  });

  describe('001-env-memory-to-config', () => {
    it('no-op when no legacy file', async () => {
      const r = await migration001.run({ home: fakeHome, dryRun: false });
      expect(r.applied).toBe(false);
      expect(r.message).toMatch(/no legacy/);
    });

    it('moves legacy file to config/', async () => {
      await writeFile(join(fakeHome, '.env.memory'), 'ABMIND_KEY=x\n');
      const r = await migration001.run({ home: fakeHome, dryRun: false });
      expect(r.applied).toBe(true);
      await expect(stat(join(fakeHome, '.env.memory'))).rejects.toThrow();
      await expect(stat(join(fakeHome, 'config', '.env.memory'))).resolves.toBeDefined();
    });

    it('refuses to overwrite existing config/.env.memory', async () => {
      await writeFile(join(fakeHome, '.env.memory'), 'LEGACY=1\n');
      await writeFile(join(fakeHome, 'config', '.env.memory'), 'NEW=2\n');
      const r = await migration001.run({ home: fakeHome, dryRun: false });
      expect(r.applied).toBe(false);
      // Legacy still there, config still has NEW
      await expect(stat(join(fakeHome, '.env.memory'))).resolves.toBeDefined();
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(join(fakeHome, 'config', '.env.memory'), 'utf-8');
      expect(content).toContain('NEW=2');
    });

    it('dry-run reports plan without moving', async () => {
      await writeFile(join(fakeHome, '.env.memory'), 'X=1\n');
      const r = await migration001.run({ home: fakeHome, dryRun: true });
      expect(r.applied).toBe(false);
      expect(r.message).toMatch(/dry-run/);
      await expect(stat(join(fakeHome, '.env.memory'))).resolves.toBeDefined();
    });
  });

  describe('002-env-skills-to-config', () => {
    it('moves legacy file', async () => {
      await writeFile(join(fakeHome, '.env.skills'), 'SKILL=1\n');
      const r = await migration002.run({ home: fakeHome, dryRun: false });
      expect(r.applied).toBe(true);
      await expect(stat(join(fakeHome, 'config', '.env.skills'))).resolves.toBeDefined();
    });

    it('respects dst precedence', async () => {
      await writeFile(join(fakeHome, '.env.skills'), 'OLD=1\n');
      await writeFile(join(fakeHome, 'config', '.env.skills'), 'NEW=1\n');
      const r = await migration002.run({ home: fakeHome, dryRun: false });
      expect(r.applied).toBe(false);
    });
  });
});
