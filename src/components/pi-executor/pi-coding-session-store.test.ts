import { describe, it, expect, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskDatabase } from "../tasks/kanban-board.js";
import { PiCodingSessionStore } from "./pi-coding-session-store.js";

const _require = createRequire(import.meta.url);
const sharedPath = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");
const Database: typeof import("better-sqlite3") = _require(sharedPath);

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
  };
}

function makeStore(): { store: PiCodingSessionStore; db: TaskDatabase } {
  const db = createTestDb();
  const store = new PiCodingSessionStore(db);
  return { store, db };
}

function seed(h: { store: PiCodingSessionStore }, sessionId = "c-1"): void {
  h.store.create({
    sessionId,
    ownerPrincipal: "usr-1",
    workspaceAlias: "repo-a",
    canonicalPath: "/tmp/ws/repo-a",
  });
}

describe("PiCodingSessionStore #1635", () => {
  it("create writes a durable row starting creating/initial/never_started", () => {
    const h = makeStore();
    seed(h);
    const rec = h.store.get("c-1")!;
    expect(rec.sessionId).toBe("c-1");
    expect(rec.ownerPrincipal).toBe("usr-1");
    expect(rec.workspaceAlias).toBe("repo-a");
    expect(rec.state).toBe("creating");
    expect(rec.runtimeGeneration).toBe(1);
    expect(rec.generationIntent).toBe("initial");
    expect(rec.resumeCapability).toBe("never_started");
    expect(rec.memoryMode).toBe("none");
    expect(rec.leaseGeneration).toBeUndefined();
  });

  it("create is idempotent on the session id", () => {
    const h = makeStore();
    seed(h);
    seed(h);
    expect(h.store.listForOwner("usr-1")).toHaveLength(1);
  });

  it("CAS transition applies exactly the expected state change", () => {
    const h = makeStore();
    seed(h);
    const r = h.store.casTransition("c-1", "creating", "idle");
    expect(r.applied).toBe(true);
    expect(h.store.get("c-1")!.state).toBe("idle");
    const denied = h.store.casTransition("c-1", "creating", "starting");
    expect(denied.applied).toBe(false);
    expect((denied as { reason: string }).reason).toBe("wrong_state");
    expect(h.store.get("c-1")!.state).toBe("idle");
  });

  it("CAS transition is generation-fenced", () => {
    const h = makeStore();
    seed(h);
    h.store.casTransition("c-1", "creating", "idle");
    h.store.advanceGeneration("c-1", 1, "initial");
    const r = h.store.casTransition("c-1", "idle", "starting", {}, 1);
    expect(r.applied).toBe(false);
    expect((r as { reason: string }).reason).toBe("stale_generation");
  });

  it("advanceGeneration bumps the runtime generation with the explicit intent", () => {
    const h = makeStore();
    seed(h);
    expect(h.store.advanceGeneration("c-1", 1, "resume")).toBe(true);
    const rec = h.store.get("c-1")!;
    expect(rec.runtimeGeneration).toBe(2);
    expect(rec.generationIntent).toBe("resume");
    expect(h.store.advanceGeneration("c-1", 1, "initial")).toBe(false);
  });

  it("lease set/clear are exclusive and exact-generation fenced", () => {
    const h = makeStore();
    seed(h);
    expect(h.store.setLease("c-1", { frontend: "telegram-rpc", owner: "conn-1", generation: 1, acquiredAt: "2026-08-12" }, 1)).toBe(true);
    const rec = h.store.get("c-1")!;
    expect(rec.leaseFrontend).toBe("telegram-rpc");
    expect(rec.leaseGeneration).toBe(1);
    expect(rec.leaseOwner).toBe("conn-1");
    // a second holder cannot acquire while one is live
    expect(h.store.setLease("c-1", { frontend: "native-tui", owner: "tui-1", generation: 1, acquiredAt: "2026-08-12" }, 1)).toBe(false);
    // a stale generation cannot clear a newer lease
    expect(h.store.clearLease("c-1", 2)).toBe(false);
    expect(h.store.get("c-1")!.leaseGeneration).toBe(1);
    // the exact generation clears it
    expect(h.store.clearLease("c-1", 1)).toBe(true);
    expect(h.store.get("c-1")!.leaseGeneration).toBeUndefined();
  });

  it("recordResumeCapability persists a proof-derived capability", () => {
    const h = makeStore();
    seed(h);
    h.store.recordResumeCapability("c-1", "available");
    expect(h.store.get("c-1")!.resumeCapability).toBe("available");
  });

  it("listForOwner excludes ended sessions and orders by recency", () => {
    const h = makeStore();
    seed(h, "c-1");
    seed(h, "c-2");
    h.store.casTransition("c-1", "creating", "idle");
    h.store.touchActivity("c-1");
    h.store.markEnded("c-2");
    const list = h.store.listForOwner("usr-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.sessionId).toBe("c-1");
  });

  it("re-running migrate() twice does not throw", () => {
    const h = makeStore();
    seed(h);
    h.store.casTransition("c-1", "creating", "idle");
    const second = new PiCodingSessionStore(h.db);
    expect(second.get("c-1")!.state).toBe("idle");
  });

  it("markEnded keeps the row and never touches the transcript", () => {
    const h = makeStore();
    seed(h);
    expect(h.store.markEnded("c-1")).toBe(true);
    const rec = h.store.get("c-1")!;
    expect(rec.state).toBe("ended");
    expect(h.store.getMostRecentForOwner("usr-1")).toBeNull();
  });
});
