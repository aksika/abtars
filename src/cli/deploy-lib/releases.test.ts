import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicSwap, configSnapshot, cleanStaleStaging, writeSentinel, readSentinel, clearSentinel } from './releases.js';

describe('deploy-lib/releases', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'releases-test-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('atomicSwap moves staging to app and app to app.prev', () => {
    const app = join(tmp, 'app');
    const appPrev = join(tmp, 'app.prev');
    const appStaging = join(tmp, 'app.staging');

    mkdirSync(app);
    writeFileSync(join(app, 'old.txt'), 'old');
    mkdirSync(appStaging);
    writeFileSync(join(appStaging, 'new.txt'), 'new');

    atomicSwap(app, appPrev, appStaging);

    expect(existsSync(join(app, 'new.txt'))).toBe(true);
    expect(existsSync(join(appPrev, 'old.txt'))).toBe(true);
    expect(existsSync(appStaging)).toBe(false);
  });

  it('atomicSwap works when app does not exist yet (first install)', () => {
    const app = join(tmp, 'app');
    const appPrev = join(tmp, 'app.prev');
    const appStaging = join(tmp, 'app.staging');

    mkdirSync(appStaging);
    writeFileSync(join(appStaging, 'first.txt'), 'first');

    atomicSwap(app, appPrev, appStaging);

    expect(existsSync(join(app, 'first.txt'))).toBe(true);
    expect(existsSync(appPrev)).toBe(false);
  });

  it('atomicSwap removes old app.prev before swap', () => {
    const app = join(tmp, 'app');
    const appPrev = join(tmp, 'app.prev');
    const appStaging = join(tmp, 'app.staging');

    mkdirSync(app);
    mkdirSync(appPrev);
    writeFileSync(join(appPrev, 'ancient.txt'), 'ancient');
    mkdirSync(appStaging);

    atomicSwap(app, appPrev, appStaging);

    // ancient.txt gone, replaced by current app's content
    expect(existsSync(join(appPrev, 'ancient.txt'))).toBe(false);
  });

  it('configSnapshot creates 3-slot rotation', () => {
    const config = join(tmp, 'config');
    mkdirSync(config);
    writeFileSync(join(config, 'transport.json'), '{"v":1}');

    configSnapshot(config);
    expect(existsSync(join(config, '.pre-update', 'transport.json'))).toBe(true);

    writeFileSync(join(config, 'transport.json'), '{"v":2}');
    configSnapshot(config);
    expect(readFileSync(join(config, '.pre-update', 'transport.json'), 'utf-8')).toBe('{"v":2}');
    expect(readFileSync(join(config, '.pre-update.1', 'transport.json'), 'utf-8')).toBe('{"v":1}');

    writeFileSync(join(config, 'transport.json'), '{"v":3}');
    configSnapshot(config);
    expect(readFileSync(join(config, '.pre-update', 'transport.json'), 'utf-8')).toBe('{"v":3}');
    expect(readFileSync(join(config, '.pre-update.1', 'transport.json'), 'utf-8')).toBe('{"v":2}');
    expect(readFileSync(join(config, '.pre-update.2', 'transport.json'), 'utf-8')).toBe('{"v":1}');

    // 4th snapshot drops slot 2
    writeFileSync(join(config, 'transport.json'), '{"v":4}');
    configSnapshot(config);
    expect(readFileSync(join(config, '.pre-update.2', 'transport.json'), 'utf-8')).toBe('{"v":2}');
  });

  it('configSnapshot excludes .pre-update dirs from the copy', () => {
    const config = join(tmp, 'config');
    mkdirSync(config);
    writeFileSync(join(config, 'a.json'), 'a');
    mkdirSync(join(config, '.pre-update'));
    writeFileSync(join(config, '.pre-update', 'old.json'), 'old');

    configSnapshot(config);
    // The snapshot should NOT contain .pre-update subdir
    expect(existsSync(join(config, '.pre-update', '.pre-update'))).toBe(false);
    expect(existsSync(join(config, '.pre-update', 'a.json'))).toBe(true);
  });

  it('cleanStaleStaging removes staging dir', () => {
    const staging = join(tmp, 'app.staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'leftover.txt'), 'x');

    cleanStaleStaging(staging);
    expect(existsSync(staging)).toBe(false);
  });

  it('cleanStaleStaging is no-op if staging does not exist', () => {
    cleanStaleStaging(join(tmp, 'app.staging'));
    // no throw
  });

  it('sentinel write/read/clear cycle', () => {
    writeSentinel(tmp, { version: '1.0.0-abc', previousVersion: '0.9.0-def', startedAt: '2026-06-04T01:00:00Z', status: 'pending' });
    const s = readSentinel(tmp);
    expect(s?.status).toBe('pending');
    expect(s?.version).toBe('1.0.0-abc');

    clearSentinel(tmp, '1.0.0-abc');
    const s2 = readSentinel(tmp);
    expect(s2?.status).toBe('success');
  });

  it('readSentinel returns null when file does not exist', () => {
    expect(readSentinel(tmp)).toBeNull();
  });
});
