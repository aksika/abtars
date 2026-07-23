import { printBanner } from './banner.js';
import { join } from "node:path";
import { abtarsHome } from "../../paths.js";
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { acquireLock } from "../deploy-lib/lock.js";
import { publishCommand, resetRestartCount } from "../../supervisor/state.js";
import { isPidAlive, validateBridgePid, readBridgeLock } from "../../supervisor/identity.js";

async function killBridge(pid: number, expectedIdentity: string): Promise<void> {
  if (!validateBridgePid(pid, expectedIdentity, ["abtars.js", "bundle"]).safeToSignal) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  process.stdout.write(`Killing bridge (PID ${pid})...\n`);
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!isPidAlive(pid)) return;
  }
  if (validateBridgePid(pid, expectedIdentity, ["abtars.js", "bundle"]).safeToSignal) {
    try { process.kill(pid, "SIGKILL"); } catch (err) { logAndSwallow("restart", "op", err); }
  }
  await new Promise(r => setTimeout(r, 1000));
}

export async function restart(opts: { cold?: boolean }): Promise<number> {
  await printBanner("restart");
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");
  const cold = opts.cold ?? false;

  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireLock(join(home, ".update.lock"), `restart${cold ? " --cold" : ""}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stdout.write(`Restart already in progress: ${msg}\n`);
    return 0;
  }

  try {
    const lock = readBridgeLock(lockFile);
    const bridgePid = lock && typeof lock.pid === "number" ? lock.pid : undefined;
    const bridgeIdentity = lock && typeof lock.startIdentity === "string" ? lock.startIdentity : null;
    const bridgeAlive = bridgePid != null && bridgePid > 0 && bridgeIdentity !== null &&
      validateBridgePid(bridgePid, bridgeIdentity, ["abtars.js", "bundle"]).safeToSignal;

    if (cold) {
      if (bridgeAlive) await killBridge(bridgePid!, bridgeIdentity!);
      resetRestartCount(home, "cold-restart");
      const { start } = await import("./start.js");
      return start();
    }

    if (bridgeAlive) {
      const command = publishCommand(home, "restart", "restart");
      if (command.result === "busy") {
        process.stderr.write("Restart already has another pending supervisor command.\n");
        return 1;
      }
      try {
        const current = readBridgeLock(join(home, "bridge.lock"));
        const wdPid = current && typeof current.watchdogPid === "number" ? current.watchdogPid : null;
        const wdIdentity = current && typeof current.watchdogStartIdentity === "string" ? current.watchdogStartIdentity : null;
        if (wdPid && wdPid > 0 && wdIdentity && validateBridgePid(wdPid, wdIdentity, ["abtars-watchdog.sh"]).safeToSignal) {
          process.kill(wdPid, "SIGUSR1");
        }
      } catch { /* lock missing */ }
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
