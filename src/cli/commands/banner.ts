/**
 * CLI banner — prints command name + version on every invocation.
 * Shared utility: mirrored in abmind/cli/banner.ts — keep in sync.
 */

import { packagePaths, readManifest } from '../deploy-lib-import.js';

export async function printBanner(command: string): Promise<void> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version ?? 'unknown';
  const commit = manifest?.commit ?? '?';
  const display = version.includes(commit) ? version : `${version} (${commit})`;
  process.stdout.write(`abtars ${command}\nVersion: ${display}\n\n`);
}
