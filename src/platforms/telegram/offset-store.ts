/**
 * Atomic offset store for Telegram poller.
 * Persists the last-acked update_id to disk so crash recovery resumes
 * from the correct position. Writes atomically (temp + rename).
 */

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logAndSwallow } from "../../components/log-and-swallow.js";

const TAG = "offset_store";

export interface OffsetStore {
  read(): Promise<number>;
  write(offset: number): Promise<void>;
}

/** File-backed offset store with atomic writes. */
export function createFileOffsetStore(filePath: string): OffsetStore {
  let pending: Promise<void> = Promise.resolve();

  return {
    async read(): Promise<number> {
      try {
        const raw = await readFile(filePath, "utf-8");
        const val = parseInt(raw.trim(), 10);
        return Number.isFinite(val) ? val : 0;
      } catch (err) {
        logAndSwallow(TAG, "read offset file", err);
        return 0;
      }
    },
    write(offset: number): Promise<void> {
      // Serialize writes via promise chain (async mutex).
      pending = pending.then(async () => {
        const tmp = filePath + ".tmp";
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(tmp, String(offset), "utf-8");
        await rename(tmp, filePath);
      }).catch(err => logAndSwallow(TAG, "write offset file", err));
      return pending;
    },
  };
}

/** In-memory offset store for tests. */
export function createMemoryOffsetStore(initial = 0): OffsetStore & { value: number } {
  const store = {
    value: initial,
    async read(): Promise<number> { return store.value; },
    async write(offset: number): Promise<void> { store.value = offset; },
  };
  return store;
}
