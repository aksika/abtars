/**
 * bridge.lock — single source of truth for bridge runtime state.
 * Fields: pid, startedAt, lastHeartbeat, lastPromptAt, version,
 *         sleepStatus, restartReason, restartRequested.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../../paths.js";
import { localISO } from "../../utils/local-time.js";

export type SleepStatus = "awake" | "sleeping" | "hw_sleep";

/** Read lastPromptAt from bridge.lock. Returns 0 if missing/unreadable. */
export function readLastPromptAt(): number {
  try {
    const lock = JSON.parse(readFileSync(join(agentBridgeHome(), "bridge.lock"), "utf-8"));
    return typeof lock.lastPromptAt === "number" ? lock.lastPromptAt : 0;
  } catch { return 0; }
}

/** Update a single field in bridge.lock (read-merge-write). */
export function updateBridgeLockField(key: string, value: unknown): void {
  const p = join(agentBridgeHome(), "bridge.lock");
  try {
    const lock = JSON.parse(readFileSync(p, "utf-8"));
    lock[key] = value;
    writeFileSync(p, JSON.stringify(lock), "utf-8");
  } catch { /* */ }
}

/** Read a field from bridge.lock. Returns null if missing/unreadable. */
export function readBridgeLockField<T = unknown>(key: string): T | null {
  try {
    const lock = JSON.parse(readFileSync(join(agentBridgeHome(), "bridge.lock"), "utf-8"));
    return lock[key] ?? null;
  } catch { return null; }
}

/** Write restart reason to bridge.lock. */
export function writeRestartReason(reason: string): void {
  updateBridgeLockField("restartReason", `${localISO()} ${reason}`);
}

/** Read and clear restart reason from bridge.lock. */
export function readAndClearRestartReason(): string | null {
  const reason = readBridgeLockField<string>("restartReason");
  if (reason) updateBridgeLockField("restartReason", null);
  return reason;
}

/** Write restart request to bridge.lock. */
export function writeRestartRequested(reason: string): void {
  updateBridgeLockField("restartRequested", `${localISO()} ${reason}`);
}

/** Read and clear restart request from bridge.lock. */
export function readAndClearRestartRequested(): string | null {
  const req = readBridgeLockField<string>("restartRequested");
  if (req) updateBridgeLockField("restartRequested", null);
  return req;
}

/** Update sleep status in bridge.lock. */
export function writeSleepStatus(status: SleepStatus): void {
  updateBridgeLockField("sleepStatus", status);
}
