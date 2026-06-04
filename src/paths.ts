import { resolve, join, relative } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

/** Base directory for all Abtars runtime data. Override with ABTARS_HOME env var. */
export function abtarsHome(): string {
  return process.env.ABTARS_HOME ?? resolve(homedir(), ".abtars");
}

// ── Lazy directory creation ─────────────────────────────────────────────────

let lazyRootsCache: string[] | null = null;

/** Set allowed lazy roots (called once at boot from manifest). */
export function setLazyRoots(roots: string[]): void { lazyRootsCache = roots; }

/**
 * Create a directory under abtarsHome if it doesn't exist.
 * If lazyRoots are configured, warns on undeclared paths.
 */
export function ensureDir(absPath: string): void {
  const home = abtarsHome();
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
 * Example: reportsDir("tasks") → ~/.abtars/reports/tasks/
 *
 * Callers are responsible for mkdirSync(dir, { recursive: true }).
 * All abtars-produced reports should live under this tree so they're
 * discoverable by the send-report skill and the future consolidation work.
 */
export function reportsDir(category: string): string {
  return join(abtarsHome(), "reports", category);
}
