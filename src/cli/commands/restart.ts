import { printBanner } from './banner.js';
/**
 * abtars restart [--cold] — unified restart command.
 * Warm (default): writeRestartRequested → main.ts internal loop restarts.
 * Cold (--cold): kill process, then start fresh.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { acquireLock } from "../deploy-lib/lock.js";

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf-8"))[field]; } catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function killBridge(pid: number): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  process.stdout.write(`Killing bridge (PID ${pid})...\n`);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!pidAlive(pid)) return;
  }
  try { process.kill(pid, "SIGKILL"); } catch (err) { logAndSwallow("restart", "op", err); }
  await new Promise(r => setTimeout(r, 1000));
}

export async function restart(opts: { cold?: boolean }): Promise<number> {
  await printBanner("restart");
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");
  const cold = opts.cold ?? false;

  // Acquire operation lock to prevent concurrent restart/deploy
  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireLock(join(home, ".update.lock"), `restart${cold ? " --cold" : ""}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Restart already in progress: ${msg}\n`);
    return 0;
  }

  try {
    const bridgePid = readJsonField(lockFile, "pid") as number | undefined;
    const bridgeAlive = bridgePid != null && bridgePid > 0 && pidAlive(bridgePid);

    if (cold) {
      if (bridgeAlive) await killBridge(bridgePid!);

      // Clear circuit breaker — intentional restart = clean slate
      try {
        const s = JSON.parse(readFileSync(join(home, "deploy.state"), "utf-8"));
        s.restartCount = 0;
        (await import("node:fs")).writeFileSync(join(home, "deploy.state"), JSON.stringify(s) + "\n");
      } catch {}

      // Start via the start command (handles both modes)
      const { start } = await import("./start.js");
      return start();
    }

    // Warm restart
    if (bridgeAlive) {
      const { writeRestartRequested } = await import("../../components/transport/bridge-lock-transport.js");
      writeRestartRequested("restart");
      process.stdout.write(`Restart requested (PID ${bridgePid}) — bridge will restart within 30s\n`);
      return 0;
    }

    process.stdout.write("Bridge not running. Use --cold to start fresh.\n");
    return 1;
  } finally {
    if (releaseLock) await releaseLock();
  }
}
