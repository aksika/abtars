/**
 * CLI banner — prints command name + version on every invocation.
 * Shared utility: mirrored in abmind/cli/banner.ts — keep in sync.
 */

import { packagePaths, readManifest } from '../deploy-lib-import.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function cliVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch { return 'unknown'; }
}

export async function printBanner(command: string): Promise<void> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version ?? cliVersion();
  const commit = manifest?.commit ?? '?';
  const display = version.includes(commit) ? version : `${version} (${commit})`;
  process.stdout.write(`abtars ${command}\nVersion: ${display}\n\n`);
}
