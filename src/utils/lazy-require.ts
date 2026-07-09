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
 * Resolve a package specifier (e.g. "@earendil-works/pi-ai" or
 * "@earendil-works/pi-ai/api/openai-completions") to a concrete ESM file path on
 * disk under ~/.local/lib/node_modules/. ESM can't import a directory; we have to
 * find the entry file. Honors the modern `exports` field (conditional `import` /
 * `default`, wildcard `./api/*` → `./dist/api/*.js`) first, then falls back to
 * `main` / `module`. Returns the spec-joined path on miss (caller surfaces the
 * real error).
 */
function resolvePackageFile(spec: string): string {
  const libNm = libNodeModules();
  // Split into pkgName + subpath. Handle scoped names (@scope/name[/sub]).
  let pkgName: string; let subpath: string;
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    pkgName = parts.slice(0, 2).join("/");
    subpath = parts.slice(2).join("/");
  } else {
    const slash = spec.indexOf("/");
    if (slash === -1) { pkgName = spec; subpath = ""; }
    else { pkgName = spec.slice(0, slash); subpath = spec.slice(slash + 1); }
  }
  const pkgDir = join(libNm, pkgName);
  if (!existsSync(pkgDir)) return join(libNm, spec);

  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return join(libNm, spec);
  let meta: { main?: string; module?: string; exports?: unknown };
  try { meta = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as typeof meta; }
  catch { return join(libNm, spec); }

  const exp = meta.exports as Record<string, unknown> | undefined;
  if (exp) {
    const wantKey = subpath ? `./${subpath}` : ".";
    // Prefer exact key match; fall back to a wildcard key (`./api/*`) that covers
    // the requested subpath. The wildcard form is what pi-ai uses for subpath
    // exports like `"./api/*": { "import": "./dist/api/*.js" }`.
    let target: unknown = exp[wantKey];
    let wildcardSuffix: string | null = null;
    if (target === undefined && subpath) {
      for (const k of Object.keys(exp)) {
        if (k.endsWith("/*") && wantKey.startsWith(k.slice(0, -1))) {
          target = exp[k];
          wildcardSuffix = wantKey.slice(k.length - 1); // the part after the prefix
          break;
        }
      }
    }
    if (target === undefined) target = exp["."];

    if (typeof target === "string") {
      if (wildcardSuffix !== null) return join(pkgDir, target.replace(/\*/g, wildcardSuffix));
      return join(pkgDir, target);
    }
    if (target && typeof target === "object") {
      const obj = target as Record<string, unknown>;
      const cond = obj["import"] ?? obj["default"] ?? obj["node"];
      if (typeof cond === "string") {
        if (wildcardSuffix !== null) return join(pkgDir, cond.replace(/\*/g, wildcardSuffix));
        return join(pkgDir, cond);
      }
    }
  }

  // No exports match (or no exports field). For "." (no subpath) use main/module;
  // for a subpath, join the literal path under the package dir.
  if (!subpath) {
    const main = meta.main ?? meta.module;
    if (typeof main === "string") return join(pkgDir, main);
  }
  return join(libNm, spec);
}

/**
 * Lazy import — tries normal resolution first, falls back to ~/.local/lib/node_modules/, auto-installs if missing.
 *
 * Implementation note: we use CJS `require()` (via createRequire) rather than
 * dynamic `import()`. The bundle lives at ~/.abtars-releases/<commit>/bundle/,
 * which has no node_modules/ of its own. ESM `import(absPath)` would resolve
 * the imported file's OWN deps (e.g. pi-ai → openai) from the bundle's location
 * and fail. CJS `require(absPath)` resolves the imported file's deps from the
 * file's own location — which is ~/.local/lib/node_modules/@earendil-works/pi-ai/
 * — and finds its sibling `openai`, `zod`, etc. there. Node 22's CJS-from-ESM
 * interop returns the ESM module's named exports directly.
 */
export async function lazyRequire<T = any>(pkg: string, label?: string): Promise<T> {
  // Try normal resolution first (globally installed or in bundle)
  try { return _require(pkg) as T; } catch { /* not found normally */ }

  // Try from ~/.local/lib/node_modules/ — resolve the entry file via the
  // package's exports field (handles bare main + subpath wildcards like ./api/*).
  const entry = resolvePackageFile(pkg);
  try { return _require(entry) as T; } catch { /* broken install */ }

  // Auto-install
  logInfo(TAG, `Installing ${label ?? pkg}...`);
  try {
    installPackages([versionedSpec(pkg)]);
    return _require(resolvePackageFile(pkg)) as T;
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
