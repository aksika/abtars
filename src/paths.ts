import { resolve, join, relative } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync } from "node:fs";

/** Base directory for all Abtars runtime data. Override with ABTARS_HOME env var. */
export function abtarsHome(): string {
  return process.env.ABTARS_HOME ?? resolve(homedir(), ".abtars");
}

/** Base directory for abmind runtime data. Override with ABMIND_HOME env var. */
export function abmindHome(): string {
  return process.env.ABMIND_HOME ?? resolve(homedir(), ".abmind");
}

/** Single source of truth for deployed version. Reads ~/.abtars/manifest.json. */
export function getDeployedVersion(): { version: string; commit: string } {
  try {
    const manifest = JSON.parse(readFileSync(join(abtarsHome(), "manifest.json"), "utf-8"));
    return { version: manifest.version ?? "?", commit: manifest.commit ?? "" };
  } catch { return { version: "?", commit: "" }; }
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


