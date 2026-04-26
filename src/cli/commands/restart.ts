/**
 * agentbridge restart [--cold] — unified restart command.
 * Warm (default): writeRestartRequested flag → bridge exits within 30s → supervisor respawns.
 * Cold: ensures supervisor is running before/after flag write.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function agentBridgeHome(): string {
  return process.env["AGENT_BRIDGE_HOME"] ?? join(process.env["HOME"] ?? "", ".agentbridge");
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

function readInstallMode(home: string): "simple" | "supervised" {
  try {
    const mf = JSON.parse(readFileSync(join(home, "manifest.json"), "utf-8"));
    const mode = mf.installMode;
    return mode === "simple" || mode === "supervised" ? mode : "supervised";
  } catch {
    return "supervised";
  }
}

function supervisorInstalled(): boolean {
  const home = process.env["HOME"] ?? "";
  if (process.platform === "darwin") {
    return existsSync(join(home, "Library", "LaunchAgents", "com.agentbridge.watchdog.plist"));
  }
  return existsSync(join(home, ".config", "systemd", "user", "agentbridge-watchdog.service"));
}

function supervisorRunning(): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("launchctl print gui/$(id -u)/com.agentbridge.watchdog", { stdio: "pipe" });
      return true;
    }
    const out = execSync("systemctl --user is-active agentbridge-watchdog", { encoding: "utf-8", stdio: "pipe" }).trim();
    return out === "active";
  } catch { return false; }
}

function startSupervisor(): boolean {
  try {
    if (process.platform === "darwin") {
      execSync("launchctl kickstart gui/$(id -u)/com.agentbridge.watchdog", { stdio: "inherit" });
    } else {
      execSync("systemctl --user start agentbridge-watchdog", { stdio: "inherit" });
    }
    return true;
  } catch (err) {
    process.stderr.write(`Failed to start supervisor: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

export async function restart(opts: { cold?: boolean }): Promise<number> {
  const home = agentBridgeHome();
  const lockFile = join(home, "bridge.lock");
  const wdLockFile = join(home, "watchdog.lock");
  const cold = opts.cold ?? false;
  const mode = readInstallMode(home) ?? "simple";

  const bridgePid = readJsonField(lockFile, "pid") as number | undefined;
  const bridgeAlive = bridgePid != null && bridgePid > 0 && pidAlive(bridgePid);

  const wdPid = readJsonField(wdLockFile, "pid") as number | undefined;
  const wdAlive = wdPid != null && wdPid > 0 && pidAlive(wdPid);

  if (bridgeAlive) {
    // Write restart flag
    const { writeRestartRequested } = await import("../../components/transport/bridge-lock-transport.js");
    writeRestartRequested(cold ? "cold-restart" : "restart");
    process.stdout.write(`♻️ Restart requested (PID ${bridgePid}) — bridge will restart within 30s\n`);

    // Cold + supervised: ensure watchdog is alive so bridge respawns after exit
    if (cold && mode === "supervised" && !wdAlive) {
      if (supervisorInstalled()) {
        process.stdout.write("⚠️ Watchdog not running — starting supervisor\n");
        if (!startSupervisor()) return 1;
      }
    }
    return 0;
  }

  // Bridge not running
  if (!cold) {
    process.stdout.write("Bridge not running. Use --cold to start.\n");
    return 1;
  }

  // Cold path: try to bring it up
  if (wdAlive) {
    process.stdout.write("♻️ Watchdog active — bridge will respawn shortly\n");
    return 0;
  }

  if (mode === "supervised" && supervisorInstalled()) {
    if (supervisorRunning()) {
      process.stdout.write("♻️ Supervisor running — bridge will respawn shortly\n");
      return 0;
    }
    process.stdout.write("♻️ Starting supervisor\n");
    return startSupervisor() ? 0 : 1;
  }

  // Simple mode or no supervisor
  process.stdout.write("Bridge not running. Start manually or install with --mode=supervised.\n");
  return 1;
}
