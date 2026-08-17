import { printBanner } from './banner.js';
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { abtarsHome } from "../../paths.js";
import { setDesiredState, migrateSupervisorState } from "../../supervisor/state.js";
import { readBridgeLock, validateBridgeLock } from "../../supervisor/identity.js";

function readJsonField(file: string, field: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf-8"))[field]; } catch { return undefined; }
}

export type DaemonStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

function commandErrorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString().trim();
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  }
  return (err instanceof Error ? err.message : String(err)).trim();
}

/** Start the installed watchdog and report failures to the CLI caller. */
export function startDaemonService(
  platform: NodeJS.Platform = process.platform,
  execFile: typeof execFileSync = execFileSync,
): DaemonStartResult {
  if (platform === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.abtars.watchdog.plist");
    const uid = `gui/${process.getuid?.() ?? 501}`;
    try {
      execFile("launchctl", ["bootstrap", uid, plistPath], { timeout: 5000 });
      return { ok: true };
    } catch (err) {
      const message = commandErrorMessage(err);
      if (/already\s+(?:loaded|bootstrapped)/i.test(message)) return { ok: true };
      return { ok: false, error: `launchctl bootstrap: ${message.slice(-300)}` };
    }
  }

  const commands: Array<[string[], string]> = [
    [["--user", "unmask", "abtars-watchdog"], "unmask watchdog unit"],
    [["--user", "enable", "abtars-watchdog"], "enable watchdog unit"],
    [["--user", "start", "abtars-watchdog"], "start watchdog unit"],
  ];
  for (const [args, operation] of commands) {
    try {
      execFile("systemctl", args, { timeout: 5000 });
    } catch (err) {
      return { ok: false, error: `${operation}: ${commandErrorMessage(err).slice(-300)}` };
    }
  }
  return { ok: true };
}

export async function start(): Promise<number> {
  await printBanner("start");
  const home = abtarsHome();
  const lockFile = join(home, "bridge.lock");

  migrateSupervisorState(home);
  setDesiredState(home, "running");

  const installMode = readJsonField(join(home, "manifest.json"), "installMode") as string | undefined;

  if (installMode === "daemon") {
    const serviceResult = startDaemonService();
    if (!serviceResult.ok) {
      process.stderr.write(`x Watchdog service start failed: ${serviceResult.error}\n`);
      return 1;
    }
    process.stdout.write(`+ Service loaded. Watchdog starting...\n`);
    return 0;
  }

  if (existsSync(lockFile)) {
    try {
      const lock = readBridgeLock(lockFile);
      const result = validateBridgeLock(lock, ["abtars.js", "bundle"]);
      if (result.safeToAdopt && lock && typeof lock.pid === "number") {
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
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const logFd = openSync(join(home, "logs", `bridge-${dateStr}.log`), "a");
  const br = spawn("node", ["--max-old-space-size=1024", entryPoint], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: home,
    env: { ...process.env, ABTARS_START_REASON: "manual-start" },
  });
  br.unref();
  closeSync(logFd);
  process.stdout.write(`+ Bridge started (pid ${br.pid}).\n`);
  return 0;
}
