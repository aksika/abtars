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
  const lockFile = join(home, "bridge.lock");

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
