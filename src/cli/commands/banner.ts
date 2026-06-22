/**
 * CLI banner — prints command name + version on every invocation.
 */

import { packagePaths, readManifest } from '../deploy-lib-import.js';

export async function printBanner(command: string): Promise<void> {
  const paths = packagePaths('abtars');
  const manifest = await readManifest(paths.manifest);
  const version = manifest?.version ?? 'unknown';
  const commit = manifest?.commit ?? '?';
  process.stdout.write(`abtars ${command}\nVersion: ${version} (${commit})\n\n`);
}
