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
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");
  const stoppedSentinel = join(home, ".stopped");

  // Remove stop sentinel
  try { if (existsSync(stoppedSentinel)) unlinkSync(stoppedSentinel); } catch {}

  // Reload supervisor service if supervised
  const installMode = readJsonField(join(home, "manifest.json"), "installMode") as string | undefined;
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

  if (existsSync(lockFile)) {
    try {
      const lock = JSON.parse(readFileSync(lockFile, "utf-8"));
      if (lock.pid && pidAlive(lock.pid)) {
        process.stdout.write(`Bridge already running (pid ${lock.pid}).\n`);
        return 0;
      }
    } catch { /* corrupt lock — proceed with start */ }
  }

  const { restart } = await import("./restart.js");
  return restart({ cold: true });
}
