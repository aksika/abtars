import { execFile } from "node:child_process";

/** Run a command with timeout, resolve stdout or null on error. */
export function execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, encoding: "utf-8" }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
    child.stderr?.resume();
  });
}
