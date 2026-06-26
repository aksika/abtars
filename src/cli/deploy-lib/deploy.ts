/**
 * Unified deploy flow. #1085 unified install+update; #1237 split into:
 *   - obtain (sync + prepare + abmind)  — fail-safe, may run as old code
 *   - deployActivation()                — brick-risk, runs fresh via __deploy
 * deploy() keeps the monolithic path (obtain+activate) for --local and tests.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, copyFileSync, unlinkSync, chmodSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execSync, spawnSync } from "node:child_process";
import { acquireLock, cleanStaleStaging, healthProbe, packagePaths, readManifest, writeManifest, emptyManifest } from "../deploy-lib/index.js";
import { makeLocalBuildSource } from "../update-sources/dev.js";
import { makeNpmSource } from "../update-sources/npm.js";
import type { SourceName, StagedRelease } from "../update-sources/types.js";

export interface DeployOptions {
  readonly source: SourceName;
  readonly localDir?: string;
  readonly skipFreshness?: boolean;
}

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf-8"))[field]; } catch { return undefined; }
}

/**
 * Sync source repos into <releasesDir>/src — clone if missing, fetch+reset if
 * present, nuke+reclone on failure. Throws if a required repo (abtars) cannot
 * be synced. Obtain step — fail-safe (no release is swapped here).
 */
