/**
 * abtars restart [--cold] — unified restart command.
 * Warm (default): writeRestartRequested → main.ts internal loop restarts.
 * Cold (--cold): kill process + spawn new launcher. Always, both modes.
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { existsSync, readFileSync } from "node:fs";
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

async function spawnLauncher(home: string, argv: string[]): Promise<number> {
  const { spawn } = await import("node:child_process");
  const launcher = join(home, "abtars.sh");
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
    // Under supervised-daemon, cold restart requires sudo — refuse and print instructions
    const manifestPath = join(home, "manifest.json");
    const installMode = readJsonField(manifestPath, "installMode") as string | undefined;
    if (installMode === "supervised-daemon") {
      const platform = process.platform;
      if (platform === "darwin") {
        process.stderr.write(`Cold restart under supervised-daemon requires sudo:\n  sudo -k launchctl kickstart -k system/com.abtars.daemon\n`);
      } else {
        process.stderr.write(`Cold restart under supervised-daemon requires sudo:\n  sudo -k systemctl restart abtars\n`);
      }
      return 1;
    }

    if (bridgeAlive) await killBridge(bridgePid!);
    const argv = (readJsonField(lockFile, "argv") as string[] | undefined) ?? [];
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
