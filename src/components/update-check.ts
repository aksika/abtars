/**
 * update-check.ts — Check npm registry for newer abtars versions (#440, #588, #806).
 * Once-per-release notification. No daily nagging. Env: UPDATE_NOTIFICATION=OFF to disable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";

const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6h

interface CacheData {
  ts: number;
  latest: string;
  lastNotifiedVersion?: string;
}

function cachePath(pkg?: string): string {
  const dir = join(abtarsHome(), "state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, pkg ? `update-check-${pkg}.json` : "update-check.json");
}

function readCache(ttlMs: number, pkg?: string): CacheData | null {
  try {
    const data = JSON.parse(readFileSync(cachePath(pkg), "utf-8")) as CacheData;
    if (Date.now() - data.ts < ttlMs) return data;
  } catch { /* missing or corrupt */ }
  return null;
}

function writeCache(data: CacheData, pkg?: string): void {
  try { writeFileSync(cachePath(pkg), JSON.stringify(data), "utf-8"); } catch { /* non-critical */ }
}

/** Fetch the appropriate version from npm based on whether we're running a prerelease. */
function fetchLatest(pkg: string, currentVersion: string): string | null {
  try {
    // If running a prerelease, compare against alpha tag
    if (currentVersion.includes("-alpha") || currentVersion.includes("-beta")) {
      const raw = execFileSync("npm", ["view", pkg, "dist-tags", "--json"], { encoding: "utf-8", timeout: 10_000 }).trim();
      const tags = JSON.parse(raw) as Record<string, string>;
      return tags.alpha ?? tags.latest ?? null;
    }
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** True if a is newer than b. Handles prerelease: strips -alpha.N, compares base, then prerelease number. */
function isNewer(a: string, b: string): boolean {
  const parseVer = (v: string): { parts: number[]; pre: number | null } => {
    const [base, preStr] = v.split("-alpha.");
    return { parts: (base ?? "").split(".").map(Number), pre: preStr != null ? Number(preStr) : null };
  };
  const va = parseVer(a);
  const vb = parseVer(b);
  // Compare base version
  for (let i = 0; i < 3; i++) {
    if ((va.parts[i] ?? 0) > (vb.parts[i] ?? 0)) return true;
    if ((va.parts[i] ?? 0) < (vb.parts[i] ?? 0)) return false;
  }
  // Same base — compare prerelease (null = stable > any alpha)
  if (va.pre === null && vb.pre !== null) return true; // stable > alpha
  if (va.pre !== null && vb.pre === null) return false; // alpha < stable
  if (va.pre !== null && vb.pre !== null) return va.pre > vb.pre;
  return false;
}

export interface UpdateCheckResult {
  current: string;
  latest: string;
  updateAvailable: boolean;
  shouldNotify: boolean;
}

/**
 * Check if a newer version is available on npm.
 * Returns null if check is skipped (cached fresh / offline / npm not found / notifications off).
 */
export function checkForUpdate(pkg: string, currentVersion: string, opts?: { ttlMs?: number }): UpdateCheckResult | null {
  // Env kill-switch
  if (process.env.UPDATE_NOTIFICATION === "OFF") return null;

  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cache = readCache(ttlMs, pkg);
  const latest = cache?.latest ?? fetchLatest(pkg, currentVersion);
  if (!latest) return null;

  const updateAvailable = isNewer(latest, currentVersion);
  // Notify once per release: only if latest !== lastNotifiedVersion
  const shouldNotify = updateAvailable && cache?.lastNotifiedVersion !== latest;

  const newCache: CacheData = {
    ts: Date.now(),
    latest,
    lastNotifiedVersion: shouldNotify ? latest : cache?.lastNotifiedVersion,
  };
  if (!cache || shouldNotify) writeCache(newCache, pkg);

  return { current: currentVersion, latest, updateAvailable, shouldNotify };
}
