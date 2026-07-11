import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

let TEST_HOME: string;
let mod: typeof import("./pi-request-ledger.js");

beforeEach(async () => {
  vi.resetModules();
  TEST_HOME = join(tmpdir(), `pi-ledger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(TEST_HOME, { recursive: true });
  vi.doMock("../paths.js", () => ({ abtarsHome: () => TEST_HOME }));
  mod = await import("./pi-request-ledger.js");
});

afterEach(() => {
  rmSync(TEST_HOME, { recursive: true, force: true });
});

describe("pi-request-ledger", () => {
  it("creates the DB on first use", () => {
    mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(existsSync(join(TEST_HOME, "kanban", "kanban.db"))).toBe(true);
  });

  it("hashCanonicalJson produces deterministic output", () => {
    const h1 = mod.hashCanonicalJson({ b: 2, a: 1 });
    const h2 = mod.hashCanonicalJson({ a: 1, b: 2 });
    expect(h1).toBe(h2);
  });

  it("reserveRequest inserts a pending entry", () => {
    const r = mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.state).toBe("pending");
      expect(r.entry.requestId).toBe("req-1");
    }
  });

  it("completeRequest updates state and stores response", () => {
    mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    mod.completeRequest("pi-local", "notify", "req-1", '{"ok":true}');

    const r = mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.state).toBe("completed");
      expect(r.entry.responseJson).toBe('{"ok":true}');
    }
  });

  it("failRequest updates state to failed", () => {
    mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    mod.failRequest("pi-local", "notify", "req-1", '{"error":"fail"}');

    const r = mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.state).toBe("failed");
      expect(r.entry.responseJson).toBe('{"error":"fail"}');
    }
  });

  it("returns duplicate_conflict when same key with different hash", () => {
    mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    const r = mod.reserveRequest("pi-local", "notify", "req-1", "hash2");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("duplicate_conflict");
    }
  });

  it("returns outcome_unknown when same key with same hash but incomplete", () => {
    mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    // still pending — same hash but not completed
    const r = mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("outcome_unknown");
    }
  });

  it("different client+operation+requestId inserts independently", () => {
    const r1 = mod.reserveRequest("client-a", "notify", "req-1", "hash1");
    expect(r1.ok).toBe(true);
    const r2 = mod.reserveRequest("client-b", "notify", "req-1", "hash1");
    expect(r2.ok).toBe(true);
  });

  it("same client, different operations are independent", () => {
    const r1 = mod.reserveRequest("pi-local", "notify", "req-1", "hash1");
    expect(r1.ok).toBe(true);
    const r2 = mod.reserveRequest("pi-local", "task:create", "req-1", "hash1");
    expect(r2.ok).toBe(true);
  });

  it("pruneLedger completes without error and only removes old entries", () => {
    mod.reserveRequest("pi-local", "notify", "old-req", "hash1");
    mod.completeRequest("pi-local", "notify", "old-req", "{}");
    // Prune with 0 days won't affect rows just updated (updated_at == datetime('now'))
    const pruned = mod.pruneLedger(0);
    expect(typeof pruned).toBe("number");

    // Row should still exist since it was just updated
    const r = mod.reserveRequest("pi-local", "notify", "old-req", "hash1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.state).toBe("completed");
    }
  });

  it("pruneLedger does not remove pending entries", () => {
    mod.reserveRequest("pi-local", "notify", "pending-req", "hash1");
    // still pending — should NOT be pruned
    const pruned = mod.pruneLedger(0);
    expect(pruned).toBe(0);
  });
});
