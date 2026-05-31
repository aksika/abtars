/**
 * `abtars daemon` — manage the system service (install/uninstall/start/stop/restart/status).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { logAndSwallow } from "../../components/log-and-swallow.js";

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
}

function isWSL(): boolean {
  try { return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft"); } catch { return false; }
}

type Scope = "system" | "user" | null;

function detectScope(): Scope {
  if (existsSync("/etc/systemd/system/abtars.service")) return "system";
  const userUnit = join(process.env["HOME"] ?? "", ".config", "systemd", "user", "abtars-watchdog.service");
  if (existsSync(userUnit)) return "user";
  return null;
}
function unitName(scope: Scope): string {
  return scope === "user" ? "abtars-watchdog" : "abtars";
}

// ── install ──

async function daemonInstall(): Promise<number> {
  const platform = process.platform;
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  if (platform === "linux" && isWSL()) {
    process.stderr.write(`ℹ️  WSL detected — ensure systemd is enabled (wsl.conf: [boot] systemd=true)\n`);
  }

  const sudoUser = process.env["SUDO_USER"];
  if (process.getuid?.() !== 0) {
    process.stderr.write(
      `Requires sudo for system-scope service registration.\n` +
      `Run: sudo -k $(which abtars) daemon install\n`,
    );
    return 2;
  }
  if (!sudoUser) {
    process.stderr.write(`Cannot determine target user — $SUDO_USER is not set.\n`);
    return 2;
  }

  // Resolve the SUDO_USER's home, not root's
  const { execSync: execSyncHome } = await import("node:child_process");
  const userHome = execSyncHome(`eval echo ~${sudoUser}`, { encoding: "utf-8" }).trim();
  const home = join(userHome, ".abtars");

  const currentLink = join(home, "current");
  if (!existsSync(currentLink)) {
    process.stderr.write(`No release staged. Run 'abtars install' first.\n`);
    return 2;
  }

  if (platform === "darwin") {
    const { execSync, execFileSync } = await import("node:child_process");
    let group = sudoUser;
    try { group = execSync(`id -gn ${sudoUser}`, { encoding: "utf-8" }).trim(); } catch (err) { logAndSwallow("daemon", "op", err); }

    const plistSrc = join(pkgRoot, "scripts", "com.abtars.daemon.plist");
    if (!existsSync(plistSrc)) { process.stderr.write(`Template not found: ${plistSrc}\n`); return 1; }
    let content = readFileSync(plistSrc, "utf-8");
    content = content.replaceAll("{{USER}}", sudoUser).replaceAll("{{GROUP}}", group);
    const dst = "/Library/LaunchDaemons/com.abtars.daemon.plist";

    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(dst, content);
    chmodSync(dst, 0o644);
    try { execFileSync("launchctl", ["bootstrap", "system", dst]); } catch (err) { logAndSwallow("daemon", "op", err); }
    process.stdout.write(`✓ LaunchDaemon installed at ${dst}\n`);
    process.stdout.write(`✓ bridge runs as ${sudoUser}, survives logout + reboot\n`);
    return 0;
  }

  if (platform === "linux") {
    const { execSync, execFileSync } = await import("node:child_process");
    try { execSync("systemctl --version", { stdio: "ignore" }); } catch {
      process.stderr.write(`systemctl not found — requires systemd.\n`);
      return 2;
    }

    const unitSrc = join(pkgRoot, "scripts", "abtars-daemon.service");
    if (!existsSync(unitSrc)) { process.stderr.write(`Template not found: ${unitSrc}\n`); return 1; }
    let content = readFileSync(unitSrc, "utf-8");
    content = content.replaceAll("{{USER}}", sudoUser);
    const dst = "/etc/systemd/system/abtars.service";

    const { writeFileSync } = await import("node:fs");
    writeFileSync(dst, content);
    execFileSync("systemctl", ["daemon-reload"]);
    execFileSync("systemctl", ["enable", "--now", "abtars"]);
    process.stdout.write(`✓ systemd unit installed at ${dst}\n`);
    process.stdout.write(`✓ bridge runs as ${sudoUser}, survives logout + reboot\n`);
    return 0;
  }

  process.stderr.write(`Unsupported platform: ${platform}\n`);
  return 2;
}

// ── uninstall ──

async function daemonUninstall(): Promise<number> {
  const scope = detectScope();
  if (!scope) { process.stderr.write("No daemon service found.\n"); return 1; }

  if (scope === "system") {
    if (process.getuid?.() !== 0) {
      process.stderr.write(`Requires sudo: sudo -k $(which abtars) daemon uninstall\n`);
      return 2;
    }
    const { execFileSync } = await import("node:child_process");
    const { unlinkSync } = await import("node:fs");
    try { execFileSync("systemctl", ["stop", "abtars"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { execFileSync("systemctl", ["disable", "abtars"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { unlinkSync("/etc/systemd/system/abtars.service"); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { execFileSync("systemctl", ["daemon-reload"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    process.stdout.write("✓ system service removed\n");
  } else {
    const { execFileSync } = await import("node:child_process");
    const { unlinkSync } = await import("node:fs");
    const unit = join(process.env["HOME"] ?? "", ".config", "systemd", "user", "abtars-watchdog.service");
    try { execFileSync("systemctl", ["--user", "stop", "abtars-watchdog"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { execFileSync("systemctl", ["--user", "disable", "abtars-watchdog"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { unlinkSync(unit); } catch (err) { logAndSwallow("daemon", "op", err); }
    try { execFileSync("systemctl", ["--user", "daemon-reload"]); } catch (err) { logAndSwallow("daemon", "op", err); }
    process.stdout.write("✓ user service removed\n");
  }
  return 0;
}

// ── start/stop/restart ──

async function daemonControl(action: "start" | "stop" | "restart"): Promise<number> {
  const scope = detectScope();
  if (!scope) { process.stderr.write("No daemon service found. Run: abtars daemon install\n"); return 1; }
  const { execFileSync } = await import("node:child_process");
  const unit = unitName(scope);
  const args = scope === "user" ? ["--user", action, unit] : [action, unit];
  try {
    execFileSync("systemctl", args, { stdio: "inherit" });
    process.stdout.write(`✓ ${action} ${unit}\n`);
  } catch {
    process.stderr.write(`✗ ${action} failed\n`);
    return 1;
  }
  return 0;
}

// ── status ──

async function daemonStatus(): Promise<number> {
  const scope = detectScope();
  if (!scope) {
    process.stdout.write("No daemon service installed.\n");
    process.stdout.write("  Install: sudo $(which abtars) daemon install\n");
    return 0;
  }

  const { spawnSync } = await import("node:child_process");
  const unit = unitName(scope);
  const args = scope === "user" ? ["--user", "status", unit] : ["status", unit];
  const r = spawnSync("systemctl", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  const output = r.stdout || r.stderr || "";

  // Parse active state
  const activeMatch = output.match(/Active:\s+(.+)/);
  const pidMatch = output.match(/Main PID:\s+(\d+)/);

  process.stdout.write(`● ${unit} (${scope} scope)\n`);
  process.stdout.write(`  ${activeMatch?.[1] ?? "unknown"}\n`);
  if (pidMatch) process.stdout.write(`  PID: ${pidMatch[1]}\n`);

  // Bridge info from bridge.lock
  const home = abtarsHome();
  const lockPath = join(home, "bridge.lock");
  if (existsSync(lockPath)) {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf-8"));
      if (lock.pid) process.stdout.write(`  Bridge PID: ${lock.pid}\n`);
      if (lock.startedAt) {
        const upMs = Date.now() - new Date(lock.startedAt).getTime();
        const upMin = Math.round(upMs / 60000);
        process.stdout.write(`  Uptime: ${upMin >= 60 ? `${Math.floor(upMin / 60)}h ${upMin % 60}m` : `${upMin}m`}\n`);
      }
      if (lock.version) process.stdout.write(`  Version: ${lock.version}\n`);
      if (lock.restartReason) process.stdout.write(`  Last restart: ${lock.restartReason}\n`);
    } catch { /* ignore */ }
  }
  return 0;
}

// ── router ──

export async function daemon(args: string[]): Promise<number> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "install": return daemonInstall();
    case "uninstall": return daemonUninstall();
    case "start": return daemonControl("start");
    case "stop": return daemonControl("stop");
    case "restart": return daemonControl("restart");
    case "status": return daemonStatus();
    default:
      process.stderr.write(`Unknown: abtars daemon ${sub}\nUsage: abtars daemon [install|uninstall|start|stop|restart|status]\n`);
      return 1;
  }
}
