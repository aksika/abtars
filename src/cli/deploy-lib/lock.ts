import { readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync, unlinkSync, rmdirSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const STALE_MS = 5 * 60 * 1000;

export interface LockContent {
  readonly token: string;
  readonly pid: number;
  readonly startIdentity: string;
  readonly host: string;
  readonly startedAt: string;
  readonly cmd: string;
}

export class LockHeldError extends Error {
  constructor(
    public readonly content: LockContent,
    public readonly isStale: boolean,
  ) {
    const staleMsg = isStale ? " (appears stale — process may have crashed)" : "";
    super(
      `Lock held by pid ${content.pid} since ${content.startedAt} ` +
        `(cmd: ${content.cmd})${staleMsg}`,
    );
    this.name = "LockHeldError";
  }
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeAtomic(target: string, data: string): void {
  const tmp = target + ".tmp." + randomUUID().slice(0, 8);
  writeFileSync(tmp, data, "utf-8");
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, target);
}

function processStartIdentity(pid: number): string {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const startTime = stat.split(" ")[21];
    return `${pid}:${startTime ?? "0"}`;
  } catch {
    return `${pid}:0`;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_OWNER_FILE = "owner.json";

function releaseLockDirectory(lockDir: string, token: string): void {
  const ownerPath = lockDir + "/" + LOCK_OWNER_FILE;
  const owner = readJsonSafe<LockContent>(ownerPath);
  if (owner && owner.token === token) {
    try { unlinkSync(ownerPath); } catch { /* ok */ }
    try { rmdirSync(lockDir); } catch { /* ok */ }
  }
}

export async function acquireLock(path: string, cmd: string): Promise<() => Promise<void>> {
  const lockDir = path + ".lockdir";

  const existing = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (existing) {
    const alive = isPidAlive(existing.pid);
    const startOk = processStartIdentity(existing.pid) === existing.startIdentity;
    const started = Date.parse(existing.startedAt);
    const age = Date.now() - (Number.isFinite(started) ? started : 0);
    const stale = !alive || !startOk || age > STALE_MS;
    if (!stale) {
      throw new LockHeldError(existing, false);
    }
    if (stale) {
      const tombstone = lockDir + ".stale." + randomUUID().slice(0, 8);
      try {
        renameSync(lockDir, tombstone);
      } catch {
        // Another contender took it
      }
    }
  }

  const content: LockContent = {
    token: randomUUID(),
    pid: process.pid,
    startIdentity: processStartIdentity(process.pid),
    host: hostname(),
    startedAt: new Date().toISOString(),
    cmd,
  };

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      mkdirSync(lockDir);
      writeAtomic(lockDir + "/" + LOCK_OWNER_FILE, JSON.stringify(content, null, 2) + "\n");
      break;
    } catch {
      // Someone else created the directory — retry stale takeover
      const recheck = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
      if (recheck) {
        const alive = isPidAlive(recheck.pid);
        const startOk = processStartIdentity(recheck.pid) === recheck.startIdentity;
        const stale = !alive || !startOk;
        if (stale) {
          const tombstone = lockDir + ".stale." + randomUUID().slice(0, 8);
          try {
            renameSync(lockDir, tombstone);
            continue;
          } catch {
            // Another contender renamed it
          }
        }
      }
      if (attempt < 50) {
        await new Promise((r) => setTimeout(r, 50));
      } else {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  const verify = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (!verify || verify.token !== content.token) {
    throw new LockHeldError(verify ?? content, false);
  }

  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    releaseLockDirectory(lockDir, content.token);
  };

  const exitHandler = (): void => {
    releaseLockDirectory(lockDir, content.token);
  };
  process.once("exit", exitHandler);

  return release;
}

export async function inspectLock(path: string): Promise<
  | { held: false }
  | { held: true; content: LockContent; stale: boolean }
> {
  const lockDir = path + ".lockdir";
  const content = readJsonSafe<LockContent>(lockDir + "/" + LOCK_OWNER_FILE);
  if (!content) return { held: false };
  const alive = isPidAlive(content.pid);
  const startOk = processStartIdentity(content.pid) === content.startIdentity;
  const started = Date.parse(content.startedAt);
  const age = Date.now() - (Number.isFinite(started) ? started : 0);
  const stale = !alive || !startOk || age > STALE_MS;
  return { held: true, content, stale };
}
