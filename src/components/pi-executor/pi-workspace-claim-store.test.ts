import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { PiWorkspaceClaimStore } from "./pi-workspace-claim-store.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: new (p: string) => import("better-sqlite3").Database = _require(sharedPath);

function createTestDb(): TaskDatabase {
  const raw = new Database(":memory:");
  raw.pragma("journal_mode = WAL");
  return {
    prepare(sql: string) {
      const stmt = raw.prepare(sql);
      return {
        run(...params: unknown[]) { return stmt.run(...params); },
        get(...params: unknown[]) { return stmt.get(...params) as Record<string, unknown> | undefined; },
        all(...params: unknown[]) { return stmt.all(...params) as Record<string, unknown>[]; },
      };
    },
    exec(sql: string) { raw.exec(sql); },
    transaction<T>(fn: () => T): T { return raw.transaction(fn)(); },
    transactionImmediate<T>(fn: () => T): T { return raw.transaction(fn)(); },
  };
}

/** Seed the pre-#1635 two-kind schema and one live standalone row. */
function seedLegacySchema(db: TaskDatabase): void {
  db.exec(`CREATE TABLE pi_workspace_claims (
    canonical_path TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    execution_generation INTEGER NOT NULL,
    owner_kind TEXT NOT NULL CHECK(owner_kind IN ('standalone','supervised')),
    acquired_at TEXT NOT NULL,
    UNIQUE(run_id, execution_generation)
  )`);
  db.exec(`INSERT INTO pi_workspace_claims VALUES ('/ws/a', 'run-1', 1, 'standalone', '2026-08-12')`);
}

describe("PiWorkspaceClaimStore #1635", () => {
  it("migrates the legacy two-kind schema preserving live rows", () => {
    const db = createTestDb();
    seedLegacySchema(db);
    const store = new PiWorkspaceClaimStore(db);
    const rows = store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ canonicalPath: "/ws/a", ownerId: "run-1", generation: 1, ownerKind: "standalone" });
    // the migrated table accepts the new owner kind
    const claim = store.tryAcquireInTx({ canonicalPath: "/ws/b", ownerId: "sess-1", generation: 1, ownerKind: "interactive" });
    expect(claim.kind).toBe("claimed");
    expect(store.list()).toHaveLength(2);
  });

  it("acquire is idempotent for the exact holder and busy for others", () => {
    const db = createTestDb();
    const store = new PiWorkspaceClaimStore(db);
    expect(store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 1, ownerKind: "interactive" }).kind).toBe("claimed");
    expect(store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 1, ownerKind: "interactive" }).kind).toBe("idempotent");
    const busy = store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "run-9", generation: 1, ownerKind: "standalone" });
    expect(busy.kind).toBe("busy");
    if (busy.kind === "busy") expect(busy.holderOwnerId).toBe("sess-1");
  });

  it("a stale generation cannot release a newer holder", () => {
    const db = createTestDb();
    const store = new PiWorkspaceClaimStore(db);
    store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 1, ownerKind: "interactive" });
    expect(store.releaseForGeneration({ ownerId: "sess-1", generation: 2 })).toBe(false);
    expect(store.list()).toHaveLength(1);
    expect(store.releaseForGeneration({ ownerId: "sess-1", generation: 1 })).toBe(true);
    expect(store.list()).toHaveLength(0);
  });

  it("releaseExact never frees a newer holder on the same path", () => {
    const db = createTestDb();
    const store = new PiWorkspaceClaimStore(db);
    store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 2, ownerKind: "interactive" });
    const r = store.releaseExact({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 1 });
    expect(r.released).toBe(false);
    expect((r as { reason: string }).reason).toBe("not_holder");
    expect(store.list()).toHaveLength(1);
  });

  it("acquire and release pair inside a caller transaction", () => {
    const db = createTestDb();
    const store = new PiWorkspaceClaimStore(db);
    const outcome = db.transaction<boolean>(() => {
      if (store.tryAcquireInTx({ canonicalPath: "/ws/a", ownerId: "sess-1", generation: 1, ownerKind: "interactive" }).kind !== "claimed") return false;
      return true;
    });
    expect(outcome).toBe(true);
    expect(store.list()).toHaveLength(1);
    // rollback undoes the acquire
    expect(() => db.transaction<boolean>(() => {
      store.tryAcquireInTx({ canonicalPath: "/ws/b", ownerId: "sess-2", generation: 1, ownerKind: "interactive" });
      throw new Error("rollback");
    })).toThrow("rollback");
    expect(store.list()).toHaveLength(1);
  });
});
