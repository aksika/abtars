/**
 * Read the main agent's active transport from bridge.lock.
 * Subagents use this as fallback when their own model fails.
 */
import { readFileSync } from "node:fs";
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
