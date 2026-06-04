/**
 * `abtars doctor` — thin TS wrapper around scripts/doctor.sh.
 *
 * Per plan v7 Ag2-review round 2: don't port bash-native diagnostic logic
 * to TS. scripts/doctor.sh does pgrep/filesystem/lock inspection well;
 * rewriting duplicates platform detection. Wrapper spawns doctor.sh
 * (installed by the migration into $AB/scripts/), captures exit status +
 * output, pretty-prints, and returns the status.
 *
 * Fallback: if $AB/scripts/doctor.sh isn't present (pre-install, or flat
 * layout pre-migration), execs the repo's scripts/doctor.sh from cwd.
 */

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { packagePaths } from '../deploy-lib-import.js';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function doctor(args: readonly string[] = []): Promise<number> {
  const paths = packagePaths('abtars');
  const installed = join(paths.home, 'scripts', 'doctor.sh');
  const repo = join(process.cwd(), 'scripts', 'doctor.sh');
  const candidate = (await pathExists(installed)) ? installed : (await pathExists(repo)) ? repo : null;

  if (candidate === null) {
    process.stderr.write(
      `doctor.sh not found (looked in ${installed} and ${repo}).\n` +
        `Run from an abtars checkout or after 'abtars install'.\n`,
    );
    return 2;
  }

  return new Promise<number>((resolve) => {
    const child = spawn(candidate, [...args], { stdio: 'inherit', env: process.env });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`doctor.sh spawn failed: ${err.message}\n`);
      resolve(1);
    });
  });
}
