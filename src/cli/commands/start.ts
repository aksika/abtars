import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function abtarsHome(): string {
  return process.env["ABTARS_HOME"] ?? join(process.env["HOME"] ?? "", ".abtars");
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function start(): Promise<number> {
  const home = abtarsHome();
  const pidFile = join(home, "bridge.pid");

  if (existsSync(pidFile)) {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!isNaN(pid) && pidAlive(pid)) {
      process.stdout.write(`Bridge already running (pid ${pid}).\n`);
      return 0;
    }
  }

  const { restart } = await import("./restart.js");
  return restart({ cold: true });
}
