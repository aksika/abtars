/**
 * Unified deploy flow — 9 steps, handles both first install and update.
 * #1085: replaces separate install + update commands.
 */
import { hostname } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { execSync, spawn } from "node:child_process";
import { abtarsHome } from "../../paths.js";
import { acquireLock, atomicSwap, cleanStaleStaging, healthProbe, packagePaths, readManifest, writeManifest, emptyManifest } from "../deploy-lib/index.js";
import { makeLocalBuildSource } from "../update-sources/dev.js";
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

  // Sync source repos — clone if missing, fetch+reset if exists, nuke+reclone on failure
  if (!opts.localDir) {
    const srcDir = join(paths.releasesDir, "src");
    mkdirSync(srcDir, { recursive: true });
    const abtarsSrcDir = join(srcDir, "abtars");
    const abmindSrcDir = join(srcDir, "abmind");
    const repos: Array<[string, string]> = [[abtarsSrcDir, "abtars"], [abmindSrcDir, "abmind"]];
    for (const [dir, name] of repos) {
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
          if (name === "abtars") return 1;
        }
      }
    }

    // Ensure abmind is built (needs deps for tsc)
    if (existsSync(join(abmindSrcDir, "package.json")) && !existsSync(join(abmindSrcDir, "dist", "cli", "abmind.js"))) {
      try {
        execSync("pnpm install --ignore-scripts 2>/dev/null || npm install --ignore-scripts 2>/dev/null", { cwd: abmindSrcDir, stdio: "pipe", timeout: 120_000 });
        execSync("npm run build", { cwd: abmindSrcDir, stdio: "pipe", timeout: 60_000 });
      } catch {}
    }
  }

  const repoRoot = opts.localDir ?? join(paths.releasesDir, "src", "abtars");

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
    const source = opts.source === "alpha" || opts.source === "stable"
      ? makeNpmSource("abtars", opts.source === "alpha" ? "alpha" : "latest")
      : makeLocalBuildSource({ repoRoot, allowStale: !!opts.skipFreshness });

    const staged = await source.prepare({ stagingDir: paths.appStaging, home: paths.home, allowStale: !!opts.skipFreshness });
    process.stdout.write(`✓ staged ${staged.version}\n`);

    // External runtime deps
    const pkgPath = join(staged.stagedPath, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.dependencies?.abmind?.startsWith("file:")) delete pkg.dependencies.abmind;
      // Remove bundled-only deps that aren't needed at runtime
      delete pkg.dependencies?.patchright;
      delete pkg.dependencies?.["rettiwt-api"];
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

    // ── Step 4: Bootstrap manifest if missing ─────────────────────────────
    if (isFirstInstall) {
      await writeManifest(paths.manifest, {
        ...emptyManifest("abtars", hostname()),
        installMode: "daemon",
        source: opts.source,
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
      source: opts.source,
      previousVersion: prior?.version ?? null,
      previousCommit: prior?.commit ?? null,
      installMode: prior?.installMode ?? "daemon",
      repoRoot,
    } as any);
    writeFileSync(join(paths.home, "deploy.state"), JSON.stringify({ status: "deploying", version: staged.version, startedAt: new Date().toISOString() }) + "\n");
    process.stdout.write(`✓ manifest updated\n`);

    // ── Step 7: Stop everything ─────────────────────────────────────────
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
      // simple mode: update only deploys, user manages lifecycle via start/stop
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

  // abmind CLI wrappers — point at the bundled copy inside the release
  const abmindDist = join(paths.app, "node_modules", "abmind", "dist", "cli");
  if (existsSync(abmindDist)) {
    for (const name of ["abmind", "abmind-embed"]) {
      const cliFile = name === "abmind" ? "abmind.js" : `${name}.js`;
      const target = join(abmindDist, cliFile);
      const content = `#!/usr/bin/env bash\nexec node "${target}" "$@"\n`;
      const dest = join(paths.bin, name);
      try { rmSync(dest); } catch {}
      await writeFile(dest, content, { mode: 0o755 });
    }
  }

  process.stdout.write(`✓ wrappers refreshed (${installManifest.cliWrappers.length} files)\n`);

  // One-time cleanup: remove stale binary dirs from data directories (#1134)
  const abmindHome = join(process.env["HOME"] ?? "", ".abmind");
  for (const stale of [join(abmindHome, "bin"), join(abmindHome, "current"), join(paths.home, "bin")]) {
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
  try { const { chmodSync } = await import("node:fs"); chmodSync(join(dest, "dist/cli/abmind.js"), 0o755); } catch {}
  process.stdout.write(`✓ abmind copied\n`);
}
