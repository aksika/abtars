/**
 * `abtars update` — build, stage, atomic swap, health-verified restart.
 *
 * #785: replaces releases/ + current symlink with app/ + app.prev/ atomic rename.
 * Flow: pre-flight → build → validate → config snapshot → atomic swap →
 *       housekeeping → sentinel → restart → health probe → auto-rollback.
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { copyFile, mkdir, chmod, readdir } from 'node:fs/promises';
import { rmSync, cpSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
import { makeLocalBuildSource } from '../update-sources/local.js';
import { makeNpmSource } from '../update-sources/npm.js';
import type { SourceName } from '../update-sources/types.js';
import {
  acquireLock, atomicSwap, cleanStaleStaging, configSnapshot,
  emptyManifest, hashFile, healthProbe, packagePaths,
  readManifest, readSentinel, writeManifest, writeSentinel,
  type UpdateSentinel,
} from '../deploy-lib-import.js';
import { showHintOnce } from '../../components/hints.js';

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf-8'))[field]; } catch { return undefined; }
}

export interface UpdateOptions {
  readonly source: SourceName;
  readonly fromLocal: boolean;
  readonly allowAbmindMismatch: boolean;
  readonly repoRoot?: string;
  readonly dryRun?: boolean;
  readonly check?: boolean;
}

export async function update(opts: UpdateOptions): Promise<number> {
  if (opts.source !== 'local' && opts.source !== 'npm') {
    process.stderr.write(`--source ${opts.source} is not yet supported.\nUse --source local (default) or --source npm.\n`);
    return 2;
  }

  const paths = packagePaths('abtars');

  // ── Step 0: Pre-flight ──────────────────────────────────────────────
  const sentinel = readSentinel(paths.home);
  if (sentinel?.status === 'pending') {
    const age = Date.now() - new Date(sentinel.startedAt).getTime();
    if (age > 5 * 60_000) {
      process.stderr.write(`⚠️ Previous update (${sentinel.version}) never completed successfully. Proceeding...\n`);
    }
  }

  // --check: just report ahead/behind, no lock, no build
  if (opts.check) {
    return checkForUpdates(paths.home, opts);
  }

  const release = await acquireLock(paths.lock, `update --source ${opts.source}`);

  try {
    // Clean stale staging from interrupted previous run
    cleanStaleStaging(paths.appStaging);

    // Register interruption handler
    const cleanupHandler = (): void => {
      if (existsSync(paths.appStaging) && existsSync(paths.app)) {
        rmSync(paths.appStaging, { recursive: true, force: true });
      }
    };
    process.on('SIGHUP', () => { cleanupHandler(); process.exit(130); });
    process.on('SIGTERM', () => { cleanupHandler(); process.exit(143); });

    // ── Step 1: Resolve source ──────────────────────────────────────────
    let repoRoot = opts.repoRoot ?? process.cwd();
    if (!opts.repoRoot && !existsSync(join(repoRoot, '.git'))) {
      const { realpathSync } = await import('node:fs');
      const scriptPath = realpathSync(process.argv[1] ?? '');
      const { dirname } = await import('node:path');
      const candidate = join(dirname(scriptPath), '..');
      if (existsSync(join(candidate, 'bundle'))) repoRoot = candidate;
    }

    const source = opts.source === 'npm'
      ? makeNpmSource('abtars')
      : makeLocalBuildSource({ repoRoot, allowStale: opts.fromLocal });

    if (opts.fromLocal) {
      showHintOnce("update-from-local", "Building from working copy (--from-local). To sync with remote first: git pull && abtars update");
    }

    // --dry-run: print plan and exit
    if (opts.dryRun) {
      return printDryRun(paths, repoRoot, opts);
    }

    process.stdout.write(`Building from local checkout (${repoRoot})...\n`);

    // ── Step 2: Build into app.staging/ ─────────────────────────────────
    const staged = await source.prepare({
      stagingDir: paths.appStaging,
      home: paths.home,
      allowStale: opts.fromLocal,
    });
    process.stdout.write(`✓ staged ${staged.version}\n`);

    // Install external runtime deps
    {
      const pkgPath = join(staged.stagedPath, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const externals: Record<string, string> = { patchright: "^1.59.4", "rettiwt-api": "^4.1.3" };
        pkg.dependencies = { ...pkg.dependencies, ...externals };
        if (pkg.dependencies?.abmind?.startsWith("file:")) delete pkg.dependencies.abmind;
        const { writeFileSync } = await import("node:fs");
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        const { execSync } = await import("node:child_process");
        execSync("npm install --omit=dev --ignore-scripts 2>/dev/null", { cwd: staged.stagedPath, timeout: 60_000 });
        process.stdout.write(`✓ external deps installed\n`);
      } catch (err) {
        process.stdout.write(`⚠ external deps install failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Copy abmind into staging
    await copyAbmind(staged.stagedPath, repoRoot);

    // ── Step 3: Validate staging ────────────────────────────────────────
    const entryPoint = join(staged.stagedPath, 'bundle', 'abtars.js');
    if (!existsSync(entryPoint)) {
      process.stderr.write(`❌ Entry point not found: ${entryPoint}\n`);
      return 1;
    }

    // ── Step 4: Config snapshot ─────────────────────────────────────────
    configSnapshot(paths.config);
    process.stdout.write(`✓ config snapshot (3-slot rotation)\n`);

    // ── Step 5: Write update sentinel (watchdog respects this) ──────────
    const prior = await readManifest(paths.manifest);
    const sentinelData: UpdateSentinel = {
      version: staged.version,
      previousVersion: prior?.version ?? null,
      startedAt: new Date().toISOString(),
      status: 'pending',
    };
    writeSentinel(paths.home, sentinelData);

    // ── Step 6: Atomic swap ─────────────────────────────────────────────
    atomicSwap(paths.app, paths.appPrev, paths.appStaging);
    process.stdout.write(`✓ atomic swap: app.staging/ → app/\n`);

    // ── Step 7: Post-swap housekeeping ──────────────────────────────────
    await postSwapHousekeeping(paths, repoRoot, staged);

    // Update manifest
    await writeManifest(paths.manifest, {
      ...(prior ?? emptyManifest('abtars', hostname())),
      version: staged.version,
      commit: staged.commit,
      branch: staged.branch,
      packageLockHash: staged.packageLockHash,
      activatedAt: new Date().toISOString(),
      source: 'local',
      previousVersion: prior?.version ?? null,
      previousCommit: prior?.commit ?? null,
      installMode: prior?.installMode ?? 'supervised',
      repoRoot: repoRoot,
    } as any);
    process.stdout.write(`✓ manifest updated\n`);

    // ── Step 8: Restart bridge ──────────────────────────────────────────
    const restartTimestamp = Date.now();
    const restarted = await restartBridge(paths);

    if (!restarted) {
      process.stdout.write(`⚠️ Could not restart bridge. Start manually.\n`);
      return 0;
    }

    // ── Step 9: Health probe ────────────────────────────────────────────
    process.stdout.write(`Waiting for bridge health...\n`);
    const health = await healthProbe(paths.home, restartTimestamp, 60_000);

    if (health.healthy) {
      writeSentinel(paths.home, { ...sentinelData, status: 'success' });
      process.stdout.write(`✓ Bridge healthy (PID ${health.pid}, tick at ${new Date(health.heartbeat!).toISOString()})\n`);
      // Deploy state: success (#878)
      const stateFile = join(paths.home, "deploy.state");
      writeFileSync(stateFile, JSON.stringify({ status: "success", completedAt: new Date().toISOString(), version: staged.version }) + "\n");
      await syncAssets(paths.home, staged.stagedPath);
      await refreshBinaries(paths.home);
      return 0;
    }

    // ── Step 10: Auto-rollback ──────────────────────────────────────────
    process.stderr.write(`❌ Bridge unhealthy after 60s. Auto-rolling back...\n`);

    if (!existsSync(paths.appPrev1)) {
      process.stderr.write(`❌ No app.prev.1/ to roll back to. Manual intervention required.\n`);
      process.stderr.write(`   Check: ~/.abtars/logs/bridge.log\n`);
      return 2;
    }

    // Swap back
    const brokenDir = join(paths.home, 'app.broken');
    rmSync(brokenDir, { recursive: true, force: true });
    const { renameSync } = await import('node:fs');
    renameSync(paths.app, brokenDir);
    renameSync(paths.appPrev1, paths.app);

    // Restore manifest
    if (prior) {
      await writeManifest(paths.manifest, prior);
    }

    // Restart again
    const rollbackTs = Date.now();
    await restartBridge(paths);
    const rollbackHealth = await healthProbe(paths.home, rollbackTs, 30_000);

    if (rollbackHealth.healthy) {
      process.stderr.write(`⚠️ Rolled back to previous version. Investigate ${brokenDir} for the failure.\n`);
      rmSync(brokenDir, { recursive: true, force: true });
      return 1;
    }

    process.stderr.write(`❌ Rollback also failed. Manual intervention required.\n`);
    process.stderr.write(`   Check: ~/.abtars/logs/bridge.log\n`);
    process.stderr.write(`   Broken version preserved at: ${brokenDir}\n`);
    return 2;

  } finally {
    await release();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function copyAbmind(stagedPath: string, repoRoot: string): Promise<void> {
  if ((process.env['MEMORY'] ?? 'auto') === 'none') return;
  const candidates = [
    process.env['ABMIND_REPO'],
    join(repoRoot, '..', 'abmind'),
    join(process.env['HOME'] ?? '', 'abmind'),
  ].filter(Boolean) as string[];

  for (const src of candidates) {
    const distDir = join(src, 'dist');
    if (existsSync(distDir)) {
      // Copy into bundle/node_modules/ ONLY (single instance — prevents dual DB connection #860)
      const dest = join(stagedPath, 'bundle', 'node_modules', 'abmind');
      mkdirSync(dest, { recursive: true });
      cpSync(distDir, join(dest, 'dist'), { recursive: true });
      if (existsSync(join(src, 'package.json'))) cpSync(join(src, 'package.json'), join(dest, 'package.json'));
      if (existsSync(join(src, 'prompts'))) cpSync(join(src, 'prompts'), join(dest, 'prompts'), { recursive: true });
      // Remove stale parent-level copy if it exists (cleanup from older deploys)
      const stalePath = join(stagedPath, 'node_modules', 'abmind');
      if (existsSync(stalePath)) rmSync(stalePath, { recursive: true });
      // Update ~/.abmind/manifest.json with deployed version
      try {
        const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf-8'));
        const { resolveAbmindHome } = await import("../deploy-lib/paths.js");
        const abmindHome = resolveAbmindHome();
        mkdirSync(abmindHome, { recursive: true });
        const { spawnSync } = await import('node:child_process');
        const gitResult = spawnSync('git', ['-C', src, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' });
        const commit = gitResult.status === 0 ? gitResult.stdout.trim() : '';
        const version = commit ? `${pkg.version}-${commit}` : pkg.version;
        const manifest = { version, activatedAt: new Date().toISOString(), source: 'local' };
        writeFileSync(join(abmindHome, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      } catch { /* non-fatal — display only */ }
      process.stdout.write(`✓ abmind copied from ${src}\n`);

      // #920: Refresh global abmind CLI to match deployed version
      try {
        const { spawnSync } = await import('node:child_process');
        const linkResult = spawnSync('npm', ['link'], { cwd: src, stdio: 'pipe', timeout: 30_000 });
        if (linkResult.status === 0) {
          process.stdout.write(`✓ abmind CLI linked (global binary refreshed)\n`);
        }
      } catch { /* non-fatal — CLI may be stale but bridge works */ }

      return;
    }
  }
  process.stdout.write(`⚠ abmind source not found (checked: ${candidates.join(', ')}). Bridge may fail to start.\n`);
}

