import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from './abtars.js';
import { deployActivationCli } from './deploy-lib/deploy.js';

const here = dirname(fileURLToPath(import.meta.url));

describe('#1237 bootstrap / __deploy split', () => {
  it('bootstrap.ts is a minimal old-code surface — no components/ imports', () => {
    // The bootstrap runs as OLD code; keeping it free of business logic is what
    // makes it stable enough that it cannot rot and brick updates.
    const src = readFileSync(join(here, 'bootstrap.ts'), 'utf-8');
    expect(src).not.toMatch(/from ["'][^"']*\/components\//);
  });

  it('__deploy requires --staged (returns 2, runs before any side effect)', async () => {
    expect(await deployActivationCli(new Map())).toBe(2);
  });

  it('__deploy ignores unknown flags (forward-compatible contract)', async () => {
    // An old bootstrap may pass flags a newer __deploy does not know, and vice
    // versa. Unknown keys must not satisfy or break the required-arg check.
    expect(await deployActivationCli(new Map([['futureflag', 'x'], ['another', true]]))).toBe(2);
  });

  it('__deploy is dispatchable via the CLI but hidden from help', async () => {
    // Dispatchable: routes to deployActivationCli; missing --staged → exit 2.
    expect(await main(['__deploy'])).toBe(2);
    // Hidden: never advertised in usage text.
    const dispatcherSrc = readFileSync(join(here, 'abtars.ts'), 'utf-8');
    const usageStart = dispatcherSrc.indexOf('function printUsage');
    const usageEnd = dispatcherSrc.indexOf('export async function main');
    const usageBlock = dispatcherSrc.slice(usageStart, usageEnd);
    expect(usageBlock).not.toContain('__deploy');
  });
});

// #1237 Stage 2 Task 8 — chicken-and-egg fail-safe proof.
// A broken __deploy payload (staged release with no entry point) must be refused
// BEFORE any filesystem swap, so the running release keeps serving. That fail-safe
// is what makes a buggy __deploy non-bricking: the next update runs the fixed
// __deploy because activation always runs fresh. (The full broken→update→fixed
// cycle is e2e, Stage 2 Task 10; this is the unit-level proof of the no-swap half.)
describe('#1237 chicken-and-egg — broken __deploy is fail-safe', () => {
  let home: string;
  const prevHome = process.env['ABTARS_HOME'];
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'abtars-1237-'));
    process.env['ABTARS_HOME'] = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['ABTARS_HOME'];
    else process.env['ABTARS_HOME'] = prevHome;
  });

  it('missing entry point → __deploy exits 1 and swaps nothing (no brick)', async () => {
    // Staged release exists but has no bundle/abtars.js — models a broken payload.
    const staged = join(home, 'staged-broken');
    mkdirSync(staged, { recursive: true });

    const code = await deployActivationCli(new Map<string, string | boolean>([
      ['staged', staged],
      ['version', '0.0.0-broken'],
      ['commit', 'broken123'],
      ['channel', 'dev'],
    ]));

    expect(code).toBe(1);                                       // activation refused
    expect(existsSync(join(home, 'manifest.json'))).toBe(false); // no manifest written
    expect(existsSync(join(home, 'deploy.state'))).toBe(false);  // no deploy.state
    // The entry-point check (deploy.ts) returns before Step 3 (mkdir releasesDir),
    // so the real ~/.abtars-releases + ~/.local/bin are never touched.
  });
});
