/**
 * `agentbridge install [--upgrade]` — first-time setup.
 *
 * Phase 1 behavior:
 *   - No existing ~/.agentbridge: create dirs, seed config/ from .env.example,
 *     create PATH symlinks. Does NOT run onboard (Phase 3).
 *   - Existing ~/.agentbridge with flat layout (pre-158): refuse unless
 *     --upgrade, then run migration 003-flat-to-releases (Phase 1c).
 *   - Existing ~/.agentbridge with new layout: refuse unless --force (which
 *     re-seeds missing config and reconciles symlinks, no code changes).
 */

import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runMigrations } from '../migrations/index.js';
import { emptyManifest, packagePaths, readManifest, resolveUserBinDir, writeManifest } from '../deploy-lib-import.js';

export interface InstallOptions {
  readonly upgrade: boolean;
  readonly force: boolean;
  readonly dryRun: boolean;
}

// Files placed into ~/.agentbridge/bin/ at install time. Each is a thin
// wrapper that invokes `node current/dist/cli/<name>.js "$@"`. Regenerated
// on every install / flat-to-releases migration.
const CLI_WRAPPERS = ['agentbridge', 'agentbridge-browser', 'agentbridge-restart', 'agentbridge-tweet'] as const;

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isSymlink(p: string): Promise<boolean> {
  try {
    const { lstat } = await import('node:fs/promises');
    const s = await lstat(p);
    return s.isSymbolicLink();
  } catch {
    return false;
  }
}

/** True if `~/.agentbridge/dist/` exists without `~/.agentbridge/releases/` — pre-158 layout. */
async function isFlatLayout(home: string): Promise<boolean> {
  const hasDist = await exists(join(home, 'dist'));
  const hasReleases = await exists(join(home, 'releases'));
  return hasDist && !hasReleases;
}

async function createSkeleton(home: string, dryRun: boolean): Promise<void> {
  const dirs = [
    join(home, 'config'),
    join(home, 'logs'),
    join(home, 'memory'),
    join(home, 'reports'),
    join(home, 'received'),
    join(home, 'workspace'),
    join(home, 'backup'),
    join(home, 'bin'),
    join(home, 'releases'),
    join(home, 'skills', 'core'),
    join(home, 'skills', 'personal'),
    join(home, 'skills', 'auto'),
    join(home, 'skills', 'downloaded'),
    join(home, 'agents'),
    join(home, 'tasks'),
    join(home, 'prompts'),
    join(home, 'core'),
  ];
  if (dryRun) {
    process.stdout.write(`[dry-run] mkdir -p:\n  ${dirs.join('\n  ')}\n`);
    return;
  }
  for (const d of dirs) await mkdir(d, { recursive: true });
}

async function seedConfig(repoRoot: string, configDir: string, dryRun: boolean): Promise<readonly string[]> {
  // Minimal seed: copy .env.example → config/.env if config/.env missing.
  // Additional config files (transport.json, models.json, users.json) are
  // operator-provided or created by Phase 3 onboard — we don't seed those.
  const pairs: Array<readonly [string, string]> = [
    [join(repoRoot, '.env.example'), join(configDir, '.env')],
    [join(repoRoot, '.env.skills.example'), join(configDir, '.env.skills')],
  ];
  const seeded: string[] = [];
  for (const [src, dst] of pairs) {
    if (!(await exists(src))) continue;
    if (await exists(dst)) continue;
    if (dryRun) {
      seeded.push(`[dry-run] cp ${src} ${dst}`);
      continue;
    }
    const content = await readFile(src, 'utf-8');
    await writeFile(dst, content, { mode: 0o600 });
    seeded.push(basename(dst));
  }
  return seeded;
}

/**
 * Reconcile a single PATH symlink at ~/.local/bin/<name>.
 * Policy (plan §"PATH symlink collision"):
 *   - Missing  → create
 *   - Symlink pointing into our own ~/.agentbridge/bin/ → overwrite
 *   - Anything else → refuse with message, unless force
 */
async function reconcilePathLink(
  binDir: string,
  userBinDir: string,
  name: string,
  force: boolean,
  dryRun: boolean,
): Promise<{ action: string; message?: string }> {
  const linkPath = join(userBinDir, name);
  const targetPath = join(binDir, name);
  const linkExists = await exists(linkPath);
  if (!linkExists) {
    if (dryRun) return { action: `[dry-run] ln -s ${targetPath} ${linkPath}` };
    await symlink(targetPath, linkPath);
    return { action: `created ${linkPath}` };
  }
  if (await isSymlink(linkPath)) {
    const { readlink, unlink } = await import('node:fs/promises');
    const current = await readlink(linkPath);
    const ownsIt = current === targetPath || current.endsWith(`/.agentbridge/bin/${name}`);
    if (ownsIt) {
      if (dryRun) return { action: `[dry-run] overwrite ${linkPath} (we own it)` };
      await unlink(linkPath);
      await symlink(targetPath, linkPath);
      return { action: `updated ${linkPath}` };
    }
    if (force) {
      if (dryRun) return { action: `[dry-run] --force overwrite ${linkPath} (currently -> ${current})` };
      await unlink(linkPath);
      await symlink(targetPath, linkPath);
      return { action: `forced overwrite ${linkPath} (was -> ${current})` };
    }
    return {
      action: 'refused',
      message: `${linkPath} is a symlink to ${current} (not ours). Pass --force to overwrite.`,
    };
  }
  if (force) {
    if (dryRun) return { action: `[dry-run] --force overwrite ${linkPath} (regular file)` };
    const { unlink } = await import('node:fs/promises');
    await unlink(linkPath);
    await symlink(targetPath, linkPath);
    return { action: `forced overwrite ${linkPath} (was regular file)` };
  }
  return {
    action: 'refused',
    message: `${linkPath} exists as a regular file (not our symlink). Pass --force to overwrite.`,
  };
}

