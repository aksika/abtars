import { readFileSync } from "node:fs";

export type ValidationResult =
  | { readonly status: "valid"; readonly safeToSignal: true; readonly safeToAdopt: true }
  | { readonly status: "dead"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "reused"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "wrong-command"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "mismatch"; readonly safeToSignal: false; readonly safeToAdopt: false }
  | { readonly status: "corrupt"; readonly safeToSignal: false; readonly safeToAdopt: false };

export function processStartIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // comm (field 2) is wrapped in parens and may contain spaces, so parse from
    // the LAST ')'. Fields after it are space-separated starting at field 3
    // (state); starttime is field 22 → index 22-3 = 19.
    const rp = stat.lastIndexOf(")");
    if (rp < 0) return `${pid}:0`;
    const fields = stat.slice(rp + 2).split(" ");
    const startTime = fields[19];
    return `${pid}:${startTime ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function validateBridgePid(
  pid: number,
  expectedIdentity: string | null,
  needles: readonly string[],
): ValidationResult {
  const alive = isPidAlive(pid);
  if (!alive) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  if (expectedIdentity !== null) {
    const actual = processStartIdentity(pid);
    if (actual !== expectedIdentity) {
      return { status: "reused", safeToSignal: false, safeToAdopt: false };
    }
  }
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const match = needles.some((n) => cmdline.includes(n));
    if (!match) {
      return { status: "wrong-command", safeToSignal: false, safeToAdopt: false };
    }
  } catch {
    // /proc unavailable (macOS, container, etc.) — trust the lock
    return { status: "valid", safeToSignal: true, safeToAdopt: true };
  }
  return { status: "valid", safeToSignal: true, safeToAdopt: true };
}

export function validateBridgeLock(
  lock: Record<string, unknown> | null,
  needles: readonly string[],
): ValidationResult {
  if (lock === null || typeof lock !== "object") {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const pid = typeof lock.pid === "number" ? lock.pid : null;
  if (pid === null || pid <= 0) {
    return { status: "dead", safeToSignal: false, safeToAdopt: false };
  }
  // R6.2.4: the bridge instance identifier must be present — confirms the
  // bridge completed identity initialization. A lock missing it did not come
  // from a fully-initialized #1262 bridge and is not safe to adopt/signal.
  const instanceId = typeof lock.instanceId === "string" ? lock.instanceId : "";
  if (!instanceId) {
    return { status: "corrupt", safeToSignal: false, safeToAdopt: false };
  }
  const startIdentity = typeof lock.startIdentity === "string" ? lock.startIdentity : null;
  return validateBridgePid(pid, startIdentity, needles);
}
