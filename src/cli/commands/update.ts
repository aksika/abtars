import { printBanner } from './banner.js';
/**
 * `abtars update` — unified deploy command.
 * Detects first-time install (no manifest.json) and onboards automatically.
 * #1085: replaces separate install + update commands.
 */
import { deploy } from "../deploy-lib/deploy.js";
import type { SourceName } from "../update-sources/types.js";

export interface UpdateOptions {
  readonly source: SourceName | null;
  readonly localDir?: string;
  readonly skipFreshness?: boolean;
  readonly allowAbmindMismatch: boolean;
  readonly dryRun?: boolean;
  readonly check?: boolean;
}

export async function update(opts: UpdateOptions): Promise<number> {
  await printBanner("update");
  if (!opts.source) {
    process.stderr.write(`No channel specified.\nUsage: abtars update --dev [dir] | --alpha | --stable\n`);
    return 2;
  }

  if (opts.check) {
    // TODO: implement check-for-updates (git fetch --dry-run)
    process.stdout.write("--check not yet implemented in new deploy flow\n");
    return 0;
  }

  if (opts.dryRun) {
    process.stdout.write("--dry-run not yet implemented in new deploy flow\n");
    return 0;
  }

  // Explicit local build (--local <dir> / --dev <dir>): build that checkout
  // in-process. Used by devs and by emergency-update.sh (which already execs a
  // freshly-built bundle). The latest-dev / alpha / stable paths go through the
  // stable bootstrap, which obtains fresh code then execs a fresh __deploy.
  if (opts.localDir) {
    return deploy({ source: opts.source, localDir: opts.localDir, skipFreshness: opts.skipFreshness });
  }

  const { bootstrap } = await import("../bootstrap.js");
  return bootstrap({ channel: opts.source });
}
