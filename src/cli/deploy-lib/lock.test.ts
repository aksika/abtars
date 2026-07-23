import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, inspectLock, LockHeldError } from './lock.js';
import { randomUUID } from 'node:crypto';

function lockDir(path: string): string {
  return path + ".lockdir";
}

function ownerFile(path: string): string {
  return join(lockDir(path), "owner.json");
}

function currentStartIdentity(): string {
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    const startTime = stat.split(" ")[21];
    return `${process.pid}:${startTime ?? "0"}`;
  } catch {
    return `${process.pid}:0`;
  }
}

function fakeOwner(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: randomUUID(),
    pid: process.pid,
    startIdentity: currentStartIdentity(),
    host: 'h',
    startedAt: new Date().toISOString(),
    cmd: 'test',
    ...overrides,
  };
}

describe('deploy-lib/lock', () => {
  let tmp: string;
  let lockPath: string;
  beforeEach(async () => {
    const base = join(homedir(), '.cache', 'abtars-test');
    await mkdir(base, { recursive: true });
    tmp = await mkdtemp(join(base, 'deploy-lib-lock-'));
    lockPath = join(tmp, '.update.lock');
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('acquireLock succeeds when no lock exists', async () => {
    const release = await acquireLock(lockPath, 'test');
    const content = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.cmd).toBe('test');
    await release();
  });

  it('acquireLock throws LockHeldError when another live process holds it', async () => {
    const owner = fakeOwner({ pid: process.pid });
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    await expect(acquireLock(lockPath, 'test')).rejects.toBeInstanceOf(LockHeldError);
  });

  it('acquireLock steals stale lock from dead PID', async () => {
    const owner = fakeOwner({ pid: 999_999_999 });
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const release = await acquireLock(lockPath, 'test');
    const after = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(after.pid).toBe(process.pid);
    await release();
  });

  it('does NOT steal a live lock based on age alone (R2.5)', async () => {
    // A live owner with a matching start-identity must never be expired solely
    // because wall-clock age exceeded a threshold. Age is intentionally absent
    // from the staleness decision.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const owner = fakeOwner({ startedAt: twoHoursAgo }); // pid=process.pid (alive)
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    await expect(acquireLock(lockPath, 'test')).rejects.toBeInstanceOf(LockHeldError);
    // Lock is still held by the original (live) owner.
    const after = JSON.parse(await readFile(ownerFile(lockPath), 'utf-8'));
    expect(after.startedAt).toBe(twoHoursAgo);
  });

  it('release is idempotent', async () => {
    const release = await acquireLock(lockPath, 'test');
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('release removes the lockfile', async () => {
    const release = await acquireLock(lockPath, 'test');
    await release();
    const { stat } = await import('node:fs/promises');
    await expect(stat(lockDir(lockPath))).rejects.toThrow();
  });

  it('inspectLock reports not held when absent', async () => {
    const r = await inspectLock(lockPath);
    expect(r).toEqual({ held: false });
  });

  it('inspectLock reports held + live for fresh lock', async () => {
    const release = await acquireLock(lockPath, 'test');
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) {
      expect(r.stale).toBe(false);
      expect(r.content.pid).toBe(process.pid);
    }
    await release();
  });

  it('inspectLock reports stale for dead PID', async () => {
    const owner = fakeOwner({ pid: 999_999_999 });
    mkdirSync(lockDir(lockPath), { recursive: true });
    writeFileSync(ownerFile(lockPath), JSON.stringify(owner));
    const r = await inspectLock(lockPath);
    expect(r.held).toBe(true);
    if (r.held) expect(r.stale).toBe(true);
  });
});
