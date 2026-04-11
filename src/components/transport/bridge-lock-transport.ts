/**
 * Read the main agent's active transport from bridge.lock.
 * Subagents use this as fallback when their own model fails.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentBridgeHome } from "../../paths.js";

export interface BridgeLockTransport {
  type: string;
  endpoint?: string;
  model: string;
}

export function readBridgeLockTransport(): BridgeLockTransport | null {
  try {
    const lock = JSON.parse(readFileSync(join(agentBridgeHome(), "bridge.lock"), "utf-8"));
    if (lock.transport?.type && lock.transport?.model) return lock.transport;
  } catch { /* no lock or invalid */ }
  return null;
}

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
