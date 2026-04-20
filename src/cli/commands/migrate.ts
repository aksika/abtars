/**
 * `agentbridge migrate` — standalone runner for migrations.
 *
 * Migrations also run automatically at the end of `update` (Phase 1b's
 * update.ts will call runMigrations). This subcommand lets operators
 * re-run or dry-run them independently.
 */

import { packagePaths } from '../deploy-lib-import.js';
import { runMigrations } from '../migrations/index.js';

export interface MigrateOptions {
  readonly dryRun: boolean;
  readonly only?: readonly string[];
}

export async function migrate(opts: MigrateOptions): Promise<number> {
  const paths = packagePaths('agentbridge');
  process.stdout.write(`agentbridge migrate${opts.dryRun ? ' (DRY-RUN)' : ''}\n`);
  process.stdout.write(`  home: ${paths.home}\n\n`);

  const results = await runMigrations({
    home: paths.home,
    dryRun: opts.dryRun,
    only: opts.only,
  });

  if (results.length === 0) {
    process.stdout.write(`No migrations registered.\n`);
    return 0;
  }

  let anyFailed = false;
  for (const r of results) {
    const mark = r.applied ? '✓' : '·';
    process.stdout.write(`  ${mark} ${r.name}: ${r.message}\n`);
    // A migration that throws is already surfaced by runMigrations — but a
    // migration that returns applied=false with an error-like message is
    // worth flagging.
    if (!r.applied && r.message.startsWith('refused:')) anyFailed = true;
  }

  return anyFailed ? 1 : 0;
}
