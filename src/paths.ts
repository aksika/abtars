import { resolve, join, relative } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

/** Base directory for all AgentBridge runtime data. Override with AGENT_BRIDGE_HOME env var. */
export function agentBridgeHome(): string {
  return process.env.AGENT_BRIDGE_HOME ?? resolve(homedir(), ".agentbridge");
}

// ── Lazy directory creation ─────────────────────────────────────────────────

let lazyRootsCache: string[] | null = null;

/** Set allowed lazy roots (called once at boot from manifest). */
export function setLazyRoots(roots: string[]): void { lazyRootsCache = roots; }

/**
 * Create a directory under agentBridgeHome if it doesn't exist.
 * If lazyRoots are configured, warns on undeclared paths.
 */
export function ensureDir(absPath: string): void {
  const home = agentBridgeHome();
  const rel = relative(home, absPath);
  if (lazyRootsCache && !rel.startsWith("..") && rel !== "") {
    const allowed = lazyRootsCache.some(root => rel === root || rel.startsWith(root + "/"));
    if (!allowed) {
      // Check if it's an eager dir (those are always allowed)
      const isEager = ["config", "logs", "scripts", "bin", "releases"].some(d => rel === d || rel.startsWith(d + "/"));
      if (!isEager) {
        // eslint-disable-next-line no-console
        console.warn(`[manifest] ensureDir: "${rel}" is not under a declared lazyRoot or eager directory`);
      }
    }
  }
  mkdirSync(absPath, { recursive: true });
}

/**
 * Canonical path for user-facing reports, grouped by category.
 * Example: reportsDir("tasks") → ~/.agentbridge/reports/tasks/
 *
 * Callers are responsible for mkdirSync(dir, { recursive: true }).
 * All agentbridge-produced reports should live under this tree so they're
 * discoverable by the send-report skill and the future consolidation work.
 */
export function reportsDir(category: string): string {
  return join(agentBridgeHome(), "reports", category);
}
