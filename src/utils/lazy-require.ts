/**
 * lazy-require.ts — Install optional deps on first use.
 * Installs into ~/.abtars/lib/node_modules/. Falls back gracefully.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logWarn } from "../components/logger.js";
import { abtarsHome } from "../paths.js";

const TAG = "deps";

export interface OptionalDep {
  readonly packages: readonly string[];
  readonly label: string;
}

export const OPTIONAL_DEPS: Record<string, OptionalDep> = {
  browser: { packages: ["patchright"], label: "Browser automation" },
  pdf: { packages: ["pdf-parse"], label: "PDF reading" },
  youtube: { packages: ["youtube-transcript"], label: "YouTube transcripts" },
  image: { packages: ["jimp"], label: "Image processing" },
};

function libDir(): string {
  const d = join(abtarsHome(), "lib");
  mkdirSync(d, { recursive: true });
  return d;
}

function libNodeModules(): string {
  return join(libDir(), "node_modules");
}

/** Check if a package is installed in ~/.abtars/lib/ */
export function isInstalled(pkg: string): boolean {
  return existsSync(join(libNodeModules(), pkg));
}

/** Install packages into ~/.abtars/lib/ */
export function installPackages(packages: readonly string[]): void {
  const { execSync } = require("node:child_process");
  const dir = libDir();
  execSync(`npm install --prefix "${dir}" ${packages.join(" ")} --no-audit --no-fund`, { stdio: "pipe" });
}

/**
 * Lazy import — tries normal import, falls back to ~/.abtars/lib/, auto-installs if missing.
 */
export async function lazyRequire<T = any>(pkg: string, label?: string): Promise<T> {
  // Try normal resolution first (globally installed or in bundle)
  try { return await import(pkg); } catch { /* not found normally */ }

  // Try from ~/.abtars/lib/
  const libNm = libNodeModules();
  const pkgPath = join(libNm, pkg);
  if (existsSync(pkgPath)) {
    try { return await import(pkgPath); } catch { /* broken install */ }
  }

  // Auto-install
  logInfo(TAG, `Installing ${label ?? pkg}...`);
  try {
    installPackages([pkg]);
    return await import(join(libNm, pkg));
  } catch (err) {
    logWarn(TAG, `Failed to install ${pkg}: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(`Optional dependency "${pkg}" not available. Install with: abtars deps install ${label ?? pkg}`);
  }
}
