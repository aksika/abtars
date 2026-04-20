/**
 * Migration 003: flat layout → versioned releases (cutover for #158).
 *
 * Runs once per host, via `agentbridge install --upgrade`. Detects the
 * pre-158 layout (`$AB/dist/` flat, no `$AB/releases/`) and migrates in
 * place after a mandatory filesystem backup.
 *
 * Precondition (checked by install.ts BEFORE invoking us): bridge/watchdog
 * not running. We add a second check here (defense in depth) and refuse if
 * a live process is detected.
 *
 * Steps (per plan v7 §"Cutover"):
 *   1. Detect flat layout (guard)
 *   2. Defensive process check
 *   3. cp -a $AB → $AB.pre-158.bak (automated, not optional)
 *   4. Determine version tag from git SHA or fallback to timestamp
 *   5. mv $AB/dist → $AB/releases/<version>/dist
 *   6. Back up any existing $AB/bin/ to $backup/bin.pre-158.bak/,
 *      regenerate with thin wrappers. Warn on non-wrapper files.
 *   7. Install new launcher scripts ($AB/agentbridge.sh, watchdog.sh,
 *      browser-patchright.sh) from the repo.
 *   8. Write initial manifest.json.
 */

import { spawnSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  emptyManifest,
  packagePaths,
  safeCopyTree,
  writeManifest,
} from '../deploy-lib-import.js';
import type { Migration, MigrationContext, MigrationResult } from './index.js';

const LAUNCHER_SCRIPTS = ['agentbridge.sh', 'watchdog.sh', 'browser-patchright.sh'] as const;
// Wrappers we own — any other file in bin/ is operator-owned and gets preserved.
const OWNED_WRAPPERS = new Set([
  'agentbridge',
  'agentbridge-browser',
  'agentbridge-restart',
  'agentbridge-tweet',
]);

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isFlatLayout(home: string): Promise<boolean> {
  const hasDist = await exists(join(home, 'dist'));
  const hasReleases = await exists(join(home, 'releases'));
  return hasDist && !hasReleases;
}

function runCmd(cmd: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf-8' });
  return { status: r.status ?? -1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function refuseIfProcessRunning(): string | null {
  // Match only the long-running bridge entrypoints (current or flat layout),
  // NOT short-lived CLI invocations like `agentbridge install` or tests.
  const r = runCmd('pgrep', ['-f', 'node.*\\.agentbridge.*dist/main\\.js']);
  if (r.status === 0 && r.stdout !== '') {
    return `bridge process(es) still running (pids: ${r.stdout.split('\n').join(', ')})`;
  }
  return null;
}

function deriveVersion(repoRoot: string): string {
  const r = runCmd('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD']);
  if (r.status === 0 && /^[0-9a-f]{7,}$/.test(r.stdout)) {
    // Also pull package.json version for the prefix.
    try {
      // Sync read in a sync context; file is tiny.
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { version?: string };
      if (typeof pkg.version === 'string') return `${pkg.version}-${r.stdout}`;
    } catch {
      /* ignore */
    }
    return `pre-158-${r.stdout}`;
  }
  // Fallback: timestamp tag
  return `pre-158-${Math.floor(Date.now() / 1000)}`;
}

async function backupDir(home: string, dryRun: boolean): Promise<string> {
  const backup = join(dirname(home), `${basename(home)}.pre-158.bak`);
  if (dryRun) return backup;
  if (await exists(backup)) {
    // Prior failed attempt: refuse rather than silently merge.
    throw new Error(`Backup destination already exists: ${backup}. Remove it or restore, then retry.`);
  }
  // safeCopyTree skips sockets/FIFOs/devices. Real runtimes contain UNIX
  // sockets (e.g. browser-socket/browser.sock) that Node's plain cp refuses
  // to handle with EINVAL.
  await safeCopyTree(home, backup, { preserveTimestamps: true });
  return backup;
}

async function writeWrapper(binDir: string, name: string): Promise<void> {
  const cliFile = name === 'agentbridge' ? 'agentbridge.js' : `${name}.js`;
  // Use absolute path to current symlink. When $AGENT_BRIDGE_HOME is set, we
  // rely on $HOME expansion happening once at wrapper creation time.
  const target = join('$HOME', '.agentbridge', 'current', 'dist', 'cli', cliFile);
  // Raw shell: quote target to allow $HOME expansion at invocation.
  const content = `#!/usr/bin/env bash\nexec node "${target}" "$@"\n`;
  await writeFile(join(binDir, name), content, { mode: 0o755 });
}

async function handleExistingBin(
  binDir: string,
  backupBinDir: string,
  dryRun: boolean,
): Promise<string[]> {
  if (!(await exists(binDir))) return [];
  const entries = await readdir(binDir);
  const nonWrappers: string[] = [];
  if (dryRun) {
    for (const e of entries) {
      if (!OWNED_WRAPPERS.has(e)) nonWrappers.push(e);
    }
    return nonWrappers;
  }
  // Move entire bin/ to backup, then we'll regenerate wrappers.
  await mkdir(backupBinDir, { recursive: true });
  for (const e of entries) {
    if (!OWNED_WRAPPERS.has(e)) nonWrappers.push(e);
    await rename(join(binDir, e), join(backupBinDir, e));
  }
  return nonWrappers;
}

async function installLauncherScripts(
  repoRoot: string,
  home: string,
  dryRun: boolean,
): Promise<readonly string[]> {
  const installed: string[] = [];
  if (dryRun) return LAUNCHER_SCRIPTS.map((n) => `[dry-run] ${n}`);
  // Launchers go directly in $AB/ (not $AB/scripts/) so watchdog/launchd refs
  // don't need to learn a new path. Preserve the repo's $AB/scripts/ copy too
  // for parity with the old deploy, but primary references are at the root.
  const scriptsDir = join(home, 'scripts');
  await mkdir(scriptsDir, { recursive: true });
  for (const name of LAUNCHER_SCRIPTS) {
    const src = join(repoRoot, 'scripts', name);
    if (!(await exists(src))) continue;
    const content = await readFile(src, 'utf-8');
    await writeFile(join(home, name), content, { mode: 0o755 });
    await writeFile(join(scriptsDir, name), content, { mode: 0o755 });
    installed.push(name);
  }
  return installed;
}

async function moveDist(home: string, version: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const releaseDir = join(home, 'releases', version);
  await mkdir(releaseDir, { recursive: true });
  await rename(join(home, 'dist'), join(releaseDir, 'dist'));
}

async function activateCurrent(home: string, version: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  const { symlink, unlink } = await import('node:fs/promises');
  const currentLink = join(home, 'current');
  // Might not exist, or might be a stale symlink from an earlier aborted run.
  try {
    await unlink(currentLink);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Could be a regular directory (operator weirdness). Refuse to touch.
      const s = await lstat(currentLink).catch(() => null);
      if (s && !s.isSymbolicLink()) {
        throw new Error(`${currentLink} exists and is not a symlink — refusing to overwrite`);
      }
      throw err;
    }
  }
  await symlink(join('releases', version), currentLink);
}

