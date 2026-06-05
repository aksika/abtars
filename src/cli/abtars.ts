/**
 * abtars CLI top-level dispatcher (#158 Phase 1b).
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

process.umask(0o077); // #441: all runtime files 600, dirs 700
import { doctor } from './commands/doctor.js';
import { install } from './commands/install.js';
import { uninstall } from './commands/uninstall.js';
import { backup } from './commands/backup.js';
import { onboard } from './commands/onboard.js';
import { rollback } from './commands/rollback.js';
import { restart } from './commands/restart.js';
import { status } from './commands/status.js';
import { stop } from './commands/stop.js';
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
    `abtars — install/update CLI (#158)

Usage:
  abtars install [--force] [--mode=simple|supervised] [--restore <backup.zip>]
  abtars uninstall [--yes]
  abtars update  [--source local|npm|github] [--from-local]
  abtars rollback [--to <version>]
  abtars backup [--config] [--encrypt] [--output <dir>] [--prune-days N]
  abtars restore <file.zip|.7z|.abm|.enc> [--config] [--passphrase <p>]
  abtars doctor [<args passed to doctor.sh>...]
  abtars onboard [--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ...]
  abtars restart [--cold]
  abtars start
  abtars stop [--force]
  abtars status
  abtars logs
  abtars config
`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'install':
        return await install({
          restore: typeof flags.get('restore') === 'string' ? (flags.get('restore') as string) : undefined,
          force: flags.get('force') === true,
          dryRun: flags.get('dry-run') === true,
          mode: flags.get('mode') === 'simple' ? 'simple' : flags.get('mode') === 'supervised' ? 'supervised' : undefined,
        });
      case 'uninstall':
        return await uninstall({ yes: flags.get('yes') === true });
      case 'update':
        return await update({
          source: (flags.get('source') as 'local' | 'npm' | 'github' | undefined) ?? 'local',
          fromLocal: flags.get('from-local') === true,
          allowAbmindMismatch: flags.get('allow-abmind-mismatch') === true,
        });
      case 'rollback':
        return await rollback();
      case 'backup':
        return await backup({
          config: flags.get('config') === true,
          encrypt: flags.get('encrypt') === true,
          outputDir: typeof flags.get('output') === 'string' ? (flags.get('output') as string) : undefined,
          pruneDays: typeof flags.get('prune-days') === 'string' ? Number(flags.get('prune-days')) : undefined,
        });
      case 'restore': {
        const { restore } = await import('./commands/restore.js');
        return await restore(argv[1] ?? '', {
          config: flags.get('config') === true,
          passphrase: typeof flags.get('passphrase') === 'string' ? (flags.get('passphrase') as string) : undefined,
        });
      }
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
          userName: typeof flags.get('user-name') === 'string' ? (flags.get('user-name') as string) : undefined,
          force: flags.get('force') === true,
        });
      case 'status':
        return await status();
      case 'restart':
        return await restart({ cold: flags.get('cold') === true });
      case 'stop':
        return await stop({ force: flags.get('force') === true });
      case 'start': {
        const { start: startCmd } = await import('./commands/start.js');
        return await startCmd();
      }
      case 'daemon': {
        const { daemon: daemonCmd } = await import('./commands/daemon.js');
        return await daemonCmd(argv.slice(1));
      }
      case 'deps': {
        const { deps: depsCmd } = await import('./commands/deps.js');
        return await depsCmd(argv.slice(1));
      }
      case 'logs': {
        const { logs } = await import('./commands/logs.js');
        return await logs();
      }
      case 'config': {
        const { configShow } = await import('./commands/config-show.js');
        return await configShow();
      }
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

// Direct-run guard: works when invoked as `node dist/cli/abtars.js` AND
// as `abtars` (npm-installed bin). Not executed under vitest.
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('abtars.js') ||
    process.argv[1].endsWith('abtars-cli.js') ||
    process.argv[1].endsWith('abtars') ||
    process.argv[1].endsWith('abtars.ts'));

if (isDirectRun && process.env['VITEST'] === undefined) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
