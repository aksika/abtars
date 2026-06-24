/**
 * abtars CLI top-level dispatcher.
 *
 * Subcommands:
 *   install [--upgrade] [--force]
 *   update [--dev [DIR] | --alpha | --stable]
 *   rollback [--to <version>]
 *   status
 */

process.umask(0o077); // #441: all runtime files 600, dirs 700
import { doctor } from './commands/doctor.js';
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
  abtars update  [--dev [DIR] | --alpha | --stable]
  abtars rollback [--to <version>]
  abtars backup [--config] [--encrypt] [--output <dir>] [--prune-days N]
  abtars restore <file.zip|.7z|.abm|.enc> [--config] [--passphrase <p>]
  abtars doctor [<args passed to doctor.sh>...]
  abtars install [--non-interactive --accept-risk --telegram-token ... --telegram-chat-id ...]
  abtars restart [--cold]
  abtars start
  abtars stop
  abtars status
  abtars logs
  abtars config
  abtars deps [list|install|remove]
`,
  );
}

export async function main(argv: readonly string[]): Promise<number> {
  // Handle --version before parsing (it looks like a command to parseArgs)
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    try {
      const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8'));
      process.stdout.write(`${pkg.version}\n`);
    } catch {
      process.stdout.write('unknown\n');
    }
    return 0;
  }

  const { command, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'install':
        return await onboard({
          nonInteractive: flags.get('non-interactive') === true,
          acceptRisk: flags.get('accept-risk') === true,
          telegramToken: typeof flags.get('telegram-token') === 'string' ? (flags.get('telegram-token') as string) : undefined,
          telegramChatId: typeof flags.get('telegram-chat-id') === 'string' ? (flags.get('telegram-chat-id') as string) : undefined,
          defaultProvider: typeof flags.get('default-provider') === 'string' ? (flags.get('default-provider') as string) : undefined,
          defaultModel: typeof flags.get('default-model') === 'string' ? (flags.get('default-model') as string) : undefined,
          apiKey: typeof flags.get('api-key') === 'string' ? (flags.get('api-key') as string) : undefined,
          discordA2aChannel: typeof flags.get('discord-a2a-channel') === 'string' ? (flags.get('discord-a2a-channel') as string) : undefined,
          userName: typeof flags.get('user-name') === 'string' ? (flags.get('user-name') as string) : undefined,
          instanceName: typeof flags.get('instance-name') === 'string' ? (flags.get('instance-name') as string) : undefined,
          passphrase: typeof flags.get('passphrase') === 'string' ? (flags.get('passphrase') as string) : undefined,
          force: flags.get('force') === true,
        });
      case 'uninstall':
        return await uninstall({ yes: flags.get('yes') === true });
      case 'update': {
        // Determine channel: --dev [dir], --alpha, --stable (hidden: --local [dir], --source local|npm)
        let source: 'dev' | 'alpha' | 'stable' | null = null;
        let localDir: string | undefined;
        if (flags.get('dev') === true || typeof flags.get('dev') === 'string') {
          source = 'dev';
          if (typeof flags.get('dev') === 'string') localDir = flags.get('dev') as string;
        } else if (flags.get('alpha') === true) {
          source = 'alpha';
        } else if (flags.get('stable') === true) {
          source = 'stable';
        } else if (flags.has('local') || flags.get('source') === 'local') {
          // Hidden alias: --local [dir] or --source local
          source = 'dev';
          if (typeof flags.get('local') === 'string') localDir = flags.get('local') as string;
        } else if (flags.get('source') === 'npm') {
          // Hidden alias: --source npm → alpha
          source = 'alpha';
        }
        return await update({
          source,
          localDir,
          skipFreshness: source === 'dev',
          allowAbmindMismatch: flags.get('allow-abmind-mismatch') === true,
        });
      }
      case 'rollback':
        return await rollback({ to: typeof flags.get('to') === 'string' ? Number(flags.get('to')) : undefined });
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
      case 'status':
        return await status();
      case 'restart':
        return await restart({ cold: flags.get('cold') === true });
      case 'stop':
        return await stop({});
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
      case 'orc': {
        const { orc: orcCmd } = await import('./commands/orc.js');
        return await orcCmd(argv.slice(1));
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
