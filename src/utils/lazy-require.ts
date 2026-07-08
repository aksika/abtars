/**
 * lazy-require.ts — Install optional deps on first use.
 * Installs into ~/.local/lib/node_modules/. Falls back gracefully.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { logInfo, logWarn } from "../components/logger.js";

const TAG = "deps";

const _require = createRequire(import.meta.url);

export interface OptionalDep {
  readonly packages: readonly string[];
  readonly label: string;
  readonly postInstall?: string;
}

export const OPTIONAL_DEPS: Record<string, OptionalDep> = {
  native:  { packages: ["better-sqlite3", "sqlite-vec"], label: "SQLite native deps (kanban + memory)" },
  browser: { packages: ["cloakbrowser"], label: "CloakBrowser (stealth Chromium)" },
  twitter: { packages: ["rettiwt-api"], label: "Twitter/X integration" },
  pdf:     { packages: ["pdf-parse"], label: "PDF reading" },
  youtube: { packages: ["youtube-transcript"], label: "YouTube transcripts" },
  image:   { packages: ["jimp"], label: "Image processing" },
  provider: { packages: ["@earendil-works/pi-ai"], label: "pi-ai unified provider layer (~36 providers + prompt caching)" },
};

export interface SystemDep {
  readonly bin: string;
  readonly label: string;
  readonly installHint: string;
  readonly platform?: "linux" | "darwin";
}

export const SYSTEM_DEPS: Record<string, SystemDep> = {
  bwrap:      { bin: "bwrap",      label: "Seatbelt sandbox (Linux)", installHint: "apt install bubblewrap", platform: "linux" },
  lightpanda: { bin: "lightpanda", label: "Web-fetch level 3",        installHint: "see https://lightpanda.io" },
  ollama:     { bin: "ollama",     label: "Local embeddings",         installHint: "curl -fsSL https://ollama.ai/install.sh | sh" },
};

function libDir(): string {
  const d = join(homedir(), ".local", "lib");
  mkdirSync(d, { recursive: true });
  return d;
}

function libNodeModules(): string {
  return join(libDir(), "node_modules");
}

/** Check if a package is installed in ~/.abtars-releases/deps/ */
export function isInstalled(pkg: string): boolean {
  return existsSync(join(libNodeModules(), pkg));
}

/** Install packages into ~/.abtars-releases/deps/ */
export function installPackages(packages: readonly string[]): void {
  const { execSync } = require("node:child_process");
  const dir = libDir();
  execSync(`npm install --prefix "${dir}" ${packages.join(" ")} --no-audit --no-fund`, { stdio: "pipe" });
}

/**
 * Lazy import — tries normal import, falls back to ~/.local/lib/node_modules/, auto-installs if missing.
 */
export async function lazyRequire<T = any>(pkg: string, label?: string): Promise<T> {
  // Try normal resolution first (globally installed or in bundle)
  try { return await import(pkg); } catch { /* not found normally */ }

  // Try from ~/.local/lib/node_modules/
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

/**
 * Resolve a native dep from ~/.local/lib/node_modules/ first, then normal resolution.
 * Uses createRequire for ESM compatibility.
 */
export function resolveNativeDep(pkg: string): any {
  const sharedPath = join(homedir(), ".local", "lib", "node_modules", pkg);
  if (existsSync(sharedPath)) return _require(sharedPath);
  return _require(pkg);
}
