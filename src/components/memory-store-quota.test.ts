import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStoreQuota, MAIN_MEMORY_STORE_LIMIT, MEMORY_STORE_WINDOW_MS } from "./memory-store-quota.js";
import { resolveNativeDep } from "../utils/lazy-require.js";

const Database = resolveNativeDep("better-sqlite3") as new (p: string) => {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
    all<T = Record<string, unknown>>(...params: unknown[]): T[];
  };
  exec(sql: string): void;
  close(): void;
};

function countRows(dbPath: string): { total: number; pending: number; committed: number; oldest: number | null } {
  const db = new Database(dbPath);
  try {
    const total = db.prepare("SELECT COUNT(*) AS n FROM memory_store_quota_reservations").get<{ n: number }>()!.n;
    const pending = db.prepare("SELECT COUNT(*) AS n FROM memory_store_quota_reservations WHERE state='pending'").get<{ n: number }>()!.n;
    const committed = db.prepare("SELECT COUNT(*) AS n FROM memory_store_quota_reservations WHERE state='committed'").get<{ n: number }>()!.n;
    const oldest = db.prepare("SELECT MIN(reserved_at_ms) AS v FROM memory_store_quota_reservations").get<{ v: number | null }>()!.v;
    return { total, pending, committed, oldest };
  } finally {
    db.close();
  }
}

describe("MemoryStoreQuota #1552", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "abtars-quota-"));
    dbPath = join(dir, "quota.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reserves below the limit and rejects the 21st live reservation with retry_after from the oldest", () => {
    let now = 1_000_000;
    const quota = new MemoryStoreQuota({ dbPath, now: () => now });
    const ids: string[] = [];
    for (let i = 0; i < MAIN_MEMORY_STORE_LIMIT; i++) {
      const r = quota.reserve("u1");
      expect(r.kind).toBe("reserved");
      if (r.kind === "reserved") { ids.push(r.id); quota.commit(r.id); }
    }
    const limited = quota.reserve("u1");
    expect(limited.kind).toBe("limited");
    if (limited.kind === "limited") {
      expect(limited.used).toBe(20);
      expect(limited.limit).toBe(20);
      expect(limited.retryAfter).toBe(1_000_000 + MEMORY_STORE_WINDOW_MS);
    }
    quota.close();
    expect(countRows(dbPath)).toMatchObject({ total: 20, pending: 0, committed: 20 });
  });

  it("expires reservations at the exact rolling cutoff: at cutoff is expired, just before counts", () => {
    let now = 1_000_000;
    const quota = new MemoryStoreQuota({ dbPath, now: () => now });
    for (let i = 0; i < MAIN_MEMORY_STORE_LIMIT; i++) {
      const r = quota.reserve("u1");
      if (r.kind === "reserved") quota.commit(r.id);
    }
    // One ms before the window rolls: all 20 rows are still live.
    now = 1_000_000 + MEMORY_STORE_WINDOW_MS - 1;
    expect(quota.reserve("u1").kind).toBe("limited");

    // Exactly at the cutoff (reserved_at_ms == now - window): expired.
    now = 1_000_000 + MEMORY_STORE_WINDOW_MS;
    expect(quota.reserve("u1").kind).toBe("reserved");
    quota.close();
    expect(countRows(dbPath)).toMatchObject({ total: 1, pending: 1 });
  });

  it("keeps pending reservations live across reopen (crash before outcome recording)", () => {
    const quota = new MemoryStoreQuota({ dbPath, now: () => 5_000 });
    quota.reserve("u1");
    quota.close();

    const reopened = new MemoryStoreQuota({ dbPath, now: () => 6_000 });
    expect(countRows(dbPath)).toMatchObject({ total: 1, pending: 1 });
    // The pending row still consumes a slot: 19 more fit, the 20th does not.
    for (let i = 0; i < 19; i++) {
      expect(reopened.reserve("u1").kind).toBe("reserved");
    }
    expect(reopened.reserve("u1").kind).toBe("limited");
    reopened.close();
  });

  it("isolates different users: each starts at zero", () => {
    const quota = new MemoryStoreQuota({ dbPath });
    for (let i = 0; i < MAIN_MEMORY_STORE_LIMIT; i++) {
      const r = quota.reserve("user-a");
      if (r.kind === "reserved") quota.commit(r.id);
    }
    expect(quota.reserve("user-a").kind).toBe("limited");
    expect(quota.reserve("user-b").kind).toBe("reserved");
    expect(countRows(dbPath)).toMatchObject({ total: 21, committed: 20, pending: 1 });
    quota.close();
  });

  it("two concurrent connections at 19 used slots yield exactly one reservation and one rejection", async () => {
    const seed = new MemoryStoreQuota({ dbPath });
    for (let i = 0; i < 19; i++) {
      const r = seed.reserve("race-u");
      if (r.kind === "reserved") seed.commit(r.id);
    }
    seed.close();

    const a = new MemoryStoreQuota({ dbPath });
    const b = new MemoryStoreQuota({ dbPath });
    const [ra, rb] = await Promise.all([Promise.resolve(a.reserve("race-u")), Promise.resolve(b.reserve("race-u"))]);
    const kinds = [ra.kind, rb.kind].sort();
    expect(kinds).toEqual(["limited", "reserved"]);
    a.close();
    b.close();
    expect(countRows(dbPath)).toMatchObject({ total: 20 });
  });

  it("commit and release are idempotent in effect and cannot alter another reservation", () => {
    const quota = new MemoryStoreQuota({ dbPath });
    const r1 = quota.reserve("u1");
    const r2 = quota.reserve("u1");
    expect(r1.kind).toBe("reserved");
    expect(r2.kind).toBe("reserved");
    if (r1.kind !== "reserved" || r2.kind !== "reserved") return;

    expect(quota.commit(r1.id)).toBe(true);
    expect(quota.commit(r1.id)).toBe(false); // already committed
    expect(quota.release(r1.id)).toBe(false); // committed rows are never released
    expect(quota.release(r2.id)).toBe(true);
    expect(quota.release(r2.id)).toBe(false); // already released
    quota.close();
    expect(countRows(dbPath)).toMatchObject({ total: 1, pending: 0, committed: 1 });
  });

  it("an unopenable database yields unavailable, never unmetered access", () => {
    // Parent path is a regular file → mkdirSync fails → open fails closed.
    const blocker = join(dir, "blocker-file");
    writeFileSync(blocker, "not a directory");
    const quota = new MemoryStoreQuota({ dbPath: join(blocker, "quota.db") });
    const result = quota.reserve("u1");
    expect(result.kind).toBe("unavailable");
    expect(quota.commit("any")).toBe(false);
    expect(quota.release("any")).toBe(false);
    quota.close(); // idempotent on a failed store
  });

  it("stores no memory content, only scope/id/state/timestamps", () => {
    const quota = new MemoryStoreQuota({ dbPath });
    const r = quota.reserve("u1");
    expect(r.kind).toBe("reserved");
    quota.close();
    const raw = new (resolveNativeDep("better-sqlite3") as typeof import("better-sqlite3").default)(dbPath);
    try {
      const cols = raw.prepare("PRAGMA table_info(memory_store_quota_reservations)").all<{ name: string }>();
      expect(cols.map(c => c.name).sort()).toEqual(["id", "reserved_at_ms", "state", "user_id"]);
    } finally {
      raw.close();
    }
  });
});