export function syncSrcRepos(srcDir: string, names: readonly string[]): void {
  mkdirSync(srcDir, { recursive: true });
  for (const name of names) {
    const dir = join(srcDir, name);
    try {
      if (existsSync(join(dir, ".git"))) {
        execSync("git fetch --depth 1 origin dev && git reset --hard origin/dev", { cwd: dir, stdio: "pipe", timeout: 30_000 });
      } else {
        rmSync(dir, { recursive: true, force: true });
        execSync(`git clone --depth 1 -b dev https://github.com/aksika/${name}.git`, { cwd: srcDir, stdio: "pipe", timeout: 120_000 });
      }
    } catch {
      try {
        rmSync(dir, { recursive: true, force: true });
        execSync(`git clone --depth 1 -b dev https://github.com/aksika/${name}.git`, { cwd: srcDir, stdio: "pipe", timeout: 120_000 });
      } catch (err) {
        process.stderr.write(`Failed to sync ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (name === "abtars") throw err;
      }
    }
  }
}

/**
 * Ensure abmind src is built (needs deps for tsc). Obtain step.
 * NOTE: pnpm fallback retained until WS-A (#1234); abmind path unification is #1238.
 */
export function ensureAbmindBuilt(abmindSrcDir: string): void {
  if (existsSync(join(abmindSrcDir, "package.json")) && !existsSync(join(abmindSrcDir, "dist", "cli", "abmind.js"))) {
    try {
      execSync("pnpm install --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null", { cwd: abmindSrcDir, stdio: "pipe", timeout: 120_000 });
      execSync("npm run build", { cwd: abmindSrcDir, stdio: "pipe", timeout: 60_000 });
    } catch {}
  }
}

/**
 * Monolithic deploy: obtain (sync + prepare + abmind) then activate.
 * Used by `abtars update --local <dir>` and as the single-process path.
 * The bootstrap (#1237) instead obtains, then execs fresh `__deploy` which
 * calls deployActivation() directly.
 */
export async function deploy(opts: DeployOptions): Promise<number> {
  const paths = packagePaths("abtars");

  if (!opts.localDir) {
    const srcDir = join(paths.releasesDir, "src");
    try { syncSrcRepos(srcDir, ["abtars", "abmind"]); } catch { return 1; }
    ensureAbmindBuilt(join(srcDir, "abmind"));
  }

  const repoRoot = opts.localDir ?? join(paths.releasesDir, "src", "abtars");
  if (!existsSync(join(repoRoot, "package.json"))) {
    process.stderr.write(`Source not found at ${repoRoot}\nUse: abtars update --local <DIR>\n`);
    return 1;
  }

  const { migrateIfNeeded } = await import("./migrate-layout.js");
  migrateIfNeeded(paths.home);

  const release = await acquireLock(paths.lock, "deploy");
  try {
    cleanStaleStaging(paths.appStaging);
    process.stdout.write(`Building from ${repoRoot}...\n`);

    const source = opts.source === "alpha" || opts.source === "stable"
      ? makeNpmSource("abtars", opts.source === "alpha" ? "alpha" : "latest")
      : makeLocalBuildSource({ repoRoot, allowStale: !!opts.skipFreshness });

    const staged = await source.prepare({ stagingDir: paths.appStaging, home: paths.home, allowStale: !!opts.skipFreshness });
    process.stdout.write(`✓ staged ${staged.version}\n`);

    await copyAbmind(staged.stagedPath, repoRoot);

    return await deployActivation({ staged, channel: opts.source, repoRoot });
  } finally {
    await release();
  }
}

/**
 * `__deploy` CLI entry — runs as FRESHLY-staged code (the bundle the bootstrap
 * just produced). Consumes a StagedRelease via flags and performs activation
 * only. Hidden command; stable, forward-compatible arg contract:
 *   __deploy --staged <dir> --version <v> [--commit <c>] [--branch <b>]
 *            [--channel dev|alpha|stable] [--package-lock-hash <h>] [--repo-root <dir>]
 * Unknown flags are ignored.
 */
export async function deployActivationCli(flags: ReadonlyMap<string, string | boolean>): Promise<number> {
  const str = (k: string): string | undefined => (typeof flags.get(k) === "string" ? (flags.get(k) as string) : undefined);
  const stagedPath = str("staged");
  if (!stagedPath) {
    process.stderr.write(`__deploy: --staged <dir> is required\n`);
    return 2;
  }
  const paths = packagePaths("abtars");
  const channel = (str("channel") ?? "dev") as SourceName;
  const staged: StagedRelease = {
    version: str("version") ?? "unknown",
    stagedPath,
    commit: str("commit") ?? null,
    branch: str("branch") ?? null,
    packageLockHash: str("package-lock-hash") ?? null,
    source: channel,
  };
  const repoRoot = str("repo-root") ?? join(paths.releasesDir, "src", "abtars");

  const { migrateIfNeeded } = await import("./migrate-layout.js");
  migrateIfNeeded(paths.home);

  const release = await acquireLock(paths.lock, "deploy");
  try {
    return await deployActivation({ staged, channel, repoRoot });
  } finally {
    await release();
  }
}

/**
 * Activation: stage → releases/<commit> → history → symlink → refresh →
 * manifest → stop → respawn → healthProbe. BRICK-RISK — always runs fresh.
 * Caller MUST hold the deploy lock. Does not build/fetch (obtain is done).
 *
 * The stop/respawn sequence (Step 7/8) is FROZEN (abtars.md watchdog) — moved
 * verbatim from the previous monolithic deploy().
 */
async function deployActivation(args: { staged: StagedRelease; channel: SourceName; repoRoot: string }): Promise<number> {
  const { staged, channel, repoRoot } = args;
  const paths = packagePaths("abtars");
  const isFirstInstall = !existsSync(paths.manifest);
  process.stdout.write(`[__deploy] activating ${staged.version} from ${staged.stagedPath}\n`);

  // Validate entry point
  if (!existsSync(join(staged.stagedPath, "bundle", "abtars.js"))) {
    process.stderr.write(`x entry point not found\n`);
    return 1;
  }

  // ── Step 3: Deploy to releases dir + repoint symlink ────────────────
  const { symlinkSync, unlinkSync: unlink } = await import("node:fs");
  mkdirSync(paths.releasesDir, { recursive: true });
  const releaseDir = join(paths.releasesDir, staged.commit || staged.version);
  if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
  // Copy (not rename): the running __deploy CLI execs from staged.stagedPath;
  // moving it would break code-split dynamic imports. staged/ is reclaimed by
  // cleanStaleStaging on the next bootstrap.
  cpSync(staged.stagedPath, releaseDir, { recursive: true });

  // Update history.json (ordered array, max 4)
  let history: string[] = [];
  try { history = JSON.parse(readFileSync(paths.releasesHistory, "utf-8")); } catch {}
  history.unshift(staged.commit || staged.version);
  if (history.length > 4) {
    const dropped = history.pop()!;
    rmSync(join(paths.releasesDir, dropped), { recursive: true, force: true });
  }
  writeFileSync(paths.releasesHistory, JSON.stringify(history) + "\n");

  // Repoint current symlink
  try { unlink(paths.releasesCurrentLink); } catch {}
  symlinkSync(releaseDir, paths.releasesCurrentLink);

  // Keep legacy app/ as symlink for backward compat (WD, bridge.lock paths)
  try { rmSync(paths.app, { recursive: true, force: true }); } catch {}
  symlinkSync(releaseDir, paths.app);

  process.stdout.write(`✓ deployed to releases/${staged.commit || staged.version}\n`);

  // ── Step 4: Bootstrap manifest if missing ─────────────────────────────
  if (isFirstInstall) {
    await writeManifest(paths.manifest, {
      ...emptyManifest("abtars", hostname()),
      installMode: "daemon",
      source: channel,
    } as any);
  }

  // ── Step 5: Refresh ───────────────────────────────────────────────────
  await refresh(paths, repoRoot);

  // ── Step 6: Manifest + deploy.state ───────────────────────────────────
  const prior = isFirstInstall ? null : await readManifest(paths.manifest);
  await writeManifest(paths.manifest, {
    ...(prior ?? emptyManifest("abtars", hostname())),
    version: staged.version,
    commit: staged.commit,
    branch: staged.branch,
    packageLockHash: staged.packageLockHash,
    activatedAt: new Date().toISOString(),
    source: channel,
    previousVersion: prior?.version ?? null,
    previousCommit: prior?.commit ?? null,
    installMode: prior?.installMode ?? "daemon",
    repoRoot,
  } as any);
  writeFileSync(join(paths.home, "deploy.state"), JSON.stringify({ status: "deploying", version: staged.version, startedAt: new Date().toISOString() }) + "\n");
  process.stdout.write(`✓ manifest updated\n`);

  // ── Step 7: Stop everything (FROZEN — abtars.md watchdog) ────────────
  if (!isFirstInstall) {
    // 7.1 Stop daemon service (tells WD to exit via service manager)
    if (process.platform === "darwin") {
      const uid = `gui/${process.getuid?.() ?? 501}`;
      try { execSync(`launchctl bootout ${uid}/com.abtars.watchdog 2>/dev/null`, { stdio: "ignore", timeout: 5000 }); } catch {}
    } else {
      try { execSync("systemctl --user stop abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
    }

    // 7.2 Write .start-reason = "update:X" (safety net if WD survives service stop)
    writeFileSync(join(paths.home, ".start-reason"), `update:${staged.version}`);

    // 7.3 Kill WD PID explicitly (belt)
    const wdPid = readJsonField(join(paths.home, "bridge.lock"), "watchdogPid") as number | undefined;
    if (wdPid && wdPid > 0) {
      try { process.kill(wdPid, "SIGTERM"); } catch {}
    }

    // 7.4 Kill bridge PID
    const bridgePid = readJsonField(join(paths.home, "bridge.lock"), "pid") as number | undefined;
    if (bridgePid && bridgePid > 0) {
      try { process.kill(bridgePid, "SIGTERM"); } catch {}
      process.stdout.write(`  x Killing bridge (PID ${bridgePid})...\n`);
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 500));
        try { process.kill(bridgePid, 0); } catch { break; }
      }
    }

    // 7.5 Wait for WD to die (flock release). SIGKILL after 3s.
    if (wdPid && wdPid > 0) {
      let wdAlive = false;
      for (let i = 0; i < 6; i++) {
        try { process.kill(wdPid, 0); wdAlive = true; } catch { wdAlive = false; break; }
        await new Promise(r => setTimeout(r, 500));
      }
      if (wdAlive) { try { process.kill(wdPid, "SIGKILL"); } catch {} }
    }

    // 7.6 Clear .stopped sentinel
    try { rmSync(join(paths.home, ".stopped")); } catch {}
  }

  // ── Step 8: Respawn ───────────────────────────────────────────────────
  // 8.1 Write neutral .start-reason — new WD won't match any exit case
  writeFileSync(join(paths.home, ".start-reason"), "deploy-respawn");

  const manifest = await readManifest(paths.manifest);
  const mode = manifest?.installMode ?? "daemon";

  // 8.2 Restart daemon service
  if (mode === "daemon") {
    if (process.platform === "darwin") {
      const plistPath = join(process.env["HOME"] ?? "", "Library/LaunchAgents/com.abtars.watchdog.plist");
      const uid = `gui/${process.getuid?.() ?? 501}`;
      try { execSync(`launchctl bootstrap ${uid} "${plistPath}"`, { stdio: "ignore", timeout: 5000 }); } catch {}
    } else {
      try { execSync("systemctl --user daemon-reload", { stdio: "ignore", timeout: 5000 }); } catch {}
      try { execSync("systemctl --user unmask abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
      try { execSync("systemctl --user enable abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
      try { execSync("systemctl --user start abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
    }
    process.stdout.write(`  Daemon started\n`);
  } else {
    process.stdout.write(`  Deployed. Run 'abtars start' to launch the bridge.\n`);
  }

  // ── Step 9: Health probe ──────────────────────────────────────────────
  process.stdout.write(`Waiting for bridge health...\n`);
  const health = await healthProbe(paths.home, Date.now(), 180_000);
  if (health.healthy) {
    process.stdout.write(`✓ Bridge healthy (PID ${health.pid}, tick at ${new Date(health.heartbeat!).toISOString()})\n`);
    writeFileSync(join(paths.home, "deploy.state"), JSON.stringify({ status: "success", version: staged.version, completedAt: new Date().toISOString() }) + "\n");
  } else {
    process.stderr.write(`⚠ Bridge not healthy after 120s — check logs. Watchdog will keep trying.\n`);
    writeFileSync(join(paths.home, "deploy.state"), JSON.stringify({ status: "unhealthy", version: staged.version, completedAt: new Date().toISOString() }) + "\n");
  }

  return 0;
}

// ── Refresh ─────────────────────────────────────────────────────────────────
async function refresh(paths: ReturnType<typeof packagePaths>, repoRoot: string): Promise<void> {
  // CLI wrappers
  await mkdir(paths.bin, { recursive: true });
  const { writeWrapper } = await import("../commands/install.js");
  const { loadManifest } = await import("../install-manifest.js");
  const installManifest = loadManifest(paths.app);
  for (const name of installManifest.cliWrappers) {
    await writeWrapper(paths.bin, name, paths.app, false);
  }

  // abmind CLI wrappers — point at the bundled copy inside the release
  const abmindDist = join(paths.app, "node_modules", "abmind", "dist", "cli");
  if (existsSync(abmindDist)) {
    for (const name of ["abmind", "abmind-embed"]) {
      const cliFile = name === "abmind" ? "abmind.js" : `${name}.js`;
      const target = join(abmindDist, cliFile);
      const content = `#!/usr/bin/env bash\nexport NODE_PATH="$HOME/.local/lib/node_modules:\${NODE_PATH:-}"\nexec node "${target}" "$@"\n`;
      const dest = join(paths.bin, name);
      try { rmSync(dest); } catch {}
      await writeFile(dest, content, { mode: 0o755 });
    }
  }

  process.stdout.write(`✓ wrappers refreshed (${installManifest.cliWrappers.length} files)\n`);

  // One-time cleanup: remove stale binary dirs from data directories (#1134)
  const abmindHome = join(process.env["HOME"] ?? "", ".abmind");
  for (const stale of [join(abmindHome, "bin"), join(abmindHome, "current"), join(abmindHome, "lib"), join(paths.home, "bin"), join(paths.home, "scripts"), join(paths.releasesDir, "deps")]) {
    if (existsSync(stale)) {
      rmSync(stale, { recursive: true, force: true });
      process.stdout.write(`✓ removed stale ${stale}\n`);
    }
  }

  // Reload plist/systemd if changed (scripts run from repoRoot directly)
  const repoScripts = join(repoRoot, "scripts");
  if (process.platform === "darwin") {
    const src = join(repoScripts, "com.abtars.watchdog.plist");
    const dst = join(process.env["HOME"] ?? "", "Library/LaunchAgents/com.abtars.watchdog.plist");
    if (existsSync(src)) {
      let srcContent = readFileSync(src, "utf-8").replace(/\{\{HOME\}\}/g, process.env["HOME"] ?? "");
      const dstContent = existsSync(dst) ? readFileSync(dst, "utf-8") : "";
      if (srcContent !== dstContent) {
        writeFileSync(dst, srcContent);
        const uid = `gui/${process.getuid?.() ?? 501}`;
        try { execSync(`launchctl bootout ${uid}/com.abtars.watchdog 2>/dev/null`, { stdio: "ignore", timeout: 5000 }); } catch {}
        try { execSync(`launchctl bootstrap ${uid} "${dst}"`, { stdio: "ignore", timeout: 5000 }); } catch {}
        process.stdout.write(`  ✓ plist reloaded\n`);
      }
    }
  } else {
    const src = join(repoScripts, "abtars-watchdog.service");
    const dst = join(process.env["HOME"] ?? "", ".config/systemd/user/abtars-watchdog.service");
    if (existsSync(src) && existsSync(dst)) {
      const srcContent = readFileSync(src, "utf-8");
      const dstContent = readFileSync(dst, "utf-8");
      if (srcContent !== dstContent) {
        copyFileSync(src, dst);
        try { execSync("systemctl --user daemon-reload", { stdio: "ignore", timeout: 5000 }); } catch {}
        process.stdout.write(`  ✓ systemd unit reloaded\n`);
      }
    }
  }

  // Reconcile runtime tree from templates
  const { reconcile, migrate } = await import("./reconcile.js");
  const templatesSrc = join(paths.app, "templates");
  reconcile(templatesSrc, paths.home);
  migrate(paths.home);
  process.stdout.write(`✓ skills + prompts synced\n`);
}

// ── Copy abmind ─────────────────────────────────────────────────────────────
export async function copyAbmind(stagingDir: string, repoRoot: string): Promise<void> {
  const abmindSrc = join(repoRoot, "..", "abmind");
  if (existsSync(join(abmindSrc, "package.json"))) {
    // Dev mode: build from sibling git repo
    try {
      execSync("npm run build", { cwd: abmindSrc, stdio: "pipe", timeout: 60_000 });
    } catch {}
    if (!existsSync(join(abmindSrc, "dist", "cli", "abmind.js"))) {
      process.stdout.write(`⚠ abmind build failed (no dist output)\n`);
      return;
    }
    process.stdout.write(`✓ abmind rebuilt\n`);
    const dest = join(stagingDir, "node_modules", "abmind");
    cpSync(abmindSrc, dest, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes(".git") });
    try { chmodSync(join(dest, "dist/cli/abmind.js"), 0o755); } catch {}
    process.stdout.write(`✓ abmind copied\n`);
    return;
  }

  // Registry mode (#1176): fetch abmind tarball directly
  try {
    const { resolveVersion, downloadTarball } = await import("../update-sources/registry-client.js");
    const tag = process.env["ABMIND_TAG"] ?? "alpha";
    const { version, tarballUrl } = await resolveVersion("abmind", tag);
    const dest = join(stagingDir, "node_modules", "abmind");
    const tgzPath = join(stagingDir, `abmind-${version}.tgz`);
    await downloadTarball(tarballUrl, tgzPath);
    mkdirSync(dest, { recursive: true });
    spawnSync("tar", ["-xzf", tgzPath, "--strip-components=1", "-C", dest], { stdio: "pipe" });
    if (existsSync(tgzPath)) unlinkSync(tgzPath);
    try { chmodSync(join(dest, "dist/cli/abmind.js"), 0o755); } catch {}
    process.stdout.write(`✓ abmind ${version} (registry)\n`);
  } catch (err) {
    process.stdout.write(`⚠ abmind fetch skipped: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
