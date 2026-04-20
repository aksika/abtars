/**
 * agentbridge CLI top-level dispatcher (#158 Phase 1b).
 *
 * Subcommands:
 *   install [--upgrade] [--force]
 *   update [--source local|npm|github] [--from-local]
 *   rollback [--to <version>]
 *   status
 *
 * Phase 2 will add: reset, doctor, onboard, migrate.
 * Phase 1 install intentionally does NOT run onboard — operator seeds
 * config/ from examples only; interactive onboard is Phase 3.
 */

import { doctor } from './commands/doctor.js';
import { install } from './commands/install.js';
import { migrate } from './commands/migrate.js';
import { onboard } from './commands/onboard.js';
import { reset, type ResetScope } from './commands/reset.js';
import { rollback } from './commands/rollback.js';
import { status } from './commands/status.js';
import { update } from './commands/update.js';

type Args = {
  readonly command: string;
  readonly flags: ReadonlyMap<string, string | boolean>;
};

function parseArgs(argv: readonly string[]): Args {
  const command = argv[0] ?? '';
  const flags = new Map<string, string | boolean>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const eqIdx = a.indexOf('=');
      if (eqIdx > 2) {
        flags.set(a.slice(2, eqIdx), a.slice(eqIdx + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    }
  }
  return { command, flags };
}

function printUsage(): void {
  process.stdout.write(
    `agentbridge — install/update CLI (#158)

Usage:
  agentbridge install [--upgrade] [--force]
  agentbridge update  [--source local|npm|github] [--from-local]
  agentbridge rollback [--to <version>]
  agentbridge reset --scope <config|config+data|full> [--yes] [--dry-run] [--no-backup]
  agentbridge migrate [--only <name>] [--dry-run]
  agentbridge doctor [<args passed to doctor.sh>...]
  agentbridge onboard [--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ...]
  agentbridge status

See abproject/docs/plans/158-deploy-rewrite.md for the full contract.
`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'install':
        return await install({
          upgrade: flags.get('upgrade') === true,
          force: flags.get('force') === true,
          dryRun: flags.get('dry-run') === true,
        });
      case 'update':
        return await update({
          source: (flags.get('source') as 'local' | 'npm' | 'github' | undefined) ?? 'local',
          fromLocal: flags.get('from-local') === true,
          allowAbmindMismatch: flags.get('allow-abmind-mismatch') === true,
        });
      case 'rollback':
        return await rollback({
          to: typeof flags.get('to') === 'string' ? (flags.get('to') as string) : undefined,
        });
      case 'reset':
        return await reset({
          scope: flags.get('scope') as ResetScope | undefined,
          yes: flags.get('yes') === true,
          dryRun: flags.get('dry-run') === true,
          nonInteractive: flags.get('non-interactive') === true,
          noBackup: flags.get('no-backup') === true,
          force: flags.get('force') === true,
        });
      case 'migrate':
        return await migrate({
          dryRun: flags.get('dry-run') === true,
          only: typeof flags.get('only') === 'string' ? [flags.get('only') as string] : undefined,
        });
      case 'doctor':
        // Pass remaining --flags through to doctor.sh. Primitive pass-through:
        // anything after 'doctor' except recognized flags goes to the script.
        return await doctor(argv.slice(1).filter((a) => a !== ''));
      case 'onboard':
        return await onboard({
          nonInteractive: flags.get('non-interactive') === true,
          acceptRisk: flags.get('accept-risk') === true,
          telegramToken: typeof flags.get('telegram-token') === 'string' ? (flags.get('telegram-token') as string) : undefined,
          telegramChatId: typeof flags.get('telegram-chat-id') === 'string' ? (flags.get('telegram-chat-id') as string) : undefined,
          defaultProvider: typeof flags.get('default-provider') === 'string' ? (flags.get('default-provider') as string) : undefined,
          defaultModel: typeof flags.get('default-model') === 'string' ? (flags.get('default-model') as string) : undefined,
          discordA2aChannel: typeof flags.get('discord-a2a-channel') === 'string' ? (flags.get('discord-a2a-channel') as string) : undefined,
          force: flags.get('force') === true,
        });
      case 'status':
        return await status();
      case '':
      case 'help':
      case '--help':
      case '-h':
        printUsage();
        return 0;
      default:
        process.stderr.write(`unknown subcommand: ${command}\n\n`);
        printUsage();
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

// Direct-run guard: works when invoked as `node dist/cli/agentbridge.js` AND
// as `agentbridge` (npm-installed bin). Not executed under vitest.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('agentbridge.js') ||
    process.argv[1].endsWith('agentbridge') ||
    process.argv[1].endsWith('agentbridge.ts'));

if (isDirectRun && process.env['VITEST'] === undefined) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
