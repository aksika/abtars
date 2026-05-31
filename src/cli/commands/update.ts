/**
 * `abtars update` — build current checkout, stage new release, flip symlink.
 *
 * Phase 1 implements --source local only. Other sources error with a
 * "not yet supported" stub (Phase 5 will add NpmSource).
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { copyFile, mkdir, chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { makeLocalBuildSource } from '../update-sources/local.js';
import { makeNpmSource } from '../update-sources/npm.js';
import type { SourceName } from '../update-sources/types.js';
import { acquireLock, activate, emptyManifest, hashFile, packagePaths, pruneReleases, readManifest, writeManifest, RETENTION, type PriorRelease } from '../deploy-lib-import.js';
import { showHintOnce } from '../../components/hints.js';

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf-8'))[field]; } catch { return undefined; }
}

export interface UpdateOptions {
  readonly source: SourceName;
  readonly fromLocal: boolean;
  readonly allowAbmindMismatch: boolean;
  readonly repoRoot?: string;
}

export async function update(opts: UpdateOptions): Promise<number> {
  if (opts.source !== 'local' && opts.source !== 'npm') {
    process.stderr.write(`--source ${opts.source} is not yet supported.\nUse --source local (default) or --source npm.\n`);
    return 2;
  }

  const paths = packagePaths('abtars');

  // Auto-migrate old flat layout (current/main.js without releases/) → create releases dir
  if (!existsSync(paths.releases) && existsSync(join(paths.home, 'current'))) {
    process.stdout.write('Migrating old layout → releases/...\n');
    mkdirSync(paths.releases, { recursive: true });
  }
  const release = await acquireLock(paths.lock, `update --source ${opts.source}`);

  try {
    // Resolve source root: explicit > cwd (if git) > npm package (from argv[1])
    let repoRoot = opts.repoRoot ?? process.cwd();
    if (!opts.repoRoot && !existsSync(join(repoRoot, '.git'))) {
      // Not in a git checkout — try npm global package path
      const scriptPath = process.argv[1] ?? '';
      const candidate = join(dirname(scriptPath), '..');
      if (existsSync(join(candidate, 'bundle'))) repoRoot = candidate;
    }
    const source = opts.source === 'npm'
      ? makeNpmSource('abtars')
      : makeLocalBuildSource({ repoRoot, allowStale: opts.fromLocal });
    if (opts.fromLocal) {
      showHintOnce("update-from-local", "Building from working copy (--from-local). To sync with remote first: git pull && abtars update");
    }
    process.stdout.write(`Building from local checkout (${process.cwd()})...\n`);
    const staged = await source.prepare({
      releasesDir: paths.releases,
      nodeModulesDir: paths.nodeModules,
      home: paths.home,
      allowStale: opts.fromLocal,
    });
    process.stdout.write(`✓ staged ${staged.version} at ${staged.stagedPath}\n`);

    // Install external runtime deps at the release dir (#582)
    {
      const pkgPath = join(staged.stagedPath, "package.json");
      const { readFileSync, writeFileSync } = await import("node:fs");
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        const externals: Record<string, string> = { patchright: "^1.59.4", "rettiwt-api": "^4.1.3" };
        pkg.dependencies = { ...pkg.dependencies, ...externals };
        writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
        const { execSync } = await import("node:child_process");
        execSync("npm install --omit=dev --ignore-scripts 2>/dev/null", { cwd: staged.stagedPath, timeout: 60_000 });
        process.stdout.write(`✓ external deps installed\n`);
      } catch (err) {
        process.stdout.write(`⚠ external deps install failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    // Create stable entry point symlink (main.js → bundle or dist)
    {
      const { existsSync, unlinkSync, symlinkSync } = await import("node:fs");
      const mainLink = join(staged.stagedPath, "main.js");
      try { unlinkSync(mainLink); } catch (err) { logAndSwallow("update", "op", err); }
      const entry = existsSync(join(staged.stagedPath, "bundle", "abtars.js"))
        ? "bundle/abtars.js"
        : "dist/main.js";
      symlinkSync(entry, mainLink);
    }

    // Preserve abmind symlinks from old release (#722)
    const { existsSync: ex2, lstatSync, readlinkSync, symlinkSync: sl2, mkdirSync: mk2 } = await import("node:fs");
    const oldNm = join(paths.home, "current", "node_modules");
    const preservedLinks: Array<{ name: string; target: string }> = [];
    if (ex2(oldNm)) {
      for (const name of ["abmind", "better-sqlite3"]) {
        const p = join(oldNm, name);
        try { if (ex2(p) && lstatSync(p).isSymbolicLink()) preservedLinks.push({ name, target: readlinkSync(p) }); } catch { /* skip */ }
      }
    }

    // Flip current → releases/<version>
    await activate(paths.current, staged.version);
    process.stdout.write(`✓ current -> releases/${staged.version}\n`);

    // Recreate preserved symlinks in new release
    if (preservedLinks.length > 0) {
      const newNm = join(paths.home, "current", "node_modules");
      mk2(newNm, { recursive: true });
      for (const { name, target } of preservedLinks) {
        try { sl2(target, join(newNm, name)); } catch { /* best effort */ }
      }
    }

    // Update manifest
    const prior = await readManifest(paths.manifest);
    const now = new Date().toISOString();
    const newPriorReleases = prior?.version
      ? [
          {
            version: prior.version,
            commit: prior.commit,
            activatedAt: prior.activatedAt,
            packageLockHash: prior.packageLockHash,
          },
          ...(prior.priorReleases ?? []),
        ].slice(0, RETENTION - 1)
      : prior?.priorReleases ?? [];

    await writeManifest(paths.manifest, {
      ...(prior ?? emptyManifest('abtars', hostname())),
      version: staged.version,
      commit: staged.commit,
      branch: staged.branch,
      packageLockHash: staged.packageLockHash,
      activatedAt: now,
      source: 'local',
      priorReleases: newPriorReleases,
    });
    process.stdout.write(`✓ manifest updated\n`);

    // Prune old releases
    const pruned = await pruneReleases(
      paths.releases,
      [staged.version, ...newPriorReleases.map((r: PriorRelease) => r.version)],
      staged.version,
      RETENTION,
    );
    if (pruned.length > 0) {
      process.stdout.write(`✓ pruned ${pruned.length} old release${pruned.length === 1 ? '' : 's'}: ${pruned.join(', ')}\n`);
    }

    process.stdout.write(`\nUpdate complete: ${staged.version}\n`);

    // Refresh scripts from repo — manifest-driven
    const { loadManifest } = await import('../install-manifest.js');
    const installManifest = loadManifest(process.cwd());
    const repoScripts = join(process.cwd(), 'scripts');
    const destScripts = join(paths.home, 'scripts');
    await mkdir(destScripts, { recursive: true });
    const allScriptFiles = await readdir(repoScripts).catch(() => [] as string[]);
    // Filter by manifest include patterns
    const matchesInclude = (name: string): boolean =>
      installManifest.scripts.include.some(pattern => {
        const ext = pattern.replace("*", "");
        return name.endsWith(ext);
      });
    const scriptFiles = allScriptFiles.filter(matchesInclude);
    const home = process.env['HOME'] ?? '';
    let serviceChanged = false;

    // Resolve install mode — skip supervisor artifacts in simple mode
    const installMode = (await readManifest(paths.manifest))?.installMode ?? "supervised";

    const isExecutable = (name: string): boolean => {
      const ext = installManifest.scripts.executable.replace("*", "");
      return name.endsWith(ext);
    };

    for (const name of scriptFiles) {
      await copyFile(join(repoScripts, name), join(destScripts, name));
      if (isExecutable(name)) await chmod(join(destScripts, name), 0o755);
      // Root-level copies for launcher scripts watchdog/launchd reference directly
      if (isExecutable(name)) {
        await copyFile(join(repoScripts, name), join(paths.home, name));
        await chmod(join(paths.home, name), 0o755);
      }
      // macOS: template + install LaunchAgent plist (supervised only)
      const macService = installManifest.services.supervised.macos;
      if (macService && name === macService.plist && process.platform === 'darwin' && home && installMode === 'supervised') {
        const launchAgentsDir = join(home, 'Library', 'LaunchAgents');
        await mkdir(launchAgentsDir, { recursive: true });
        const dst = join(launchAgentsDir, name);
        const oldContent = await readFile(dst, 'utf-8').catch(() => '');
        let templated = await readFile(join(repoScripts, name), 'utf-8');
        for (const ph of macService.placeholders) templated = templated.replaceAll(ph, home);
        await writeFile(dst, templated);
        if (oldContent !== templated) serviceChanged = true;
      }
      // Linux: install systemd user service (supervised only)
      const linuxService = installManifest.services.supervised.linux;
      if (linuxService?.units.includes(name) && process.platform === 'linux' && home && installMode === 'supervised') {
        const systemdDir = join(home, '.config', 'systemd', 'user');
        await mkdir(systemdDir, { recursive: true });
        const dst = join(systemdDir, name);
        const oldContent = await readFile(dst, 'utf-8').catch(() => '');
        await copyFile(join(repoScripts, name), dst);
        const newContent = await readFile(dst, 'utf-8').catch(() => '');
        if (oldContent !== newContent) serviceChanged = true;
      }
    }
    process.stdout.write(`✓ scripts refreshed (${scriptFiles.length} files)\n`);

    // Regenerate CLI bin wrappers (#310) — keeps wrapper paths in sync with build layout
    const { writeWrapper } = await import('./install.js');
    await mkdir(paths.bin, { recursive: true });
    for (const name of installManifest.cliWrappers) {
      await writeWrapper(paths.bin, name, paths.current, false);
    }
    process.stdout.write(`✓ wrappers refreshed (${installManifest.cliWrappers.length} files)\n`);

    // Sync core skills from release to runtime (#438)
    const { rmSync, cpSync, readdirSync } = await import("node:fs");
    const skillsCoreSrc = join(staged.stagedPath, "core", "skills");
    const skillsCoreDst = join(paths.home, "skills", "core");
    if (existsSync(skillsCoreSrc)) {
      rmSync(skillsCoreDst, { recursive: true, force: true });
      cpSync(skillsCoreSrc, skillsCoreDst, { recursive: true });
      const files = readdirSync(skillsCoreDst, { recursive: true }) as string[];
      const count = files.filter(f => f.endsWith("SKILL.md")).length;
      process.stdout.write(`✓ skills/core synced (${count} skills)\n`);
    }
    // Ensure other skill dirs exist
    for (const d of ["custom", "downloaded", "self"]) {
      await mkdir(join(paths.home, "skills", d), { recursive: true });
    }
    // Migration (#614): remove stale pre-#438 top-level skill dirs (duplicates of core/)
    for (const stale of ["memory", "ops", "tools", "coding"]) {
      const p = join(paths.home, "skills", stale);
      if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); }
    }

    if (serviceChanged) {
      if (process.platform === 'darwin') {
        process.stdout.write(`⚠️  LaunchAgent plist updated — reload with: launchctl bootout gui/$(id -u)/com.abtars.watchdog && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abtars.watchdog.plist\n`);
      } else {
        process.stdout.write(`⚠️  systemd service updated — reload with: systemctl --user daemon-reload && systemctl --user restart abtars-watchdog\n`);
      }
    }


    // hashFile is unused here but imported to validate the re-export surface;
    // leaving this no-op call removed — the re-export is exercised by tests.
    void hashFile;

    // #426 — Seed missing config + run config migrations
    const { ensureInstallInvariants } = await import("../ensure-invariants.js");
    const invariantResults = await ensureInstallInvariants(process.cwd(), paths.home);
    if (invariantResults.length > 0) {
      process.stdout.write(`✓ invariants: ${invariantResults.join(", ")}\n`);
    }

    // Native deps (sqlite-vec, better-sqlite3) handled by `abmind install` (#716)

    // Run doctor before restart
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

    // Auto-restart bridge on new code
    const manifestForRestart = await readManifest(paths.manifest);
    const restartMode = manifestForRestart?.installMode;
    if (!restartMode) {
      process.stderr.write("❌ installMode not set in manifest.json. Run 'abtars install' first.\n");
      return 1;
    }

    if (restartMode === "supervised-daemon" || restartMode === "supervised") {
      // Send USR1 to watchdog for graceful restart (#688)
      process.stdout.write("\nRestarting bridge via watchdog...\n");
      const wdLock = join(paths.home, "watchdog.lock");
      const wdPid = readJsonField(wdLock, "pid") as number | undefined;
      if (wdPid && wdPid > 0) {
        try {
          process.kill(wdPid, "SIGUSR1");
          process.stdout.write(`♻️ USR1 sent to watchdog (PID ${wdPid}) — bridge will restart\n`);
        } catch {
          process.stdout.write(`⚠️ Could not signal watchdog (PID ${wdPid}). Restart manually:\n`);
          if (process.platform === "darwin") {
            process.stdout.write(`  launchctl kickstart -k gui/$(id -u)/com.abtars.watchdog\n`);
          } else {
            process.stdout.write(`  systemctl --user restart abtars-watchdog\n`);
          }
        }
      } else {
        // No watchdog running — fall back to cold restart
        process.stdout.write(`⚠️ Watchdog not running. Cold restart...\n`);
        const { restart } = await import("./restart.js");
        await restart({ cold: true }).catch((err: unknown) => {
          process.stderr.write(`⚠️ Restart failed: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
    } else {
      // simple mode: no watchdog, cold restart
      process.stdout.write("\nRestarting bridge...\n");
      const { restart } = await import("./restart.js");
      await restart({ cold: true }).catch((err: unknown) => {
        process.stderr.write(`⚠️ Restart failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }

    const { printHealthSummary } = await import('./health-check.js');
    printHealthSummary(paths.home);

    return 0;
  } finally {
    await release();
  }
}