async function writeWrapper(binDir: string, name: string, currentLink: string, dryRun: boolean): Promise<void> {
  const cliFile = name === 'agentbridge' ? 'agentbridge.js' : `${name}.js`;
  const target = join(currentLink, 'dist', 'cli', cliFile);
  const content = `#!/usr/bin/env bash\nexec node "${target}" "$@"\n`;
  const path = join(binDir, name);
  if (dryRun) {
    process.stdout.write(`[dry-run] write wrapper ${path} -> node ${target}\n`);
    return;
  }
  await writeFile(path, content, { mode: 0o755 });
}

function isPathOnPATH(userBinDir: string): boolean {
  const PATH = process.env['PATH'] ?? '';
  return PATH.split(':').some((p) => p === userBinDir);
}

export async function install(opts: InstallOptions): Promise<number> {
  const paths = packagePaths('agentbridge');
  const home = paths.home;
  const userBinDir = resolveUserBinDir();
  const repoRoot = process.cwd();

  const homeExists = await exists(home);
  const flat = homeExists ? await isFlatLayout(home) : false;
  const manifest = homeExists ? await readManifest(paths.manifest) : null;

  if (homeExists && flat && !opts.upgrade) {
    process.stderr.write(
      `Existing ~/.agentbridge uses pre-158 flat layout.\nRe-run with --upgrade to migrate to the versioned-releases layout.\n`,
    );
    return 2;
  }

  if (homeExists && !flat && manifest && !opts.force && !opts.upgrade) {
    process.stderr.write(
      `~/.agentbridge already installed at version ${manifest.version || '(unset)'}.\nUse 'agentbridge update' to upgrade, or --force to re-seed missing config.\n`,
    );
    return 2;
  }

  if (flat && opts.upgrade) {
    process.stdout.write(`Existing flat layout detected. Running migration 003-flat-to-releases...\n`);
    // Safety check: no live processes before migration.
    const { spawnSync } = await import('node:child_process');
    const pgrep = spawnSync('pgrep', ['-f', 'node.*agentbridge'], { encoding: 'utf-8' });
    if (pgrep.status === 0 && pgrep.stdout.trim() !== '') {
      process.stderr.write(
        `Refused: bridge process(es) still running (pids: ${pgrep.stdout.trim().split('\n').join(', ')}).\nStop the watchdog + bridge before running --upgrade.\n`,
      );
      return 3;
    }
    const migrated = await runMigrations({ home, dryRun: opts.dryRun, only: ['003-flat-to-releases'] });
    process.stdout.write(`Migration result: ${migrated.map((m) => `${m.name}=${m.applied ? 'applied' : 'skipped'}`).join(', ')}\n`);
  }

  // Create skeleton (idempotent)
  await createSkeleton(home, opts.dryRun);
  process.stdout.write(`✓ skeleton at ${home}\n`);

  // Seed config from examples (only missing ones)
  const seeded = await seedConfig(repoRoot, paths.config, opts.dryRun);
  if (seeded.length > 0) {
    process.stdout.write(`✓ seeded config: ${seeded.join(', ')}\n`);
  }

  // Write wrappers (always overwrite — they're regenerable thin shims)
  if (!opts.dryRun) {
    await mkdir(paths.bin, { recursive: true });
  }
  for (const name of CLI_WRAPPERS) {
    await writeWrapper(paths.bin, name, paths.current, opts.dryRun);
  }
  process.stdout.write(`✓ wrappers in ${paths.bin}\n`);

  // Reconcile PATH symlinks
  if (!opts.dryRun) await mkdir(userBinDir, { recursive: true });
  const refused: string[] = [];
  for (const name of CLI_WRAPPERS) {
    const r = await reconcilePathLink(paths.bin, userBinDir, name, opts.force, opts.dryRun);
    if (r.action === 'refused') {
      refused.push(r.message ?? name);
    }
  }
  if (refused.length > 0) {
    process.stderr.write(`\nPATH symlink conflicts:\n  ${refused.join('\n  ')}\n`);
    return 4;
  }
  process.stdout.write(`✓ PATH symlinks in ${userBinDir}\n`);

  // Warn if ~/.local/bin not on PATH
  if (!isPathOnPATH(userBinDir)) {
    process.stderr.write(
      `\nWarning: ${userBinDir} is not on $PATH. Add to your shell config:\n  export PATH="${userBinDir}:$PATH"\n`,
    );
  }

  // Initialize manifest if brand-new install
  if (!manifest && !opts.dryRun) {
    await writeManifest(paths.manifest, {
      ...emptyManifest('agentbridge', hostname()),
      version: '',
      preMigrationBackup: flat ? join(dirname(home), '.agentbridge.pre-158.bak') : null,
    });
    process.stdout.write(`✓ manifest initialized at ${paths.manifest}\n`);
  }

  process.stdout.write(`\nInstall complete.\n`);
  if (!manifest || manifest.version === '') {
    process.stdout.write(`Next: 'agentbridge update' to build and activate the first release.\n`);
  }
  return 0;
}
