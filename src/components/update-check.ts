/**
 * update-check — check npm registry for newer versions (#440).
 * Cached 24h. Non-blocking. Returns null if offline/unavailable.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_FILE = join(process.env["ABTARS_HOME"] ?? join(homedir(), ".abtars"), "state", "update-check.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

type CacheEntry = { checkedAt: number; latest: string };

function readCache(): CacheEntry | null {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as CacheEntry;
    if (Date.now() - raw.checkedAt < CACHE_TTL_MS) return raw;
  } catch { /* missing or corrupt */ }
  return null;
}

function writeCache(latest: string): void {
  try {
    mkdirSync(join(CACHE_FILE, ".."), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify({ checkedAt: Date.now(), latest }), "utf-8");
  } catch { /* non-critical */ }
}

function fetchLatest(pkg: string): string | null {
  try {
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export type UpdateCheckResult = { current: string; latest: string; updateAvailable: boolean } | null;

/**
 * Check if a newer version is available on npm.
 * Returns null if check is skipped (cached/offline/npm not found).
 */
export function checkForUpdate(pkg: string, currentVersion: string): UpdateCheckResult {
  const cached = readCache();
  const latest = cached?.latest ?? fetchLatest(pkg);
  if (!latest) return null;
  if (!cached) writeCache(latest);

  const updateAvailable = latest !== currentVersion && !currentVersion.includes(latest);
  return { current: currentVersion, latest, updateAvailable };
}
