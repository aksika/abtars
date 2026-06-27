import { printBanner } from './banner.js';
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";


function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf-8"))[field]; } catch { return undefined; }
}

export async function start(): Promise<number> {
  await printBanner("start");
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");
  const startReasonFile = join(home, ".start-reason");

  // Clear stop sentinel so WD/bridge can start
  try { unlinkSync(startReasonFile); } catch {}
  try { unlinkSync(join(home, ".stopped")); } catch {}

  const installMode = readJsonField(join(home, "manifest.json"), "installMode") as string | undefined;

  // Daemon mode — let launchd/systemd handle it
  if (installMode === "daemon") {
    if (process.platform === "darwin") {
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.abtars.watchdog.plist");
      const uid = `gui/${process.getuid!()}`;
      try { execFileSync("launchctl", ["bootstrap", uid, plistPath], { timeout: 5000 }); } catch {}
    } else {
      try { execFileSync("systemctl", ["--user", "unmask", "abtars-watchdog"], { timeout: 5000 }); } catch {}
      try { execFileSync("systemctl", ["--user", "enable", "abtars-watchdog"], { timeout: 5000 }); } catch {}
      try { execFileSync("systemctl", ["--user", "start", "abtars-watchdog"], { timeout: 5000 }); } catch {}
    }
    process.stdout.write(`✓ Service loaded. Watchdog starting...\n`);
    return 0;
  }

  // Simple mode — spawn bridge directly
  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, "utf-8"));
      if (lock.pid && pidAlive(lock.pid)) {
        process.stdout.write(`Bridge already running (pid ${lock.pid}).\n`);
        return 0;
      }
    } catch { /* corrupt lock — proceed */ }
  }

  const entryPoint = join(home, "app", "bundle", "abtars.js");
  if (!existsSync(entryPoint)) {
    process.stderr.write(`No release deployed. Run 'abtars update' first.\n`);
    return 1;
  }

  const { spawn } = await import("node:child_process");
  const { openSync, closeSync, mkdirSync } = await import("node:fs");
  mkdirSync(join(home, "logs"), { recursive: true });
  const logFd = openSync(join(home, "logs", "bridge.log"), "a");
  const br = spawn("node", ["--max-old-space-size=1024", entryPoint], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: home,
    env: { ...process.env, ABTARS_START_REASON: "manual-start" },
  });
  br.unref();
  closeSync(logFd);
  process.stdout.write(`✓ Bridge started (pid ${br.pid}).\n`);
  return 0;
}
