/**
 * `abtars install [--force]` — first-time setup.
 *
 *   - No existing ~/.abtars: create dirs, seed config/ from .env.example,
 *     create PATH symlinks. Does NOT run onboard (Phase 3).
 *   - Existing ~/.abtars: refuse unless --force (which
 *     re-seeds missing config and reconciles symlinks, no code changes).
 */

import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { hostname, homedir as _homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { emptyManifest, packagePaths, readManifest, resolveUserBinDir, writeManifest } from '../deploy-lib-import.js';

/** Resolve real user home even under sudo. */
function homedir(): string {
  const sudoUser = process.env['SUDO_USER'];
  if (sudoUser) {
    try { return execSync(`getent passwd ${sudoUser}`, { encoding: 'utf-8' }).split(':')[5]!.trim(); }
    catch { /* fall through */ }
  }
  return _homedir();
}

export interface InstallOptions {
  readonly restore?: string;
  readonly force: boolean;
  readonly dryRun: boolean;
  readonly mode?: "simple" | "supervised";
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
    await mkdir(dirname(dst), { recursive: true });
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
  // #912: ensure node is in PATH on macOS (homebrew) and Linux (.local/bin)
  const pathPreamble = `export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH"\n`;
  let content: string;

  if (name === 'abmind') {
    content = `#!/usr/bin/env bash
${pathPreamble}# Resolve abmind CLI — no ~/.abmind/current dependency (#863)
BUNDLE_CLI="$HOME/.abtars/app/bundle/node_modules/abmind/dist/cli/abmind.js"
SRC_CLI="$HOME/.abtars/src/abmind/dist/cli/abmind.js"
GLOBAL_CLI="$(npm root -g 2>/dev/null)/abmind/dist/cli/abmind.js"
if [ -f "$BUNDLE_CLI" ]; then
  exec node "$BUNDLE_CLI" "$@"
elif [ -f "$SRC_CLI" ]; then
  exec node "$SRC_CLI" "$@"
elif [ -f "$GLOBAL_CLI" ]; then
  exec node "$GLOBAL_CLI" "$@"
else
  echo "abmind: not found. Install via npm or deploy via abtars update." >&2
  exit 1
fi
`;
  } else {
    const target = join(currentLink, 'bundle', bundleFile);
    const distFile = name === 'abtars' ? 'abtars.js' : `${name}.js`;
    const fallback = join(currentLink, 'dist', 'cli', distFile);
    content = `#!/usr/bin/env bash
${pathPreamble}if [ -f "${target}" ]; then
  exec node "${target}" "$@"
elif [ -f "${fallback}" ]; then
  exec node "${fallback}" "$@"
else
  GLOBAL_BIN="$(npm root -g 2>/dev/null)/abtars/bundle/${bundleFile}"
  if [ -f "$GLOBAL_BIN" ]; then
    exec node "$GLOBAL_BIN" "$@"
  fi
  echo "abtars: no release staged. Run 'abtars install' first." >&2
  exit 1
fi
`;
  }
  const path = join(binDir, name);
  if (dryRun) {
    process.stdout.write(`[dry-run] write wrapper ${path}\n`);
    return;
  }
  await writeFile(path, content, { mode: 0o755 });
}

function isPathOnPATH(userBinDir: string): boolean {
  const PATH = process.env['PATH'] ?? '';
  return PATH.split(':').some((p) => p === userBinDir);
}

export async function install(opts: InstallOptions): Promise<number> {
  const paths = packagePaths('abtars');
  const home = paths.home;
  const userBinDir = resolveUserBinDir();
  const repoRoot = process.cwd();

  // Install log (#718)
  const { initInstallLog, logInstall, logInstallHeader } = await import("../install-log.js");
  initInstallLog(home);
  logInstallHeader("install");
  const _origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: any, ...args: any[]) => {
    if (typeof chunk === "string" && (chunk.startsWith("✓") || chunk.startsWith("⚠"))) logInstall(chunk.trimEnd());
    return _origWrite(chunk, ...args);
  }) as typeof process.stdout.write;

  const homeExists = await exists(home);
  const manifest = homeExists ? await readManifest(paths.manifest) : null;

  if (homeExists && manifest && !opts.force && !opts.restore) {
    process.stderr.write(
      `~/.abtars already installed at version ${manifest.version || '(unset)'}.\nUse 'abtars update' to upgrade, or --force to re-seed missing config.\n`,
    );
    return 2;
  }

  // Kill stale daemon/watchdog from previous install (#771)
  try {
    const { execSync } = await import("node:child_process");
    execSync("systemctl is-active abtars 2>/dev/null", { stdio: "ignore" });
    execSync("sudo -n systemctl stop abtars 2>/dev/null", { stdio: "ignore" });
    execSync("sudo -n systemctl disable abtars 2>/dev/null", { stdio: "ignore" });
  } catch { /* not running or no sudo — fine */ }
  try {
    const { execSync } = await import("node:child_process");
    execSync("pkill -f 'watchdog.sh' 2>/dev/null", { stdio: "ignore" });
  } catch { /* no watchdog — fine */ }

  // Create skeleton (idempotent)
  await createSkeleton(home, opts.dryRun);
  process.stdout.write(`✓ skeleton at ${home}\n`);

  // Core templates: abmind seeds its own on first boot (#427 ensureInitialized).
  // No longer seeded by abtars install.

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

  // Generate Ed25519 identity keypair (skip if already exists)
  const identityKey = join(paths.config, 'identity.key');
  const identityPub = join(paths.config, 'identity.pub');
  if (!opts.dryRun && !(await exists(identityKey))) {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(identityKey, privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    await writeFile(identityPub, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    const { chmodSync } = await import('node:fs');
    chmodSync(identityKey, 0o600);
    process.stdout.write(`✓ identity keypair generated\n`);
  }

  // Generate self-signed Ed25519 TLS certificate (skip if already exists)
  const identityCrt = join(paths.config, 'identity.crt');
  const identityTlsKey = join(paths.config, 'identity.tls.key');
  if (!opts.dryRun && !(await exists(identityCrt))) {
    const { execSync } = await import('node:child_process');
    const { chmodSync } = await import('node:fs');
    const agentName = hostname();
    try {
      execSync(`openssl req -x509 -newkey ed25519 -keyout identity.tls.key -out identity.crt -days 3650 -nodes -subj "/CN=${agentName}"`, { cwd: paths.config, stdio: 'ignore' });
      chmodSync(identityTlsKey, 0o600);
      process.stdout.write(`✓ TLS certificate generated (Ed25519, 10yr)\n`);
    } catch (err) {
      process.stderr.write(`⚠ TLS cert generation failed (openssl not found?). Agent-api will start without TLS.\n`);
    }
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
  } else {
    process.stdout.write(`✓ PATH symlinks in ${userBinDir}\n`);
  }

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

  // Release staging is handled by `abtars update` (auto-detects npm vs git source)

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
    const is7z = zipPath.endsWith('.7z');
    const extractCmd = is7z
      ? spawnSync('7z', ['x', zipPath, `-o${tmpDir}`, '-y'], { encoding: 'utf-8' })
      : spawnSync('unzip', ['-o', zipPath, '-d', tmpDir], { encoding: 'utf-8' });
    if (extractCmd.status !== 0) {
      process.stderr.write(`error: extract failed: ${extractCmd.stderr}\n`);
      return 1;
    }
    // Copy abtars files — overwrite everything EXCEPT binaries (releases/, current, bin/)
    const abSrc = join(tmpDir, 'abtars');
    if (fileExists(abSrc)) {
      const skipSet = new Set(['releases', 'current', 'bin']);
      for (const f of readdirSync(abSrc)) {
        if (skipSet.has(f)) continue;
        spawnSync('cp', ['-r', join(abSrc, f), home], { stdio: 'inherit' });
      }
      process.stdout.write(`✓ restored abtars data\n`);
    }
    // Copy abmind files
    const abmindHome = process.env['ABMIND_HOME'] ?? join(dirname(home), '.abmind');
    const abmindSrc = join(tmpDir, 'abmind');
    if (fileExists(abmindSrc)) {
      spawnSync('cp', ['-r', ...readdirSync(abmindSrc).map(f => join(abmindSrc, f)), abmindHome], { stdio: 'inherit' });
      process.stdout.write(`✓ restored abmind data\n`);
    }
    // Cleanup + resync
    spawnSync('rm', ['-rf', tmpDir]);
    process.stdout.write(`\n✓ Restore complete. Run 'abtars update' to resync.\n`);
    return 0;
  }

  // --- supervised: load user-scope watchdog (LaunchAgent / systemd user) ---
  if (mode === 'supervised') {
    const { execSync } = await import('node:child_process');
    if (process.platform === 'darwin') {
      const plistSrc = join(home, 'scripts', 'com.abtars.watchdog.plist');
      const plistDst = join(homedir(), 'Library', 'LaunchAgents', 'com.abtars.watchdog.plist');
      if (existsSync(plistSrc)) {
        const content = readFileSync(plistSrc, 'utf-8').replaceAll('{{HOME}}', homedir());
        const { writeFileSync } = await import('node:fs');
        writeFileSync(plistDst, content);
        try { execSync(`launchctl load "${plistDst}"`, { stdio: 'ignore' }); } catch { /* already loaded */ }
        process.stdout.write(`✓ watchdog LaunchAgent loaded\n`);
      }
    } else if (process.platform === 'linux') {
      const unitSrc = join(home, 'scripts', 'abtars-watchdog.service');
      const unitDir = join(homedir(), '.config', 'systemd', 'user');
      if (existsSync(unitSrc)) {
        mkdirSync(unitDir, { recursive: true });
        copyFileSync(unitSrc, join(unitDir, 'abtars-watchdog.service'));
        try { execSync('systemctl --user daemon-reload && systemctl --user enable --now abtars-watchdog', { stdio: 'ignore' }); } catch { /* may fail in chroot */ }
        process.stdout.write(`✓ watchdog systemd user service enabled\n`);
      }
    }
  }

  process.stdout.write(`\nInstall complete.\n`);
  if (!manifestAfter || manifestAfter.version === '') {
    process.stdout.write(`Next: 'abtars update' to build and activate the first release.\n`);
  } else {
    process.stdout.write(`\n── Next steps ──\n`);
    process.stdout.write(`  1. Run 'abtars onboard' to configure Telegram token + model provider\n`);
    process.stdout.write(`  2. (Optional) Install Ollama for memory embeddings: curl -fsSL https://ollama.com/install.sh | sh\n`);
    process.stdout.write(`  3. Start the bridge: 'abtars restart' or use the watchdog\n\n`);
  }

  const { printHealthSummary } = await import('./health-check.js');
  printHealthSummary(paths.home);

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
