import { printBanner } from './banner.js';
import { logAndSwallow } from "../../components/log-and-swallow.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { setDesiredState, publishCommand } from "../../supervisor/state.js";
import { isPidAlive, validateBridgePid } from "../../supervisor/identity.js";

function readJsonField(file: string, field: string): unknown {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data[field];
  } catch { return undefined; }
}

type KillResult = "killed" | "forced" | "gone" | "stale" | "not-running";

async function killGracefully(pid: number, needles: readonly string[]): Promise<KillResult> {
  const result = validateBridgePid(pid, null, needles);
  if (!result.safeToSignal) {
    if (result.status === "dead") return "not-running";
    return "stale";
  }

  try { process.kill(pid, "SIGTERM"); } catch { return "not-running"; }

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!isPidAlive(pid)) return "killed";
  }

  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 500));
  return isPidAlive(pid) ? "not-running" : "forced";
}

function removeLock(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); }
  catch (err) { logAndSwallow("stop", "op", err); }
}

function sigusrWatchdog(home: string): void {
  try {
    const lock = JSON.parse(readFileSync(join(home, "bridge.lock"), "utf-8"));
    const wdPid = typeof lock.watchdogPid === "number" ? lock.watchdogPid : null;
    if (wdPid && wdPid > 0) {
      process.kill(wdPid, "SIGUSR1");
    }
  } catch { /* lock missing — ok */ }
}

export async function stop(_opts: {}): Promise<number> {
  await printBanner("stop");
  const home = abtarsHome();
  const manifestPath = join(home, "manifest.json");
  const bridgeLock = join(home, "bridge.lock");

  publishCommand(home, "stop", "stopped");
  setDesiredState(home, "stopped");
  sigusrWatchdog(home);

  const installMode = readJsonField(manifestPath, "installMode") as string | undefined;

  let serviceWasStopped = false;
  if (installMode === "daemon") {
    if (process.platform === "darwin") {
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.abtars.watchdog.plist");
      const uid = `gui/${process.getuid!()}`;
      try { execFileSync("launchctl", ["bootout", uid, plistPath], { timeout: 5000, stdio: 'pipe' }); serviceWasStopped = true; } catch {}
      await new Promise(r => setTimeout(r, 1000));
      try { execFileSync("launchctl", ["bootout", uid, plistPath], { timeout: 5000, stdio: 'pipe' }); } catch {}
    } else {
      try { execFileSync("systemctl", ["--user", "stop", "abtars-watchdog"], { timeout: 5000, stdio: 'pipe' }); serviceWasStopped = true; } catch {}
      try { execFileSync("systemctl", ["--user", "disable", "abtars-watchdog"], { timeout: 5000, stdio: 'pipe' }); } catch {}
    }
  }

  const wdPid = readJsonField(bridgeLock, "watchdogPid") as number | undefined;
  let wdResult: KillResult = "not-running";
  let wdPidActual: number | undefined;
  if (wdPid && wdPid > 0) {
    wdPidActual = wdPid;
    wdResult = await killGracefully(wdPid, ["abtars-watchdog.sh"]);
  }

  const brPid = readJsonField(bridgeLock, "pid") as number | undefined;
  let brResult: KillResult = "not-running";
  let brPidActual: number | undefined;
  if (brPid && brPid > 0) {
    brPidActual = brPid;
    brResult = await killGracefully(brPid, ["abtars.js", "bundle"]);
    if (brResult === "killed" || brResult === "forced") {
      removeLock(bridgeLock);
    } else if (brResult === "stale") {
      process.stdout.write(`warning bridge.lock PID ${brPid} is not abtars — stale lock, removing\n`);
      removeLock(bridgeLock);
    }
  }

  const wdMsg = formatResult("Watchdog", wdResult, wdPidActual);
  const brMsg = formatResult("Bridge", brResult, brPidActual);

  if (wdResult === "not-running" && brResult === "not-running") {
    if (serviceWasStopped) {
      removeLock(bridgeLock);
      process.stdout.write(`* Stopped via service manager.\n`);
    } else {
      process.stdout.write(`Nothing to stop — neither watchdog nor bridge running.\n`);
    }
    return 0;
  }

  process.stdout.write(`* ${wdMsg}\n   ${brMsg}\n`);

  if (installMode === "daemon") {
    process.stdout.write(`   Service unloaded. Use 'abtars start' to restart.\n`);
  }

  const allDown =
    (wdResult === "not-running" || wdResult === "killed" || wdResult === "forced" || wdResult === "stale") &&
    (brResult === "not-running" || brResult === "killed" || brResult === "forced" || brResult === "stale");
  return allDown ? 0 : 1;
}

function formatResult(label: string, result: KillResult, pid: number | undefined): string {
  switch (result) {
    case "killed":      return `${label} stopped (PID ${pid}, SIGTERM)`;
    case "forced":      return `${label} stopped (PID ${pid}, SIGKILL)`;
    case "stale":       return `${label} lock was stale (PID ${pid} not ours)`;
    case "not-running": return `${label} was not running`;
    case "gone":        return `${label} kill failed — PID ${pid} still alive`;
  }
}
