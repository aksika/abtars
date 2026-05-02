/**
 * `abtars install [--upgrade]` — first-time setup.
 *
 * Phase 1 behavior:
 *   - No existing ~/.abtars: create dirs, seed config/ from .env.example,
 *     create PATH symlinks. Does NOT run onboard (Phase 3).
 *   - Existing ~/.abtars with flat layout (pre-158): refuse unless
 *     --upgrade, then run migration 003-flat-to-releases (Phase 1c).
 *   - Existing ~/.abtars with new layout: refuse unless --force (which
 *     re-seeds missing config and reconciles symlinks, no code changes).
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { hostname, homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { emptyManifest, packagePaths, readManifest, resolveUserBinDir, writeManifest } from '../deploy-lib-import.js';

export interface InstallOptions {
  readonly restore?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly mode?: "simple" | "supervised" | "supervised-daemon";
}

// CLI wrappers are read from install-manifest.json at runtime.
// Each is a thin wrapper that invokes `node current/dist/cli/<name>.js "$@"`.
// Regenerated on every install / flat-to-releases migration.

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `p` exists as any filesystem entry — regular file, directory,
 * symlink (including dangling). Use this for collision checks in
 * reconcilePathLink, where a dangling symlink still occupies the inode
 * and would cause EEXIST on symlink(). `exists()` above uses stat() which
 * follows symlinks and returns false on dangling ones; that's wrong for
 * collision detection.
 */
