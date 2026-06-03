import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onboard } from './onboard.js';

/**
 * Onboard has two halves: interactive (clack prompts) and non-interactive
 * (flag-driven). We only test the non-interactive path here — the clack
 * UI is out of scope for automated tests. End-to-end smoke on the
 * interactive path is a manual step on KP.
 */
describe('onboard command (non-interactive)', () => {
  let fakeHome: string;
  let restoreEnv: string | undefined;

  beforeEach(async () => {
    restoreEnv = process.env['ABTARS_HOME'];
    const base = join(homedir(), '.cache', 'abtars-test');
    await mkdir(base, { recursive: true });
    fakeHome = await mkdtemp(join(base, 'onboard-'));
    process.env['ABTARS_HOME'] = fakeHome;

    // Seed what `install` would have created.
    await mkdir(join(fakeHome, 'config'), { recursive: true });
    await writeFile(
      join(fakeHome, 'manifest.json'),
      JSON.stringify({
        package: 'abtars',
        version: '',
        commit: null,
        branch: null,
        packageLockHash: null,
        activatedAt: new Date().toISOString(),
        host: 'test',
        source: 'local',
        migrationsApplied: [],
        priorReleases: [],
      }),
    );
  });

  afterEach(async () => {
    if (restoreEnv === undefined) delete process.env['ABTARS_HOME'];
    else process.env['ABTARS_HOME'] = restoreEnv;
    await rm(fakeHome, { recursive: true, force: true });
  });

  it('refuses without --accept-risk', async () => {
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: false,
      telegramToken: '123:abc',
      telegramChatId: '42',
      force: false,
    });
    expect(code).toBe(4);
  });

  it('accepts no flags (all fields optional now)', async () => {
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      force: false,
    });
    expect(code).toBe(0);
  });

  it('refuses with invalid provider', async () => {
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '123:abc',
      telegramChatId: '42',
      defaultProvider: 'nonsense',
      force: false,
    });
    expect(code).toBe(4);
  });

  it('writes config/.env with owned keys', async () => {
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '123:secret',
      telegramChatId: '4242',
      defaultProvider: 'openrouter',
      defaultModel: 'z-ai/glm-4.6',
      force: false,
    });
    expect(code).toBe(0);
    const env = await readFile(join(fakeHome, 'config', '.env'), 'utf-8');
    expect(env).toMatch(/MAIN_CHAT_ID=4242/);
    expect(env).toMatch(/DEFAULT_PROVIDER=openrouter/);
    expect(env).toMatch(/DEFAULT_MODEL=z-ai\/glm-4\.6/);
    expect(env).not.toMatch(/DISCORD_A2A_CHANNEL_ID=/);
    // Secrets go to secret/ dir
    const token = await readFile(join(fakeHome, 'secret', 'TELEGRAM_BOT_TOKEN'), 'utf-8');
    expect(token).toBe('123:secret');
  });

  it('preserves operator-added lines in .env', async () => {
    // Seed existing .env with a custom line.
    await writeFile(join(fakeHome, 'config', '.env'), 'CUSTOM_OPERATOR_KEY=x\nOTHER=y\n');
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '999:aa',
      telegramChatId: '1',
      defaultProvider: 'anthropic',
      force: true,
    });
    expect(code).toBe(0);
    const env = await readFile(join(fakeHome, 'config', '.env'), 'utf-8');
    expect(env).toContain('CUSTOM_OPERATOR_KEY=x');
    expect(env).toContain('OTHER=y');
    const token = await readFile(join(fakeHome, 'secret', 'TELEGRAM_BOT_TOKEN'), 'utf-8');
    expect(token).toBe('999:aa');
  });

  it('overwrites owned keys but not custom ones on re-run', async () => {
    // First run
    await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '1:a',
      telegramChatId: '1',
      defaultProvider: 'openai',
      force: false,
    });
    // Second run without --force refuses (env already has owned keys)
    const refuseCode = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '2:b',
      telegramChatId: '2',
      defaultProvider: 'anthropic',
      force: false,
    });
    expect(refuseCode).toBe(3);

    // With --force it overwrites
    const code = await onboard({
      nonInteractive: true,
      acceptRisk: true,
      telegramToken: '2:b',
      telegramChatId: '2',
      defaultProvider: 'anthropic',
      force: true,
    });
    expect(code).toBe(0);
    const env = await readFile(join(fakeHome, 'config', '.env'), 'utf-8');
    expect(env).toMatch(/DEFAULT_PROVIDER=anthropic/);
    const token = await readFile(join(fakeHome, 'secret', 'TELEGRAM_BOT_TOKEN'), 'utf-8');
    expect(token).toBe('2:b');
  });

  it('refuses if not installed (no manifest)', async () => {
    const unitialized = await mkdtemp(join(homedir(), '.cache', 'abtars-test', 'empty-'));
    process.env['ABTARS_HOME'] = unitialized;
    try {
      const code = await onboard({
        nonInteractive: true,
        acceptRisk: true,
        telegramToken: '1:a',
        telegramChatId: '1',
        force: false,
      });
      expect(code).toBe(2);
    } finally {
      await rm(unitialized, { recursive: true, force: true });
    }
  });
});
