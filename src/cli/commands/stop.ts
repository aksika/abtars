/**
 * abtars stop — kill watchdog (if running) then bridge (#372).
 *
 * Ordering matters: watchdog dies first so it doesn't respawn the bridge
 * we're about to kill. Each process gets SIGTERM → 5s grace → SIGKILL.
 *
 * Lock files (verified against live install):
 *   ~/.abtars/watchdog.lock = {"pid": number, "lastCheck": epoch-ms}
 *   ~/.abtars/bridge.lock   = {"pid": number, "lastHeartbeat": ..., ...}
 * Both are separate files; no watchdog PID is embedded in bridge.lock.
 *
 * Supervised-daemon mode: refuses without --force (systemd/launchd would
 * respawn immediately). Mirrors the pattern in restart.ts for --cold.
 */

import { logAndSwallow } from "../../components/log-and-swallow.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
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
  const watchdogLock = join(home, "watchdog.lock");
  const bridgeLock = join(home, "bridge.lock");
  const force = opts.force ?? false;

  // Supervised-daemon refusal
  const installMode = readJsonField(manifestPath, "installMode") as string | undefined;
  if (installMode === "supervised-daemon" && !force) {
    process.stderr.write(`Bridge runs under supervised-daemon — use supervisor stop (supervisor will respawn if you kill the process directly).\n`);
    if (process.platform === "darwin") {
      process.stderr.write(`  sudo -k launchctl bootout system/com.abtars.daemon\n`);
    } else {
      process.stderr.write(`  sudo -k systemctl stop abtars\n`);
    }
    process.stderr.write(`\nUse 'abtars stop --force' to kill the process anyway (supervisor will respawn).\n`);
    return 1;
  }

  // 1) Watchdog first
  const wdPid = readJsonField(watchdogLock, "pid") as number | undefined;
  let wdResult: KillResult = "not-running";
  let wdPidActual: number | undefined;
  if (wdPid && wdPid > 0) {
    wdPidActual = wdPid;
    wdResult = await killGracefully(wdPid, ["watchdog.sh"]);
    if (wdResult === "killed" || wdResult === "forced") {
      removeLock(watchdogLock);
    } else if (wdResult === "stale") {
      process.stdout.write(`⚠️ watchdog.lock PID ${wdPid} is not watchdog.sh — stale lock, removing\n`);
      removeLock(watchdogLock);
    }
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
