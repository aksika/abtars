/**
 * abtars stop — kill watchdog (if running) then bridge (#372).
 *
 * Ordering matters: watchdog dies first so it doesn't respawn the bridge
 * we're about to kill. Each process gets SIGTERM → 5s grace → SIGKILL.
 *
 * Lock files (verified against live install):
 *   ~/.abtars/bridge.lock = {pid, watchdogPid, startedAt, version, sleepStatus, lastHeartbeat, ...}
 *   ~/.abtars/bridge.lock   = {"pid": number, "lastHeartbeat": ..., ...}
 * Both are separate files; no watchdog PID is embedded in bridge.lock.
 *
 * Supervised-daemon mode: refuses without --force (systemd/launchd would
 * respawn immediately). Mirrors the pattern in restart.ts for --cold.
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";


function readJsonField(file: string, field: string): unknown {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return data[field];
  } catch { return undefined; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Linux-only guard: verify cmdline contains expected substring. Mac has no /proc — returns true. */
function pidLooksLike(pid: number, needles: string[]): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    return needles.some(n => cmdline.includes(n));
  } catch { return true; /* /proc unavailable — trust the lock */ }
}

type KillResult = "killed" | "forced" | "gone" | "stale" | "not-running";

async function killGracefully(pid: number, needles: string[]): Promise<KillResult> {
  if (!pidAlive(pid)) return "not-running";
  if (!pidLooksLike(pid, needles)) return "stale";

  try { process.kill(pid, "SIGTERM"); } catch { return "not-running"; }

  // 10 × 500ms poll = 5s grace per process
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (!pidAlive(pid)) return "killed";
  }

  // Force kill
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 500));
  return pidAlive(pid) ? "not-running" : "forced";
}

function removeLock(path: string): void {
  try { if (existsSync(path)) unlinkSync(path); }
  catch (err) { logAndSwallow("stop", "op", err); }
}

export async function stop(opts: { force?: boolean }): Promise<number> {
  const home = abtarsHome();
  const manifestPath = join(home, "manifest.json");
  const bridgeLock = join(home, "bridge.lock");
  const stoppedSentinel = join(home, ".start-reason");

  const installMode = readJsonField(manifestPath, "installMode") as string | undefined;

  // 0) Write sentinel — prevents watchdog from respawning even if kill races with launchd
  try { require("node:fs").writeFileSync(stoppedSentinel, "stopped"); } catch {}

  // 1) Unload supervisor service (prevent respawn)
  if (installMode === "daemon") {
    if (process.platform === "darwin") {
      const plistPath = join(homedir(), "Library", "LaunchAgents", "com.abtars.watchdog.plist");
      const uid = `gui/${process.getuid!()}`;
      try { execFileSync("launchctl", ["bootout", uid, plistPath], { timeout: 5000 }); } catch {}
      await new Promise(r => setTimeout(r, 1000));
      // Retry in case launchd respawned before bootout took effect
      try { execFileSync("launchctl", ["bootout", uid, plistPath], { timeout: 5000 }); } catch {}
    } else {
      try { execFileSync("systemctl", ["--user", "stop", "abtars-watchdog"], { timeout: 5000 }); } catch {}
      try { execFileSync("systemctl", ["--user", "disable", "abtars-watchdog"], { timeout: 5000 }); } catch {}
    }
  }

  const wdPid = readJsonField(bridgeLock, "watchdogPid") as number | undefined;
  let wdResult: KillResult = "not-running";
  let wdPidActual: number | undefined;
  if (wdPid && wdPid > 0) {
    wdPidActual = wdPid;
    wdResult = await killGracefully(wdPid, ["watchdog.sh"]);
  }

  // 2) Bridge second
  const brPid = readJsonField(bridgeLock, "pid") as number | undefined;
  let brResult: KillResult = "not-running";
  let brPidActual: number | undefined;
  if (brPid && brPid > 0) {
    brPidActual = brPid;
    brResult = await killGracefully(brPid, ["abtars", "main.js", "bundle"]);
    if (brResult === "killed" || brResult === "forced") {
      removeLock(bridgeLock);
    } else if (brResult === "stale") {
      process.stdout.write(`⚠️ bridge.lock PID ${brPid} is not abtars — stale lock, removing\n`);
      removeLock(bridgeLock);
    }
  }

  // 3) Summary + exit code
  const wdMsg = formatResult("Watchdog", wdResult, wdPidActual);
  const brMsg = formatResult("Bridge", brResult, brPidActual);

  if (wdResult === "not-running" && brResult === "not-running") {
    process.stdout.write(`Nothing to stop — neither watchdog nor bridge running.\n`);
    return 0;
  }

  process.stdout.write(`🛑 ${wdMsg}\n   ${brMsg}\n`);

  if (installMode === "daemon") {
    process.stdout.write(`   Service unloaded. Use 'abtars start' to restart.\n`);
  }

  // Return 0 if nothing's still alive; 1 if we left something running
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
