import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