async function existsAny(p: string): Promise<boolean> {
  try {
    const { lstat } = await import('node:fs/promises');
    await lstat(p);
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

async function createSkeleton(home: string, dryRun: boolean): Promise<void> {
  const { loadManifest } = await import('../install-manifest.js');
  const manifest = loadManifest();
  const dirs = manifest.directories.map(d => join(home, d.path));
  if (dryRun) {
    process.stdout.write(`[dry-run] mkdir -p:\n  ${dirs.join('\n  ')}\n`);
    return;
  }
  for (const d of manifest.directories) {
    await mkdir(join(home, d.path), { recursive: true, mode: d.mode ? parseInt(d.mode, 8) : undefined });
  }
}

async function seedConfig(repoRoot: string, _configDir: string, dryRun: boolean, home: string): Promise<readonly string[]> {
  const { loadManifest } = await import('../install-manifest.js');
  const manifest = loadManifest(repoRoot);
  const seeded: string[] = [];
  for (const seed of manifest.configSeeds) {
    const src = join(repoRoot, seed.source);
    const dst = join(home, seed.dest);
    if (!(await exists(src))) continue;
    if (await exists(dst)) continue;
    if (dryRun) {
      seeded.push(`[dry-run] cp ${src} ${dst}`);
      continue;
    }
    const content = await readFile(src, 'utf-8');
    await writeFile(dst, content, { mode: seed.mode ? parseInt(seed.mode, 8) : 0o644 });
    seeded.push(basename(dst));
  }
  return seeded;
}

/**
 * Reconcile a single PATH symlink at ~/.local/bin/<name>.
 * Policy (plan §"PATH symlink collision"):
 *   - Missing  → create
 *   - Symlink pointing into our own ~/.abtars/bin/ → overwrite
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
  const linkExists = await existsAny(linkPath);
  if (!linkExists) {
    if (dryRun) return { action: `[dry-run] ln -s ${targetPath} ${linkPath}` };
    await symlink(targetPath, linkPath);
    return { action: `created ${linkPath}` };
  }
  if (await isSymlink(linkPath)) {
    const { readlink, unlink } = await import('node:fs/promises');
    const current = await readlink(linkPath);
    // "We own it" means: points at THIS install's bin dir, not a fuzzy match
    // on any path containing /.abtars/bin/. A smoke-test install at
    // ABTARS_HOME=~/.cache/ab-smoke-.../ must not clobber the real
    // ~/.abtars symlinks. Compare absolute paths directly.
    const ownsIt = current === targetPath;
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

export async function writeWrapper(binDir: string, name: string, currentLink: string, dryRun: boolean): Promise<void> {
  const bundleFile = name === 'abtars' ? 'abtars-cli.js' : `${name}.js`;
  const target = join(currentLink, 'bundle', bundleFile);
  // Fallback: pre-bundle dist/ layout (tsc build) for installs that haven't migrated yet.
  const distFile = name === 'abtars' ? 'abtars.js' : `${name}.js`;
  const fallback = join(currentLink, 'dist', 'cli', distFile);
  const content = `#!/usr/bin/env bash
if [ -f "${target}" ]; then
  exec node "${target}" "$@"
elif [ -f "${fallback}" ]; then
  exec node "${fallback}" "$@"
else
  echo "abtars: no release staged yet. Run 'abtars update' or 'npm run bundle' in the repo checkout." >&2
  exit 1
fi
`;
  const path = join(binDir, name);
  if (dryRun) {
    process.stdout.write(`[dry-run] write wrapper ${path} -> node ${target} (fallback: ${fallback})\n`);
    return;
  }
  await writeFile(path, content, { mode: 0o755 });
}

function isPathOnPATH(userBinDir: string): boolean {
  const PATH = process.env['PATH'] ?? '';
  return PATH.split(':').some((p) => p === userBinDir);
}

function isWSL(): boolean {
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop")
      || /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch { return false; }
}

async function installSupervisedDaemon(home: string, repoRoot: string, dryRun: boolean): Promise<number> {
  const platform = process.platform;

  // WSL guard
  if (platform === 'linux' && isWSL()) {
    process.stderr.write(
      `supervised-daemon on WSL can't survive Windows-level lifecycle events.\n` +
      `Recommended: --mode=simple (run from tmux).\n` +
      `Re-run with --mode=simple to proceed.\n`,
    );
    return 2;
  }

  // Sudo check — supervised-daemon requires root for system-scope service install
  const sudoUser = process.env['SUDO_USER'];
  if (process.getuid?.() !== 0) {
    process.stderr.write(
      `supervised-daemon requires sudo for system-scope service install.\n` +
      `Run: sudo -k abtars install --mode=supervised-daemon\n`,
    );
    return 2;
  }
  if (!sudoUser) {
    process.stderr.write(
      `Cannot determine target user — $SUDO_USER is not set.\n` +
      `Run via: sudo -k abtars install --mode=supervised-daemon\n` +
      `(Do not use 'su -' — it doesn't set SUDO_USER.)\n`,
    );
    return 2;
  }

  // Validate that a normal install exists
  const currentLink = join(home, 'current');
  if (!existsSync(currentLink)) {
    process.stderr.write(
      `No release staged at ${currentLink}.\n` +
      `Run 'abtars install' and 'abtars update' as ${sudoUser} first,\n` +
      `then re-run with sudo for supervised-daemon.\n`,
    );
    return 2;
  }

  const userGroup = sudoUser; // primary group = username on most systems

  if (platform === 'darwin') {
    // Resolve actual primary group on macOS
    const { execSync } = await import('node:child_process');
    let group = userGroup;
    try { group = execSync(`id -gn ${sudoUser}`, { encoding: 'utf-8' }).trim(); } catch (err) { logAndSwallow("install", "op", err); }

    const plistSrc = join(repoRoot, 'scripts', 'com.abtars.daemon.plist');
    if (!existsSync(plistSrc)) {
      process.stderr.write(`Template not found: ${plistSrc}\n`);
      return 1;
    }
    let content = readFileSync(plistSrc, 'utf-8');
    content = content.replaceAll('{{USER}}', sudoUser).replaceAll('{{GROUP}}', group);
    const dst = '/Library/LaunchDaemons/com.abtars.daemon.plist';

    if (dryRun) {
      process.stdout.write(`[dry-run] write ${dst}\n[dry-run] launchctl bootstrap system ${dst}\n`);
      return 0;
    }

    // Remove existing user-scope LaunchAgent if present
    const userAgent = join('/Users', sudoUser, 'Library', 'LaunchAgents', 'com.abtars.watchdog.plist');
    if (existsSync(userAgent)) {
      const { execFileSync } = await import('node:child_process');
      try { execFileSync('launchctl', ['bootout', `gui/${process.env['SUDO_UID'] ?? ''}`, userAgent]); } catch (err) { logAndSwallow("install", "op", err); }
      process.stdout.write(`✓ disabled user-scope LaunchAgent\n`);
    }

    const { writeFileSync, chmodSync } = await import('node:fs');
    writeFileSync(dst, content);
    chmodSync(dst, 0o644);
    const { execFileSync } = await import('node:child_process');
    try { execFileSync('launchctl', ['bootstrap', 'system', dst]); } catch (err) { logAndSwallow("install", "op", err); }
    process.stdout.write(`✓ LaunchDaemon installed at ${dst}\n`);
    process.stdout.write(`✓ supervised-daemon active — bridge runs as ${sudoUser}, survives logout + reboot\n`);
    return 0;
  }

  if (platform === 'linux') {
    // systemd check
    const { execSync } = await import('node:child_process');
    try { execSync('systemctl --version', { stdio: 'ignore' }); } catch {
      process.stderr.write(`systemctl not found — supervised-daemon requires systemd.\n`);
      return 2;
    }

    const unitSrc = join(repoRoot, 'scripts', 'abtars-daemon.service');
    if (!existsSync(unitSrc)) {
      process.stderr.write(`Template not found: ${unitSrc}\n`);
      return 1;
    }
    let content = readFileSync(unitSrc, 'utf-8');
    content = content.replaceAll('{{USER}}', sudoUser);
    const dst = '/etc/systemd/system/abtars.service';

    if (dryRun) {
      process.stdout.write(`[dry-run] write ${dst}\n[dry-run] systemctl enable --now abtars\n`);
      return 0;
    }

    const { writeFileSync } = await import('node:fs');
    writeFileSync(dst, content);
    const { execFileSync } = await import('node:child_process');
    execFileSync('systemctl', ['daemon-reload']);
    execFileSync('systemctl', ['enable', '--now', 'abtars']);
    process.stdout.write(`✓ systemd unit installed at ${dst}\n`);
    process.stdout.write(`✓ supervised-daemon active — bridge runs as ${sudoUser}, survives logout + reboot\n`);
    return 0;
  }

  process.stderr.write(`supervised-daemon is not supported on ${platform}.\n`);
  return 2;
}

export async function install(opts: InstallOptions): Promise<number> {
  const paths = packagePaths('abtars');
  const home = paths.home;
  const userBinDir = resolveUserBinDir();
  const repoRoot = process.cwd();

  const homeExists = await exists(home);
  const manifest = homeExists ? await readManifest(paths.manifest) : null;

  if (homeExists && manifest && !opts.force && !opts.restore) {
    process.stderr.write(
      `~/.abtars already installed at version ${manifest.version || '(unset)'}.\nUse 'abtars update' to upgrade, or --force to re-seed missing config.\n`,
    );
    return 2;
  }

  // Create skeleton (idempotent)
  await createSkeleton(home, opts.dryRun);
  process.stdout.write(`✓ skeleton at ${home}\n`);

  // Create abmind skeleton — abtars depends on abmind at runtime
  const abmindHome = process.env['ABMIND_HOME'] ?? join(dirname(home), '.abmind');
  const abmindDirs = [
    { path: join(abmindHome, 'config'), mode: 0o700 },
    { path: join(abmindHome, 'memory'), mode: 0o700 },
    { path: join(abmindHome, 'memory', 'sleep') },
  ];
  if (opts.dryRun) {
    process.stdout.write(`[dry-run] mkdir -p: ${abmindDirs.map(d => d.path).join(', ')}\n`);
  } else {
    for (const d of abmindDirs) await mkdir(d.path, { recursive: true, mode: d.mode });
  }
  process.stdout.write(`✓ abmind skeleton at ${abmindHome}\n`);

  // Deploy core templates to ~/.abmind/memory/core/ (never overwrite existing)
  const coreTemplatesDir = join(repoRoot, 'core', 'core_templates');
  const coreTargetDir = join(abmindHome, 'memory', 'core');
  if (!opts.dryRun) {
    await mkdir(coreTargetDir, { recursive: true });
    const { readdirSync } = await import('node:fs');
    for (const file of readdirSync(coreTemplatesDir)) {
      const dst = join(coreTargetDir, file);
      if (!(await exists(dst))) {
        await writeFile(dst, await readFile(join(coreTemplatesDir, file), 'utf-8'));
      }
    }
    process.stdout.write(`✓ core templates deployed to ${coreTargetDir}\n`);
  }

  // Create kiro-cli agent config — ACP transport needs ~/.kiro/agents/professor.json
  const kiroAgentsDir = join(homedir(), '.kiro', 'agents');
  const professorJson = join(kiroAgentsDir, 'professor.json');
  if (!opts.dryRun) {
    await mkdir(kiroAgentsDir, { recursive: true });
    if (!(await exists(professorJson))) {
      await writeFile(professorJson, JSON.stringify({
        name: "professor",
        description: "Abtars bridge agent",
        tools: ["*"],
        allowedTools: ["@builtin"],
        toolsSettings: { shell: { autoAllowReadonly: true } },
        includeMcpJson: true,
      }, null, 2) + '\n');
      process.stdout.write(`✓ kiro agent: ${professorJson}\n`);
    }
  } else {
    process.stdout.write(`[dry-run] create ${professorJson}\n`);
  }

  // Seed config from examples (only missing ones)
  const seeded = await seedConfig(repoRoot, paths.config, opts.dryRun, home);
  if (seeded.length > 0) {
    process.stdout.write(`✓ seeded config: ${seeded.join(', ')}\n`);
  }

  // Write wrappers (always overwrite — they're regenerable thin shims)
  const { loadManifest: loadInstallManifest } = await import('../install-manifest.js');
  const installManifest = loadInstallManifest(repoRoot);
  if (!opts.dryRun) {
    await mkdir(paths.bin, { recursive: true });
  }
  for (const name of installManifest.cliWrappers) {
    await writeWrapper(paths.bin, name, paths.current, opts.dryRun);
  }
  process.stdout.write(`✓ wrappers in ${paths.bin}\n`);

  // Reconcile PATH symlinks
  if (!opts.dryRun) await mkdir(userBinDir, { recursive: true });
  const refused: string[] = [];
  for (const name of installManifest.cliWrappers) {
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

  // Initialize manifest if brand-new install AND migration didn't write one.
  // (Migration 003 writes a manifest mid-flow with version + migration record;
  // we must not clobber it here.)
  const manifestAfter = await readManifest(paths.manifest);
  if (manifestAfter === null && !opts.dryRun) {
    await writeManifest(paths.manifest, {
      ...emptyManifest('abtars', hostname()),
      version: '',
      preMigrationBackup: null,
    });
    process.stdout.write(`✓ manifest initialized at ${paths.manifest}\n`);
  }

  // Write install mode to manifest. Priority:
  //   1. --mode flag (explicit) — always wins
  //   2. existing manifest installMode — preserved (don't clobber on --force)
  //   3. default: supervised
  const manifestForMode = await readManifest(paths.manifest);
  const existingMode = manifestForMode?.installMode;
  const mode = opts.mode ?? existingMode ?? "supervised";
  if (manifestForMode) {
    await writeManifest(paths.manifest, { ...manifestForMode, installMode: mode });
  }
  process.stdout.write(`✓ install mode: ${mode}\n`);

  // --- supervised-daemon: system-scope service install (additive, does not touch simple/supervised paths) ---
  if (mode === 'supervised-daemon') {
    return installSupervisedDaemon(home, repoRoot, opts.dryRun);
  }

  // Restore from backup zip
  if (opts.restore) {
    const { spawnSync } = await import('node:child_process');
    const { existsSync: fileExists } = await import('node:fs');
    const zipPath = opts.restore;
    if (!fileExists(zipPath)) {
      process.stderr.write(`error: backup file not found: ${zipPath}\n`);
      return 1;
    }
    // Extract to temp dir
    const tmpDir = join(process.env['TMPDIR'] ?? '/tmp', `abtars-restore-${Date.now()}`);
    const unzip = spawnSync('unzip', ['-o', zipPath, '-d', tmpDir], { encoding: 'utf-8' });
    if (unzip.status !== 0) {
      process.stderr.write(`error: unzip failed: ${unzip.stderr}\n`);
      return 1;
    }
    // Copy abtars files
    const abSrc = join(tmpDir, 'abtars');
    if (fileExists(abSrc)) {
      spawnSync('cp', ['-r', ...readdirSync(abSrc).map(f => join(abSrc, f)), home], { stdio: 'inherit' });
      process.stdout.write(`✓ restored abtars config\n`);
    }
    // Copy abmind files
    const abmindHome = process.env['ABMIND_HOME'] ?? join(dirname(home), '.abmind');
    const abmindSrc = join(tmpDir, 'abmind');
    if (fileExists(abmindSrc)) {
      spawnSync('cp', ['-r', ...readdirSync(abmindSrc).map(f => join(abmindSrc, f)), abmindHome], { stdio: 'inherit' });
      process.stdout.write(`✓ restored abmind data\n`);
    }
    // Cleanup
    spawnSync('rm', ['-rf', tmpDir]);
    process.stdout.write(`\nRestore complete.\n`);
    process.stdout.write(`Next: 'abtars update' to build and activate.\n`);
    return 0;
  }

  process.stdout.write(`\nInstall complete.\n`);
  if (!manifestAfter || manifestAfter.version === '') {
    process.stdout.write(`Next: 'abtars update' to build and activate the first release.\n`);
  }

  // #334: Post-install healthcheck — validate operator channel exists (only on --restore)
  if (!opts.dryRun && opts.restore) {
    const { validateMinimumViability, formatValidationError } = await import('./install-validate.js');
    const validation = validateMinimumViability(paths.config);
    if (!validation.ok) {
      const invocation = `abtars install --restore ${opts.restore}`;
      process.stderr.write("\n" + formatValidationError(validation, invocation) + "\n");
      return 1;
    }
  }

  return 0;
}
