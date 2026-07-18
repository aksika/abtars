/**
 * `abtars status` — operator-facing status. Thin wrapper around
 * `getStatus()` (one data function) + `renderOperatorStatus()` (CLI renderer).
 */

import { printBanner } from './banner.js';
import { getStatus, renderOperatorStatus } from '../../components/status.js';
import { packagePaths, readSentinel } from '../deploy-lib-import.js';

export async function status(args: string[] = []): Promise<number> {
  const json = args.includes("--json");
  if (!json) await printBanner("status");

  const paths = packagePaths('abtars');
  const view = await getStatus();

  if (json) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n");
  } else {
    process.stdout.write(renderOperatorStatus(view) + "\n");
  }

  // Sentinel warning (kept here, not in renderer — runtime concern for CLI exit code)
  const sentinel = readSentinel(paths.home);
  if (sentinel?.status === 'pending') {
    const age = Date.now() - new Date(sentinel.startedAt).getTime();
    if (age > 5 * 60_000) {
      process.stderr.write(`\n⚠️ Last update (${sentinel.version}) may have failed — bridge never confirmed boot.\n`);
      return 1;
    }
  }

  if (!view.appPresent) {
    process.stderr.write(`\n⚠️ app/ directory missing. Run 'abtars update' to deploy.\n`);
    return 1;
  }

  return view.warnings.length > 0 ? 1 : 0;
}
