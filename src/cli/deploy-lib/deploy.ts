/**
 * Unified deploy flow — 9 steps, handles both first install and update.
 * #1085: replaces separate install + update commands.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { abtarsHome } from "../../paths.js";
import { acquireLock, atomicSwap, cleanStaleStaging, healthProbe, packagePaths, readManifest, writeManifest, emptyManifest } from "../deploy-lib/index.js";
import { makeLocalBuildSource } from "../update-sources/local.js";
import { makeNpmSource } from "../update-sources/npm.js";
import type { SourceName } from "../update-sources/types.js";

export interface DeployOptions {
  readonly source: SourceName;
  readonly localDir?: string;
  readonly skipFreshness?: boolean;
}

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf-8"))[field]; } catch { return undefined; }
}

export async function deploy(opts: DeployOptions): Promise<number> {
  const paths = packagePaths("abtars");
  const isFirstInstall = !existsSync(paths.manifest);
  const repoRoot = opts.localDir
    ?? (existsSync(join(paths.releasesDir, "src", "abtars", "package.json")) ? join(paths.releasesDir, "src", "abtars") : join(abtarsHome(), "src", "abtars"));

  // Sync source repos — clone if missing, fetch+reset if exists, nuke+reclone on failure
  if (!opts.localDir) {
    const srcDir = join(paths.releasesDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const abmindSrcDir = join(srcDir, "abmind");
    const repos: Array<[string, string]> = [[repoRoot, "abtars"], [abmindSrcDir, "abmind"]];
    for (const [dir, name] of repos) {
      try {
        if (existsSync(join(dir, ".git"))) {
          execSync("git fetch --depth 1 origin dev && git reset --hard origin/dev", { cwd: dir, stdio: "pipe", timeout: 30_000 });
        } else {
          rmSync(dir, { recursive: true, force: true });
          execSync(`git clone --depth 1 -b dev https://github.com/aksika/${name}.git`, { cwd: srcDir, stdio: "pipe", timeout: 120_000 });
        }
      } catch {
        // Fetch failed (corrupted shallow clone) — nuke and reclone
        try {
          rmSync(dir, { recursive: true, force: true });
          execSync(`git clone --depth 1 -b dev https://github.com/aksika/${name}.git`, { cwd: srcDir, stdio: "pipe", timeout: 120_000 });
        } catch (err) {
          process.stderr.write(`Failed to sync ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
          if (name === "abtars") return 1;
        }
      }
    }
  }

  if (!existsSync(join(repoRoot, "package.json"))) {
    process.stderr.write(`Source not found at ${repoRoot}\nUse: abtars update --local <DIR>\n`);
    return 1;
  }

  // ── Migrate from old layout if needed ────────────────────────────────
  const { migrateIfNeeded } = await import("./migrate-layout.js");
  migrateIfNeeded(paths.home);

  // ── Step 1: Lock ───────────────────────────────────────────────────────
  const release = await acquireLock(paths.lock, "deploy");
  try {
    cleanStaleStaging(paths.appStaging);
    process.stdout.write(`Building from ${repoRoot}...\n`);

    // ── Step 2: Build + Stage ──────────────────────────────────────────────
    const source = opts.source === "npm"
      ? makeNpmSource("abtars")
      : makeLocalBuildSource({ repoRoot, allowStale: !!opts.skipFreshness });

    const staged = await source.prepare({ stagingDir: paths.appStaging, home: paths.home, allowStale: !!opts.skipFreshness });
    process.stdout.write(`✓ staged ${staged.version}\n`);

    // External runtime deps
    const pkgPath = join(staged.stagedPath, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const externals: Record<string, string> = { patchright: "^1.59.4", "rettiwt-api": "^4.1.3" };
      pkg.dependencies = { ...pkg.dependencies, ...externals };
      if (pkg.dependencies?.abmind?.startsWith("file:")) delete pkg.dependencies.abmind;
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      execSync("pnpm install --prod --ignore-scripts 2>/dev/null", { cwd: staged.stagedPath, timeout: 120_000 });
      process.stdout.write(`✓ external deps installed\n`);
    } catch { process.stdout.write(`⚠ external deps install failed\n`); }

    // Copy abmind
    await copyAbmind(staged.stagedPath, repoRoot);

    // Validate
    if (!existsSync(join(staged.stagedPath, "bundle", "abtars.js"))) {
      process.stderr.write(`x entry point not found\n`);
      return 1;
    }

    // ── Step 3: Deploy to releases dir + repoint symlink ────────────────
    const { symlinkSync, unlinkSync, renameSync } = await import("node:fs");
    mkdirSync(paths.releasesDir, { recursive: true });
    const releaseDir = join(paths.releasesDir, staged.commit || staged.version);
    if (existsSync(releaseDir)) rmSync(releaseDir, { recursive: true, force: true });
    renameSync(staged.stagedPath, releaseDir);

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
    try { unlinkSync(paths.releasesCurrentLink); } catch {}
    symlinkSync(releaseDir, paths.releasesCurrentLink);

    // Keep legacy app/ as symlink for backward compat (WD, bridge.lock paths)
    try { rmSync(paths.app, { recursive: true, force: true }); } catch {}
    symlinkSync(releaseDir, paths.app);

    process.stdout.write(`✓ deployed to releases/${staged.commit || staged.version}\n`);

    // ── Step 4: Require prior install ──────────────────────────────────────
    if (isFirstInstall) {
      process.stderr.write("No manifest.json found. Run 'abtars install' first.\n");
      return 1;
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
      source: opts.source,
      previousVersion: prior?.version ?? null,
      previousCommit: prior?.commit ?? null,
      installMode: prior?.installMode ?? "daemon",
      repoRoot,
    } as any);
    writeFileSync(join(paths.home, "deploy.state"), JSON.stringify({ status: "deploying", version: staged.version, startedAt: new Date().toISOString() }) + "\n");
    process.stdout.write(`✓ manifest updated\n`);

    // ── Step 7: Kill bridge ───────────────────────────────────────────────
    if (!isFirstInstall) {
      writeFileSync(join(paths.home, ".start-reason"), `update:${staged.version}`);
      const bridgePid = readJsonField(join(paths.home, "bridge.lock"), "pid") as number | undefined;
      if (bridgePid && bridgePid > 0) {
        try { process.kill(bridgePid, "SIGTERM"); } catch {}
        process.stdout.write(`  x Killing bridge (PID ${bridgePid})...\n`);
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          try { process.kill(bridgePid, 0); } catch { break; }
        }
      }
      // Clear .stopped so WD can start
      try { rmSync(join(paths.home, ".stopped")); } catch {}
    }

    // ── Step 8: Respawn ───────────────────────────────────────────────────
    const manifest = await readManifest(paths.manifest);
    const mode = manifest?.installMode ?? "daemon";

    if (mode === "daemon") {
      if (process.platform === "darwin") {
        const plistPath = join(process.env["HOME"] ?? "", "Library/LaunchAgents/com.abtars.watchdog.plist");
        const uid = `gui/${process.getuid?.() ?? 501}`;
        try { execSync(`launchctl bootstrap ${uid} "${plistPath}"`, { stdio: "ignore", timeout: 5000 }); } catch {}
      } else {
        try { execSync("systemctl --user unmask abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
        try { execSync("systemctl --user enable abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
        try { execSync("systemctl --user start abtars-watchdog", { stdio: "ignore", timeout: 5000 }); } catch {}
      }
      process.stdout.write(`  Daemon started\n`);
    } else {
      // simple: start bridge directly
      const logFd = (await import("node:fs")).openSync(join(paths.home, "logs/bridge.log"), "a");
      const br = spawn("node", ["--max-old-space-size=1024", "app/bundle/abtars.js"], { detached: true, stdio: ["ignore", logFd, logFd], cwd: paths.home, env: { ...process.env, ABTARS_START_REASON: `update:${staged.version}` } });
      br.unref();
      (await import("node:fs")).closeSync(logFd);
      process.stdout.write(`  Bridge spawned directly\n`);
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
  } finally {
    await release();
  }
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
  process.stdout.write(`✓ wrappers refreshed (${installManifest.cliWrappers.length} files)\n`);

  // Nuke stale npm-global binary
  try { execSync("npm uninstall -g abtars 2>/dev/null", { stdio: "ignore", timeout: 10_000 }); } catch {}

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
    const src = join(paths.home, "scripts", "abtars-watchdog.service");
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

  // Skills + prompts
  const skillsSrc = join(paths.app, "core", "skills");
  const skillsDst = join(paths.home, "skills", "core");
  if (existsSync(skillsSrc)) {
    rmSync(skillsDst, { recursive: true, force: true });
    cpSync(skillsSrc, skillsDst, { recursive: true });
  }
  const promptsSrc = join(paths.app, "core", "prompts");
  const promptsDst = join(paths.home, "core", "prompts");
  if (existsSync(promptsSrc)) {
    mkdirSync(promptsDst, { recursive: true });
    for (const f of readdirSync(promptsSrc).filter(f => f.endsWith(".md"))) {
      copyFileSync(join(promptsSrc, f), join(promptsDst, f));
    }
  }
  process.stdout.write(`✓ skills + prompts synced\n`);

  // Config seed (first install only — don't overwrite existing)
  const releaseConfig = join(paths.app, "config");
  const destConfig = join(paths.home, "config");
  if (existsSync(releaseConfig)) {
    mkdirSync(destConfig, { recursive: true });
    for (const f of readdirSync(releaseConfig)) {
      if (f.endsWith(".example")) {
        cpSync(join(releaseConfig, f), join(destConfig, f));
        const target = join(destConfig, f.replace(".example", ""));
        if (!existsSync(target)) cpSync(join(releaseConfig, f), target);
      }
    }
    const defaultTransport = join(releaseConfig, "transport.default.json");
    if (existsSync(defaultTransport)) cpSync(defaultTransport, join(destConfig, "transport.default.json"));
  }
}

// ── Copy abmind ─────────────────────────────────────────────────────────────
async function copyAbmind(stagingDir: string, repoRoot: string): Promise<void> {
  const abmindSrc = join(repoRoot, "..", "abmind");
  if (!existsSync(join(abmindSrc, "package.json"))) return;
  // Rebuild abmind (type errors are non-fatal — check dist exists after)
  try {
    execSync("npm run build", { cwd: abmindSrc, stdio: "pipe", timeout: 60_000 });
  } catch {}
  if (!existsSync(join(abmindSrc, "dist", "cli", "abmind.js"))) {
    process.stdout.write(`⚠ abmind build failed (no dist output)\n`);
    return;
  }
  process.stdout.write(`✓ abmind rebuilt\n`);
  // Copy dist into staging
  const dest = join(stagingDir, "node_modules", "abmind");
  cpSync(abmindSrc, dest, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.includes(".git") });
  process.stdout.write(`✓ abmind copied\n`);
  // Refresh global abmind CLI
  try {
    execSync(`npm link --ignore-scripts`, { cwd: abmindSrc, stdio: "pipe", timeout: 30_000 });
    process.stdout.write(`✓ abmind CLI linked (global binary refreshed)\n`);
  } catch { process.stdout.write(`⚠ abmind CLI link failed (non-critical)\n`); }
}
