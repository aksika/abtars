/**
 * update-checker.ts — Check if a newer abtars version is published on npm (#440).
 * Runs on heartbeat, caches result for 6h, notifies once per day.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logInfo, logDebug } from "./logger.js";
import { abtarsHome } from "../paths.js";

const TAG = "update-check";
const CACHE_TTL_MS = 6 * 60 * 60_000; // 6h
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60_000; // 1 per day
const PACKAGE_NAME = "abtars";

interface CacheData {
  ts: number;
  localVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  lastNotifiedAt?: number;
}

function cachePath(): string {
  const dir = join(abtarsHome(), "state");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "update-check.json");
}

function readCache(): CacheData | null {
  try { return JSON.parse(readFileSync(cachePath(), "utf-8")); } catch { return null; }
}

function writeCache(data: CacheData): void {
  try { writeFileSync(cachePath(), JSON.stringify(data), "utf-8"); } catch { /* silent */ }
}

function getLocalVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(abtarsHome(), "manifest.json"), "utf-8"));
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getLatestNpmVersion(): string | null {
  try {
    return execFileSync("npm", ["view", PACKAGE_NAME, "version"], { timeout: 15_000, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function isNewer(latest: string, local: string): boolean {
  const [lMaj, lMin, lPat] = latest.split(".").map(Number);
  const [cMaj, cMin, cPat] = local.split(".").map(Number);
  if (lMaj! > cMaj!) return true;
  if (lMaj === cMaj && lMin! > cMin!) return true;
  if (lMaj === cMaj && lMin === cMin && lPat! > cPat!) return true;
  return false;
}

export interface UpdateCheckResult {
  latestVersion: string;
  localVersion: string;
  shouldNotify: boolean;
}

export function checkForUpdates(): UpdateCheckResult | null {
  const cache = readCache();
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    logDebug(TAG, `cached: local=${cache.localVersion}, latest=${cache.latestVersion}`);
    return null;
  }

  const localVersion = getLocalVersion();
  const latestVersion = getLatestNpmVersion();
  if (!latestVersion) {
    logDebug(TAG, "npm check failed (offline?)");
    return null;
  }

  const updateAvailable = isNewer(latestVersion, localVersion);
  const shouldNotify = updateAvailable && (!cache?.lastNotifiedAt || Date.now() - cache.lastNotifiedAt > NOTIFY_COOLDOWN_MS);

  const data: CacheData = { ts: Date.now(), localVersion, latestVersion, updateAvailable, lastNotifiedAt: shouldNotify ? Date.now() : cache?.lastNotifiedAt };
  writeCache(data);

  if (updateAvailable) logInfo(TAG, `update available: ${localVersion} → ${latestVersion}`);
  else logDebug(TAG, `up to date (${localVersion})`);

  return { latestVersion, localVersion, shouldNotify };
}