export const migration003: Migration = {
  name: '003-flat-to-releases',
  async run(ctx: MigrationContext): Promise<MigrationResult> {
    const home = ctx.home;

    if (!(await isFlatLayout(home))) {
      return {
        name: this.name,
        applied: false,
        message: 'not applicable (flat layout not detected)',
      };
    }

    const procError = refuseIfProcessRunning();
    if (procError) {
      return {
        name: this.name,
        applied: false,
        message: `refused: ${procError}. Stop the bridge/watchdog and re-run.`,
      };
    }

    // Step 3: backup.
    const backup = await backupDir(home, ctx.dryRun);

    // Step 4: version tag. Repo root is cwd (install runs from the checkout).
    const version = deriveVersion(process.cwd());

    // Step 5: move dist/
    await moveDist(home, version, ctx.dryRun);

    // Step 6: bin/
    const paths = packagePaths('agentbridge');
    const backupBinDir = join(backup, 'bin.pre-158.bak');
    const nonWrappers = await handleExistingBin(paths.bin, backupBinDir, ctx.dryRun);
    if (!ctx.dryRun) {
      await mkdir(paths.bin, { recursive: true });
      for (const name of OWNED_WRAPPERS) {
        await writeWrapper(paths.bin, name);
      }
    }

    // Step 7: activate current symlink.
    await activateCurrent(home, version, ctx.dryRun);

    // Step 8: launchers from repo.
    const launchers = await installLauncherScripts(process.cwd(), home, ctx.dryRun);

    // Step 9: initial manifest.
    if (!ctx.dryRun) {
      await writeManifest(paths.manifest, {
        ...emptyManifest('agentbridge', hostname()),
        version,
        commit: deriveVersion(process.cwd()).split('-').pop() ?? null,
        source: 'local',
        activatedAt: new Date().toISOString(),
        preMigrationBackup: backup,
        migrationsApplied: [this.name],
      });
    }

    const warnings: string[] = [];
    if (nonWrappers.length > 0) {
      warnings.push(
        `preserved ${nonWrappers.length} non-wrapper file(s) from bin/: ${nonWrappers.join(', ')} → ${backupBinDir}`,
      );
    }

    return {
      name: this.name,
      applied: true,
      message: [
        `migrated flat → releases/${version}`,
        `backup at ${backup}`,
        `launchers: ${launchers.join(', ') || '(none)'}`,
        ...warnings,
      ].join('; '),
    };
  },
};
