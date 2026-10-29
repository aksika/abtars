/**
 * reconcile-quarantine-store.test.ts — #1664: durable reconcile failure and
 * quarantine state.
 *
 * Proves the round-trip the no-speculative-schema rule requires (write, read
 * back, clear), the same-signature threshold that sets quarantined_at, the
 * signature-reset rule, clear-on-success semantics, the operator release
 * contract, and the redaction/digit-normalization contract of the signature
 * formatter. Runs against a real SQLite database in an isolated home.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ReconcileQuarantineStore,
  QUARANTINE_THRESHOLD,
  reconcileErrorSignature,
} from "./reconcile-quarantine-store.js";

let home: string;
let board: typeof import("./tasks/kanban-board.js");

async function loadStore(): Promise<typeof import("./reconcile-quarantine-store.js")> {
  vi.resetModules();
  // NOTE: this test lives one level under src/, so paths.js is ../paths.js —
  // not ../../paths.js, which is the convention for src/components/*/ tests.
  vi.doMock("../paths.js", () => ({ abtarsHome: () => home }));
  const s = await import("./reconcile-quarantine-store.js");
  board = await import("./tasks/kanban-board.js");
  return s;
}

function db(): import("./tasks/kanban-board.js").TaskDatabase {
  return board.requireTaskDatabase();
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "reconcile-quarantine-"));
  mkdirSync(join(home, "tasks"), { recursive: true });
  await loadStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("ReconcileQuarantineStore", () => {
  it("records a failure, reads it back, and clears it (round-trip)", () => {
    const store = new ReconcileQuarantineStore(db());
    const row = store.recordFailure(63, "Error:boom", "2026-08-16T10:00:00.000Z");
    expect(row).toEqual({
      cardId: 63,
      failureCount: 1,
      errorSignature: "Error:boom",
      lastErrorAt: "2026-08-16T10:00:00.000Z",
      quarantinedAt: null,
    });
    expect(store.isQuarantined(63)).toBe(false);
    expect(store.listQuarantined()).toEqual([]);
    store.clearFailures(63);
    expect(store.isQuarantined(63)).toBe(false);
    // cleared row is gone — next failure starts at 1
    const again = store.recordFailure(63, "Error:boom", "2026-08-16T10:01:00.000Z");
    expect(again.failureCount).toBe(1);
  });

  it("quarantines after QUARANTINE_THRESHOLD same-signature failures", () => {
    const store = new ReconcileQuarantineStore(db());
    for (let i = 1; i < QUARANTINE_THRESHOLD; i++) {
      const row = store.recordFailure(7, "Error:same", `2026-08-16T10:0${i}:00.000Z`);
      expect(row.quarantinedAt).toBeNull();
      expect(store.isQuarantined(7)).toBe(false);
    }
    const row = store.recordFailure(7, "Error:same", "2026-08-16T10:05:00.000Z");
    expect(row.failureCount).toBe(QUARANTINE_THRESHOLD);
    expect(row.quarantinedAt).toBe("2026-08-16T10:05:00.000Z");
    expect(store.isQuarantined(7)).toBe(true);
    const listed = store.listQuarantined();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ cardId: 7, failureCount: QUARANTINE_THRESHOLD, errorSignature: "Error:same" });
  });

  it("a different signature restarts the count at 1 and clears quarantined_at", () => {
    const store = new ReconcileQuarantineStore(db());
    store.recordFailure(7, "Error:first", "2026-08-16T10:00:00.000Z");
    store.recordFailure(7, "Error:first", "2026-08-16T10:01:00.000Z");
    const row = store.recordFailure(7, "Error:second", "2026-08-16T10:02:00.000Z");
    expect(row.failureCount).toBe(1);
    expect(row.errorSignature).toBe("Error:second");
    expect(row.quarantinedAt).toBeNull();
  });

  it("clearFailures after two failures means the next failure starts at 1", () => {
    const store = new ReconcileQuarantineStore(db());
    store.recordFailure(7, "Error:same", "2026-08-16T10:00:00.000Z");
    store.recordFailure(7, "Error:same", "2026-08-16T10:01:00.000Z");
    store.clearFailures(7);
    const row = store.recordFailure(7, "Error:same", "2026-08-16T10:02:00.000Z");
    expect(row.failureCount).toBe(1);
  });

  it("releaseQuarantine clears only a quarantined card and reports unknown cards", () => {
    const store = new ReconcileQuarantineStore(db());
    expect(store.releaseQuarantine(999)).toBe(false);
    store.recordFailure(7, "Error:same", "2026-08-16T10:00:00.000Z");
    store.recordFailure(7, "Error:same", "2026-08-16T10:01:00.000Z");
    expect(store.releaseQuarantine(7)).toBe(false); // failures recorded, not quarantined
    store.recordFailure(7, "Error:same", "2026-08-16T10:02:00.000Z");
    expect(store.isQuarantined(7)).toBe(true);
    expect(store.releaseQuarantine(7)).toBe(true);
    expect(store.isQuarantined(7)).toBe(false);
    expect(store.releaseQuarantine(7)).toBe(false); // idempotent second release
  });

  it("cards are independent — one card's quarantine never affects another", () => {
    const store = new ReconcileQuarantineStore(db());
    store.recordFailure(1, "Error:same", "2026-08-16T10:00:00.000Z");
    store.recordFailure(1, "Error:same", "2026-08-16T10:01:00.000Z");
    store.recordFailure(1, "Error:same", "2026-08-16T10:02:00.000Z");
    expect(store.isQuarantined(1)).toBe(true);
    expect(store.isQuarantined(2)).toBe(false);
    expect(store.isQuarantined(3)).toBe(false);
    store.recordFailure(2, "Error:other", "2026-08-16T10:03:00.000Z");
    expect(store.isQuarantined(2)).toBe(false);
  });
});

