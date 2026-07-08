import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packagePaths, resolveAbmindHome, resolveAbtarsHome, resolveReleasesDir, resolveUserBinDir } from './paths.js';

describe('deploy-lib/paths', () => {
  const originalBridge = process.env['ABTARS_HOME'];
  const originalAbmind = process.env['ABMIND_HOME'];
  const originalReleases = process.env['ABTARS_RELEASES'];
  const originalBin = process.env['ABTARS_BIN'];

  afterEach(() => {
    if (originalBridge === undefined) delete process.env['ABTARS_HOME'];
    else process.env['ABTARS_HOME'] = originalBridge;
    if (originalAbmind === undefined) delete process.env['ABMIND_HOME'];
    else process.env['ABMIND_HOME'] = originalAbmind;
    if (originalReleases === undefined) delete process.env['ABTARS_RELEASES'];
    else process.env['ABTARS_RELEASES'] = originalReleases;
    if (originalBin === undefined) delete process.env['ABTARS_BIN'];
    else process.env['ABTARS_BIN'] = originalBin;
  });

  it('resolveAbtarsHome defaults to ~/.abtars', () => {
    delete process.env['ABTARS_HOME'];
    expect(resolveAbtarsHome()).toBe(join(homedir(), '.abtars'));
  });

  it('resolveAbtarsHome honors ABTARS_HOME override', () => {
    process.env['ABTARS_HOME'] = '/custom/bridge';
    expect(resolveAbtarsHome()).toBe('/custom/bridge');
  });

  it('resolveAbmindHome honors ABMIND_HOME override', () => {
    process.env['ABMIND_HOME'] = '/custom/abmind';
    expect(resolveAbmindHome()).toBe('/custom/abmind');
  });

  it('resolveReleasesDir defaults to ~/.abtars-releases', () => {
    delete process.env['ABTARS_RELEASES'];
    expect(resolveReleasesDir()).toBe(join(homedir(), '.abtars-releases'));
  });

  it('resolveReleasesDir honors ABTARS_RELEASES override', () => {
    process.env['ABTARS_RELEASES'] = '/tmp/test-releases';
    expect(resolveReleasesDir()).toBe('/tmp/test-releases');
  });

  it('resolveUserBinDir defaults to ~/.local/bin', () => {
    delete process.env['ABTARS_BIN'];
    expect(resolveUserBinDir()).toBe(join(homedir(), '.local', 'bin'));
  });

  it('resolveUserBinDir honors ABTARS_BIN override', () => {
    process.env['ABTARS_BIN'] = '/tmp/test-bin';
    expect(resolveUserBinDir()).toBe('/tmp/test-bin');
  });

  it('packagePaths composes all sub-paths under home and releasesDir', () => {
    process.env['ABTARS_HOME'] = '/x/ab';
    process.env['ABTARS_RELEASES'] = '/x/releases';
    const p = packagePaths('abtars');
    expect(p.home).toBe('/x/ab');
    expect(p.config).toBe('/x/ab/config');
    expect(p.app).toBe('/x/ab/app');
    expect(p.appPrev).toBe('/x/ab/app.prev');
    expect(p.appStaging).toBe('/x/releases/app.staging');
    expect(p.bin).toBe(join(homedir(), '.local', 'bin'));
    expect(p.manifest).toBe('/x/ab/manifest.json');
    expect(p.lock).toBe('/x/ab/.update.lock');
  });

  it('packagePaths composes releasesDir from env', () => {
    process.env['ABTARS_RELEASES'] = '/tmp/test-releases';
    const p = packagePaths('abtars');
    expect(p.releasesDir).toBe('/tmp/test-releases');
    expect(p.releasesCurrentLink).toBe('/tmp/test-releases/current');
    expect(p.releasesHistory).toBe('/tmp/test-releases/history.json');
    expect(p.releasesSrc).toBe('/tmp/test-releases/src');
  });

  it('circuit-breaker: default resolution matches legacy hardcoded paths', () => {
    delete process.env['ABTARS_HOME'];
    delete process.env['ABTARS_RELEASES'];
    // Legacy: process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "/tmp", ".abtars")
    // New: resolveAbtarsHome() — same logic via homedir()
    expect(resolveAbtarsHome()).toBe(join(homedir(), '.abtars'));
    // Legacy: resolve(homedir(), ".abtars-releases")
    // New: resolveReleasesDir()
    expect(resolveReleasesDir()).toBe(join(homedir(), '.abtars-releases'));
  });

  it('circuit-breaker: env overrides take effect', () => {
    process.env['ABTARS_HOME'] = '/test/abtars';
    process.env['ABTARS_RELEASES'] = '/test/releases';
    expect(resolveAbtarsHome()).toBe('/test/abtars');
    expect(resolveReleasesDir()).toBe('/test/releases');
  });
});
