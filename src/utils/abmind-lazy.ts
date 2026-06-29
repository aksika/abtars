/**
 * Lazy abmind loader — pre-loaded once at boot, then available synchronously.
 * ALL runtime access to abmind goes through here.
 *
 * If abmind is not installed, or is below the supported contract version
 * (#1243), abmind() returns null and the bridge runs without persistent
 * memory (nullMemory). A below-floor abmind is rejected loudly — never a
 * silent contract break that would quietly drop memory mid-session.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { logDebug, logError, logWarn } from "../components/logger.js";

type AbmindModule = typeof import("abmind");

/**
 * Minimum abmind version that provides the supported contract surface
 * (abmind SUPPORTED-SURFACE.md, #1243). Below this → memory disabled loudly.
 * Bump only when abtars starts relying on newer surface.
 */
export const ABMIND_MIN: readonly [number, number, number] = [0, 3, 0];

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

/** Read the version of the resolvable abmind package, or null if not resolvable. */
function readResolvedAbmindVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve("abmind/package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf-8")).version as string) ?? null;
  } catch {
    return null;
  }
}

/** Call once at boot (phase-memory). Caches the module. Returns null if unavailable or below-floor. */
export async function loadAbmind(): Promise<AbmindModule | null> {
  if (_loaded) return _mod;
  _loaded = true;

  let mod: AbmindModule | null = null;
  try {
    const req = createRequire(import.meta.url);
    const resolvedPath = req.resolve("abmind");
    mod = await import(resolvedPath);
  } catch {
    mod = null;
  }
  if (!mod) {
    logWarn("boot", "abmind not installed — running without persistent memory");
    _mod = null;
    return null;
  }

  const ver = readResolvedAbmindVersion();
  if (!ver || !isSupportedVersion(ver)) {
    logError(
      "boot",
      `abmind@${ver ?? "?"} is below the supported floor ${ABMIND_MIN.join(".")} — memory disabled to avoid a silent contract break. Upgrade: npm install -g abmind@latest`,
    );
    _mod = null;
    return null;
  }

  logDebug("boot", `memory: enabled via abmind@${ver}`);
  _mod = mod;
  return _mod;
}

/** Synchronous access after loadAbmind() has been called. Returns null if unavailable. */
export function abmind(): AbmindModule | null {
  return _mod;
}
