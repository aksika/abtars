/**
 * abtars restart [--cold] — unified restart command.
 * Warm (default): writeRestartRequested → main.ts internal loop restarts.
 * Cold (--cold): kill process + spawn new launcher. Always, both modes.
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
}

function readJsonField(file: string, field: string): unknown {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data[field];
  } catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** #686: Kill any process holding port 3100 before spawning a new bridge. */
function killPortHolder(port: number): void {
  try {
    const pid = execSync(`lsof -ti :${port}`, { encoding: "utf-8", timeout: 3000 }).trim();
    if (!pid) return;
    process.stdout.write(`🛑 Killing stale process on port ${port} (pid ${pid})...\n`);
    try { execSync(`kill ${pid}`, { timeout: 3000, stdio: "pipe" }); } catch { /* */ }
    for (let i = 0; i < 5; i++) {
      try { execSync(`lsof -ti :${port}`, { stdio: "pipe", timeout: 1000 }); } catch { return; }
      try { execSync("sleep 1", { timeout: 2000, stdio: "pipe" }); } catch { /* */ }
    }
    try { execSync(`kill -9 ${pid}`, { timeout: 1000, stdio: "pipe" }); } catch { /* */ }
  } catch { /* no process on port — good */ }
}

async function spawnLauncher(home: string, argv: string[]): Promise<number> {
  const { spawn } = await import("node:child_process");
  const launcher = join(home, "scripts", "abtars.sh");
  if (!existsSync(launcher)) {
    process.stderr.write(`Launcher not found: ${launcher}\n`);
    return 1;
  }
  const child = spawn(launcher, argv, { detached: true, stdio: "ignore", cwd: home });
  child.unref();
  process.stdout.write(`♻️ Bridge starting (args: ${argv.join(" ")})...\n`);
  return 0;
}

async function killBridge(pid: number): Promise<void> {
  // Verify PID is actually the bridge (Linux /proc, fallback: skip check)
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    if (!cmdline.includes("abtars") && !cmdline.includes("main.js") && !cmdline.includes("bundle")) {
      process.stdout.write(`⚠️ PID ${pid} is not abtars — stale PID file\n`);
      return;
    }
  } catch (err) { logAndSwallow("restart", "op", err); }

  try { process.kill(pid, "SIGTERM"); } catch { return; }
  process.stdout.write(`🛑 Killing bridge (PID ${pid})...\n`);

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!pidAlive(pid)) return;
  }
  try { process.kill(pid, "SIGKILL"); } catch (err) { logAndSwallow("restart", "op", err); }
  await new Promise(r => setTimeout(r, 1000));
}

export async function restart(opts: { cold?: boolean }): Promise<number> {
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");
  const cold = opts.cold ?? false;

  const bridgePid = readJsonField(lockFile, "pid") as number | undefined;
  const bridgeAlive = bridgePid != null && bridgePid > 0 && pidAlive(bridgePid);

  if (cold) {
    const manifestPath = join(home, "manifest.json");
    const installMode = readJsonField(manifestPath, "installMode") as string | undefined;
    if (!installMode) {
      process.stderr.write("❌ installMode not set in manifest.json. Run 'abtars install' first.\n");
      return 1;
    }

    // Supervised mode: stop watchdog+bridge cleanly, start fresh. No USR1 race (#841).
    if (installMode === "supervised-daemon" || installMode === "supervised") {
      const { execSync } = await import("node:child_process");
      const wdLock = join(home, "watchdog.lock");
      const wdPid = readJsonField(wdLock, "pid") as number | undefined;
      process.stdout.write(`🛑 Stopping supervisor${wdPid ? ` (PID ${wdPid})` : ""}...\n`);
      try {
        execSync("abtars stop --force", { stdio: "pipe", timeout: 30_000 });
      } catch { /* may already be stopped */ }
      process.stdout.write(`✅ Supervisor stopped\n♻️ Starting fresh...\n`);
      try {
        execSync("abtars start", { stdio: "pipe", timeout: 30_000 });
      } catch (err) {
        process.stderr.write(`❌ Start failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      // Wait for bridge.lock to confirm new PIDs
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const newPid = readJsonField(lockFile, "pid") as number | undefined;
        if (newPid && newPid > 0 && pidAlive(newPid)) {
          const newWdPid = readJsonField(wdLock, "pid") as number | undefined;
          process.stdout.write(`✅ Bridge running (PID ${newPid})\n`);
          process.stdout.write(`✅ Supervisor running (PID ${newWdPid ?? "?"})\n`);
          return 0;
        }
      }
      process.stderr.write(`⚠️ Bridge started but health not confirmed within 30s.\n`);
      return 0;
    }

    // Simple (unsupervised) mode: kill bridge, spawn fresh
    const doctorPath = join(home, "scripts", "doctor.sh");
    if (existsSync(doctorPath)) {
      process.stdout.write("🩺 Health check...\n");
      try {
        const { execSync } = await import("node:child_process");
        execSync(`bash "${doctorPath}" --fix`, { stdio: "inherit", timeout: 30_000 });
      } catch (err) {
        process.stderr.write(`⚠️ doctor --fix failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }

    if (bridgeAlive) await killBridge(bridgePid!);
    killPortHolder(3100);
    const { updateBridgeLockField } = await import("../../components/transport/bridge-lock-transport.js");
    updateBridgeLockField("restartRequested", null);
    const argv: string[] = [];
    return spawnLauncher(home, argv);
  }

  // Warm restart
  if (bridgeAlive) {
    const { writeRestartRequested } = await import("../../components/transport/bridge-lock-transport.js");
    writeRestartRequested("restart");
    process.stdout.write(`♻️ Restart requested (PID ${bridgePid}) — bridge will restart within 30s\n`);
    return 0;
  }

  process.stdout.write("Bridge not running. Use --cold to start.\n");
  return 1;
}
