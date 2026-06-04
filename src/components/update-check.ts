/**
 * update-check.ts — Check npm registry for newer abtars versions (#440, #588).
 * Single module: configurable TTL, notify cooldown, logger integration.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { abtarsHome } from "../paths.js";

const DEFAULT_TTL_MS = 6 * 60 * 60_000; // 6h
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60_000; // 1 per day

interface CacheData {
  ts: number;
  latest: string;
  lastNotifiedAt?: number;
}

function cachePath(): string {
  const dir = join(abtarsHome(), "state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "update-check.json");
}

function readCache(ttlMs: number): CacheData | null {
  try {
    const data = JSON.parse(readFileSync(cachePath(), "utf-8")) as CacheData;
    if (Date.now() - data.ts < ttlMs) return data;
  } catch { /* missing or corrupt */ }
  return null;
}

function writeCache(data: CacheData): void {
  try { writeFileSync(cachePath(), JSON.stringify(data), "utf-8"); } catch { /* non-critical */ }
}

function fetchLatest(pkg: string): string | null {
  try {
    return execFileSync("npm", ["view", pkg, "version"], { encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

/** True if a is newer than b (semver major.minor.patch). */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
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
 * Returns null if check is skipped (cached fresh / offline / npm not found).
 */
export function checkForUpdate(pkg: string, currentVersion: string, opts?: { ttlMs?: number }): UpdateCheckResult | null {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const cache = readCache(ttlMs);
  const latest = cache?.latest ?? fetchLatest(pkg);
  if (!latest) return null;

  const now = Date.now();
  const updateAvailable = isNewer(latest, currentVersion);
  const shouldNotify = updateAvailable && (!cache?.lastNotifiedAt || now - cache.lastNotifiedAt > NOTIFY_COOLDOWN_MS);

  const newCache: CacheData = { ts: now, latest, lastNotifiedAt: shouldNotify ? now : cache?.lastNotifiedAt };
  if (!cache) writeCache(newCache);
  else if (shouldNotify) writeCache(newCache);

  return { current: currentVersion, latest, updateAvailable, shouldNotify };
}