describe("reconcileErrorSignature", () => {
  it("builds a name:message signature from an Error", () => {
    expect(reconcileErrorSignature(new Error("boom"))).toBe("Error:boom");
  });

  it("normalizes digits so per-project ids and timestamps do not split a signature", () => {
    expect(reconcileErrorSignature(new Error("UNIQUE constraint failed: x.review_case_id (case 123)")))
      .toBe("Error:UNIQUE constraint failed: x.review_case_id (case #)");
  });

  it("redacts secrets before storage", () => {
    // Build the secret dynamically so no secret-like literal is embedded in
    // source; assert the stored signature never carries it.
    const secret = "sk_" + "live_" + "a".repeat(26);
    const sig = reconcileErrorSignature(new Error(`token ${secret} leaked`));
    expect(sig).not.toContain(secret);
    expect(sig).toContain("REDACTED");
  });

  it("redacts and bounds custom Error names and direct store signatures", () => {
    const secret = "Bearer " + "b".repeat(24);
    const err = new Error("failure");
    err.name = `${secret}-${"x".repeat(300)}`;

    const signature = reconcileErrorSignature(err);
    expect(signature).not.toContain(secret);
    expect(signature).toContain("REDACTED");
    expect(signature.length).toBeLessThanOrEqual(180 + 6);

    const store = new ReconcileQuarantineStore(db());
    const stored = store.recordFailure(64, `${secret}-${"y".repeat(300)}`, "2026-08-16T10:00:00.000Z");
    expect(stored.errorSignature).not.toContain(secret);
    expect(stored.errorSignature).toContain("REDACTED");
    expect(stored.errorSignature.length).toBeLessThanOrEqual(180 + 6);
  });

  it("bounds the stored signature length", () => {
    const sig = reconcileErrorSignature(new Error("x".repeat(500)));
    expect(sig.length).toBeLessThanOrEqual(180 + 6); // name prefix + separator
  });

  it("falls back to the value's type when the thrown value is not an Error", () => {
    expect(reconcileErrorSignature("string-reason")).toBe("string:string-reason");
    expect(reconcileErrorSignature(42)).toBe("number:#");
  });
});