async function postSwapHousekeeping(
  paths: ReturnType<typeof packagePaths>,
  repoRoot: string,
  _staged: { version: string; stagedPath: string },
): Promise<void> {
  // Refresh scripts
  const { loadManifest } = await import('../install-manifest.js');
  const installManifest = loadManifest(paths.app);
  const repoScripts = join(repoRoot, 'scripts');
  const destScripts = join(paths.home, 'scripts');
  await mkdir(destScripts, { recursive: true });
  const allScriptFiles = await readdir(repoScripts).catch(() => [] as string[]);
  const matchesInclude = (name: string): boolean =>
    installManifest.scripts.include.some((pattern: string) => name.endsWith(pattern.replace("*", "")));
  const scriptFiles = allScriptFiles.filter(matchesInclude);
  const isExecutable = (name: string): boolean => name.endsWith(installManifest.scripts.executable.replace("*", ""));

  for (const name of scriptFiles) {
    await copyFile(join(repoScripts, name), join(destScripts, name));
    if (isExecutable(name)) await chmod(join(destScripts, name), 0o755);
  }
  process.stdout.write(`✓ scripts refreshed (${scriptFiles.length} files)\n`);

  // Regenerate CLI bin wrappers
  const { writeWrapper } = await import('./install.js');
  await mkdir(paths.bin, { recursive: true });
  for (const name of installManifest.cliWrappers) {
    await writeWrapper(paths.bin, name, paths.app, false);
  }
  process.stdout.write(`✓ wrappers refreshed (${installManifest.cliWrappers.length} files)\n`);

  // Sync core skills
  const skillsCoreSrc = join(paths.app, "core", "skills");
  const skillsCoreDst = join(paths.home, "skills", "core");
  if (existsSync(skillsCoreSrc)) {
    rmSync(skillsCoreDst, { recursive: true, force: true });
    cpSync(skillsCoreSrc, skillsCoreDst, { recursive: true });
    const files = readdirSync(skillsCoreDst, { recursive: true }) as string[];
    const count = files.filter(f => f.endsWith("SKILL.md")).length;
    process.stdout.write(`✓ skills/core synced (${count} skills)\n`);
  }

  // Sync core/prompts → ~/.abtars/core/prompts/
  const promptsSrc = join(paths.app, "core", "prompts");
  const promptsDst = join(paths.home, "core", "prompts");
  if (existsSync(promptsSrc)) {
    mkdirSync(promptsDst, { recursive: true });
    for (const f of readdirSync(promptsSrc).filter(f => f.endsWith(".md"))) {
      copyFileSync(join(promptsSrc, f), join(promptsDst, f));
    }
  }

  for (const d of ["custom", "downloaded", "self"]) {
    await mkdir(join(paths.home, "skills", d), { recursive: true });
  }

  // Seed missing config files
  const releaseConfig = join(paths.app, "config");
  const destConfig = join(paths.home, "config");
  if (existsSync(releaseConfig)) {
    for (const f of readdirSync(releaseConfig)) {
      const src = join(releaseConfig, f);
      if (f.endsWith('.example')) {
        cpSync(src, join(destConfig, f));
        const target = join(destConfig, f.replace('.example', ''));
        if (!existsSync(target)) cpSync(src, target);
      }
    }
    const defaultTransport = join(releaseConfig, 'transport.default.json');
    if (existsSync(defaultTransport)) cpSync(defaultTransport, join(destConfig, 'transport.default.json'));
  }

  // Clear stale model demotions
  const transportJson = join(paths.home, "config", "transport.json");
  if (existsSync(transportJson)) {
    try {
      const tc = JSON.parse(readFileSync(transportJson, "utf-8"));
      let cleared = false;
      for (const agent of Object.values(tc.agents ?? {})) {
        if ((agent as any).demoted) { delete (agent as any).demoted; delete (agent as any).demotedReason; delete (agent as any).demotedModel; cleared = true; }
        for (const fb of (agent as any).fallbacks ?? []) {
          if (fb.demoted) { delete fb.demoted; delete fb.demotedReason; delete fb.demotedModel; cleared = true; }
        }
      }
      if (cleared) { const { writeFileSync } = await import("node:fs"); writeFileSync(transportJson, JSON.stringify(tc, null, 2) + "\n"); }
    } catch { /* best effort */ }
  }

  // Run doctor
  const doctorPath = join(paths.home, "scripts", "doctor.sh");
  if (existsSync(doctorPath)) {
    process.stdout.write("\n🩺 Health check...\n");
    try {
      const { execSync } = await import("node:child_process");
      execSync(`bash "${doctorPath}" --fix`, { stdio: "inherit", timeout: 30_000 });
    } catch (err) {
      process.stderr.write(`⚠️ doctor --fix failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // Ensure invariants
  const { ensureInstallInvariants } = await import("../ensure-invariants.js");
  const invariantResults = await ensureInstallInvariants(process.cwd(), paths.home);
  if (invariantResults.length > 0) {
    process.stdout.write(`✓ invariants: ${invariantResults.join(", ")}\n`);
  }

  void hashFile; // preserve import
}

async function restartBridge(paths: ReturnType<typeof packagePaths>): Promise<boolean> {
  const manifest = await readManifest(paths.manifest);
  const mode = manifest?.installMode;
  if (!mode) {
    process.stderr.write("❌ installMode not set in manifest.json. Run 'abtars install' first.\n");
    return false;
  }

  if (mode === "supervised-daemon" || mode === "supervised") {
    process.stdout.write("\n♻️ Restarting bridge via watchdog...\n");
    const wdLock = join(paths.home, "watchdog.lock");
    const wdPid = readJsonField(wdLock, "pid") as number | undefined;
    if (wdPid && wdPid > 0) {
      try {
        process.kill(wdPid, "SIGUSR1");
        process.stdout.write(`  USR1 sent to watchdog (PID ${wdPid})\n`);
        return true;
      } catch {
        process.stdout.write(`⚠️ Could not signal watchdog (PID ${wdPid}).\n`);
      }
    }
    // Fallback: cold restart
    const { restart } = await import("./restart.js");
    await restart({ cold: true }).catch((err: unknown) => {
      process.stderr.write(`⚠️ Restart failed: ${err instanceof Error ? err.message : String(err)}\n`);
    });
    return true;
  }

  // Simple mode
  process.stdout.write("\n♻️ Restarting bridge...\n");
  const { restart } = await import("./restart.js");
  await restart({ cold: true }).catch((err: unknown) => {
    process.stderr.write(`⚠️ Restart failed: ${err instanceof Error ? err.message : String(err)}\n`);
  });
  return true;
}

function printDryRun(paths: ReturnType<typeof packagePaths>, repoRoot: string, opts: UpdateOptions): number {
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).stdout?.trim() ?? '?';
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).stdout?.trim() ?? '?';
  const wdLock = join(paths.home, "watchdog.lock");
  const wdPid = readJsonField(wdLock, "pid") as number | undefined;

  process.stdout.write(`
Dry run — no changes will be made.
  Source:       ${opts.source} (commit ${commit} on ${branch})
  Staging to:   ${paths.appStaging}
  Swap:         app/ → app.prev/, app.staging/ → app/
  Config snap:  config/ → config/.pre-update/ (3-slot rotation)
  Restart:      ${wdPid ? `USR1 to watchdog (PID ${wdPid})` : 'cold restart'}
  Health:       poll bridge.lock for 60s
  On failure:   auto-rollback (swap app/ ↔ app.prev/)
`);
  return 0;
}

async function checkForUpdates(home: string, opts: UpdateOptions): Promise<number> {
  const repoRoot = opts.repoRoot ?? process.cwd();
  if (!existsSync(join(repoRoot, '.git'))) {
    process.stderr.write("Not a git repository. --check requires a git checkout.\n");
    return 2;
  }
  const { spawnSync } = await import('node:child_process');
  spawnSync('git', ['fetch', '--quiet'], { cwd: repoRoot });
  const result = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/dev'], { cwd: repoRoot, encoding: 'utf-8' });
  const abtarsAhead = parseInt(result.stdout?.trim() ?? '0', 10);

  // Also check abmind sibling repo (#963)
  const abmindRepo = process.env['ABMIND_REPO'] ?? join(repoRoot, '..', 'abmind');
  let abmindAhead = 0;
  if (existsSync(join(abmindRepo, '.git'))) {
    spawnSync('git', ['fetch', '--quiet'], { cwd: abmindRepo });
    const abmindResult = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/dev'], { cwd: abmindRepo, encoding: 'utf-8' });
    abmindAhead = parseInt(abmindResult.stdout?.trim() ?? '0', 10);
  }

  const manifest = await readManifest(join(home, 'manifest.json'));
  process.stdout.write(`Current: ${manifest?.version ?? 'unknown'} (deployed ${manifest?.activatedAt ?? 'never'})\n`);

  if (abtarsAhead === 0 && abmindAhead === 0) {
    process.stdout.write(`Remote:  up to date\n`);
    return 0;
  }
  if (abtarsAhead > 0) process.stdout.write(`Remote:  abtars dev is ${abtarsAhead} commit${abtarsAhead === 1 ? '' : 's'} ahead\n`);
  if (abmindAhead > 0) process.stdout.write(`Remote:  abmind dev is ${abmindAhead} commit${abmindAhead === 1 ? '' : 's'} ahead\n`);
  process.stdout.write(`Action:  run 'abtars update' to apply\n`);
  return 2; // exit 2 = behind (not error, informational — per AG1 review)
}

/** Sync bundled assets to runtime paths after successful deploy (#875). */
async function syncAssets(home: string, _stagedPath: string): Promise<void> {
  // abtars core/skills/ → ~/.abtars/skills/core/
  const skillsSrc = join(home, 'app', 'core', 'skills');
  if (existsSync(skillsSrc)) {
    const skillsDst = join(home, 'skills', 'core');
    mkdirSync(skillsDst, { recursive: true });
    cpSync(skillsSrc, skillsDst, { recursive: true });
  }

  // abtars agents/default.md → ~/.abtars/agents/
  const agentSrc = join(home, 'app', 'bundle', 'agents', 'default.md');
  if (existsSync(agentSrc)) {
    const agentDst = join(home, 'agents');
    mkdirSync(agentDst, { recursive: true });
    const live = join(agentDst, 'default.md');
    if (!existsSync(live)) {
      copyFileSync(agentSrc, live);
    } else {
      copyFileSync(agentSrc, join(agentDst, 'default.template.md'));
    }
  }
}

/** #925: Overwrite abtars + abmind binaries at their current PATH location. */
async function refreshBinaries(home: string): Promise<void> {
  const { execSync } = await import("node:child_process");
  const { dirname, join: pjoin } = await import("node:path");
  const { mkdirSync } = await import("node:fs");
  const { homedir } = await import("node:os");
  const { writeWrapper } = await import("./install.js");
  const appDir = pjoin(home, "app");

  for (const name of ["abtars", "abmind"] as const) {
    let targetDir: string;
    try {
      const current = execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8" }).trim();
      targetDir = current ? dirname(current) : pjoin(homedir(), ".local", "bin");
    } catch {
      targetDir = pjoin(homedir(), ".local", "bin");
    }
    mkdirSync(targetDir, { recursive: true });
    await writeWrapper(targetDir, name, appDir, false);
  }
  process.stdout.write(`✓ CLI binaries refreshed in PATH\n`);
}
