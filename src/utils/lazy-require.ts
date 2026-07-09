/**
 * lazy-require.ts — Install optional deps on first use.
 * Installs into ~/.local/lib/node_modules/. Falls back gracefully.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  /** #1311 C7: pin spec (e.g. "~0.80"). When set, installs `pkg@version` for reproducibility. */
  readonly version?: string;
}

export const OPTIONAL_DEPS: Record<string, OptionalDep> = {
  native:  { packages: ["better-sqlite3", "sqlite-vec"], label: "SQLite native deps (kanban + memory)" },
  browser: { packages: ["cloakbrowser"], label: "CloakBrowser (stealth Chromium)" },
  twitter: { packages: ["rettiwt-api"], label: "Twitter/X integration" },
  pdf:     { packages: ["pdf-parse"], label: "PDF reading" },
  youtube: { packages: ["youtube-transcript"], label: "YouTube transcripts" },
  image:   { packages: ["jimp"], label: "Image processing" },
  provider: { packages: ["@earendil-works/pi-ai"], label: "pi-ai unified provider layer (~36 providers + prompt caching)", version: "~0.80" },
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

/** #1311 C7: append the pinned version (if any) from OPTIONAL_DEPS so auto-installs are reproducible. */
function versionedSpec(pkg: string): string {
  for (const dep of Object.values(OPTIONAL_DEPS)) {
    if (dep.packages.includes(pkg) && dep.version) return `${pkg}@${dep.version}`;
  }
  return pkg;
}

/**
 * Resolve a package directory to its main ESM entry file by reading its package.json.
 * ESM can't import a directory path; we need a concrete `.js` file. Honors the modern
 * `exports` field (with conditional `import`) first, then falls back to `main`/`module`.
 * Returns the package directory path itself if no entry can be determined (caller
 * will then surface the same "directory import" error).
 */
function resolvePackageEntry(pkgDir: string): string {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return pkgDir;
  let meta: { main?: string; module?: string; exports?: unknown; type?: string };
  try { meta = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof meta; }
  catch { return pkgDir; }

  // `exports: { ".": { "import": "./dist/index.js" } }` — pick the ESM import target.
  const exp = meta.exports as Record<string, unknown> | undefined;
  const dot = exp?.["."] as Record<string, unknown> | undefined;
  const importTarget = (dot?.["import"] ?? dot?.["default"]) as string | undefined;
  if (typeof importTarget === "string") return join(pkgDir, importTarget);
  if (dot && typeof dot === "string") return join(pkgDir, dot);

  // CJS / fallback
  const main = meta.main ?? meta.module;
  if (typeof main === "string") return join(pkgDir, main);
  return pkgDir;
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
    // #1311: ESM can't import a directory — resolve the package's main entry via
    // package.json (honors `exports` / `main` / `module`) before importing.
    const entry = resolvePackageEntry(pkgPath);
    try { return await import(entry); } catch { /* broken install */ }
  }

  // Auto-install
  logInfo(TAG, `Installing ${label ?? pkg}...`);
  try {
    installPackages([versionedSpec(pkg)]);
    const entry = resolvePackageEntry(join(libNm, pkg));
    return await import(entry);
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
