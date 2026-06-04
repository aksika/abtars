/**
 * Deploy primitives: atomic swap, config snapshot, health probe, hash.
 *
 * #785: replaces the old releases/current symlink model with
 * app/ + app.prev/ atomic rename swap.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Atomic swap: app.staging/ → app/, old app/ → app.prev/.
 * Two renames (~instant). Caller must ensure app.staging/ is fully built.
 */
export function atomicSwap(appDir: string, appPrevDir: string, appStagingDir: string): void {
  // Remove old prev
  if (existsSync(appPrevDir)) {
    rmSync(appPrevDir, { recursive: true, force: true });
  }
  // app/ → app.prev/
  if (existsSync(appDir)) {
    renameSync(appDir, appPrevDir);
  }
  // app.staging/ → app/
  renameSync(appStagingDir, appDir);
}

/**
 * Rotate config snapshots (3 slots) and create a fresh snapshot.
 * Excludes .pre-update* dirs from the copy to avoid recursion.
 */
export function configSnapshot(configDir: string): void {
  const slot0 = join(configDir, '.pre-update');
  const slot1 = join(configDir, '.pre-update.1');
  const slot2 = join(configDir, '.pre-update.2');

  // Rotate
  if (existsSync(slot2)) rmSync(slot2, { recursive: true, force: true });
  if (existsSync(slot1)) renameSync(slot1, slot2);
  if (existsSync(slot0)) renameSync(slot0, slot1);

  // Fresh snapshot — copy config/ contents excluding .pre-update* dirs
  mkdirSync(slot0, { recursive: true });
  if (!existsSync(configDir)) return;
  for (const entry of readdirSync(configDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.pre-update')) continue;
    const src = join(configDir, entry.name);
    const dst = join(slot0, entry.name);
    if (entry.isDirectory()) {
      cpSync(src, dst, { recursive: true });
    } else {
      cpSync(src, dst);
    }
  }
}

/**
 * Poll bridge.lock for a fresh lastHeartbeat after restart.
 * Returns true if healthy within timeoutMs, false otherwise.
 */
export async function healthProbe(
  home: string,
  afterTimestamp: number,
  timeoutMs: number = 60_000,
): Promise<{ healthy: boolean; pid?: number; heartbeat?: number }> {
  const lockPath = join(home, 'bridge.lock');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const content = JSON.parse(await readFile(lockPath, 'utf-8'));
      if (content.lastHeartbeat && content.lastHeartbeat > afterTimestamp) {
        return { healthy: true, pid: content.pid, heartbeat: content.lastHeartbeat };
      }
    } catch {
      // File doesn't exist yet or invalid JSON — keep polling
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return { healthy: false };
}

/**
 * Write/read/clear the update sentinel.
 */
export interface UpdateSentinel {
  version: string;
  previousVersion: string | null;
  startedAt: string;
  status: 'pending' | 'success';
}

export function writeSentinel(home: string, sentinel: UpdateSentinel): void {
  const dir = join(home, 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'update.sentinel'), JSON.stringify(sentinel, null, 2) + '\n');
}

export function readSentinel(home: string): UpdateSentinel | null {
  try {
    const content = readFileSync(join(home, 'state', 'update.sentinel'), 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function clearSentinel(home: string, _version: string): void {
  const path = join(home, 'state', 'update.sentinel');
  if (!existsSync(path)) return;
  try {
    const sentinel: UpdateSentinel = JSON.parse(readFileSync(path, 'utf-8'));
    sentinel.status = 'success';
    writeFileSync(path, JSON.stringify(sentinel, null, 2) + '\n');
  } catch {
    // Best effort
  }
}

export async function hashFile(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Clean up stale app.staging/ from a previously interrupted update.
 */
export function cleanStaleStaging(stagingDir: string): void {
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
