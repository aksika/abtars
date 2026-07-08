/**
 * Lazy abmind loader — pre-loaded once at boot, then available synchronously.
 * ALL runtime access to abmind goes through here.
 *
 * If abmind is not installed, or is below the supported contract version
 * (#1243), abmind() returns null and the bridge runs without persistent
 * memory (nullMemory). A below-floor abmind is rejected loudly — never a
 * silent contract break that would quietly drop memory mid-session.
 *
 * #1286: resolution uses active, ordered discovery — NOT passive ancestor-walk
 * from the bundle path (which never finds the global install). The class of
 * "ambient/heisenbug" failures is killed by probing real known locations:
 *   1. ABMIND_PATH env override        — escape hatch + test hook
 *   2. createRequire (ancestor-walk)   — KP/WSL dev file: link
 *   3. npm root -g → <root>/abmind     — canonical global install (#1243)
 *   4. ~/.abmind/src/abmind   — dev source checkout (`abmind update --dev`)
 *   5. ~/.local/lib/node_modules/abmind — legacy install location
 * First valid, version-floor-passing candidate wins.
 */
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { logInfo, logError, logWarn } from "../components/logger.js";

type AbmindModule = typeof import("abmind");

/**
 * Minimum abmind version that provides the supported contract surface
 * (abmind SUPPORTED-SURFACE.md, #1243). Below this → memory disabled loudly.
 * Bump only when abtars starts relying on newer surface.
 */
export const ABMIND_MIN: readonly [number, number, number] = [0, 2, 6];

let _mod: AbmindModule | null = null;
let _loaded = false;

/** Reset cache — called on in-process restart. */
export function resetAbmindCache(): void {
  _mod = null;
  _loaded = false;
}

/** Parse the leading major.minor.patch from a semver string (ignores pre-release/build). */
export function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function lt(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];
}

/** True iff `version` is at least ABMIND_MIN (the supported contract floor). */
export function isSupportedVersion(version: string): boolean {
  const p = parseSemver(version);
  return !!p && !lt(p, ABMIND_MIN);
}

// ── Discovery helpers ────────────────────────────────────────────────────────

/** Run `npm root -g` and return the trimmed path, or null if npm is absent / errors. */
export function npmRootG(): string | null {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const result = execSync("npm root -g", { encoding: "utf-8", timeout: 3000 }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Read the `version` field from a package.json file, or null if missing/unparseable. */
export function readVersion(pkgPath: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    return typeof raw["version"] === "string" ? raw["version"] : null;
  } catch {
    return null;
  }
}

/** Dirname of a resolved package.json path (strips the filename). */
export function dirOfPkg(pkgJsonPath: string): string {
  return dirname(pkgJsonPath);
}

/**
 * Resolve the absolute entry-point path for an abmind package directory.
 * Reads `main` from package.json (relative to dir); falls back to
 * `dist/src/index.js` which is the known built output location.
 */
export function resolveEntry(dir: string, pkgPath: string): string {
  try {
    const raw = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    const main = typeof raw["main"] === "string" ? raw["main"] : null;
    if (main) return join(dir, main);
  } catch { /* fall through */ }
  return join(dir, "dist", "src", "index.js");
}

/** A named discovery strategy: returns a candidate abmind package directory or null. */
interface Strategy {
  readonly name: string;
  resolve(): string | null;
}

/**
 * Ordered discovery strategies (#1286). First valid, version-floor-passing
 * candidate wins. Pure/lazy — each resolve() is only called until one succeeds.
 *
 * Exported so tests can exercise individual strategies directly.
 */
export function abmindStrategies(): Strategy[] {
  const req = createRequire(import.meta.url);
  return [
    {
      // 1. Explicit override — escape hatch for custom installs and tests.
      name: "ABMIND_PATH",
      resolve(): string | null {
        return process.env["ABMIND_PATH"]?.trim() || null;
      },
    },
    {
      // 2. Ancestor-walk from the bundle — covers KP/WSL dev `file:../abmind` link.
      //    This is the only strategy that uses Node's passive resolution.
      name: "createRequire",
      resolve(): string | null {
        try {
          return dirOfPkg(req.resolve("abmind/package.json"));
        } catch {
          return null;
        }
      },
    },
    {
      // 3. Canonical global npm install (#1243). The real location on every
      //    production host; `npm root -g` is platform-correct regardless of
      //    whether global prefix is ~/.npm-global, /opt/homebrew, or elsewhere.
      name: "npm-root-g",
      resolve(): string | null {
        const root = npmRootG();
        return root ? join(root, "abmind") : null;
      },
    },
    {
      // 4. Dev source checkout owned by abmind (#1308) at ~/.abmind/src/abmind.
      //    Populated by `abmind update --dev` (no dir). Also the npm-absent fallback.
      name: "releases-src",
      resolve(): string | null {
        return join(homedir(), ".abmind", "src", "abmind");
      },
    },
    {
      // 5. Legacy install location — for hosts that installed before the npm-global
      //    convention was adopted. Not present on current Molty/KP but kept for
      //    back-compat with older setups.
      name: "legacy-local",
      resolve(): string | null {
        return join(homedir(), ".local", "lib", "node_modules", "abmind");
      },
    },
  ];
}

// ── Loader ───────────────────────────────────────────────────────────────────

/**
 * Call once at boot (phase-memory). Caches the module.
 * Returns null if abmind is unavailable or below the supported version floor.
 *
 * Resolution strategy (#1286): ordered active discovery — zero dependence on
 * NODE_PATH, cwd, or launch method. See module-level comment for the strategy list.
 */
export async function loadAbmind(): Promise<AbmindModule | null> {
  if (_loaded) return _mod;
  _loaded = true;

  for (const strategy of abmindStrategies()) {
    const dir = strategy.resolve();
    if (!dir) continue;

    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) continue;

    const ver = readVersion(pkgPath);

    // Below-floor: loud error + stop. Do NOT silently fall through to an older
    // copy from a lower-priority location — that hides a real misconfig.
    if (!ver || !isSupportedVersion(ver)) {
      logError(
        "boot",
        `abmind@${ver ?? "?"} at ${dir} is below the supported floor ` +
        `${ABMIND_MIN.join(".")} (strategy=${strategy.name}) — memory disabled to ` +
        `avoid a silent contract break. Upgrade: npm install -g abmind@latest`,
      );
      _mod = null;
      return null;
    }

    const entry = resolveEntry(dir, pkgPath);
    try {
      const mod = await import(pathToFileURL(entry).href) as AbmindModule;
      logInfo("boot", `memory: enabled via abmind@${ver} (via ${strategy.name})`);
      _mod = mod;
      return _mod;
    } catch (err) {
      // Import failed for this candidate (e.g. native module ABI mismatch, corrupt
      // dist). Log and try the next strategy — don't give up the whole boot.
      logWarn(
        "boot",
        `abmind@${ver} found at ${dir} (strategy=${strategy.name}) but failed to ` +
        `import: ${err instanceof Error ? err.message : String(err)} — trying next`,
      );
    }
  }

  logWarn("boot", "abmind not found via any discovery strategy — running without persistent memory");
  _mod = null;
  return null;
}

/** Synchronous access after loadAbmind() has been called. Returns null if unavailable. */
export function abmind(): AbmindModule | null {
  return _mod;
}
